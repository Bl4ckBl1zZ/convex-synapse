package synapsetest

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/Iann29/synapse/internal/models"
)

// Bloco 9b — Drift Engine + dry-run planner. The engine COMPARES DesiredState
// against ObservedState and CLASSIFIES the divergence; the planner turns each
// classification into a *planned* step. Nothing applies — these tests assert
// that too (FakeDocker stays untouched, desired/observed unchanged).

// ---------- response shapes (reuse the real models for strict decoding) ----------

type driftResult struct {
	Report *models.DriftReport `json:"report"`
	Items  []models.DriftItem  `json:"items"`
}

type planStepLike struct {
	Action       string `json:"action"`
	ResourceType string `json:"resourceType"`
	ResourceKey  string `json:"resourceKey"`
	Status       string `json:"status"`
	Reason       string `json:"reason,omitempty"`
	WillApply    bool   `json:"willApply"`
}

type dryRunResult struct {
	OperationRun models.OperationRun `json:"operationRun"`
	Steps        []planStepLike      `json:"steps"`
}

// ---------- seeding helpers ----------

// seedObservedContainer inserts a docker_container observed_states row directly
// (simulating what an agent would have reported). depID empty → an unmanaged
// container with no synapse.deployment_id label.
func seedObservedContainer(t *testing.T, h *Harness, hostID, depID, cellID, projectID, state string) {
	t.Helper()
	labels := map[string]string{"synapse.managed": "true"}
	if depID != "" {
		labels["synapse.deployment_id"] = depID
	}
	if cellID != "" {
		labels["synapse.cell_id"] = cellID
	}
	if projectID != "" {
		labels["synapse.project_id"] = projectID
	}
	key := depID
	if key == "" {
		key = "anon-" + randHex(4)
	}
	observed := map[string]any{
		"id": "c" + randHex(6), "name": "convex-" + key,
		"image": "ghcr.io/get-convex/convex-backend", "state": state, "status": "Up 2 minutes",
		"labels": labels, "ports": "3210/tcp", "createdAt": "2026-01-01T00:00:00Z",
	}
	raw, _ := json.Marshal(observed)
	var resID any
	if depID != "" {
		resID = depID
	}
	if _, err := h.DB.Exec(h.rootCtx, `
		INSERT INTO observed_states (host_id, resource_type, resource_id, resource_key, observed_json, observed_hash, source)
		VALUES ($1, 'docker_container', $2, $3, $4, $5, 'agent')
	`, hostID, resID, "docker_container:"+key, raw, "hash-"+randHex(6)); err != nil {
		t.Fatalf("seed observed container: %v", err)
	}
}

// setHeartbeatAgo backdates the host's last_heartbeat_at so its computed
// effectiveStatus is online (≤60s) / stale (≤300s) / offline (>300s).
func setHeartbeatAgo(t *testing.T, h *Harness, hostID string, secsAgo int) {
	t.Helper()
	if _, err := h.DB.Exec(h.rootCtx,
		`UPDATE hosts SET last_heartbeat_at = now() - make_interval(secs => $2), status = 'online' WHERE id::text = $1`,
		hostID, secsAgo); err != nil {
		t.Fatalf("set heartbeat: %v", err)
	}
}

func trustHost(t *testing.T, h *Harness, hostID string)   { setHeartbeatAgo(t, h, hostID, 1) }
func offlineHost(t *testing.T, h *Harness, hostID string) { setHeartbeatAgo(t, h, hostID, 600) }

func setPlacementDesired(t *testing.T, h *Harness, depID, status string) {
	t.Helper()
	if _, err := h.DB.Exec(h.rootCtx,
		`UPDATE deployment_placements SET desired_status = $2 WHERE deployment_id::text = $1`, depID, status); err != nil {
		t.Fatalf("set placement desired_status: %v", err)
	}
}

func syncDrift(t *testing.T, h *Harness, bearer, projectID string) {
	t.Helper()
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/desired_state/sync_from_placements",
		bearer, map[string]any{}, http.StatusOK, &syncResult{})
}

func recomputeDrift(t *testing.T, h *Harness, bearer, scopePath string) driftResult {
	t.Helper()
	var res driftResult
	h.DoJSON(http.MethodPost, scopePath+"/drift/recompute", bearer, map[string]any{}, http.StatusOK, &res)
	return res
}

func findDriftItem(items []models.DriftItem, status string) *models.DriftItem {
	for i := range items {
		if items[i].DriftStatus == status {
			return &items[i]
		}
	}
	return nil
}

func summaryCount(t *testing.T, m map[string]any, key string) int {
	t.Helper()
	v, ok := m[key]
	if !ok {
		t.Fatalf("summary missing key %q (have %+v)", key, m)
	}
	f, ok := v.(float64)
	if !ok {
		t.Fatalf("summary[%q] is %T, want number", key, v)
	}
	return int(f)
}

func markDeploymentDeleted(t *testing.T, h *Harness, depID string) {
	t.Helper()
	if _, err := h.DB.Exec(h.rootCtx, `UPDATE deployments SET status = 'deleted' WHERE id::text = $1`, depID); err != nil {
		t.Fatalf("mark deployment deleted: %v", err)
	}
}

func countRowsArg(t *testing.T, h *Harness, query, arg string) int {
	t.Helper()
	var n int
	if err := h.DB.QueryRow(h.rootCtx, query, arg).Scan(&n); err != nil {
		t.Fatalf("count query %q: %v", query, err)
	}
	return n
}

