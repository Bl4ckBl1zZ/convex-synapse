package synapsetest

import (
	"net/http"
	"testing"
)

// updateAdoptedFixture adopts a fake backend into a fresh team/project and
// returns everything the update_adopted tests poke at.
type updateAdoptedFixture struct {
	owner   *User
	projID  string
	backend *fakeConvexBackend
	name    string
	id      string
}

func newUpdateAdoptedFixture(t *testing.T, h *Harness, suffix, adminKey string) updateAdoptedFixture {
	t.Helper()
	owner := h.RegisterRandomUser()
	_, projID := projectFor(t, h, owner, "UpdAdoptCo"+suffix, "App"+suffix)
	backend := newFakeConvexBackend(t, adminKey)

	var d deploymentJSON
	h.DoJSON(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", owner.AccessToken,
		map[string]any{"deploymentUrl": backend.server.URL, "adminKey": adminKey},
		http.StatusCreated, &d)
	return updateAdoptedFixture{owner: owner, projID: projID, backend: backend, name: d.Name, id: d.ID}
}

// rowURLKeyStatus reads the columns update_adopted writes, straight from
// the DB — the response shape is asserted separately.
func rowURLKeyStatus(t *testing.T, h *Harness, id string) (url, key, status string) {
	t.Helper()
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT COALESCE(deployment_url, ''), admin_key, status FROM deployments WHERE id = $1`, id,
	).Scan(&url, &key, &status); err != nil {
		t.Fatalf("read row: %v", err)
	}
	return url, key, status
}

// TestUpdateAdopted_KeyRotation is the headline use case: the admin key
// rotated on the source side; the operator updates it in place and the
// name (and everything referencing it) survives.
func TestUpdateAdopted_KeyRotation(t *testing.T) {
	h := Setup(t)
	f := newUpdateAdoptedFixture(t, h, "1", "old-key-1")

	// Source side rotates the key — the stored one is now wrong.
	f.backend.setKey("new-key-1")

	var d deploymentJSON
	h.DoJSON(http.MethodPost, "/v1/deployments/"+f.name+"/update_adopted", f.owner.AccessToken,
		map[string]any{"adminKey": "new-key-1"},
		http.StatusOK, &d)
	if d.Name != f.name {
		t.Errorf("name changed across update: %q → %q", f.name, d.Name)
	}
	if !d.Adopted {
		t.Errorf("adopted flag lost across update")
	}

	gotURL, gotKey, gotStatus := rowURLKeyStatus(t, h, f.id)
	if gotKey != "new-key-1" {
		t.Errorf("admin_key: got %q want new-key-1", gotKey)
	}
	if gotURL != f.backend.server.URL {
		t.Errorf("deployment_url changed unexpectedly: %q", gotURL)
	}
	if gotStatus != "running" {
		t.Errorf("status: got %q want running", gotStatus)
	}

	// The audit trail records the update (and which fields changed).
	var audits int
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT count(*) FROM audit_events WHERE action = 'updateAdoptedDeployment'`,
	).Scan(&audits); err != nil {
		t.Fatalf("count audits: %v", err)
	}
	if audits != 1 {
		t.Errorf("audit events: got %d want 1", audits)
	}
}

// TestUpdateAdopted_NewURL re-points the row at a different backend
// (same key) — the "backend moved hosts" case.
func TestUpdateAdopted_NewURL(t *testing.T) {
	h := Setup(t)
	f := newUpdateAdoptedFixture(t, h, "2", "key-2")

	second := newFakeConvexBackend(t, "key-2")
	var d deploymentJSON
	h.DoJSON(http.MethodPost, "/v1/deployments/"+f.name+"/update_adopted", f.owner.AccessToken,
		map[string]any{"deploymentUrl": second.server.URL},
		http.StatusOK, &d)
	if d.DeploymentURL != second.server.URL {
		t.Errorf("response url: got %q want %q", d.DeploymentURL, second.server.URL)
	}

	gotURL, gotKey, _ := rowURLKeyStatus(t, h, f.id)
	if gotURL != second.server.URL {
		t.Errorf("deployment_url: got %q want %q", gotURL, second.server.URL)
	}
	if gotKey != "key-2" {
		t.Errorf("admin_key changed unexpectedly: %q", gotKey)
	}
}

