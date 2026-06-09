package synapsetest

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Iann29/synapse/internal/email"
)

// okResp pins the {ok:true} shape both password-reset endpoints return.
// forgot_password's body must be IDENTICAL for known and unknown emails —
// TestPasswordReset_UnknownEmailSilent enforces it on the wire.
type okResp struct {
	OK bool `json:"ok"`
}

// resetHarness builds the SetupOpts the reset flow needs: a recording
// sender (so tests can read the emailed link) + a PublicURL (so the
// handler can build it).
func resetHarness(t *testing.T, sender *recordingSender) *Harness {
	t.Helper()
	return SetupWithOpts(t, SetupOpts{
		PublicURL: "https://panel.example.com",
		Email:     sender,
	})
}

// waitForEmails polls the recording sender until `want` messages landed.
// The reset email is dispatched from a detached goroutine (so the
// forgot_password response time can't leak whether the account exists via
// Resend latency), hence the poll instead of a sync read.
func waitForEmails(t *testing.T, s *recordingSender, want int) []email.Message {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if msgs := s.sent(); len(msgs) >= want {
			return msgs
		}
		time.Sleep(25 * time.Millisecond)
	}
	msgs := s.sent()
	t.Fatalf("emails = %d, want %d", len(msgs), want)
	return msgs
}

// extractResetToken pulls the token out of the emailed plaintext link —
// the same way a real user would, by clicking what's in the inbox.
func extractResetToken(t *testing.T, text string) string {
	t.Helper()
	const marker = "/reset-password?token="
	i := strings.Index(text, marker)
	if i < 0 {
		t.Fatalf("email text has no reset link:\n%s", text)
	}
	rest := text[i+len(marker):]
	if j := strings.IndexAny(rest, " \n\r\t"); j >= 0 {
		rest = rest[:j]
	}
	if rest == "" {
		t.Fatalf("empty token in reset link:\n%s", text)
	}
	return rest
}

// countResetRows returns how many password_reset_tokens rows exist for the
// user (used + active alike).
func countResetRows(t *testing.T, h *Harness, userID string) int {
	t.Helper()
	var n int
	if err := h.DB.QueryRow(context.Background(),
		`SELECT count(*) FROM password_reset_tokens WHERE user_id = $1`, userID,
	).Scan(&n); err != nil {
		t.Fatalf("count reset rows: %v", err)
	}
	return n
}