// Bloco 14: a soft-deleted deployment (status='deleted') with a lingering
// active desired state must read as ORPHANED — never missing→create. Pre-fix
// the existence check ignored status, so the engine thought it still existed
// and recommended recreating a deployment the operator intentionally deleted.
func TestDrift_SoftDeletedIsOrphaned(t *testing.T) {
	h := Setup(t)
	owner, projectID, _, hostID, depID := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID)
	markDeploymentDeleted(t, h, depID)

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/hosts/"+hostID)
	if it := findDriftItem(res.Items, models.DriftStatusMissing); it != nil {
		t.Fatalf("soft-deleted deployment must NOT be missing→create, got %+v", it)
	}
	if it := findDriftItem(res.Items, models.DriftStatusOrphaned); it == nil {
		t.Fatalf("expected orphaned for soft-deleted deployment, items=%+v", res.Items)
	}
}

// Bloco 14: deleting a deployment must clean up its Cell Control Plane
// footprint — supersede the desired state, drop the placement, unlink the
// cell_resource — so it stops appearing as a ghost in cells / topology / drift.
func TestDeleteDeployment_CleansCellState(t *testing.T) {
	h := Setup(t)
	owner, projectID, cellID, _, depID := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID) // desired + placement now exist
	// Simulate the backfill pointing the cell's primary_deployment_id at the dep.
	if _, err := h.DB.Exec(h.rootCtx, `UPDATE cells SET primary_deployment_id = $1 WHERE id::text = $2`, depID, cellID); err != nil {
		t.Fatalf("set primary_deployment_id: %v", err)
	}

	if n := countRowsArg(t, h, `SELECT count(*) FROM desired_states WHERE resource_id = $1 AND status = 'active'`, depID); n != 1 {
		t.Fatalf("precondition: expected 1 active desired state, got %d", n)
	}

	h.DoJSON(http.MethodPost, "/v1/deployments/lush-heron-4656/delete", owner.AccessToken, map[string]any{}, http.StatusOK, &map[string]string{})

	if n := countRowsArg(t, h, `SELECT count(*) FROM desired_states WHERE resource_id = $1 AND status = 'active'`, depID); n != 0 {
		t.Errorf("desired_state should be superseded after delete, %d still active", n)
	}
	if n := countRowsArg(t, h, `SELECT count(*) FROM deployment_placements WHERE deployment_id::text = $1`, depID); n != 0 {
		t.Errorf("placement should be gone after delete, %d remain", n)
	}
	if n := countRowsArg(t, h, `SELECT count(*) FROM cell_resources WHERE resource_id = $1`, depID); n != 0 {
		t.Errorf("cell_resource should be gone after delete, %d remain", n)
	}
	if n := countRowsArg(t, h, `SELECT count(*) FROM cells WHERE primary_deployment_id::text = $1`, depID); n != 0 {
		t.Errorf("cell primary_deployment_id should be cleared after delete, %d remain", n)
	}
}

// Bloco 14.1: the synapse self-host runs the control plane, so it must read
// online regardless of a stale/absent agent heartbeat — otherwise the box
// serving the panel shows "offline" while you're browsing it. (Liveness only;
// drift trust still requires a real scan, asserted elsewhere.)
func TestHost_SelfHostOnlineDespiteStaleHeartbeat(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	var host models.Host
	h.DoJSON(http.MethodPost, "/v1/hosts", owner.AccessToken, map[string]any{"name": "self", "region": "local"}, http.StatusCreated, &host)
	// mark it the self-host with a long-stale heartbeat (would be offline otherwise)
	// Bloco 14.1 / Phase 4: migration 000026 self-seeds the is_synapse_host
	// row, so there might already BE a self-host. Use UPDATE on the row we
	// just created via /v1/hosts (which is NOT the self-host) AND clear the
	// flag on any pre-existing self-host first to satisfy the
	// hosts_one_synapse_host_idx partial unique index.
	if _, err := h.DB.Exec(h.rootCtx, `UPDATE hosts SET is_synapse_host = false WHERE is_synapse_host = true AND id::text <> $1`, host.ID); err != nil {
		t.Fatalf("clear pre-existing self-host: %v", err)
	}
	if _, err := h.DB.Exec(h.rootCtx, `UPDATE hosts SET is_synapse_host = true, last_heartbeat_at = now() - make_interval(hours => 17) WHERE id::text = $1`, host.ID); err != nil {
		t.Fatalf("mark self-host: %v", err)
	}
	var list struct {
		Items []models.Host `json:"items"`
	}
	h.DoJSON(http.MethodGet, "/v1/hosts", owner.AccessToken, nil, http.StatusOK, &list)
	var got *models.Host
	for i := range list.Items {
		if list.Items[i].ID == host.ID {
			got = &list.Items[i]
		}
	}
	if got == nil {
		t.Fatalf("self-host not returned in /v1/hosts")
	}
	if got.EffectiveStatus != models.HostStatusOnline {
		t.Errorf("self-host with 17h-stale heartbeat must read online, got %q", got.EffectiveStatus)
	}
}

// ---------- A. in_sync ----------

func TestDrift_CleanInSync(t *testing.T) {
	h := Setup(t)
	owner, projectID, cellID, hostID, depID := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID)
	seedObservedContainer(t, h, hostID, depID, cellID, projectID, "running")

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/hosts/"+hostID)
	if res.Report == nil || res.Report.Status != models.DriftReportStatusClean {
		t.Fatalf("expected clean report, got %+v", res.Report)
	}
	it := findDriftItem(res.Items, models.DriftStatusInSync)
	if it == nil || it.Severity != models.SeverityInfo || it.RecommendedAction != models.RecommendedActionNone {
		t.Fatalf("expected in_sync/info/none, got %+v", res.Items)
	}
	if it.ResourceKey != "convex_deployment:"+depID {
		t.Errorf("resourceKey = %q", it.ResourceKey)
	}
	if summaryCount(t, res.Report.Summary, "inSync") != 1 {
		t.Errorf("summary inSync != 1: %+v", res.Report.Summary)
	}
}

// ---------- B. missing ----------

