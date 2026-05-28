package synapsetest

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Iann29/synapse/internal/audit"
	"github.com/Iann29/synapse/internal/cells"
	"github.com/Iann29/synapse/internal/models"
)

// Cell Control Plane — Bloco 1 acceptance tests (feat/cell-control-plane).
//
// Covers the criteria the implementation plan committed to:
//   - create host (+ instance-admin gate)
//   - create cell (incl. kind=runtime without a deployment)
//   - attach deployment to a cell
//   - backfill idempotence
//   - existing deployments keep working after backfill

// TODO: no happy-path test exists for PATCH /v1/hosts/{id} (audit.ActionUpdateHost)
// TODO: no happy-path test exists for POST  /v1/hosts/{id}/drain (audit.ActionDrainHost)
// TODO: no happy-path test exists for PATCH /v1/cells/{id} (audit.ActionUpdateCell)
// TODO: no happy-path test exists for POST  /v1/cells/{id}/drain (audit.ActionDrainCell)

// assertAuditEvent polls audit_events for up to 2s for a row matching
// action+actor+target. Direct SQL (not the team-scoped /audit_log endpoint)
// because instance-scoped CCP events — hosts, host agents — carry no team_id
// and therefore never surface in that feed. audit.Record is best-effort, so a
// tight assertion would flake under load; the bounded poll buys us
// determinism without slowing the green path.
func assertAuditEvent(t *testing.T, h *Harness, action, actorID, targetType, targetID string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for {
		var n int
		if err := h.DB.QueryRow(h.rootCtx, `
			SELECT count(*) FROM audit_events
			 WHERE action = $1 AND actor_id::text = $2
			   AND target_type = $3 AND target_id::text = $4`,
			action, actorID, targetType, targetID,
		).Scan(&n); err != nil {
			t.Fatalf("query audit_events: %v", err)
		}
		if n > 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("audit_event missing: action=%s actor=%s target=%s/%s",
				action, actorID, targetType, targetID)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

type hostsListResp struct {
	Items []models.Host `json:"items"`
}

type cellsListResp struct {
	Items []models.Cell `json:"items"`
}

type adoptionTokenResp struct {
	Token       string  `json:"token"`
	ID          string  `json:"id"`
	HostID      string  `json:"hostId"`
	Name        string  `json:"name,omitempty"`
	ExpiresAt   *string `json:"expiresAt,omitempty"`
	JoinCommand string  `json:"joinCommand"`
}

type attachResp struct {
	Cell      models.Cell                `json:"cell"`
	Placement models.DeploymentPlacement `json:"placement"`
}

// ---------- Hosts ----------

func TestHosts_CreateListGet(t *testing.T) {
	h := Setup(t)
	admin := h.RegisterRandomUser() // first user in a fresh DB is the instance admin

	if !admin.IsInstanceAdmin {
		t.Fatalf("expected first registered user to be instance admin")
	}

	var created models.Host
	h.DoJSON(http.MethodPost, "/v1/hosts", admin.AccessToken, map[string]any{
		"name":     "vps-br-1",
		"provider": "hostinger",
		"region":   "br",
		"publicIp": "203.0.113.10",
		"labels":   map[string]string{"tier": "prod"},
	}, http.StatusCreated, &created)

	if created.ID == "" || created.Name != "vps-br-1" || created.Provider != "hostinger" || created.Region != "br" {
		t.Fatalf("unexpected host: %+v", created)
	}
	if created.Status != models.HostStatusUnknown {
		t.Errorf("manually-created host should start status=unknown, got %q", created.Status)
	}
	if created.IsSynapseHost {
		t.Errorf("manually-created host should not be the synapse host")
	}
	if created.Labels["tier"] != "prod" {
		t.Errorf("labels not round-tripped: %+v", created.Labels)
	}

	// Phase 4: migration 000026 self-seeds the is_synapse_host row, so
	// listing /v1/hosts now returns BOTH the self-host AND vps-br-1.
	// Filter to assert the created one exists, not exclusivity.
	var list hostsListResp
	h.DoJSON(http.MethodGet, "/v1/hosts", admin.AccessToken, nil, http.StatusOK, &list)
	found := false
	for _, h := range list.Items {
		if h.ID == created.ID {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("created host not in /v1/hosts list, got %+v", list.Items)
	}

	var got models.Host
	h.DoJSON(http.MethodGet, "/v1/hosts/"+created.ID, admin.AccessToken, nil, http.StatusOK, &got)
	if got.ID != created.ID {
		t.Fatalf("get host id mismatch: %s != %s", got.ID, created.ID)
	}
	assertAuditEvent(t, h, audit.ActionCreateHost, admin.ID, audit.TargetHost, created.ID)
}

func TestHosts_RequireInstanceAdmin(t *testing.T) {
	h := Setup(t)
	_ = h.RegisterRandomUser()         // first user = instance admin (not used here)
	stranger := h.RegisterRandomUser() // second user = NOT instance admin
	if stranger.IsInstanceAdmin {
		t.Fatalf("second registered user should not be instance admin")
	}

	// Non-admin: create + list both blocked.
	h.AssertStatus(http.MethodPost, "/v1/hosts", stranger.AccessToken,
		map[string]any{"name": "sneaky"}, http.StatusForbidden)
	h.AssertStatus(http.MethodGet, "/v1/hosts", stranger.AccessToken, nil, http.StatusForbidden)

	// Unauthenticated is rejected before the admin gate.
	h.AssertStatus(http.MethodGet, "/v1/hosts", "", nil, http.StatusUnauthorized)
}

func TestHosts_AdoptionToken(t *testing.T) {
	h := Setup(t)
	admin := h.RegisterRandomUser()

	var host models.Host
	h.DoJSON(http.MethodPost, "/v1/hosts", admin.AccessToken,
		map[string]any{"name": "vps-runtime-br-1"}, http.StatusCreated, &host)

	var tok adoptionTokenResp
	h.DoJSON(http.MethodPost, "/v1/hosts/"+host.ID+"/adoption_token", admin.AccessToken,
		map[string]any{"name": "first-join"}, http.StatusCreated, &tok)

	if tok.Token == "" {
		t.Fatalf("adoption token plaintext should be returned once")
	}
	if tok.HostID != host.ID {
		t.Errorf("token host id mismatch: %s != %s", tok.HostID, host.ID)
	}
	if !strings.Contains(tok.JoinCommand, tok.Token) || !strings.Contains(tok.JoinCommand, "synapse-agent join") {
		t.Errorf("join command missing token or verb: %q", tok.JoinCommand)
	}
	// Stored only as a hash — the plaintext must not be readable back out.
	var hashed string
	if err := h.DB.QueryRow(context.Background(),
		`SELECT token_hash FROM host_adoption_tokens WHERE id = $1`, tok.ID).Scan(&hashed); err != nil {
		t.Fatalf("query token hash: %v", err)
	}
	if hashed == "" || hashed == tok.Token {
		t.Errorf("token must be stored hashed, not plaintext")
	}
}

// ---------- Cells ----------

func TestCells_CreateRuntimeWithoutDeployment(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Amage IA")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "amagejumpy")

	// Acceptance: create a kind=runtime Cell with no deployment attached yet.
	var cell models.Cell
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/cells", owner.AccessToken, map[string]any{
		"name":        "runtime-prod-br-1",
		"kind":        "runtime",
		"environment": "prod",
		"region":      "br",
	}, http.StatusCreated, &cell)

	if cell.Kind != models.CellKindRuntime || cell.Environment != models.CellEnvProd {
		t.Fatalf("unexpected cell: %+v", cell)
	}
	if cell.PrimaryDeploymentID != nil {
		t.Errorf("runtime cell should have no primary deployment yet")
	}
	if cell.Slug != "runtime-prod-br-1" {
		t.Errorf("slug mismatch: %q", cell.Slug)
	}

	// It shows up in the project-scoped list.
	var list cellsListResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/cells", owner.AccessToken, nil, http.StatusOK, &list)
	if len(list.Items) != 1 || list.Items[0].ID != cell.ID {
		t.Fatalf("expected created cell in list, got %+v", list.Items)
	}

	// Invalid kind is rejected.
	h.AssertStatus(http.MethodPost, "/v1/projects/"+proj.ID+"/cells", owner.AccessToken,
		map[string]any{"name": "bad", "kind": "wat"}, http.StatusBadRequest)
	assertAuditEvent(t, h, audit.ActionCreateCell, owner.ID, audit.TargetCell, cell.ID)
}

func TestCells_AttachDeployment(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Amage IA")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "amagejumpy")
	depID := h.SeedDeployment(proj.ID, "lush-heron-4656", "prod", "running", true, owner.ID, 3300, "")

	var cell models.Cell
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/cells", owner.AccessToken,
		map[string]any{"name": "core-prod-br-1", "kind": "core", "environment": "prod", "region": "br"},
		http.StatusCreated, &cell)

	var att attachResp
	h.DoJSON(http.MethodPost, "/v1/cells/"+cell.ID+"/attach_deployment", owner.AccessToken,
		map[string]any{"deploymentName": "lush-heron-4656"}, http.StatusOK, &att)

	if att.Cell.PrimaryDeploymentID == nil || *att.Cell.PrimaryDeploymentID != depID {
		t.Fatalf("attach should set primary_deployment_id to %s, got %+v", depID, att.Cell.PrimaryDeploymentID)
	}
	if att.Placement.DeploymentID != depID || att.Placement.CellID != cell.ID {
		t.Fatalf("placement wrong: %+v", att.Placement)
	}
	if att.Placement.DesiredStatus != models.PlacementDesiredRunning || att.Placement.ObservedStatus != models.PlacementObservedRunning {
		t.Errorf("placement status wrong: desired=%s observed=%s", att.Placement.DesiredStatus, att.Placement.ObservedStatus)
	}

	// Double-attach of the same deployment → 409 (a deployment lives in one cell).
	h.AssertStatus(http.MethodPost, "/v1/cells/"+cell.ID+"/attach_deployment", owner.AccessToken,
		map[string]any{"deploymentName": "lush-heron-4656"}, http.StatusConflict)

	// resources endpoint reflects the attach.
	var res struct {
		Resources  []models.CellResource        `json:"resources"`
		Placements []models.DeploymentPlacement `json:"placements"`
	}
	h.DoJSON(http.MethodGet, "/v1/cells/"+cell.ID+"/resources", owner.AccessToken, nil, http.StatusOK, &res)
	if len(res.Resources) != 1 || res.Resources[0].ResourceID != depID || len(res.Placements) != 1 {
		t.Fatalf("resources/placements not reflecting attach: %+v / %+v", res.Resources, res.Placements)
	}
	assertAuditEvent(t, h, audit.ActionAttachDeploymentToCell, owner.ID, audit.TargetCell, cell.ID)
}