// Happy path: forgot → email with link → reset → old password dead, new
// password works.
func TestPasswordReset_FullFlow(t *testing.T) {
	sender := &recordingSender{enabled: true}
	h := resetHarness(t, sender)
	u := h.RegisterRandomUser()

	var got okResp
	h.DoJSON(http.MethodPost, "/v1/auth/forgot_password", "",
		map[string]string{"email": u.Email}, http.StatusOK, &got)
	if !got.OK {
		t.Fatal("forgot_password ok=false")
	}

	msgs := waitForEmails(t, sender, 1)
	m := msgs[0]
	if m.To != u.Email {
		t.Errorf("email To = %q, want %q", m.To, u.Email)
	}
	if !strings.Contains(strings.ToLower(m.Subject), "password") {
		t.Errorf("subject %q should mention the password", m.Subject)
	}
	token := extractResetToken(t, m.Text)
	if !strings.HasPrefix(token, "syn_reset_") {
		t.Errorf("token %q should carry the syn_reset_ prefix (leak scanners)", token)
	}
	if !strings.Contains(m.HTML, "/reset-password?token=") {
		t.Error("HTML body missing the reset link")
	}

	got = okResp{}
	h.DoJSON(http.MethodPost, "/v1/auth/reset_password", "",
		map[string]string{"token": token, "newPassword": "brandnewpass456"},
		http.StatusOK, &got)
	if !got.OK {
		t.Fatal("reset_password ok=false")
	}

	// Old password refused, new one accepted.
	h.AssertStatus(http.MethodPost, "/v1/auth/login", "",
		map[string]string{"email": u.Email, "password": "supersecret123"},
		http.StatusUnauthorized)
	resp := h.Do(http.MethodPost, "/v1/auth/login", "",
		map[string]string{"email": u.Email, "password": "brandnewpass456"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login with new password: status=%d", resp.StatusCode)
	}
}

// No user enumeration: an unknown email gets the exact same 200 {ok:true}
// and sends nothing.
func TestPasswordReset_UnknownEmailSilent(t *testing.T) {
	sender := &recordingSender{enabled: true}
	h := resetHarness(t, sender)

	var got okResp
	h.DoJSON(http.MethodPost, "/v1/auth/forgot_password", "",
		map[string]string{"email": "nobody-" + randHex(6) + "@example.test"},
		http.StatusOK, &got)
	if !got.OK {
		t.Fatal("unknown email must still answer ok=true")
	}
	// The send is async — give a would-be email time to land before
	// asserting silence.
	time.Sleep(300 * time.Millisecond)
	if n := len(sender.sent()); n != 0 {
		t.Errorf("unknown email sent %d emails, want 0", n)
	}
}

// Single-use + sibling invalidation: two outstanding tokens; using one
// kills both (the used one AND the not-yet-used sibling).
func TestPasswordReset_TokenSingleUseAndSiblings(t *testing.T) {
	sender := &recordingSender{enabled: true}
	h := resetHarness(t, sender)
	u := h.RegisterRandomUser()

	for range 2 {
		h.DoJSON(http.MethodPost, "/v1/auth/forgot_password", "",
			map[string]string{"email": u.Email}, http.StatusOK, &okResp{})
	}
	msgs := waitForEmails(t, sender, 2)
	tokenA := extractResetToken(t, msgs[0].Text)
	tokenB := extractResetToken(t, msgs[1].Text)

	h.DoJSON(http.MethodPost, "/v1/auth/reset_password", "",
		map[string]string{"token": tokenB, "newPassword": "brandnewpass456"},
		http.StatusOK, &okResp{})

	env := h.AssertStatus(http.MethodPost, "/v1/auth/reset_password", "",
		map[string]string{"token": tokenB, "newPassword": "anotherpass789"},
		http.StatusBadRequest)
	if env.Code != "invalid_token" {
		t.Errorf("reused token: code = %q, want invalid_token", env.Code)
	}
	env = h.AssertStatus(http.MethodPost, "/v1/auth/reset_password", "",
		map[string]string{"token": tokenA, "newPassword": "anotherpass789"},
		http.StatusBadRequest)
	if env.Code != "invalid_token" {
		t.Errorf("sibling token after a successful reset: code = %q, want invalid_token", env.Code)
	}
}

// Expired tokens are refused.
func TestPasswordReset_ExpiredToken(t *testing.T) {
	sender := &recordingSender{enabled: true}
	h := resetHarness(t, sender)
	u := h.RegisterRandomUser()

	h.DoJSON(http.MethodPost, "/v1/auth/forgot_password", "",
		map[string]string{"email": u.Email}, http.StatusOK, &okResp{})
	token := extractResetToken(t, waitForEmails(t, sender, 1)[0].Text)

	if _, err := h.DB.Exec(context.Background(),
		`UPDATE password_reset_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = $1`,
		u.ID); err != nil {
		t.Fatalf("backdate token: %v", err)
	}

	env := h.AssertStatus(http.MethodPost, "/v1/auth/reset_password", "",
		map[string]string{"token": token, "newPassword": "brandnewpass456"},
		http.StatusBadRequest)
	if env.Code != "invalid_token" {
		t.Errorf("expired token: code = %q, want invalid_token", env.Code)
	}
}

// Garbage token → same invalid_token (no oracle for token format).
func TestPasswordReset_BogusToken(t *testing.T) {
	h := resetHarness(t, &recordingSender{enabled: true})
	env := h.AssertStatus(http.MethodPost, "/v1/auth/reset_password", "",
		map[string]string{"token": "syn_reset_definitely-not-real", "newPassword": "brandnewpass456"},
		http.StatusBadRequest)
	if env.Code != "invalid_token" {
		t.Errorf("bogus token: code = %q, want invalid_token", env.Code)
	}
}

// A weak new password 400s WITHOUT consuming the token — the user can
// retry with a stronger one.
func TestPasswordReset_WeakPasswordKeepsToken(t *testing.T) {
	sender := &recordingSender{enabled: true}
	h := resetHarness(t, sender)
	u := h.RegisterRandomUser()

	h.DoJSON(http.MethodPost, "/v1/auth/forgot_password", "",
		map[string]string{"email": u.Email}, http.StatusOK, &okResp{})
	token := extractResetToken(t, waitForEmails(t, sender, 1)[0].Text)

	env := h.AssertStatus(http.MethodPost, "/v1/auth/reset_password", "",
		map[string]string{"token": token, "newPassword": "short"},
		http.StatusBadRequest)
	if env.Code != "weak_password" {
		t.Errorf("weak password: code = %q, want weak_password", env.Code)
	}

	// Token survived the 400 — retry succeeds.
	h.DoJSON(http.MethodPost, "/v1/auth/reset_password", "",
		map[string]string{"token": token, "newPassword": "brandnewpass456"},
		http.StatusOK, &okResp{})
}

// Rate limit: at most 3 active tokens per account. The 4th request still
// answers 200 (no oracle) but mints nothing.
func TestPasswordReset_RateLimit(t *testing.T) {
	sender := &recordingSender{enabled: true}
	h := resetHarness(t, sender)
	u := h.RegisterRandomUser()

	for range 4 {
		h.DoJSON(http.MethodPost, "/v1/auth/forgot_password", "",
			map[string]string{"email": u.Email}, http.StatusOK, &okResp{})
	}
	// Token rows are minted synchronously (deterministic cap); only the
	// email send is detached.
	if n := countResetRows(t, h, u.ID); n != 3 {
		t.Errorf("token rows = %d, want 3", n)
	}
	waitForEmails(t, sender, 3)
	time.Sleep(200 * time.Millisecond) // settle: a 4th send would be in flight by now
	if n := len(sender.sent()); n != 3 {
		t.Errorf("emails = %d, want exactly 3 (4th request over the active-token cap mints nothing)", n)
	}
}

// Email not configured (default install): forgot still answers 200 but no
// undeliverable token is minted.
func TestPasswordReset_NoEmailConfigured(t *testing.T) {
	sender := &recordingSender{enabled: false}
	h := resetHarness(t, sender)
	u := h.RegisterRandomUser()

	h.DoJSON(http.MethodPost, "/v1/auth/forgot_password", "",
		map[string]string{"email": u.Email}, http.StatusOK, &okResp{})
	if n := countResetRows(t, h, u.ID); n != 0 {
		t.Errorf("token rows = %d, want 0 (nothing to deliver the link with)", n)
	}
	time.Sleep(300 * time.Millisecond)
	if n := len(sender.sent()); n != 0 {
		t.Errorf("disabled sender got %d sends, want 0", n)
	}
}

// Resetting the password revokes refresh tokens issued BEFORE the change:
// the stateless JWT is refused by iat < users.password_changed_at.
func TestPasswordReset_RevokesOldRefreshTokens(t *testing.T) {
	sender := &recordingSender{enabled: true}
	h := resetHarness(t, sender)
	u := h.RegisterRandomUser()
	oldRefresh := u.RefreshToken

	// iat has second precision — make sure the reset lands in a LATER
	// second than the register-issued token, or the grace window (which
	// protects logins right after a reset) would keep it alive.
	time.Sleep(1100 * time.Millisecond)

	h.DoJSON(http.MethodPost, "/v1/auth/forgot_password", "",
		map[string]string{"email": u.Email}, http.StatusOK, &okResp{})
	token := extractResetToken(t, waitForEmails(t, sender, 1)[0].Text)
	h.DoJSON(http.MethodPost, "/v1/auth/reset_password", "",
		map[string]string{"token": token, "newPassword": "brandnewpass456"},
		http.StatusOK, &okResp{})

	env := h.AssertStatus(http.MethodPost, "/v1/auth/refresh", "",
		map[string]string{"refreshToken": oldRefresh}, http.StatusUnauthorized)
	if env.Code != "invalid_refresh" {
		t.Errorf("old refresh after reset: code = %q, want invalid_refresh", env.Code)
	}

	// A session started AFTER the reset refreshes fine.
	var fresh struct {
		AccessToken  string `json:"accessToken"`
		RefreshToken string `json:"refreshToken"`
		TokenType    string `json:"tokenType"`
		ExpiresIn    int    `json:"expiresIn"`
		User         any    `json:"user"`
	}
	h.DoJSON(http.MethodPost, "/v1/auth/login", "",
		map[string]string{"email": u.Email, "password": "brandnewpass456"},
		http.StatusOK, &fresh)
	h.DoJSON(http.MethodPost, "/v1/auth/refresh", "",
		map[string]string{"refreshToken": fresh.RefreshToken}, http.StatusOK, &fresh)
}