func TestDrift_MissingContainer(t *testing.T) {
	h := Setup(t)
	owner, projectID, _, hostID, depID := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID) // online — so absence is real, not "unreachable"
	// no observed container seeded.

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/hosts/"+hostID)
	it := findDriftItem(res.Items, models.DriftStatusMissing)
	if it == nil {
		t.Fatalf("expected a missing item, got %+v", res.Items)
	}
	if it.Severity != models.SeverityCritical || it.RecommendedAction != models.RecommendedActionCreate {
		t.Errorf("missing should be critical/create, got %s/%s", it.Severity, it.RecommendedAction)
	}
	if it.ResourceKey != "convex_deployment:"+depID {
		t.Errorf("resourceKey = %q", it.ResourceKey)
	}
	if res.Report.Status != models.DriftReportStatusDrifted {
		t.Errorf("report status = %q, want drifted", res.Report.Status)
	}
}

// ---------- C. desired running, observed exited ----------

func TestDrift_RunningButExited(t *testing.T) {
	h := Setup(t)
	owner, projectID, cellID, hostID, depID := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID)
	seedObservedContainer(t, h, hostID, depID, cellID, projectID, "exited")

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/hosts/"+hostID)
	it := findDriftItem(res.Items, models.DriftStatusDrifted)
	if it == nil || it.RecommendedAction != models.RecommendedActionRestart || it.Severity != models.SeverityCritical {
		t.Fatalf("expected drifted/critical/restart, got %+v", res.Items)
	}
}

// ---------- D. desired stopped, observed running ----------

func TestDrift_StoppedButRunning(t *testing.T) {
	h := Setup(t)
	owner, projectID, cellID, hostID, depID := desiredFixture(t, h)
	setPlacementDesired(t, h, depID, models.PlacementDesiredStopped)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID)
	seedObservedContainer(t, h, hostID, depID, cellID, projectID, "running")

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/hosts/"+hostID)
	it := findDriftItem(res.Items, models.DriftStatusDrifted)
	if it == nil || it.RecommendedAction != models.RecommendedActionStop || it.Severity != models.SeverityWarning {
		t.Fatalf("expected drifted/warning/stop, got %+v", res.Items)
	}
}

// ---------- E. desired absent, observed exists ----------

func TestDrift_AbsentButExists(t *testing.T) {
	h := Setup(t)
	owner, projectID, cellID, hostID, depID := desiredFixture(t, h)
	setPlacementDesired(t, h, depID, models.PlacementDesiredAbsent)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID)
	seedObservedContainer(t, h, hostID, depID, cellID, projectID, "running")

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/hosts/"+hostID)
	it := findDriftItem(res.Items, models.DriftStatusDrifted)
	if it == nil || it.RecommendedAction != models.RecommendedActionRemove {
		t.Fatalf("expected drifted/remove, got %+v", res.Items)
	}
}

// ---------- F. unmanaged ----------

func TestDrift_UnmanagedContainer(t *testing.T) {
	h := Setup(t)
	owner, _, cellID, hostID, _ := desiredFixture(t, h)
	trustHost(t, h, hostID)
	// No sync → no active desired. A synapse-managed container with a
	// deployment id that has no desired state → unmanaged.
	seedObservedContainer(t, h, hostID, "ghost-dep-"+randHex(4), cellID, "", "running")

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/hosts/"+hostID)
	it := findDriftItem(res.Items, models.DriftStatusUnmanaged)
	if it == nil || it.RecommendedAction != models.RecommendedActionInvestigate || it.Severity != models.SeverityWarning {
		t.Fatalf("expected unmanaged/warning/investigate, got %+v", res.Items)
	}
	// v0 policy: never recommend remove for unmanaged.
	if it.RecommendedAction == models.RecommendedActionRemove {
		t.Errorf("unmanaged must not recommend remove in v0")
	}
}

// ---------- G. host offline → host_unreachable, NOT missing ----------

func TestDrift_HostOfflineNotMissing(t *testing.T) {
	h := Setup(t)
	owner, projectID, _, hostID, _ := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	offlineHost(t, h, hostID) // heartbeat 10 min ago → offline
	// no observed — but because the host is offline we can't trust that.

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/hosts/"+hostID)
	if findDriftItem(res.Items, models.DriftStatusMissing) != nil {
		t.Fatalf("offline host must NOT produce a misleading 'missing' — %+v", res.Items)
	}
	it := findDriftItem(res.Items, models.DriftStatusHostUnreachable)
	if it == nil || it.RecommendedAction != models.RecommendedActionInvestigate {
		t.Fatalf("expected host_unreachable/investigate, got %+v", res.Items)
	}
	if it.Severity != models.SeverityCritical { // offline → critical
		t.Errorf("offline host_unreachable should be critical, got %s", it.Severity)
	}
}

// ---------- H. label mismatch ----------

func TestDrift_LabelMismatch(t *testing.T) {
	h := Setup(t)
	owner, projectID, _, hostID, depID := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID)
	// Same deployment id, but the container claims a different cell.
	seedObservedContainer(t, h, hostID, depID, "00000000-0000-0000-0000-000000000999", projectID, "running")

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/hosts/"+hostID)
	it := findDriftItem(res.Items, models.DriftStatusDrifted)
	if it == nil || it.Severity != models.SeverityCritical || it.RecommendedAction != models.RecommendedActionInvestigate {
		t.Fatalf("expected drifted/critical/investigate for label mismatch, got %+v", res.Items)
	}
	if _, ok := it.Diff["labelMismatch"]; !ok {
		t.Errorf("diff should carry labelMismatch: %+v", it.Diff)
	}
}

// ---------- I. summary counts ----------

