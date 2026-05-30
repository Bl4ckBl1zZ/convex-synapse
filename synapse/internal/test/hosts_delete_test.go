package synapsetest

import (
	"net/http"
	"testing"

	"github.com/Iann29/synapse/internal/audit"
	"github.com/Iann29/synapse/internal/models"
)

// Host removal — POST /v1/hosts/{hostID}/delete (investigate/host-removal).
//
// Contract under test:
//   - instance-admin only (whole /v1/hosts router uses requireInstanceAdmin)
//   - 404 host_not_found if id missing
//   - 409 cannot_remove_self_host if hosts.is_synapse_host = TRUE
//   - 409 host_has_deployments if any deployment status<>'deleted' on this host
//   - 409 host_has_pending_jobs if a provisioning_jobs row (pending|claimed)
//     belongs to a deployment on this host
//   - success: 200 {"id":...,"status":"deleted"}, soft-deleted deployments'
//     host_id reassigned to the self-host, row gone, audit deleteHost/host
//
// The harness's first registered user is the instance admin; subsequent
// registrations are plain users. Hosts are created via POST /v1/hosts
// (returns models.Host). Direct-DB inserts use h.DB + h.rootCtx like the
// other CCP tests (cells/agents/remote_setup).

// createHostViaAPI registers a non-self host through the public API and
// returns it. admin must be the instance-admin user.
func createHostViaAPI(t *testing.T, h *Harness, admin *User, name string) models.Host {
	t.Helper()
	var host models.Host
	h.DoJSON(http.MethodPost, "/v1/hosts", admin.AccessToken,
		map[string]any{"name": name}, http.StatusCreated, &host)
	if host.ID == "" {
		t.Fatalf("createHostViaAPI %q: empty id", name)
	}
	if host.IsSynapseHost {
		t.Fatalf("createHostViaAPI %q: should not be the synapse host", name)
	}
	return host
}

// selfHostID returns the implicit Synapse-control-plane host row's id.
// Migration 000026 self-seeds this row, so it always exists after migrate.
func selfHostID(t *testing.T, h *Harness) string {
	t.Helper()
	var id string
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT id FROM hosts WHERE is_synapse_host = TRUE LIMIT 1`).Scan(&id); err != nil {
		t.Fatalf("select self host: %v", err)
	}
	return id
}

// hostCount returns how many hosts rows carry the given id (0 or 1).
func hostCount(t *testing.T, h *Harness, id string) int {
	t.Helper()
	var n int
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT count(*) FROM hosts WHERE id = $1`, id).Scan(&n); err != nil {
		t.Fatalf("count host: %v", err)
	}
	return n
}

