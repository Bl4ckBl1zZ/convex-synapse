package synapsetest

import (
	"net/http"
	"testing"
	"time"
)

// inviteResp mirrors the JSON shape of POST /v1/teams/{slug}/invite_team_member.
// Re-declared here (vs reusing the anonymous struct in teams_test.go) so this
// file stands on its own — invites_test.go is the canonical place for the
// accept-side contract, and a same-package duplicate keeps a future split of
// teams_test.go from breaking these tests.
type inviteResp struct {
	InviteID    string `json:"inviteId"`
	Email       string `json:"email"`
	Role        string `json:"role"`
	InviteToken string `json:"inviteToken"`
}

// acceptInviteResp mirrors the success body of POST /v1/team_invites/accept.
type acceptInviteResp struct {
	TeamID   string `json:"teamId"`
	TeamSlug string `json:"teamSlug"`
	TeamName string `json:"teamName"`
	Role     string `json:"role"`
}

// issueInvite is a small helper: an admin (`adminBearer`) invites `email`
// with the given role and returns the issued invite (including the opaque
// `inviteToken` that the invitee must POST back to /v1/team_invites/accept).
func issueInvite(t *testing.T, h *Harness, adminBearer, teamSlug, email, role string) inviteResp {
	t.Helper()
	var got inviteResp
	h.DoJSON(http.MethodPost, "/v1/teams/"+teamSlug+"/invite_team_member",
		adminBearer,
		map[string]string{"email": email, "role": role},
		http.StatusOK, &got)
	if got.InviteToken == "" {
		t.Fatalf("issueInvite: empty invite token in response %+v", got)
	}
	return got
}