func TestDrift_SummaryCounts(t *testing.T) {
	h := Setup(t)
	owner, projectID, cellID, hostID, dep1 := desiredFixture(t, h)
	_ = h.SeedDeployment(projectID, "calm-otter-1234", "prod", "running", false, owner.ID, 3602, "")
	h.DoJSON(http.MethodPost, "/v1/cells/"+cellID+"/attach_deployment", owner.AccessToken,
		map[string]any{"deploymentName": "calm-otter-1234"}, http.StatusOK, &attachResp{})
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID)
	seedObservedContainer(t, h, hostID, dep1, cellID, projectID, "running") // in_sync
	// dep2 → no observed → missing
	seedObservedContainer(t, h, hostID, "ghost-"+randHex(4), cellID, "", "running") // unmanaged

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/hosts/"+hostID)
	s := res.Report.Summary
	if summaryCount(t, s, "total") != 3 || summaryCount(t, s, "inSync") != 1 ||
		summaryCount(t, s, "missing") != 1 || summaryCount(t, s, "unmanaged") != 1 {
		t.Fatalf("summary counts wrong: %+v", s)
	}
	if summaryCount(t, s, "critical") != 1 || summaryCount(t, s, "warning") != 1 || summaryCount(t, s, "info") != 1 {
		t.Fatalf("severity counts wrong: %+v", s)
	}
	if res.Report.Status != models.DriftReportStatusDrifted {
		t.Errorf("report status = %q, want drifted", res.Report.Status)
	}
}

// ---------- J. compute_drift OperationRun + latest + scopes ----------

func TestDrift_OperationRunAndLatest(t *testing.T) {
	h := Setup(t)
	owner, projectID, cellID, hostID, depID := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID)
	seedObservedContainer(t, h, hostID, depID, cellID, projectID, "running")

	// Project-scoped recompute creates a compute_drift OperationRun.
	res := recomputeDrift(t, h, owner.AccessToken, "/v1/projects/"+projectID)
	if res.Report == nil || res.Report.OperationRunID == nil {
		t.Fatalf("project recompute should link an operation run: %+v", res.Report)
	}
	if res.Report.ProjectID == nil || *res.Report.ProjectID != projectID {
		t.Errorf("project report should carry projectId")
	}
	var run struct {
		OperationRun models.OperationRun `json:"operationRun"`
		Steps        []any               `json:"steps"`
	}
	h.DoJSON(http.MethodGet, "/v1/operation_runs/"+*res.Report.OperationRunID, owner.AccessToken, nil, http.StatusOK, &run)
	if run.OperationRun.Type != models.OperationTypeComputeDrift || run.OperationRun.Status != models.OperationStatusSucceeded {
		t.Errorf("operation run = %+v, want compute_drift/succeeded", run.OperationRun)
	}

	// latest returns the freshly-computed report.
	var latest driftResult
	h.DoJSON(http.MethodGet, "/v1/projects/"+projectID+"/drift/latest", owner.AccessToken, nil, http.StatusOK, &latest)
	if latest.Report == nil || latest.Report.ID != res.Report.ID {
		t.Errorf("latest should return the recomputed report")
	}

	// Cell-scoped recompute works too and carries cellId.
	cellRes := recomputeDrift(t, h, owner.AccessToken, "/v1/cells/"+cellID)
	if cellRes.Report == nil || cellRes.Report.CellID == nil || *cellRes.Report.CellID != cellID {
		t.Errorf("cell report should carry cellId: %+v", cellRes.Report)
	}
}

// latest with nothing computed yet → 200 + null report.
func TestDrift_LatestEmpty(t *testing.T) {
	h := Setup(t)
	owner, projectID, _, _, _ := desiredFixture(t, h)
	var latest driftResult
	h.DoJSON(http.MethodGet, "/v1/projects/"+projectID+"/drift/latest", owner.AccessToken, nil, http.StatusOK, &latest)
	if latest.Report != nil {
		t.Fatalf("expected nil report before any compute, got %+v", latest.Report)
	}
	if len(latest.Items) != 0 {
		t.Errorf("expected no items, got %d", len(latest.Items))
	}
}

// ---------- K. dry-run: plans steps, applies NOTHING ----------

func TestDrift_DryRunPlansNothingApplied(t *testing.T) {
	h := Setup(t)
	owner, projectID, cellID, hostID, depID := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID)
	seedObservedContainer(t, h, hostID, depID, cellID, projectID, "exited") // → restart

	// Snapshot the world before the dry-run.
	desiredBefore := countRows(t, h, `SELECT count(*) FROM desired_states`)
	observedBefore := countRows(t, h, `SELECT count(*) FROM observed_states`)
	stateBefore := observedState(t, h, hostID, depID)
	provBefore := len(h.Docker.ProvisionedSpecs())
	destroyBefore := len(h.Docker.DestroyedNames())
	stopBefore := len(h.Docker.StoppedNames())
	recreateBefore := len(h.Docker.RecreatedSpecs())

	var res dryRunResult
	h.DoJSON(http.MethodPost, "/v1/hosts/"+hostID+"/reconcile/dry_run", owner.AccessToken, map[string]any{}, http.StatusOK, &res)

	// OperationRun + plan shape.
	if res.OperationRun.Type != models.OperationTypeReconcileDryRun || res.OperationRun.Status != models.OperationStatusSucceeded {
		t.Fatalf("operation run = %+v", res.OperationRun)
	}
	if res.OperationRun.PlanJSON["applyAllowed"] != false {
		t.Fatalf("plan.applyAllowed MUST be false, got %v", res.OperationRun.PlanJSON["applyAllowed"])
	}
	if res.OperationRun.PlanJSON["mode"] != "dry-run" {
		t.Errorf("plan.mode = %v, want dry-run", res.OperationRun.PlanJSON["mode"])
	}
	// A planned restart step, never applying.
	var restart *planStepLike
	for i := range res.Steps {
		if res.Steps[i].Action == models.RecommendedActionRestart {
			restart = &res.Steps[i]
		}
		if res.Steps[i].WillApply {
			t.Errorf("no step may have willApply=true: %+v", res.Steps[i])
		}
	}
	if restart == nil || restart.Status != models.OperationStepStatusPlanned {
		t.Fatalf("expected a planned restart step, got %+v", res.Steps)
	}

	// NOTHING changed: no docker calls, desired/observed untouched.
	if got := len(h.Docker.ProvisionedSpecs()); got != provBefore {
		t.Errorf("dry-run provisioned containers: %d → %d", provBefore, got)
	}
	if got := len(h.Docker.DestroyedNames()); got != destroyBefore {
		t.Errorf("dry-run destroyed containers: %d → %d", destroyBefore, got)
	}
	if got := len(h.Docker.StoppedNames()); got != stopBefore {
		t.Errorf("dry-run stopped containers: %d → %d", stopBefore, got)
	}
	if got := len(h.Docker.RecreatedSpecs()); got != recreateBefore {
		t.Errorf("dry-run recreated containers: %d → %d", recreateBefore, got)
	}
	if got := countRows(t, h, `SELECT count(*) FROM desired_states`); got != desiredBefore {
		t.Errorf("dry-run mutated desired_states: %d → %d", desiredBefore, got)
	}
	if got := countRows(t, h, `SELECT count(*) FROM observed_states`); got != observedBefore {
		t.Errorf("dry-run mutated observed_states: %d → %d", observedBefore, got)
	}
	if got := observedState(t, h, hostID, depID); got != stateBefore {
		t.Errorf("dry-run mutated observed state: %q → %q", stateBefore, got)
	}

	// The persisted steps + plan are also visible via the operation-run detail.
	var detail struct {
		OperationRun models.OperationRun `json:"operationRun"`
		Steps        []map[string]any    `json:"steps"`
	}
	h.DoJSON(http.MethodGet, "/v1/operation_runs/"+res.OperationRun.ID, owner.AccessToken, nil, http.StatusOK, &detail)
	if len(detail.Steps) == 0 {
		t.Errorf("operation run detail should expose persisted steps")
	}
	if detail.OperationRun.PlanJSON["applyAllowed"] != false {
		t.Errorf("operation run detail plan.applyAllowed must be false")
	}
}

