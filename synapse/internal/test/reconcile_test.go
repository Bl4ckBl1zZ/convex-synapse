package synapsetest

import (
	"testing"
	"time"

	"github.com/Iann29/synapse/internal/provisioner"
)

// Bloco 10 — the central-driven reconcile executor (provisioner.runReconcile).
// These drive the Worker directly via EnqueueReconcile + a hand-built
// OperationRun/Step (the apply API endpoint, Bloco 10 task 8, is what builds
// those in production). The harness wires a real Worker + FakeDocker, so a
// reconcile job is claimed and executed exactly as it would be in prod.

func seedProjectAndDeployment(t *testing.T, h *Harness, creatorUserID, status string) (projectID, depID, name string) {
	t.Helper()
	suffix := randHex(6)
	var teamID string
	if err := h.DB.QueryRow(h.rootCtx,
		`INSERT INTO teams (slug, name, creator_user_id) VALUES ($1, $2, $3) RETURNING id`,
		"team-"+suffix, "Team "+suffix, creatorUserID).Scan(&teamID); err != nil {
		t.Fatalf("insert team: %v", err)
	}
	if err := h.DB.QueryRow(h.rootCtx,
		`INSERT INTO projects (team_id, name, slug) VALUES ($1, $2, $3) RETURNING id`,
		teamID, "Project "+suffix, "proj-"+suffix).Scan(&projectID); err != nil {
		t.Fatalf("insert project: %v", err)
	}
	name = "deploy-" + suffix
	depID = h.SeedDeployment(projectID, name, "dev", status, false, creatorUserID, 0, "")
	return projectID, depID, name
}

// seedReconcileRunStep hand-builds the OperationRun + one planned step the way
// the apply handler will, and returns their ids.
func seedReconcileRunStep(t *testing.T, h *Harness, projectID, depID, action string) (runID, stepID string) {
	t.Helper()
	if err := h.DB.QueryRow(h.rootCtx,
		`INSERT INTO operation_runs (type, project_id, status) VALUES ('reconcile_apply', $1, 'queued') RETURNING id`,
		projectID).Scan(&runID); err != nil {
		t.Fatalf("insert operation_run: %v", err)
	}
	if err := h.DB.QueryRow(h.rootCtx,
		`INSERT INTO operation_steps (operation_run_id, step_index, action, resource_type, resource_key, status)
		 VALUES ($1, 0, $2, 'convex_deployment', $3, 'planned') RETURNING id`,
		runID, action, "convex_deployment:"+depID).Scan(&stepID); err != nil {
		t.Fatalf("insert operation_step: %v", err)
	}
	return runID, stepID
}

