package synapsetest

import (
	"net/http"
	"testing"
)

// reissueResp mirrors the JSON shape of reissueAdminKeyResp. Decoded
// strictly so any payload drift surfaces here instead of breaking the
// dashboard at runtime.
type reissueResp struct {
	DeploymentName string `json:"deploymentName"`
	AdminKey       string `json:"adminKey"`
	Prefix         string `json:"prefix"`
}

func TestReissueAdminKey_HappyPath_RotatesKeyButNotSecret(t *testing.T) {
	h := Setup(t)
	uniqueAdminKeyDocker("re-otter-1111")(h.Docker)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Reissue Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	deploymentID := h.SeedDeployment(proj.ID, "re-otter-1111", "prod", "running", true, owner.ID, 3501, "")

	var oldSecret, oldAdminKey string
	if err := h.DB.QueryRow(h.rootCtx, `
		SELECT instance_secret, admin_key FROM deployments WHERE id = $1
	`, deploymentID).Scan(&oldSecret, &oldAdminKey); err != nil {
		t.Fatalf("read pre-reissue credentials: %v", err)
	}

	var got reissueResp
	h.DoJSON(http.MethodPost, "/v1/deployments/re-otter-1111/reissue_admin_key",
		owner.AccessToken, map[string]any{}, http.StatusOK, &got)

	if got.DeploymentName != "re-otter-1111" {
		t.Errorf("deploymentName: got %q want re-otter-1111", got.DeploymentName)
	}
	if got.AdminKey == "" {
		t.Fatalf("adminKey: empty")
	}
	if got.AdminKey == oldAdminKey {
		t.Fatalf("adminKey did not rotate: got same as old %q", oldAdminKey)
	}
	if got.Prefix == "" {
		t.Errorf("prefix: empty")
	}

	// INSTANCE_SECRET MUST stay the same — that's the whole contract.
	// admin_key in the DB MUST be the freshly minted one.
	var newSecret, newAdminKey string
	if err := h.DB.QueryRow(h.rootCtx, `
		SELECT instance_secret, admin_key FROM deployments WHERE id = $1
	`, deploymentID).Scan(&newSecret, &newAdminKey); err != nil {
		t.Fatalf("read post-reissue credentials: %v", err)
	}
	if newSecret != oldSecret {
		t.Fatalf("instance_secret rotated unexpectedly: old=%q new=%q", oldSecret, newSecret)
	}
	if newAdminKey != got.AdminKey {
		t.Fatalf("db admin_key %q != response %q", newAdminKey, got.AdminKey)
	}

	// The Convex backend container is NOT recreated — reissue is a
	// signature-only refresh; the backend already accepts any key signed
	// by the current INSTANCE_SECRET.
	if specs := h.Docker.RecreatedSpecs(); len(specs) != 0 {
		t.Fatalf("expected no container recreate, got %d specs", len(specs))
	}
}

func TestReissueAdminKey_AdoptedDeployment_Refused(t *testing.T) {
	h := Setup(t)
	uniqueAdminKeyDocker("re-adopted")(h.Docker)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Reissue Adopted")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	deploymentID := h.SeedDeployment(proj.ID, "re-adopted", "prod", "running", true, owner.ID, 3502, "")
	if _, err := h.DB.Exec(h.rootCtx, `UPDATE deployments SET adopted = true WHERE id = $1`, deploymentID); err != nil {
		t.Fatalf("mark adopted: %v", err)
	}

	// 409 since v1.27 — consistent with every other adopted refusal.
	env := h.AssertStatus(http.MethodPost, "/v1/deployments/re-adopted/reissue_admin_key",
		owner.AccessToken, map[string]any{}, http.StatusConflict)
	if env.Code != "cannot_reissue_adopted" {
		t.Fatalf("code: got %q want cannot_reissue_adopted", env.Code)
	}
}

func TestReissueAdminKey_RequiresProjectAdmin(t *testing.T) {
	h := Setup(t)
	uniqueAdminKeyDocker("re-rbac")(h.Docker)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Reissue RBAC")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	h.SeedDeployment(proj.ID, "re-rbac", "prod", "running", true, owner.ID, 3503, "")

	// Add a second user as a regular team member, then narrow their
	// project role to 'viewer'. Reissue must refuse since viewers
	// can't admin the project (deploy keys, env vars, and deployment
	// credentials all share that gate).
	stranger := h.RegisterRandomUser()
	if _, err := h.DB.Exec(h.rootCtx,
		`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
		team.ID, stranger.ID,
	); err != nil {
		t.Fatalf("seed team_members: %v", err)
	}
	if _, err := h.DB.Exec(h.rootCtx, `
		INSERT INTO project_members (project_id, user_id, role)
		VALUES ($1, $2, 'viewer')
		ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role
	`, proj.ID, stranger.ID); err != nil {
		t.Fatalf("set project_members.viewer: %v", err)
	}

	env := h.AssertStatus(http.MethodPost, "/v1/deployments/re-rbac/reissue_admin_key",
		stranger.AccessToken, map[string]any{}, http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Fatalf("code: got %q want forbidden", env.Code)
	}
}

func TestReissueAdminKey_AuditRowWritten(t *testing.T) {
	h := Setup(t)
	uniqueAdminKeyDocker("re-audit")(h.Docker)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Reissue Audit")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	deploymentID := h.SeedDeployment(proj.ID, "re-audit", "prod", "running", true, owner.ID, 3504, "")

	h.AssertStatus(http.MethodPost, "/v1/deployments/re-audit/reissue_admin_key",
		owner.AccessToken, map[string]any{}, http.StatusOK)

	var action, targetType, targetID string
	if err := h.DB.QueryRow(h.rootCtx, `
		SELECT action, target_type, target_id::text
		  FROM audit_events
		 WHERE team_id = $1 AND action = 'reissueAdminKey'
		 ORDER BY id DESC LIMIT 1
	`, team.ID).Scan(&action, &targetType, &targetID); err != nil {
		t.Fatalf("read audit row: %v", err)
	}
	if action != "reissueAdminKey" {
		t.Errorf("action: %q", action)
	}
	if targetType != "deployment" {
		t.Errorf("targetType: %q", targetType)
	}
	if targetID != deploymentID {
		t.Errorf("targetID: got %q want %q", targetID, deploymentID)
	}
}

func TestReissueAdminKey_PreservesFreshKeyAcrossCalls(t *testing.T) {
	h := Setup(t)
	uniqueAdminKeyDocker("re-multi")(h.Docker)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Reissue Multi")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	h.SeedDeployment(proj.ID, "re-multi", "prod", "running", true, owner.ID, 3505, "")

	var a, b reissueResp
	h.DoJSON(http.MethodPost, "/v1/deployments/re-multi/reissue_admin_key",
		owner.AccessToken, map[string]any{}, http.StatusOK, &a)
	h.DoJSON(http.MethodPost, "/v1/deployments/re-multi/reissue_admin_key",
		owner.AccessToken, map[string]any{}, http.StatusOK, &b)

	if a.AdminKey == b.AdminKey {
		t.Fatalf("two reissues returned the same key: %q", a.AdminKey)
	}
}