// apply:true is rejected on both recompute and dry-run.
func TestDrift_ApplyRejected(t *testing.T) {
	h := Setup(t)
	owner, projectID, _, hostID, _ := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)

	for _, path := range []string{
		"/v1/projects/" + projectID + "/drift/recompute",
		"/v1/projects/" + projectID + "/reconcile/dry_run",
		"/v1/hosts/" + hostID + "/reconcile/dry_run",
	} {
		env := h.AssertStatus(http.MethodPost, path, owner.AccessToken, map[string]any{"apply": true}, http.StatusBadRequest)
		if env.Code != "apply_not_supported" {
			t.Errorf("%s: code = %q, want apply_not_supported", path, env.Code)
		}
	}
}

// ---------- L. RBAC ----------

func TestDrift_RBAC(t *testing.T) {
	h := Setup(t)
	owner, projectID, _, hostID, depID := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID)
	seedObservedContainer(t, h, hostID, depID, "", projectID, "running")
	// Admin (owner) computes first, so there's a latest report to view.
	recomputeDrift(t, h, owner.AccessToken, "/v1/projects/"+projectID)

	// A project member (non-admin) can VIEW but not recompute / dry-run.
	member := h.RegisterRandomUser()
	var teamID string
	if err := h.DB.QueryRow(context.Background(), `SELECT team_id FROM projects WHERE id = $1`, projectID).Scan(&teamID); err != nil {
		t.Fatalf("resolve team: %v", err)
	}
	seedTeamMember(t, h, teamID, member.ID, "member")

	h.DoJSON(http.MethodGet, "/v1/projects/"+projectID+"/drift/latest", member.AccessToken, nil, http.StatusOK, &driftResult{})
	h.AssertStatus(http.MethodPost, "/v1/projects/"+projectID+"/drift/recompute", member.AccessToken, map[string]any{}, http.StatusForbidden)
	h.AssertStatus(http.MethodPost, "/v1/projects/"+projectID+"/reconcile/dry_run", member.AccessToken, map[string]any{}, http.StatusForbidden)

	// Host-level drift requires instance-admin — a plain member is rejected.
	h.AssertStatus(http.MethodGet, "/v1/hosts/"+hostID+"/drift/latest", member.AccessToken, nil, http.StatusForbidden)
	h.AssertStatus(http.MethodPost, "/v1/hosts/"+hostID+"/drift/recompute", member.AccessToken, map[string]any{}, http.StatusForbidden)

	// A stranger (no membership) can't even view project drift.
	stranger := h.RegisterRandomUser()
	h.AssertStatus(http.MethodGet, "/v1/projects/"+projectID+"/drift/latest", stranger.AccessToken, nil, http.StatusForbidden)
}

// ---------- RODADA 1 foundation fix: prune vanished observed containers ----------

