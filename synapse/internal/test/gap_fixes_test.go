package synapsetest

import (
	"net/http"
	"testing"

	"github.com/Iann29/synapse/internal/provisioner"
)

// Regression tests for the v1.24.x gap-audit fixes.

// C1 — the apply gate is re-checked at EXECUTION time, not just enqueue. A
// reconcile job that reaches the worker while apply is DISABLED must be
// skipped, never executed. (Setup → apply off by default + no apply_settings
// row → applyEnabledNow returns the env default false → skip.) Without the
// fix the worker would Provision the container regardless of the toggle —
// the dashboard kill-switch would be an illusion for already-queued work.
func TestReconcile_ApplyDisabled_SkipsAtExecution(t *testing.T) {
	h := Setup(t) // ApplyEnabled defaults false
	admin := h.RegisterRandomUser()
	projectID, depID, name := seedProjectAndDeployment(t, h, admin.ID, "failed")
	runID, stepID := seedReconcileRunStep(t, h, projectID, depID, "create")

	if _, _, err := provisioner.EnqueueReconcile(h.rootCtx, h.DB, depID, "create", runID, stepID, false); err != nil {
		t.Fatalf("EnqueueReconcile: %v", err)
	}
	if st := waitRunTerminal(t, h, runID); st != "succeeded" {
		t.Fatalf("run status: got %q want succeeded (skipped steps roll up clean)", st)
	}

	if provisionedContains(h, name) {
		t.Fatalf("apply was disabled but the worker provisioned %q anyway", name)
	}
	if got := queryString(t, h, `SELECT status FROM operation_steps WHERE id = $1`, stepID); got != "skipped" {
		t.Fatalf("step status: got %q want skipped", got)
	}
	if got := queryString(t, h, `SELECT status FROM deployments WHERE id = $1`, depID); got != "failed" {
		t.Fatalf("deployment status: got %q want failed (untouched)", got)
	}
}

// M2 — single-flight is per-DEPLOYMENT, not per-step. Two reconcile jobs for
// the same deployment (with DIFFERENT operation_steps, the shape two
// concurrent applies produce) must not both enqueue: the second hits the
// 000031 partial unique index and EnqueueReconcile reports enqueued=false.
// Run both inserts inside ONE uncommitted tx so the worker can't drain the
// first and free the index between calls — that makes the assertion
// deterministic and proves the index, not timing, is what blocks the dup.
func TestReconcile_SingleFlightPerDeployment(t *testing.T) {
	h := Setup(t)
	admin := h.RegisterRandomUser()
	projectID, depID, _ := seedProjectAndDeployment(t, h, admin.ID, "stopped")
	runID, step1 := seedReconcileRunStep(t, h, projectID, depID, "restart")

	// A second step for the SAME deployment under the same run.
	var step2 string
	if err := h.DB.QueryRow(h.rootCtx,
		`INSERT INTO operation_steps (operation_run_id, step_index, action, resource_type, resource_key, status)
		 VALUES ($1, 1, 'restart', 'convex_deployment', $2, 'planned') RETURNING id`,
		runID, "convex_deployment:"+depID).Scan(&step2); err != nil {
		t.Fatalf("insert second step: %v", err)
	}

	tx, err := h.DB.Begin(h.rootCtx)
	if err != nil {
		t.Fatalf("begin tx: %v", err)
	}
	defer tx.Rollback(h.rootCtx)

	_, ok1, err := provisioner.EnqueueReconcile(h.rootCtx, tx, depID, "restart", runID, step1, false)
	if err != nil {
		t.Fatalf("first EnqueueReconcile: %v", err)
	}
	if !ok1 {
		t.Fatalf("first enqueue should have succeeded")
	}
	_, ok2, err := provisioner.EnqueueReconcile(h.rootCtx, tx, depID, "restart", runID, step2, false)
	if err != nil {
		t.Fatalf("second EnqueueReconcile: %v", err)
	}
	if ok2 {
		t.Fatalf("second enqueue for the same deployment should be single-flighted (enqueued=false)")
	}
}

// C2 — deleting an HA deployment tears down EVERY replica container, not just
// the single-replica convex-<name>. Before the fix Destroy(name) targeted a
// container that doesn't exist for HA (convex-<name>-0/1), no-op'd, and leaked
// both replicas + volumes while freeing their ports in the DB.
func TestDeleteDeployment_HA_DestroysAllReplicas(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "HA Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	depID := h.SeedDeployment(proj.ID, "ha-otter-7777", "prod", "running", true, owner.ID, 3240, "")

	// Promote the seeded row to HA with two replicas.
	if _, err := h.DB.Exec(h.rootCtx,
		`UPDATE deployments SET ha_enabled = TRUE, replica_count = 2 WHERE id = $1`, depID); err != nil {
		t.Fatalf("promote to HA: %v", err)
	}

	h.DoJSON(http.MethodPost, "/v1/deployments/ha-otter-7777/delete",
		owner.AccessToken, nil, http.StatusOK, &map[string]string{})

	h.Docker.mu.Lock()
	replicas := append([]struct {
		Name         string
		ReplicaIndex int
		KeepVolume   bool
	}{}, h.Docker.DestroyedReplicas...)
	h.Docker.mu.Unlock()

	seen := map[int]bool{}
	for _, rdr := range replicas {
		if rdr.Name == "ha-otter-7777" {
			seen[rdr.ReplicaIndex] = true
		}
	}
	if !seen[0] || !seen[1] {
		t.Fatalf("HA delete must DestroyReplica both 0 and 1; got %+v", replicas)
	}
	if got := mustStatus(t, h, "ha-otter-7777"); got != "deleted" {
		t.Fatalf("status = %q, want deleted", got)
	}
}