// TestInvites_Accept_HappyPath locks the on-rails onboarding flow: admin
// invites email → invitee registers → invitee POSTs the token to
// /v1/team_invites/accept → invitee is now in list_members with the role
// recorded on the invite. This is the contract the dashboard's
// /accept-invite page depends on.
func TestInvites_Accept_HappyPath(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Onboard Co")

	invitee := h.RegisterRandomUser()
	inv := issueInvite(t, h, owner.AccessToken, team.Slug, invitee.Email, "member")

	var got acceptInviteResp
	h.DoJSON(http.MethodPost, "/v1/team_invites/accept", invitee.AccessToken,
		map[string]string{"token": inv.InviteToken}, http.StatusOK, &got)

	if got.TeamID != team.ID {
		t.Errorf("teamId=%q want %q", got.TeamID, team.ID)
	}
	if got.TeamSlug != team.Slug {
		t.Errorf("teamSlug=%q want %q", got.TeamSlug, team.Slug)
	}
	if got.Role != "member" {
		t.Errorf("role=%q want member", got.Role)
	}

	// Invitee is now visible to the admin via list_members with the
	// recorded role — the actual side effect dashboards care about.
	var members []teamMemberResp
	h.DoJSON(http.MethodGet, "/v1/teams/"+team.Slug+"/list_members",
		owner.AccessToken, nil, http.StatusOK, &members)
	var found *teamMemberResp
	for i := range members {
		if members[i].ID == invitee.ID {
			found = &members[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("invitee not in members list: %+v", members)
	}
	if found.Role != "member" {
		t.Errorf("invitee role=%q want member", found.Role)
	}
}

// TestInvites_Accept_InvalidToken locks the negative path operators hit
// when they share a stale or fabricated invite URL: any token that isn't
// in team_invites (or whose row has already been consumed) returns
// 404 invite_not_found. Same code on both sides matters so the dashboard
// can show a single "invite is invalid or already used" message.
func TestInvites_Accept_InvalidToken(t *testing.T) {
	h := Setup(t)
	invitee := h.RegisterRandomUser()

	env := h.AssertStatus(http.MethodPost, "/v1/team_invites/accept",
		invitee.AccessToken,
		map[string]string{"token": "totally-bogus-token-value"},
		http.StatusNotFound)
	if env.Code != "invite_not_found" {
		t.Errorf("code=%q want invite_not_found", env.Code)
	}

	// Empty-token is a separate, earlier validation branch — locked so
	// the handler can't quietly start treating "" as "look it up".
	env = h.AssertStatus(http.MethodPost, "/v1/team_invites/accept",
		invitee.AccessToken,
		map[string]string{"token": ""},
		http.StatusBadRequest)
	if env.Code != "missing_token" {
		t.Errorf("code=%q want missing_token", env.Code)
	}
}

// TestInvites_Accept_RequiresAuth: the accept endpoint is mounted under
// the Authenticator middleware (router.go), so a request without a Bearer
// header is rejected before the handler runs. The token in the body is
// NOT a substitute for identity — it only binds an invite to a team, not
// to a user. Locks that contract so the endpoint can't drift into an
// unauthenticated "self-service join" flow.
func TestInvites_Accept_RequiresAuth(t *testing.T) {
	h := Setup(t)
	env := h.AssertStatus(http.MethodPost, "/v1/team_invites/accept",
		"", // no bearer
		map[string]string{"token": "anything"},
		http.StatusUnauthorized)
	if env.Code != "missing_authorization" {
		t.Errorf("code=%q want missing_authorization", env.Code)
	}
}

// TestInvites_Accept_TokenIsSingleUse asserts the documented one-use
// semantics: after a successful accept, the invite's accepted_at is set
// and the same token can never be used again. The second call returns
// the same 404/invite_not_found a stranger would see, which is what
// the dashboard relies on to render a single "this link is no longer
// valid" state regardless of whether the user is already a member.
//
// (This is the "already_member" scenario from the assignment — the
// handler does not surface a distinct already_member code because the
// token is consumed before any membership-check could fire.)
func TestInvites_Accept_TokenIsSingleUse(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "OneShot Co")
	invitee := h.RegisterRandomUser()
	inv := issueInvite(t, h, owner.AccessToken, team.Slug, invitee.Email, "member")

	// First accept: 200.
	var first acceptInviteResp
	h.DoJSON(http.MethodPost, "/v1/team_invites/accept", invitee.AccessToken,
		map[string]string{"token": inv.InviteToken}, http.StatusOK, &first)

	// Second accept with the same token: 404, regardless of the fact
	// that the caller is already on the team.
	env := h.AssertStatus(http.MethodPost, "/v1/team_invites/accept",
		invitee.AccessToken,
		map[string]string{"token": inv.InviteToken},
		http.StatusNotFound)
	if env.Code != "invite_not_found" {
		t.Errorf("second-accept code=%q want invite_not_found", env.Code)
	}
}

// TestInvites_Accept_EmitsAudit confirms the handler records an
// audit.ActionAcceptInvite event on the success path. Auditing is the
// reason this endpoint is gated by Authenticator at all — without an
// actor, the event is meaningless — so this test guards the wiring
// between accept() and audit.Record.
//
// Audit writes happen after Commit but before the response, yet through
// a separate connection (audit.Record uses h.DB, not the tx). We poll
// briefly to match the pattern in audit_test.go and stay flake-free
// under parallel runs.
func TestInvites_Accept_EmitsAudit(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Audited Invite Co")
	invitee := h.RegisterRandomUser()
	inv := issueInvite(t, h, owner.AccessToken, team.Slug, invitee.Email, "member")

	h.DoJSON(http.MethodPost, "/v1/team_invites/accept", invitee.AccessToken,
		map[string]string{"token": inv.InviteToken}, http.StatusOK,
		&acceptInviteResp{})

	// Owner reads the team's audit log — accept event is keyed by team,
	// actor is the invitee.
	var got auditLogResp
	var accepted *auditEventResp
	deadline := time.Now().Add(2 * time.Second)
	for {
		got = auditLogResp{}
		h.DoJSON(http.MethodGet, "/v1/teams/"+team.Slug+"/audit_log",
			owner.AccessToken, nil, http.StatusOK, &got)
		for i := range got.Items {
			if got.Items[i].Action == "acceptInvite" {
				accepted = &got.Items[i]
				break
			}
		}
		if accepted != nil || time.Now().After(deadline) {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	if accepted == nil {
		t.Fatalf("expected acceptInvite audit event, got %+v", got.Items)
	}
	if accepted.ActorID != invitee.ID {
		t.Errorf("actorId=%q want %q (invitee)", accepted.ActorID, invitee.ID)
	}
	if accepted.TargetType != "team" || accepted.TargetID != team.ID {
		t.Errorf("target=%s/%s want team/%s",
			accepted.TargetType, accepted.TargetID, team.ID)
	}
	// Metadata carries the consumed inviteId + recorded role — the
	// audit reader (compliance) needs both to reconstruct who joined
	// under which invite.
	if role, _ := accepted.Metadata["role"].(string); role != "member" {
		t.Errorf("metadata.role=%v want member", accepted.Metadata["role"])
	}
	if iid, _ := accepted.Metadata["inviteId"].(string); iid != inv.InviteID {
		t.Errorf("metadata.inviteId=%v want %q", accepted.Metadata["inviteId"], inv.InviteID)
	}
}