func TestObservedState_PrunesVanishedContainers(t *testing.T) {
	h := Setup(t)
	_, hostID, tok := mintHostToken(t, h, "vps-prune")
	var reg agentRegisterResult
	h.DoJSON(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tok.Token), http.StatusCreated, &reg)

	heartbeat := func(containers []map[string]any, dockerAvailable bool) {
		hb := map[string]any{
			"hostname": "vps-prune", "os": "linux", "arch": "amd64",
			"observed": map[string]any{
				"dockerAvailable": dockerAvailable, "dockerVersion": "27.0", "containers": containers,
			},
		}
		h.DoJSON(http.MethodPost, "/v1/agents/heartbeat", reg.AgentToken, hb, http.StatusOK, &map[string]any{})
	}
	mkContainer := func(dep string) map[string]any {
		return map[string]any{
			"id": "id-" + dep, "name": "convex-" + dep, "image": "img", "state": "running", "status": "Up",
			"labels": map[string]string{"synapse.managed": "true", "synapse.deployment_id": dep},
			"ports":  "", "createdAt": "",
		}
	}

	// Two managed containers reported.
	heartbeat([]map[string]any{mkContainer("dep-a"), mkContainer("dep-b")}, true)
	if got := countObservedContainers(t, h, hostID); got != 2 {
		t.Fatalf("expected 2 observed containers, got %d", got)
	}
	// dep-b vanishes (docker available) → pruned, so it can read as "missing".
	heartbeat([]map[string]any{mkContainer("dep-a")}, true)
	if got := countObservedContainers(t, h, hostID); got != 1 {
		t.Fatalf("expected 1 observed container after prune, got %d", got)
	}
	// Docker goes UNAVAILABLE, agent reports empty → must NOT prune (outage,
	// not removal — pruning here would manufacture false "missing").
	heartbeat([]map[string]any{}, false)
	if got := countObservedContainers(t, h, hostID); got != 1 {
		t.Fatalf("docker-unavailable heartbeat must not prune; got %d", got)
	}
	// Docker back with zero containers → dep-a legitimately gone → pruned to 0.
	heartbeat([]map[string]any{}, true)
	if got := countObservedContainers(t, h, hostID); got != 0 {
		t.Fatalf("expected 0 observed containers, got %d", got)
	}
	// host_facts is never pruned.
	if got := countRows(t, h, `SELECT count(*) FROM observed_states WHERE resource_type = 'host_facts'`); got != 1 {
		t.Errorf("host_facts must survive pruning, got %d", got)
	}
}

func countObservedContainers(t *testing.T, h *Harness, hostID string) int {
	t.Helper()
	var n int
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT count(*) FROM observed_states WHERE host_id::text = $1 AND resource_type = 'docker_container'`,
		hostID).Scan(&n); err != nil {
		t.Fatalf("count observed containers: %v", err)
	}
	return n
}

// ---------- 9b.5: scan fidelity + pruning safety ----------

// seedHostFacts upserts a host_facts observed row carrying the docker + scan
// outcome the Drift Engine reads to decide host trust.
func seedHostFacts(t *testing.T, h *Harness, hostID string, dockerAvailable, scanSucceeded, scanComplete bool) {
	t.Helper()
	facts := map[string]any{
		"hostname": "h", "os": "linux", "arch": "amd64",
		"dockerAvailable": dockerAvailable, "dockerVersion": "27.0",
		"containerScan": map[string]any{
			"attempted": true, "succeeded": scanSucceeded, "complete": scanComplete, "error": nil,
		},
	}
	raw, _ := json.Marshal(facts)
	if _, err := h.DB.Exec(h.rootCtx, `
		INSERT INTO observed_states (host_id, resource_type, resource_key, observed_json, observed_hash, source)
		VALUES ($1, 'host_facts', $2, $3, $4, 'agent')
		ON CONFLICT (host_id, resource_type, resource_key)
		DO UPDATE SET observed_json = EXCLUDED.observed_json, observed_at = now()
	`, hostID, "host:"+hostID, raw, "hash-"+randHex(6)); err != nil {
		t.Fatalf("seed host_facts: %v", err)
	}
}

// Pruning is gated on the agent's reported scan outcome, not a guessed empty list.
func TestObservedState_PruningRespectsScan(t *testing.T) {
	h := Setup(t)
	_, hostID, tok := mintHostToken(t, h, "vps-scan")
	var reg agentRegisterResult
	h.DoJSON(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tok.Token), http.StatusCreated, &reg)

	beat := func(containers []map[string]any, dockerAvailable, succeeded, complete bool, scanErr any) {
		hb := map[string]any{
			"hostname": "vps-scan", "os": "linux", "arch": "amd64",
			"observed": map[string]any{
				"dockerAvailable": dockerAvailable, "dockerVersion": "27.0", "containers": containers,
				"containerScan": map[string]any{
					"attempted": true, "succeeded": succeeded, "complete": complete, "error": scanErr,
				},
			},
		}
		h.DoJSON(http.MethodPost, "/v1/agents/heartbeat", reg.AgentToken, hb, http.StatusOK, &map[string]any{})
	}
	mk := func(dep, state string) map[string]any {
		return map[string]any{
			"id": "id-" + dep, "name": "convex-" + dep, "image": "img", "state": state, "status": "x",
			"labels": map[string]string{"synapse.managed": "true", "synapse.deployment_id": dep},
			"ports":  "", "createdAt": "",
		}
	}

	// Scan succeeded+complete with two containers (one running, one exited).
	beat([]map[string]any{mk("dep-a", "running"), mk("dep-b", "exited")}, true, true, true, nil)
	if got := countObservedContainers(t, h, hostID); got != 2 {
		t.Fatalf("expected 2 observed containers, got %d", got)
	}
	// Scan FAILED with an empty list → must NOT prune (transient docker error).
	beat([]map[string]any{}, true, false, false, "docker_scan_failed")
	if got := countObservedContainers(t, h, hostID); got != 2 {
		t.Fatalf("scan-failed heartbeat must not prune; got %d", got)
	}
	// Docker UNAVAILABLE with an empty list → must NOT prune.
	beat([]map[string]any{}, false, false, false, "docker_unavailable")
	if got := countObservedContainers(t, h, hostID); got != 2 {
		t.Fatalf("docker-unavailable heartbeat must not prune; got %d", got)
	}
	// Scan succeeded+complete, dep-b gone → prune just dep-b.
	beat([]map[string]any{mk("dep-a", "running")}, true, true, true, nil)
	if got := countObservedContainers(t, h, hostID); got != 1 {
		t.Fatalf("expected 1 after scan-clean prune, got %d", got)
	}
	// Scan succeeded+complete, empty → legitimately zero containers → prune all.
	beat([]map[string]any{}, true, true, true, nil)
	if got := countObservedContainers(t, h, hostID); got != 0 {
		t.Fatalf("expected 0 observed containers, got %d", got)
	}
	// host_facts persists and records the latest scan outcome.
	if got := countRows(t, h, `SELECT count(*) FROM observed_states WHERE resource_type = 'host_facts'`); got != 1 {
		t.Errorf("host_facts must survive pruning, got %d", got)
	}
	var scanOK string
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT observed_json->'containerScan'->>'succeeded' FROM observed_states WHERE host_id::text = $1 AND resource_type = 'host_facts'`,
		hostID).Scan(&scanOK); err != nil {
		t.Fatalf("read host_facts scan: %v", err)
	}
	if scanOK != "true" {
		t.Errorf("host_facts should record scan succeeded=true, got %q", scanOK)
	}
}