// waitReconcileJob polls the latest reconcile job for a deployment until it
// reaches a terminal state, returning that status.
func waitReconcileJob(t *testing.T, h *Harness, depID string) string {
	t.Helper()
	for i := 0; i < 250; i++ {
		var s string
		err := h.DB.QueryRow(h.rootCtx,
			`SELECT status FROM provisioning_jobs
			  WHERE deployment_id = $1 AND kind = 'reconcile'
			  ORDER BY id DESC LIMIT 1`, depID).Scan(&s)
		if err == nil && (s == "done" || s == "failed") {
			return s
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("reconcile job for %s never finished", depID)
	return ""
}

// waitRunTerminal polls the OperationRun until it finalizes — the run is the
// user-facing completion signal (the worker marks the job 'done' just before
// rolling the run up, so polling the run avoids racing that rollup).
func waitRunTerminal(t *testing.T, h *Harness, runID string) string {
	t.Helper()
	for i := 0; i < 250; i++ {
		var s string
		if err := h.DB.QueryRow(h.rootCtx,
			`SELECT status FROM operation_runs WHERE id = $1`, runID).Scan(&s); err == nil &&
			(s == "succeeded" || s == "failed" || s == "cancelled") {
			return s
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("operation_run %s never finalized", runID)
	return ""
}

func queryString(t *testing.T, h *Harness, q string, arg string) string {
	t.Helper()
	var s string
	if err := h.DB.QueryRow(h.rootCtx, q, arg).Scan(&s); err != nil {
		t.Fatalf("query %q: %v", q, err)
	}
	return s
}

func provisionedContains(h *Harness, name string) bool {
	for _, sp := range h.Docker.ProvisionedSpecs() {
		if sp.Name == name {
			return true
		}
	}
	return false
}

// 1. create: a 'failed' deployment with no container is provisioned; the step
//    and run finalize 'succeeded' and the deployment row flips to 'running'.
func TestReconcile_Create(t *testing.T) {
	h := Setup(t)
	admin := h.RegisterRandomUser()
	projectID, depID, name := seedProjectAndDeployment(t, h, admin.ID, "failed")
	runID, stepID := seedReconcileRunStep(t, h, projectID, depID, "create")

	if _, err := provisioner.EnqueueReconcile(h.rootCtx, h.DB, depID, "create", runID, stepID, false); err != nil {
		t.Fatalf("EnqueueReconcile: %v", err)
	}
	if st := waitRunTerminal(t, h, runID); st != "succeeded" {
		t.Fatalf("run status: got %q want succeeded", st)
	}

	if !provisionedContains(h, name) {
		t.Fatalf("FakeDocker was not asked to provision %q", name)
	}
	if got := queryString(t, h, `SELECT status FROM deployments WHERE id = $1`, depID); got != "running" {
		t.Fatalf("deployment status: got %q want running", got)
	}
	if got := queryString(t, h, `SELECT status FROM operation_steps WHERE id = $1`, stepID); got != "succeeded" {
		t.Fatalf("step status: got %q want succeeded", got)
	}
	if got := queryString(t, h, `SELECT status FROM operation_runs WHERE id = $1`, runID); got != "succeeded" {
		t.Fatalf("run status: got %q want succeeded", got)
	}
}

// 2. create idempotency (G4): a deployment already 'provisioning' (a create is
//    in flight) is a no_op — no second container, step no_op, run succeeded.
func TestReconcile_CreateIdempotentNoOp(t *testing.T) {
	h := Setup(t)
	admin := h.RegisterRandomUser()
	projectID, depID, name := seedProjectAndDeployment(t, h, admin.ID, "provisioning")
	runID, stepID := seedReconcileRunStep(t, h, projectID, depID, "create")

	provBefore := len(h.Docker.ProvisionedSpecs())
	if _, err := provisioner.EnqueueReconcile(h.rootCtx, h.DB, depID, "create", runID, stepID, false); err != nil {
		t.Fatalf("EnqueueReconcile: %v", err)
	}
	if st := waitRunTerminal(t, h, runID); st != "succeeded" {
		t.Fatalf("run status: got %q want succeeded", st)
	}

	if provisionedContains(h, name) || len(h.Docker.ProvisionedSpecs()) != provBefore {
		t.Fatalf("idempotency violated: running deployment was re-provisioned")
	}
	if got := queryString(t, h, `SELECT status FROM operation_steps WHERE id = $1`, stepID); got != "no_op" {
		t.Fatalf("step status: got %q want no_op", got)
	}
	if got := queryString(t, h, `SELECT status FROM operation_runs WHERE id = $1`, runID); got != "succeeded" {
		t.Fatalf("run status: got %q want succeeded", got)
	}
}

// 3. restart: a 'stopped' deployment is bounced in place; step + run succeed,
//    deployment flips to 'running', no new container is provisioned.
func TestReconcile_Restart(t *testing.T) {
	h := Setup(t)
	admin := h.RegisterRandomUser()
	projectID, depID, name := seedProjectAndDeployment(t, h, admin.ID, "stopped")
	runID, stepID := seedReconcileRunStep(t, h, projectID, depID, "restart")

	provBefore := len(h.Docker.ProvisionedSpecs())
	if _, err := provisioner.EnqueueReconcile(h.rootCtx, h.DB, depID, "restart", runID, stepID, false); err != nil {
		t.Fatalf("EnqueueReconcile: %v", err)
	}
	if st := waitReconcileJob(t, h, depID); st != "done" {
		t.Fatalf("reconcile job status: got %q want done", st)
	}

	restarted := false
	for _, n := range h.Docker.RestartedNames() {
		if n == name {
			restarted = true
		}
	}
	if !restarted {
		t.Fatalf("FakeDocker was not asked to restart %q", name)
	}
	if len(h.Docker.ProvisionedSpecs()) != provBefore {
		t.Fatalf("restart must not provision a new container")
	}
	if got := queryString(t, h, `SELECT status FROM deployments WHERE id = $1`, depID); got != "running" {
		t.Fatalf("deployment status: got %q want running", got)
	}
	if got := queryString(t, h, `SELECT status FROM operation_steps WHERE id = $1`, stepID); got != "succeeded" {
		t.Fatalf("step status: got %q want succeeded", got)
	}
}