// TestUpdateAdopted_WrongKeyRejected: a failing probe writes nothing.
func TestUpdateAdopted_WrongKeyRejected(t *testing.T) {
	h := Setup(t)
	f := newUpdateAdoptedFixture(t, h, "3", "key-3")

	env := h.AssertStatus(http.MethodPost, "/v1/deployments/"+f.name+"/update_adopted",
		f.owner.AccessToken, map[string]any{"adminKey": "wrong"}, http.StatusBadRequest)
	if env.Code != "invalid_admin_key" {
		t.Errorf("expected invalid_admin_key, got %q", env.Code)
	}

	_, gotKey, _ := rowURLKeyStatus(t, h, f.id)
	if gotKey != "key-3" {
		t.Errorf("admin_key mutated by a failed update: %q", gotKey)
	}
}

// TestUpdateAdopted_UnreachableURLRejected: same, for the URL leg.
func TestUpdateAdopted_UnreachableURLRejected(t *testing.T) {
	h := Setup(t)
	f := newUpdateAdoptedFixture(t, h, "4", "key-4")

	env := h.AssertStatus(http.MethodPost, "/v1/deployments/"+f.name+"/update_adopted",
		f.owner.AccessToken,
		map[string]any{"deploymentUrl": "http://127.0.0.1:1"}, // nothing listens on port 1
		http.StatusBadGateway)
	if env.Code != "probe_failed" {
		t.Errorf("expected probe_failed, got %q", env.Code)
	}

	gotURL, _, _ := rowURLKeyStatus(t, h, f.id)
	if gotURL != f.backend.server.URL {
		t.Errorf("deployment_url mutated by a failed update: %q", gotURL)
	}
}

// TestUpdateAdopted_NotAdopted: managed deployments 409 — they own their
// URL/key lifecycle (reissue_admin_key, domains, etc).
func TestUpdateAdopted_NotAdopted(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "UpdAdopt Managed")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	h.SeedDeployment(proj.ID, "upd-managed-1", "dev", "running", false, owner.ID, 4601, "k")

	env := h.AssertStatus(http.MethodPost, "/v1/deployments/upd-managed-1/update_adopted",
		owner.AccessToken, map[string]any{"adminKey": "x"}, http.StatusConflict)
	if env.Code != "not_adopted" {
		t.Errorf("expected not_adopted, got %q", env.Code)
	}
}

// TestUpdateAdopted_MissingFields: an empty body has nothing to update.
func TestUpdateAdopted_MissingFields(t *testing.T) {
	h := Setup(t)
	f := newUpdateAdoptedFixture(t, h, "5", "key-5")

	env := h.AssertStatus(http.MethodPost, "/v1/deployments/"+f.name+"/update_adopted",
		f.owner.AccessToken, map[string]any{}, http.StatusBadRequest)
	if env.Code != "missing_fields" {
		t.Errorf("expected missing_fields, got %q", env.Code)
	}
}

// TestUpdateAdopted_MemberForbidden: project members (non-admin) can't
// re-point credentials.
func TestUpdateAdopted_MemberForbidden(t *testing.T) {
	h := Setup(t)
	f := newUpdateAdoptedFixture(t, h, "6", "key-6")

	member := h.RegisterRandomUser()
	var teamID string
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT p.team_id FROM projects p WHERE p.id::text = $1`, f.projID,
	).Scan(&teamID); err != nil {
		t.Fatalf("team lookup: %v", err)
	}
	if _, err := h.DB.Exec(h.rootCtx,
		`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
		teamID, member.ID); err != nil {
		t.Fatalf("seed member: %v", err)
	}

	env := h.AssertStatus(http.MethodPost, "/v1/deployments/"+f.name+"/update_adopted",
		member.AccessToken, map[string]any{"adminKey": "key-6"}, http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Errorf("expected forbidden, got %q", env.Code)
	}
}

// TestUpdateAdopted_RecoversStoppedStatus: a successful probe is fresh
// proof of life — a row the health sweep had marked 'stopped' comes back
// 'running' without waiting for the next sweep.
func TestUpdateAdopted_RecoversStoppedStatus(t *testing.T) {
	h := Setup(t)
	f := newUpdateAdoptedFixture(t, h, "7", "key-7")

	if _, err := h.DB.Exec(h.rootCtx,
		`UPDATE deployments SET status = 'stopped' WHERE id = $1`, f.id); err != nil {
		t.Fatalf("force stopped: %v", err)
	}

	var d deploymentJSON
	h.DoJSON(http.MethodPost, "/v1/deployments/"+f.name+"/update_adopted", f.owner.AccessToken,
		map[string]any{"deploymentUrl": f.backend.server.URL},
		http.StatusOK, &d)
	if d.Status != "running" {
		t.Errorf("response status: got %q want running", d.Status)
	}
	_, _, gotStatus := rowURLKeyStatus(t, h, f.id)
	if gotStatus != "running" {
		t.Errorf("db status: got %q want running", gotStatus)
	}
}