// seedDeploymentOnHost creates team+project+deployment directly, pinned to
// hostID with the given status, and returns the deployment id. SeedDeployment
// always targets the self-host, so for host-scoped guards we insert directly
// and re-point host_id. creatorUserID must be a real users.id (teams FK).
func seedDeploymentOnHost(t *testing.T, h *Harness, creatorUserID, hostID, status string) string {
	t.Helper()
	suffix := randHex(6)

	var teamID string
	if err := h.DB.QueryRow(h.rootCtx,
		`INSERT INTO teams (slug, name, creator_user_id) VALUES ($1, $2, $3) RETURNING id`,
		"team-"+suffix, "Team "+suffix, creatorUserID).Scan(&teamID); err != nil {
		t.Fatalf("insert team: %v", err)
	}
	var projectID string
	if err := h.DB.QueryRow(h.rootCtx,
		`INSERT INTO projects (team_id, name, slug) VALUES ($1, $2, $3) RETURNING id`,
		teamID, "Project "+suffix, "proj-"+suffix).Scan(&projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	// Reuse the harness seeder for the deployment (handles container_id /
	// instance_secret / replica invariant), then re-point its host_id.
	depID := h.SeedDeployment(projectID, "deploy-"+suffix, "dev", status, false, creatorUserID, 0, "")
	if _, err := h.DB.Exec(h.rootCtx,
		`UPDATE deployments SET host_id = $1 WHERE id = $2`, hostID, depID); err != nil {
		t.Fatalf("repoint deployment host_id: %v", err)
	}
	return depID
}

// 1. Happy path: a non-self host with no deployments can be deleted.
func TestDeleteHost_HappyPath(t *testing.T) {
	h := Setup(t)
	admin := h.RegisterRandomUser()
	host := createHostViaAPI(t, h, admin, "host-del-happy")

	var out struct {
		ID     string `json:"id"`
		Status string `json:"status"`
	}
	h.DoJSON(http.MethodPost, "/v1/hosts/"+host.ID+"/delete",
		admin.AccessToken, nil, http.StatusOK, &out)
	if out.ID != host.ID {
		t.Fatalf("response id: got %q want %q", out.ID, host.ID)
	}
	if out.Status != "deleted" {
		t.Fatalf("response status: got %q want deleted", out.Status)
	}

	// Gone via GET → 404.
	h.AssertStatus(http.MethodGet, "/v1/hosts/"+host.ID, admin.AccessToken, nil, http.StatusNotFound)

	// Gone via list (DisallowUnknownFields forces the full models.Host shape).
	var list hostsListResp
	h.DoJSON(http.MethodGet, "/v1/hosts", admin.AccessToken, nil, http.StatusOK, &list)
	for _, item := range list.Items {
		if item.ID == host.ID {
			t.Fatalf("deleted host %s still present in /v1/hosts list", host.ID)
		}
	}
	if hostCount(t, h, host.ID) != 0 {
		t.Fatalf("deleted host row still in DB")
	}
}

// 2. The implicit Synapse host cannot be deleted.
func TestDeleteHost_SelfHostForbidden(t *testing.T) {
	h := Setup(t)
	admin := h.RegisterRandomUser()
	selfID := selfHostID(t, h)

	env := h.AssertStatus(http.MethodPost, "/v1/hosts/"+selfID+"/delete",
		admin.AccessToken, nil, http.StatusConflict)
	if env.Code != "cannot_remove_self_host" {
		t.Fatalf("code: got %q want cannot_remove_self_host", env.Code)
	}
	if hostCount(t, h, selfID) != 1 {
		t.Fatalf("self host should still exist")
	}
}

// 3. A host with a live (status<>'deleted') deployment cannot be deleted.
func TestDeleteHost_WithLiveDeployment(t *testing.T) {
	h := Setup(t)
	admin := h.RegisterRandomUser()
	host := createHostViaAPI(t, h, admin, "host-del-live")
	seedDeploymentOnHost(t, h, admin.ID, host.ID, "running")

	env := h.AssertStatus(http.MethodPost, "/v1/hosts/"+host.ID+"/delete",
		admin.AccessToken, nil, http.StatusConflict)
	if env.Code != "host_has_deployments" {
		t.Fatalf("code: got %q want host_has_deployments", env.Code)
	}
	if hostCount(t, h, host.ID) != 1 {
		t.Fatalf("host should still exist after host_has_deployments")
	}
}

// 4. A host whose only deployment is status='deleted' but which has a pending
//    provisioning job is blocked by the pending-jobs guard. This isolates the
//    jobs guard: the deployments guard passes (deployment already deleted).
func TestDeleteHost_WithPendingJob(t *testing.T) {
	h := Setup(t)
	admin := h.RegisterRandomUser()
	host := createHostViaAPI(t, h, admin, "host-del-pending")
	depID := seedDeploymentOnHost(t, h, admin.ID, host.ID, "deleted")

	if _, err := h.DB.Exec(h.rootCtx,
		`INSERT INTO provisioning_jobs (deployment_id, kind, status) VALUES ($1, 'provision', 'pending')`,
		depID); err != nil {
		t.Fatalf("insert provisioning job: %v", err)
	}

	env := h.AssertStatus(http.MethodPost, "/v1/hosts/"+host.ID+"/delete",
		admin.AccessToken, nil, http.StatusConflict)
	if env.Code != "host_has_pending_jobs" {
		t.Fatalf("code: got %q want host_has_pending_jobs", env.Code)
	}
	if hostCount(t, h, host.ID) != 1 {
		t.Fatalf("host should still exist after host_has_pending_jobs")
	}
}

// 5. A non-instance-admin user is forbidden from the delete endpoint (the
//    whole /v1/hosts router is gated by requireInstanceAdmin).
func TestDeleteHost_ForbiddenForNonAdmin(t *testing.T) {
	h := Setup(t)
	admin := h.RegisterRandomUser()    // first user = instance admin
	stranger := h.RegisterRandomUser() // second user = NOT instance admin
	if stranger.IsInstanceAdmin {
		t.Fatalf("second registered user should not be instance admin")
	}
	host := createHostViaAPI(t, h, admin, "host-del-403")

	h.AssertStatus(http.MethodPost, "/v1/hosts/"+host.ID+"/delete",
		stranger.AccessToken, nil, http.StatusForbidden)

	// The request never reached the handler → host still exists.
	if hostCount(t, h, host.ID) != 1 {
		t.Fatalf("host should still exist after 403")
	}
}

// 6. A nonexistent (well-formed UUID) host id returns 404 host_not_found.
func TestDeleteHost_NotFound(t *testing.T) {
	h := Setup(t)
	admin := h.RegisterRandomUser()

	missing := "00000000-0000-0000-0000-000000000000"
	env := h.AssertStatus(http.MethodPost, "/v1/hosts/"+missing+"/delete",
		admin.AccessToken, nil, http.StatusNotFound)
	if env.Code != "host_not_found" {
		t.Fatalf("code: got %q want host_not_found", env.Code)
	}
}

// 7. A successful delete writes exactly one audit_events row
//    (action=deleteHost, target_type=host) for that host id.
func TestDeleteHost_WritesAuditEvent(t *testing.T) {
	h := Setup(t)
	admin := h.RegisterRandomUser()
	host := createHostViaAPI(t, h, admin, "host-del-audit")

	h.AssertStatus(http.MethodPost, "/v1/hosts/"+host.ID+"/delete",
		admin.AccessToken, nil, http.StatusOK)

	// assertAuditEvent (cells_test.go) polls for >=1; tighten to exactly 1.
	assertAuditEvent(t, h, audit.ActionDeleteHost, admin.ID, audit.TargetHost, host.ID)

	var n int
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT count(*) FROM audit_events
		  WHERE action = $1 AND target_type = $2 AND target_id::text = $3`,
		audit.ActionDeleteHost, audit.TargetHost, host.ID).Scan(&n); err != nil {
		t.Fatalf("count audit events: %v", err)
	}
	if n != 1 {
		t.Fatalf("expected exactly 1 deleteHost/host audit event, got %d", n)
	}
}

// 8. host_agents rows for the deleted host are cascaded away (FK ON DELETE
//    CASCADE on host_agents.host_id).
func TestDeleteHost_CascadesHostAgents(t *testing.T) {
	h := Setup(t)
	admin := h.RegisterRandomUser()
	host := createHostViaAPI(t, h, admin, "host-del-cascade")

	if _, err := h.DB.Exec(h.rootCtx,
		`INSERT INTO host_agents (host_id, token_hash) VALUES ($1, $2)`,
		host.ID, "agent-hash-"+randHex(8)); err != nil {
		t.Fatalf("insert host agent: %v", err)
	}
	var before int
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT count(*) FROM host_agents WHERE host_id = $1`, host.ID).Scan(&before); err != nil {
		t.Fatalf("count host agents before: %v", err)
	}
	if before != 1 {
		t.Fatalf("expected 1 host agent before delete, got %d", before)
	}

	h.AssertStatus(http.MethodPost, "/v1/hosts/"+host.ID+"/delete",
		admin.AccessToken, nil, http.StatusOK)

	var after int
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT count(*) FROM host_agents WHERE host_id = $1`, host.ID).Scan(&after); err != nil {
		t.Fatalf("count host agents after: %v", err)
	}
	if after != 0 {
		t.Fatalf("expected host_agents to cascade away, got %d remaining", after)
	}
}