func TestCells_AttachDeployment_WrongProject(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Amage IA")
	projA := createProject(t, h, owner.AccessToken, team.Slug, "project-a")
	projB := createProject(t, h, owner.AccessToken, team.Slug, "project-b")
	// Deployment belongs to project B.
	_ = h.SeedDeployment(projB.ID, "brave-dolphin-1060", "dev", "running", false, owner.ID, 3310, "")

	var cell models.Cell
	h.DoJSON(http.MethodPost, "/v1/projects/"+projA.ID+"/cells", owner.AccessToken,
		map[string]any{"name": "core-dev-br-1"}, http.StatusCreated, &cell)

	// Attaching project B's deployment to project A's cell is rejected.
	env := h.AssertStatus(http.MethodPost, "/v1/cells/"+cell.ID+"/attach_deployment", owner.AccessToken,
		map[string]any{"deploymentName": "brave-dolphin-1060"}, http.StatusBadRequest)
	if env.Code != "deployment_wrong_project" {
		t.Errorf("expected deployment_wrong_project, got %q", env.Code)
	}
}

func TestCells_AttachDeployment_CrossTeamIsNotFound(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser() // team 1 (also instance admin — must NOT bypass project RBAC here)
	team := createTeam(t, h, owner.AccessToken, "Amage IA")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "amagejumpy")
	var cell models.Cell
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/cells", owner.AccessToken,
		map[string]any{"name": "core-prod-br-1"}, http.StatusCreated, &cell)

	// A different user owns a different team + project + deployment.
	stranger := h.RegisterRandomUser()
	otherTeam := createTeam(t, h, stranger.AccessToken, "Other Co")
	otherProj := createProject(t, h, stranger.AccessToken, otherTeam.Slug, "other-proj")
	h.SeedDeployment(otherProj.ID, "foreign-dep-0001", "prod", "running", true, stranger.ID, 3340, "")

	// Attaching a deployment from a team the caller can't see must NOT reveal
	// that the deployment exists — it returns the same 404 as a bogus name,
	// not a 400 "wrong project". (Even though owner is the instance admin,
	// that role manages hosts/infra, not arbitrary project data.)
	env := h.AssertStatus(http.MethodPost, "/v1/cells/"+cell.ID+"/attach_deployment", owner.AccessToken,
		map[string]any{"deploymentName": "foreign-dep-0001"}, http.StatusNotFound)
	if env.Code != "deployment_not_found" {
		t.Errorf("cross-team attach should look like not-found, got %q", env.Code)
	}
}

