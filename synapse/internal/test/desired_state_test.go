package synapsetest

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/Iann29/synapse/internal/models"
)

// Bloco 9a — DesiredState / ObservedState / desired_state endpoint / OperationRun.

type syncResult struct {
	Created        int    `json:"created"`
	Updated        int    `json:"updated"`
	Unchanged      int    `json:"unchanged"`
	Superseded     int    `json:"superseded"`
	Total          int    `json:"total"`
	OperationRunID string `json:"operationRunId"`
}

type desiredListResult struct {
	Items []models.DesiredState `json:"items"`
}

type observedListResult struct {
	Items []models.ObservedState `json:"items"`
}

// desiredFixture: owner + project + core cell placed on a host + a deployment
// attached (→ a placement with a host, the source of desired state).
func desiredFixture(t *testing.T, h *Harness) (owner *User, projectID, cellID, hostID, depID string) {
	t.Helper()
	owner = h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Amage IA")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "amagejumpy")
	projectID = proj.ID
	cell := createCellViaAPI(t, h, owner.AccessToken, projectID, "core-prod-br-1", "core")
	cellID = cell.ID
	var host models.Host
	h.DoJSON(http.MethodPost, "/v1/hosts", owner.AccessToken, map[string]any{"name": "vps-br-1", "region": "br"}, http.StatusCreated, &host)
	hostID = host.ID
	h.DoJSON(http.MethodPost, "/v1/cells/"+cellID+"/attach_host", owner.AccessToken, map[string]any{"hostId": hostID}, http.StatusOK, &models.Cell{})
	depID = h.SeedDeployment(projectID, "lush-heron-4656", "prod", "running", true, owner.ID, 3601, "")
	h.DoJSON(http.MethodPost, "/v1/cells/"+cellID+"/attach_deployment", owner.AccessToken, map[string]any{"deploymentName": "lush-heron-4656"}, http.StatusOK, &attachResp{})
	return
}

func TestDesiredState_SyncFromPlacementsIdempotent(t *testing.T) {
	h := Setup(t)
	owner, projectID, _, hostID, depID := desiredFixture(t, h)

	var res syncResult
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/desired_state/sync_from_placements", owner.AccessToken, map[string]any{}, http.StatusOK, &res)
	if res.Created != 1 || res.Total != 1 {
		t.Fatalf("first sync should create 1 desired state, got %+v", res)
	}
	if res.OperationRunID == "" {
		t.Errorf("sync should return an operationRunId")
	}

	// The desired state is correct + carries NO secrets.
	var list desiredListResult
	h.DoJSON(http.MethodGet, "/v1/projects/"+projectID+"/desired_state", owner.AccessToken, nil, http.StatusOK, &list)
	if len(list.Items) != 1 {
		t.Fatalf("expected 1 active desired state, got %d", len(list.Items))
	}
	d := list.Items[0]
	if d.ResourceKey != "convex_deployment:"+depID || d.HostID != hostID || d.Status != "active" || d.Version != 1 {
		t.Errorf("unexpected desired state: %+v", d)
	}
	for _, secret := range []string{"adminKey", "instanceSecret", "env", "databaseUrl", "token"} {
		if _, bad := d.DesiredJSON[secret]; bad {
			t.Errorf("desired_json must not contain %q", secret)
		}
	}
	if labels, ok := d.DesiredJSON["labels"].(map[string]any); !ok || labels["synapse.deployment_id"] != depID {
		t.Errorf("desired labels wrong: %+v", d.DesiredJSON["labels"])
	}

	// OperationRun recorded as succeeded.
	var run struct {
		OperationRun models.OperationRun `json:"operationRun"`
		Steps        []any               `json:"steps"`
	}
	h.DoJSON(http.MethodGet, "/v1/operation_runs/"+res.OperationRunID, owner.AccessToken, nil, http.StatusOK, &run)
	if run.OperationRun.Status != "succeeded" || run.OperationRun.Type != "sync_desired_from_placements" {
		t.Errorf("operation run wrong: %+v", run.OperationRun)
	}

	// Idempotent: re-run changes nothing.
	var res2 syncResult
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/desired_state/sync_from_placements", owner.AccessToken, map[string]any{}, http.StatusOK, &res2)
	if res2.Created != 0 || res2.Updated != 0 || res2.Superseded != 0 || res2.Unchanged != 1 {
		t.Fatalf("second sync should be a no-op (unchanged=1), got %+v", res2)
	}
}