// Scan failed/incomplete on an online host → host_unreachable, never a
// misleading "missing" (the container might still be there; we just couldn't list it).
func TestDrift_ScanFailedNotMissing(t *testing.T) {
	h := Setup(t)
	owner, projectID, _, hostID, _ := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID)                         // heartbeat fresh → online liveness
	seedHostFacts(t, h, hostID, true, false, false) // docker up, but scan failed
	// no observed container.

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/hosts/"+hostID)
	if findDriftItem(res.Items, models.DriftStatusMissing) != nil {
		t.Fatalf("scan-failed must NOT yield missing: %+v", res.Items)
	}
	it := findDriftItem(res.Items, models.DriftStatusHostUnreachable)
	if it == nil || it.RecommendedAction != models.RecommendedActionInvestigate || it.Severity != models.SeverityWarning {
		t.Fatalf("expected host_unreachable/warning/investigate, got %+v", res.Items)
	}
}

// Scan succeeded+complete + no container → a real missing (create).
func TestDrift_ScanSucceededMissing(t *testing.T) {
	h := Setup(t)
	owner, projectID, _, hostID, _ := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID)
	seedHostFacts(t, h, hostID, true, true, true) // scan succeeded + complete

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/hosts/"+hostID)
	it := findDriftItem(res.Items, models.DriftStatusMissing)
	if it == nil || it.RecommendedAction != models.RecommendedActionCreate {
		t.Fatalf("scan succeeded + no container → missing/create, got %+v", res.Items)
	}
}

// Draining is lifecycle, not liveness: a draining-but-online host with a good
// scan still gets its real drift diagnosed (NOT masked as host_unreachable).
func TestDrift_DrainingOnlineStillDiagnoses(t *testing.T) {
	h := Setup(t)
	owner, projectID, cellID, hostID, depID := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	if _, err := h.DB.Exec(h.rootCtx,
		`UPDATE hosts SET status = 'draining', last_heartbeat_at = now() WHERE id::text = $1`, hostID); err != nil {
		t.Fatalf("set draining: %v", err)
	}
	seedHostFacts(t, h, hostID, true, true, true)
	seedObservedContainer(t, h, hostID, depID, cellID, projectID, "exited")

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/hosts/"+hostID)
	if findDriftItem(res.Items, models.DriftStatusHostUnreachable) != nil {
		t.Fatalf("draining+online+scan-ok must NOT be host_unreachable: %+v", res.Items)
	}
	it := findDriftItem(res.Items, models.DriftStatusDrifted)
	if it == nil || it.RecommendedAction != models.RecommendedActionRestart {
		t.Fatalf("expected drifted/restart even while draining, got %+v", res.Items)
	}
	if it.Diff["lifecycle"] != models.HostStatusDraining {
		t.Errorf("draining should be annotated on the item diff, got %+v", it.Diff)
	}
}

// ---------- Bloco 12.6: provisioner labels + legacy-label drift fallback ----------

// seedObservedLegacy inserts a docker_container observed row the way a PRE-12.6
// provisioner labelled it: synapse.deployment=<name> + synapse.managed, but NO
// synapse.deployment_id. Used to test the drift legacy-label fallback.
func seedObservedLegacy(t *testing.T, h *Harness, hostID, depName, projectID, state string) {
	t.Helper()
	labels := map[string]string{"synapse.managed": "true", "synapse.deployment": depName}
	if projectID != "" {
		labels["synapse.project_id"] = projectID
	}
	observed := map[string]any{
		"id": "c" + randHex(6), "name": "convex-" + depName, "image": "img",
		"state": state, "status": "Up", "labels": labels, "ports": "", "createdAt": "",
	}
	raw, _ := json.Marshal(observed)
	if _, err := h.DB.Exec(h.rootCtx, `
		INSERT INTO observed_states (host_id, resource_type, resource_id, resource_key, observed_json, observed_hash, source)
		VALUES ($1, 'docker_container', NULL, $2, $3, $4, 'agent')
	`, hostID, "docker_container:"+depName+"-"+randHex(4), raw, "hash-"+randHex(6)); err != nil {
		t.Fatalf("seed legacy observed: %v", err)
	}
}

// The fix: provisioned containers carry the deployment UUID + project UUID so
// drift can correlate them.
func TestProvisioner_StampsDeploymentLabels(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Prov Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "provproj")
	var got deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken, map[string]string{"type": "dev"}, http.StatusCreated, &got)
	waitForStatus(t, h, got.Name, "running", 5*time.Second)

	specs := h.Docker.ProvisionedSpecs()
	if len(specs) != 1 {
		t.Fatalf("want 1 provision spec, got %d", len(specs))
	}
	if specs[0].DeploymentID == "" {
		t.Errorf("provisioner spec missing DeploymentID — drift correlation needs the UUID label")
	}
	if specs[0].ProjectID != proj.ID {
		t.Errorf("spec.ProjectID = %q, want %q", specs[0].ProjectID, proj.ID)
	}
	if specs[0].Name != got.Name {
		t.Errorf("spec.Name = %q, want %q", specs[0].Name, got.Name)
	}
}