// ---------- Backfill ----------

func TestBackfill_Idempotent(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Amage IA")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "amagejumpy")

	// The two deployments from the deliverable example.
	devID := h.SeedDeployment(proj.ID, "brave-dolphin-1060", "dev", "running", false, owner.ID, 3320, "")
	prodID := h.SeedDeployment(proj.ID, "lush-heron-4656", "prod", "running", true, owner.ID, 3321, "")

	ctx := context.Background()
	res, err := cells.Backfill(ctx, h.DB, cells.BackfillOpts{Region: "br"})
	if err != nil {
		t.Fatalf("first backfill: %v", err)
	}
	// Phase 4: migration 000026 may have self-seeded the self-host
	// already; cells.Backfill is idempotent on the host row but creates
	// the cells. Accept either {HostCreated: true OR pre-existing} as
	// long as the 2 cells got created on the first run.
	if res.CellsCreated != 2 {
		t.Fatalf("first backfill should create 2 cells, got %+v", res)
	}

	// Second run is a no-op: no new host, no new cells.
	res2, err := cells.Backfill(ctx, h.DB, cells.BackfillOpts{Region: "br"})
	if err != nil {
		t.Fatalf("second backfill: %v", err)
	}
	if res2.HostCreated || res2.CellsCreated != 0 || res2.CellsExisting != 2 {
		t.Fatalf("second backfill should be idempotent, got %+v", res2)
	}

	// Exactly two cells, named + wired per the deliverable example:
	//   core-dev-br-1  -> brave-dolphin-1060
	//   core-prod-br-1 -> lush-heron-4656
	var list cellsListResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/cells", owner.AccessToken, nil, http.StatusOK, &list)
	if len(list.Items) != 2 {
		t.Fatalf("expected 2 backfilled cells, got %d: %+v", len(list.Items), list.Items)
	}
	byName := map[string]models.Cell{}
	for _, c := range list.Items {
		byName[c.Name] = c
	}
	dev, okDev := byName["core-dev-br-1"]
	prod, okProd := byName["core-prod-br-1"]
	if !okDev || !okProd {
		t.Fatalf("expected core-dev-br-1 and core-prod-br-1, got %v", byName)
	}
	if dev.PrimaryDeploymentID == nil || *dev.PrimaryDeploymentID != devID {
		t.Errorf("core-dev-br-1 should point at brave-dolphin-1060 (%s), got %+v", devID, dev.PrimaryDeploymentID)
	}
	if prod.PrimaryDeploymentID == nil || *prod.PrimaryDeploymentID != prodID {
		t.Errorf("core-prod-br-1 should point at lush-heron-4656 (%s), got %+v", prodID, prod.PrimaryDeploymentID)
	}
	for _, c := range []models.Cell{dev, prod} {
		if c.Kind != models.CellKindCore {
			t.Errorf("%s should be kind=core, got %q", c.Name, c.Kind)
		}
		if c.PrimaryHostID == nil || *c.PrimaryHostID != res.HostID {
			t.Errorf("%s should be placed on the synapse host %s, got %+v", c.Name, res.HostID, c.PrimaryHostID)
		}
	}

	// Only one host exists after two backfills (the synapse self-host).
	var hosts hostsListResp
	h.DoJSON(http.MethodGet, "/v1/hosts", owner.AccessToken, nil, http.StatusOK, &hosts)
	if len(hosts.Items) != 1 || !hosts.Items[0].IsSynapseHost {
		t.Fatalf("expected exactly one synapse host after backfill, got %+v", hosts.Items)
	}
}

func TestBackfill_ExistingDeploymentsStillWork(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Amage IA")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "amagejumpy")
	h.SeedDeployment(proj.ID, "lush-heron-4656", "prod", "running", true, owner.ID, 3330, "")

	// Run the backfill (additive layer on top of deployments).
	if _, err := cells.Backfill(context.Background(), h.DB, cells.BackfillOpts{Region: "br"}); err != nil {
		t.Fatalf("backfill: %v", err)
	}

	// The pre-existing deployment listing endpoint still works and still
	// returns the deployment — the new layer didn't disturb it.
	resp := h.Do(http.MethodGet, "/v1/projects/"+proj.ID+"/list_deployments", owner.AccessToken, nil)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list_deployments status=%d", resp.StatusCode)
	}
	buf := make([]byte, 1<<16)
	n, _ := resp.Body.Read(buf)
	if !strings.Contains(string(buf[:n]), "lush-heron-4656") {
		t.Fatalf("existing deployment missing from list_deployments after backfill")
	}

	// And the deployment is still individually resolvable.
	h.AssertStatus(http.MethodGet, "/v1/deployments/lush-heron-4656", owner.AccessToken, nil, http.StatusOK)
}