func TestDesiredState_SyncSupersedesOnHostChange(t *testing.T) {
	h := Setup(t)
	owner, projectID, _, hostA, depID := desiredFixture(t, h)
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/desired_state/sync_from_placements", owner.AccessToken, map[string]any{}, http.StatusOK, &syncResult{})

	// Create a second host and move the placement to it (direct UPDATE — there's
	// no move endpoint yet; the sync must reconcile the change).
	var hostB models.Host
	h.DoJSON(http.MethodPost, "/v1/hosts", owner.AccessToken, map[string]any{"name": "vps-br-2"}, http.StatusCreated, &hostB)
	if _, err := h.DB.Exec(context.Background(),
		`UPDATE deployment_placements SET host_id = $2 WHERE deployment_id = $1`, depID, hostB.ID); err != nil {
		t.Fatalf("move placement: %v", err)
	}

	var res syncResult
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/desired_state/sync_from_placements", owner.AccessToken, map[string]any{}, http.StatusOK, &res)
	if res.Created != 1 || res.Superseded != 1 {
		t.Fatalf("host change should create 1 + supersede 1, got %+v", res)
	}

	// Active desired is now on host B, not host A.
	activeA := countActiveDesired(t, h, hostA)
	activeB := countActiveDesired(t, h, hostB.ID)
	if activeA != 0 || activeB != 1 {
		t.Errorf("expected active desired on B only: A=%d B=%d", activeA, activeB)
	}
}

func countActiveDesired(t *testing.T, h *Harness, hostID string) int {
	t.Helper()
	var n int
	if err := h.DB.QueryRow(context.Background(),
		`SELECT COUNT(*) FROM desired_states WHERE host_id = $1 AND status = 'active'`, hostID).Scan(&n); err != nil {
		t.Fatalf("count desired: %v", err)
	}
	return n
}

func TestObservedState_FromHeartbeatSafe(t *testing.T) {
	h := Setup(t)
	admin, hostID, tok := mintHostToken(t, h, "vps-1")
	var reg agentRegisterResult
	h.DoJSON(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tok.Token), http.StatusCreated, &reg)

	// Heartbeat with a synapse-managed container + a NON-synapse label.
	hb := map[string]any{
		"hostname":      "vps-1.local",
		"os":            "linux",
		"arch":          "amd64",
		"agentVersion":  "test-1.0",
		"dockerVersion": "27.0",
		"cpuCores":      4,
		"memoryMb":      8192,
		"diskGb":        80,
		"observed": map[string]any{
			"dockerAvailable": true,
			"dockerVersion":   "27.0",
			"containers": []map[string]any{{
				"id":     "abc123def456",
				"name":   "convex-lush-heron-4656",
				"image":  "ghcr.io/get-convex/convex-backend",
				"state":  "running",
				"status": "Up 2 minutes",
				"labels": map[string]string{
					"synapse.managed":       "true",
					"synapse.deployment_id": "dep-xyz",
					"com.secret.token":      "SHOULD_NOT_LEAK",
				},
				"ports":     "3210/tcp",
				"createdAt": "2026-01-01T00:00:00Z",
			}},
		},
	}
	h.DoJSON(http.MethodPost, "/v1/agents/heartbeat", reg.AgentToken, hb, http.StatusOK, &map[string]any{})

	var list observedListResult
	h.DoJSON(http.MethodGet, "/v1/hosts/"+hostID+"/observed_state", admin.AccessToken, nil, http.StatusOK, &list)

	var hostFacts, container *models.ObservedState
	for i := range list.Items {
		switch list.Items[i].ResourceType {
		case "host_facts":
			hostFacts = &list.Items[i]
		case "docker_container":
			container = &list.Items[i]
		}
	}
	if hostFacts == nil || container == nil {
		t.Fatalf("expected host_facts + docker_container, got %d items", len(list.Items))
	}
	if hostFacts.ObservedJSON["hostname"] != "vps-1.local" || hostFacts.ObservedJSON["dockerAvailable"] != true {
		t.Errorf("host_facts wrong: %+v", hostFacts.ObservedJSON)
	}
	if container.ResourceKey != "docker_container:dep-xyz" {
		t.Errorf("container key wrong: %q", container.ResourceKey)
	}
	labels, ok := container.ObservedJSON["labels"].(map[string]any)
	if !ok {
		t.Fatalf("container labels missing")
	}
	if labels["synapse.managed"] != "true" {
		t.Errorf("synapse label missing")
	}
	if _, leaked := labels["com.secret.token"]; leaked {
		t.Errorf("non-synapse label leaked into observed state")
	}
	// No env / command anywhere in the observed payload.
	raw, _ := h.DB.Query(context.Background(), `SELECT observed_json::text FROM observed_states WHERE host_id = $1`, hostID)
	defer raw.Close()
	for raw.Next() {
		var s string
		_ = raw.Scan(&s)
		for _, bad := range []string{"\"env\"", "\"command\"", "SHOULD_NOT_LEAK"} {
			if strings.Contains(s, bad) {
				t.Errorf("observed_json leaked %q: %s", bad, s)
			}
		}
	}
}

