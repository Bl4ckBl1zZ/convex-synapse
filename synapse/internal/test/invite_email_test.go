package synapsetest

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/Iann29/synapse/internal/email"
)

// recordingSender is a fake email.Sender for asserting the invite email.
// enabled mirrors a configured provider; sendErr simulates a provider
// failure so we can prove the invite is best-effort (still succeeds).
type recordingSender struct {
	mu      sync.Mutex
	enabled bool
	sendErr error
	msgs    []email.Message
}

func (s *recordingSender) Enabled() bool { return s.enabled }

func (s *recordingSender) Send(_ context.Context, m email.Message) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sendErr != nil {
		return s.sendErr
	}
	s.msgs = append(s.msgs, m)
	return nil
}

func (s *recordingSender) sent() []email.Message {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]email.Message(nil), s.msgs...)
}

type inviteEmailResp struct {
	InviteID    string `json:"inviteId"`
	Email       string `json:"email"`
	Role        string `json:"role"`
	InviteToken string `json:"inviteToken"`
	Emailed     bool   `json:"emailed"`
}

// v1.22.0: inviting a team member emails the invitee a clickable accept
// link when Resend is configured. The accept URL is built from PublicURL
// so the email lands at the dashboard's /accept-invite page.
func TestInvites_SendsEmailWithAcceptLink(t *testing.T) {
	sender := &recordingSender{enabled: true}
	h := SetupWithOpts(t, SetupOpts{
		PublicURL: "https://panel.example.com",
		Email:     sender,
	})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Email Co")

	var got inviteEmailResp
	h.DoJSON(http.MethodPost, "/v1/teams/"+team.Slug+"/invite_team_member",
		owner.AccessToken,
		map[string]string{"email": "invitee@example.test", "role": "member"},
		http.StatusOK, &got)

	if !got.Emailed {
		t.Fatal("response emailed=false, want true (sender enabled + PublicURL set)")
	}
	msgs := sender.sent()
	if len(msgs) != 1 {
		t.Fatalf("sent %d emails, want exactly 1", len(msgs))
	}
	m := msgs[0]
	if m.To != "invitee@example.test" {
		t.Errorf("To: got %q, want invitee@example.test", m.To)
	}
	if !strings.Contains(m.Subject, "Email Co") {
		t.Errorf("Subject %q should name the team", m.Subject)
	}
	// Text body carries the exact accept URL (no HTML escaping), built the
	// same way the handler does — base + QueryEscape(token).
	wantLink := "https://panel.example.com/accept-invite?token=" + url.QueryEscape(got.InviteToken)
	if !strings.Contains(m.Text, wantLink) {
		t.Errorf("Text missing accept link %q\nText=%s", wantLink, m.Text)
	}
	// HTML rendered with the link + team name (loose check — html/template
	// may percent-normalize the href, so don't assert the exact URL there).
	if !strings.Contains(m.HTML, "/accept-invite?token=") || !strings.Contains(m.HTML, "Email Co") {
		t.Errorf("HTML body missing accept link or team name:\n%s", m.HTML)
	}
}

// No Resend configured (default install): the invite still succeeds, no
// email is sent, emailed=false. The token is returned so the link works.
func TestInvites_NoEmailWhenDisabled(t *testing.T) {
	sender := &recordingSender{enabled: false}
	h := SetupWithOpts(t, SetupOpts{PublicURL: "https://panel.example.com", Email: sender})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "NoEmail Co")

	var got inviteEmailResp
	h.DoJSON(http.MethodPost, "/v1/teams/"+team.Slug+"/invite_team_member",
		owner.AccessToken,
		map[string]string{"email": "invitee2@example.test", "role": "member"},
		http.StatusOK, &got)

	if got.Emailed {
		t.Error("emailed=true with a disabled sender")
	}
	if got.InviteToken == "" {
		t.Error("invite token must still be returned when email is off")
	}
	if n := len(sender.sent()); n != 0 {
		t.Errorf("disabled sender got %d sends, want 0", n)
	}
}

// A provider failure must NOT fail the invite (best-effort): the invite is
// created, the token returned, emailed=false.
func TestInvites_EmailFailureDoesNotBlockInvite(t *testing.T) {
	sender := &recordingSender{enabled: true, sendErr: errors.New("resend unreachable")}
	h := SetupWithOpts(t, SetupOpts{PublicURL: "https://panel.example.com", Email: sender})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Resilient Co")

	var got inviteEmailResp
	h.DoJSON(http.MethodPost, "/v1/teams/"+team.Slug+"/invite_team_member",
		owner.AccessToken,
		map[string]string{"email": "invitee3@example.test", "role": "member"},
		http.StatusOK, &got)

	if got.Emailed {
		t.Error("emailed=true despite the send error")
	}
	if got.InviteToken == "" {
		t.Error("invite must still be created when the email send fails")
	}
}