// Legacy container (name label only, no UUID) on a trusted host → correlates
// via fallback → in_sync, annotated. (This is the exact staging blocker.)
func TestDrift_LegacyLabelFallback(t *testing.T) {
	h := Setup(t)
	owner, projectID, _, hostID, _ := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID)
	seedObservedLegacy(t, h, hostID, "lush-heron-4656", "", "running") // no project_id (true legacy)

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/hosts/"+hostID)
	if findDriftItem(res.Items, models.DriftStatusMissing) != nil {
		t.Fatalf("legacy container must NOT show as missing — %+v", res.Items)
	}
	it := findDriftItem(res.Items, models.DriftStatusInSync)
	if it == nil {
		t.Fatalf("legacy-label container should correlate → in_sync, got %+v", res.Items)
	}
	if it.Diff["legacyLabelFallback"] != true {
		t.Errorf("expected legacyLabelFallback=true, diff=%+v", it.Diff)
	}
}

// Legacy container whose name does NOT match any desired → no fallback → missing.
func TestDrift_LegacyFallbackWrongName(t *testing.T) {
	h := Setup(t)
	owner, projectID, _, hostID, _ := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID)
	seedObservedLegacy(t, h, hostID, "some-other-deployment", "", "running")

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/hosts/"+hostID)
	if findDriftItem(res.Items, models.DriftStatusInSync) != nil {
		t.Errorf("a non-matching name must NOT fallback to in_sync: %+v", res.Items)
	}
	if findDriftItem(res.Items, models.DriftStatusMissing) == nil {
		t.Errorf("expected missing (no correlation), got %+v", res.Items)
	}
}

// Project-scope: the observed query filters on the synapse.project_id label
// that legacy containers LACK, so the fallback must top up from the project's
// hosts. (Exactly the case the live staging re-verify surfaced.)
func TestDrift_LegacyFallbackProjectScope(t *testing.T) {
	h := Setup(t)
	owner, projectID, _, hostID, _ := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID)
	seedObservedLegacy(t, h, hostID, "lush-heron-4656", "", "running") // no project_id label

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/projects/"+projectID)
	if findDriftItem(res.Items, models.DriftStatusMissing) != nil {
		t.Fatalf("project-scope: legacy container must NOT be missing — %+v", res.Items)
	}
	it := findDriftItem(res.Items, models.DriftStatusInSync)
	if it == nil || it.Diff["legacyLabelFallback"] != true {
		t.Fatalf("project-scope: expected in_sync via legacy fallback, got %+v", res.Items)
	}
}

// Two legacy containers with the same name → ambiguous → fallback refused.
func TestDrift_LegacyFallbackAmbiguous(t *testing.T) {
	h := Setup(t)
	owner, projectID, _, hostID, _ := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID)
	seedObservedLegacy(t, h, hostID, "lush-heron-4656", "", "running")
	seedObservedLegacy(t, h, hostID, "lush-heron-4656", "", "running")

	res := recomputeDrift(t, h, owner.AccessToken, "/v1/hosts/"+hostID)
	if findDriftItem(res.Items, models.DriftStatusInSync) != nil {
		t.Errorf("ambiguous name must NOT fallback to in_sync: %+v", res.Items)
	}
	if findDriftItem(res.Items, models.DriftStatusUnmanaged) == nil {
		t.Errorf("ambiguous legacy containers should be unmanaged, got %+v", res.Items)
	}
}

// ---------- shared small helpers ----------

func countRows(t *testing.T, h *Harness, query string) int {
	t.Helper()
	var n int
	if err := h.DB.QueryRow(h.rootCtx, query).Scan(&n); err != nil {
		t.Fatalf("count: %v", err)
	}
	return n
}

func observedState(t *testing.T, h *Harness, hostID, depID string) string {
	t.Helper()
	var state string
	err := h.DB.QueryRow(h.rootCtx, `
		SELECT COALESCE(observed_json->>'state', '') FROM observed_states
		 WHERE host_id::text = $1 AND resource_key = $2
	`, hostID, "docker_container:"+depID).Scan(&state)
	if err != nil {
		return "" // row gone is itself a change the caller will catch
	}
	return state
}

// TestDrift_ApplyRejected_AllScopes locks the Cell Control Plane's
// observe/plan-only contract: every drift / reconcile endpoint that
// accepts a body MUST reject apply:true with 400 apply_not_supported.
// If anyone ever adds an apply code path here, this test fails — that
// is the point. See docs/SAFETY_INVARIANTS.md.
func TestDrift_ApplyRejected_AllScopes(t *testing.T) {
	h := Setup(t)
	owner, projectID, cellID, hostID, _ := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)

	// Every mutating drift/reconcile route gated by applyRejected. Keep this
	// list in lock-step with the applyRejected callers in
	// synapse/internal/api/drift.go — a new endpoint that accepts a body
	// without going through applyRejected is a contract break.
	cases := []struct {
		name string
		path string
	}{
		{"projectRecompute", "/v1/projects/" + projectID + "/drift/recompute"},
		{"projectDryRun", "/v1/projects/" + projectID + "/reconcile/dry_run"},
		{"cellRecompute", "/v1/cells/" + cellID + "/drift/recompute"},
		{"cellDryRun", "/v1/cells/" + cellID + "/reconcile/dry_run"},
		{"hostRecompute", "/v1/hosts/" + hostID + "/drift/recompute"},
		{"hostDryRun", "/v1/hosts/" + hostID + "/reconcile/dry_run"},
	}
	body := map[string]any{"apply": true}
	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			env := h.AssertStatus(http.MethodPost, tc.path, owner.AccessToken, body, http.StatusBadRequest)
			if env.Code != "apply_not_supported" {
				t.Errorf("%s: code = %q, want apply_not_supported", tc.path, env.Code)
			}
		})
	}

	// Negative guard against over-gating: a body WITHOUT apply must still
	// succeed. If applyRejected ever starts rejecting plain bodies, the
	// dashboard's dry-run button breaks — catch that here.
	var ok dryRunResult
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/reconcile/dry_run",
		owner.AccessToken, map[string]any{}, http.StatusOK, &ok)
	if ok.OperationRun.ID == "" {
		t.Fatalf("empty body should still produce an operation run")
	}
}