func TestAgentDesiredState_HostScopedNoApply(t *testing.T) {
	h := Setup(t)
	owner, projectID, _, hostID, depID := desiredFixture(t, h)
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/desired_state/sync_from_placements", owner.AccessToken, map[string]any{}, http.StatusOK, &syncResult{})

	// Mint an adoption token for THAT host + register an agent there.
	var tok adoptionTokenResult
	h.DoJSON(http.MethodPost, "/v1/hosts/"+hostID+"/adoption_token", owner.AccessToken, map[string]any{}, http.StatusCreated, &tok)
	var reg agentRegisterResult
	h.DoJSON(http.MethodPost, "/v1/agents/register", "", agentRegisterBody(tok.Token), http.StatusCreated, &reg)

	var ds struct {
		Version      int    `json:"version"`
		Mode         string `json:"mode"`
		ApplyAllowed bool   `json:"applyAllowed"`
		Resources    []struct {
			DesiredStateID string         `json:"desiredStateId"`
			ResourceType   string         `json:"resourceType"`
			ResourceKey    string         `json:"resourceKey"`
			Version        int            `json:"version"`
			DesiredHash    string         `json:"desiredHash"`
			Desired        map[string]any `json:"desired"`
		} `json:"resources"`
	}
	h.DoJSON(http.MethodGet, "/v1/agents/desired_state", reg.AgentToken, nil, http.StatusOK, &ds)
	if ds.ApplyAllowed {
		t.Fatalf("applyAllowed MUST be false in Bloco 9")
	}
	if ds.Mode != "observe-only" {
		t.Errorf("mode = %q, want observe-only", ds.Mode)
	}
	if len(ds.Resources) != 1 || ds.Resources[0].ResourceKey != "convex_deployment:"+depID {
		t.Fatalf("agent should receive 1 host-scoped desired resource, got %+v", ds.Resources)
	}
}

func TestDesiredState_RBAC(t *testing.T) {
	h := Setup(t)
	_, projectID, _, _, _ := desiredFixture(t, h)

	// A project member (non-admin) can READ but not SYNC.
	member := h.RegisterRandomUser()
	var teamID string
	if err := h.DB.QueryRow(context.Background(), `SELECT team_id FROM projects WHERE id = $1`, projectID).Scan(&teamID); err != nil {
		t.Fatalf("resolve team: %v", err)
	}
	seedTeamMember(t, h, teamID, member.ID, "member")

	h.DoJSON(http.MethodGet, "/v1/projects/"+projectID+"/desired_state", member.AccessToken, nil, http.StatusOK, &desiredListResult{})
	h.AssertStatus(http.MethodPost, "/v1/projects/"+projectID+"/desired_state/sync_from_placements", member.AccessToken, map[string]any{}, http.StatusForbidden)

	// A stranger (no membership) can't read.
	stranger := h.RegisterRandomUser()
	h.AssertStatus(http.MethodGet, "/v1/projects/"+projectID+"/desired_state", stranger.AccessToken, nil, http.StatusForbidden)
}
