package synapsetest

import (
	"net/http"
	"testing"
)

// Bloco 10 — the reconcile/apply endpoint (api.doApply). These drive the full
// path: drift recompute → OperationRun + steps → enqueue reconcile jobs →
// worker executes → run finalizes. Gating (G1) + the no-drift fast path are
// asserted directly; the missing→create case exercises the whole pipeline.

type applyResp struct {
	OperationRunID string         `json:"operationRunId"`
	Status         string         `json:"status"`
	Summary        map[string]int `json:"summary"`
}

// G1 — apply is 404 when SYNAPSE_APPLY_ENABLED is false (the default). The
// endpoint is indistinguishable from "feature absent".
func TestApply_Disabled404(t *testing.T) {
	h := Setup(t) // ApplyEnabled defaults false
	owner, projectID, _, _, _ := desiredFixture(t, h)
	h.AssertStatus(http.MethodPost, "/v1/projects/"+projectID+"/reconcile/apply",
		owner.AccessToken, map[string]any{}, http.StatusNotFound)
}

// missing → create: a desired-but-absent deployment is provisioned by apply;
// the run finalizes succeeded and the container is created.
func TestApply_MissingCreates(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{ApplyEnabled: true})
	owner, projectID, _, hostID, depID := desiredFixture(t, h)
	syncDrift(t, h, owner.AccessToken, projectID)
	trustHost(t, h, hostID) // online — so absence is real, not "unreachable"
	// no observed container seeded → drift classifies the deployment missing→create

	var out applyResp
	h.DoJSON(http.MethodPost, "/v1/hosts/"+hostID+"/reconcile/apply",
		owner.AccessToken, map[string]any{}, http.StatusAccepted, &out)
	if out.OperationRunID == "" {
		t.Fatal("apply returned no operationRunId")
	}
	if out.Summary["queued"] != 1 {
		t.Fatalf("expected queued=1, got summary %+v", out.Summary)
	}

	if st := waitRunTerminal(t, h, out.OperationRunID); st != "succeeded" {
		t.Fatalf("apply run status: got %q want succeeded", st)
	}
	if !provisionedContains(h, "lush-heron-4656") {
		t.Fatalf("apply did not provision the missing deployment")
	}
	if got := queryString(t, h, `SELECT status FROM deployments WHERE id = $1`, depID); got != "running" {
		t.Fatalf("deployment status after apply: got %q want running", got)
	}
}

// enabled but no drift → 202, finalized 'succeeded' synchronously, nothing
// queued (no worker round-trip needed).
func TestApply_NoDriftNoOp(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{ApplyEnabled: true})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Apply NoDrift")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "nodrift")

	var out applyResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/reconcile/apply",
		owner.AccessToken, map[string]any{}, http.StatusAccepted, &out)
	if out.Status != "succeeded" {
		t.Fatalf("empty apply should finalize succeeded, got %q", out.Status)
	}
	if out.Summary["queued"] != 0 {
		t.Fatalf("nothing should be queued on an empty scope, got %+v", out.Summary)
	}
}
