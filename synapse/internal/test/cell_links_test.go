package synapsetest

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/Iann29/synapse/internal/models"
)

// Cell links + service tokens (feat/cell-control-plane, Bloco 7).

func createCellViaAPI(t *testing.T, h *Harness, bearer, projectID, name, kind string) models.Cell {
	t.Helper()
	var c models.Cell
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/cells", bearer,
		map[string]any{"name": name, "kind": kind, "environment": "prod", "region": "br"},
		http.StatusCreated, &c)
	return c
}

type discoveryResult struct {
	SourceCellID string `json:"sourceCellId"`
	Links        []struct {
		LinkID       string `json:"linkId"`
		TargetCellID string `json:"targetCellId"`
		TargetCell   struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			Kind        string `json:"kind"`
			Environment string `json:"environment"`
		} `json:"targetCell"`
		Protocol        string   `json:"protocol"`
		AuthMode        string   `json:"authMode"`
		AllowedCommands []string `json:"allowedCommands"`
		AllowedEvents   []string `json:"allowedEvents"`
		Endpoint        *string  `json:"endpoint"`
		EndpointSource  string   `json:"endpointSource"`
	} `json:"links"`
}

// linkFixture sets up an owner + project + a core and runtime cell.
func linkFixture(t *testing.T, h *Harness) (owner *User, projectID string, core, runtime models.Cell) {
	t.Helper()
	owner = h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Amage IA")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "amagejumpy")
	core = createCellViaAPI(t, h, owner.AccessToken, proj.ID, "core-prod-br-1", "core")
	runtime = createCellViaAPI(t, h, owner.AccessToken, proj.ID, "runtime-prod-br-1", "runtime")
	return owner, proj.ID, core, runtime
}

func TestCellLinks_CreateAndList(t *testing.T) {
	h := Setup(t)
	owner, projectID, core, runtime := linkFixture(t, h)

	var link models.CellLink
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/cell_links", owner.AccessToken, map[string]any{
		"sourceCellId":    core.ID,
		"targetCellId":    runtime.ID,
		"protocol":        "outbox",
		"authMode":        "service_token",
		"allowedCommands": []string{"runtime.runAutomation", "runtime.cancelRun"},
		"allowedEvents":   []string{"runtime.runStarted", "runtime.runCompleted", "runtime.runFailed"},
	}, http.StatusCreated, &link)

	if link.SourceCellID != core.ID || link.TargetCellID != runtime.ID {
		t.Fatalf("link endpoints wrong: %+v", link)
	}
	if link.Protocol != "outbox" || link.Status != models.CellLinkStatusActive {
		t.Errorf("unexpected link: %+v", link)
	}
	if len(link.AllowedCommands) != 2 || len(link.AllowedEvents) != 3 {
		t.Errorf("allowed lists wrong: cmds=%v events=%v", link.AllowedCommands, link.AllowedEvents)
	}

	var list listCellLinksResult
	h.DoJSON(http.MethodGet, "/v1/projects/"+projectID+"/cell_links", owner.AccessToken, nil, http.StatusOK, &list)
	if len(list.Items) != 1 || list.Items[0].ID != link.ID {
		t.Fatalf("expected the created link in the list, got %+v", list.Items)
	}
}

type listCellLinksResult struct {
	Items []models.CellLink `json:"items"`
}

func TestCellLinks_BlocksSelfLink(t *testing.T) {
	h := Setup(t)
	owner, projectID, core, _ := linkFixture(t, h)
	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+projectID+"/cell_links", owner.AccessToken,
		map[string]any{"sourceCellId": core.ID, "targetCellId": core.ID}, http.StatusBadRequest)
	if env.Code != "self_link" {
		t.Errorf("code = %q, want self_link", env.Code)
	}
}

func TestCellLinks_BlocksCrossProject(t *testing.T) {
	h := Setup(t)
	owner, projectAID, coreA, _ := linkFixture(t, h)
	// A second project (same owner) with its own cell.
	team := createTeam(t, h, owner.AccessToken, "Other Co")
	projB := createProject(t, h, owner.AccessToken, team.Slug, "proj-b")
	cellB := createCellViaAPI(t, h, owner.AccessToken, projB.ID, "core-b", "core")

	// Linking project A's cell to project B's cell, under project A → blocked.
	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+projectAID+"/cell_links", owner.AccessToken,
		map[string]any{"sourceCellId": coreA.ID, "targetCellId": cellB.ID}, http.StatusBadRequest)
	if env.Code != "invalid_cell" {
		t.Errorf("code = %q, want invalid_cell", env.Code)
	}
}

func TestCellLinks_BlocksDuplicateActiveButAllowsAfterDisable(t *testing.T) {
	h := Setup(t)
	owner, projectID, core, runtime := linkFixture(t, h)
	body := map[string]any{"sourceCellId": core.ID, "targetCellId": runtime.ID, "protocol": "outbox"}

	var first models.CellLink
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/cell_links", owner.AccessToken, body, http.StatusCreated, &first)

	// Duplicate active (same source+target+protocol) → 409.
	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+projectID+"/cell_links", owner.AccessToken, body, http.StatusConflict)
	if env.Code != "link_already_exists" {
		t.Errorf("code = %q, want link_already_exists", env.Code)
	}

	// Disable the first → the (source,target,protocol) slot frees up.
	h.DoJSON(http.MethodPost, "/v1/cell_links/"+first.ID+"/disable", owner.AccessToken, map[string]any{}, http.StatusOK, &models.CellLink{})
	// Now an identical link can be created again.
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/cell_links", owner.AccessToken, body, http.StatusCreated, &models.CellLink{})
}

func TestServiceToken_CreateHashOnlyAndRevoke(t *testing.T) {
	h := Setup(t)
	owner, projectID, core, runtime := linkFixture(t, h)
	var link models.CellLink
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/cell_links", owner.AccessToken,
		map[string]any{"sourceCellId": core.ID, "targetCellId": runtime.ID}, http.StatusCreated, &link)

	var tok models.ServiceToken
	h.DoJSON(http.MethodPost, "/v1/cell_links/"+link.ID+"/service_tokens", owner.AccessToken,
		map[string]any{"name": "core→runtime", "scopes": []string{"commands:send"}}, http.StatusCreated, &tok)

	if !strings.HasPrefix(tok.Token, "syn_svc_") {
		t.Errorf("service token should carry syn_svc_ prefix, got %q", tok.Token)
	}
	// Stored as hash only.
	var hash string
	if err := h.DB.QueryRow(context.Background(),
		`SELECT token_hash FROM service_tokens WHERE id = $1`, tok.ID).Scan(&hash); err != nil {
		t.Fatalf("query token hash: %v", err)
	}
	if hash == "" || hash == tok.Token {
		t.Errorf("token must be stored hashed, not plaintext")
	}

	// List never exposes the plaintext.
	var list struct {
		Items []models.ServiceToken `json:"items"`
	}
	h.DoJSON(http.MethodGet, "/v1/cell_links/"+link.ID+"/service_tokens", owner.AccessToken, nil, http.StatusOK, &list)
	if len(list.Items) != 1 || list.Items[0].Token != "" {
		t.Fatalf("list should show 1 token without plaintext, got %+v", list.Items)
	}

	// Revoke.
	h.DoJSON(http.MethodPost, "/v1/service_tokens/"+tok.ID+"/revoke", owner.AccessToken, map[string]any{}, http.StatusOK, &map[string]any{})
	var status string
	_ = h.DB.QueryRow(context.Background(), `SELECT status FROM service_tokens WHERE id = $1`, tok.ID).Scan(&status)
	if status != models.ServiceTokenStatusRevoked {
		t.Errorf("token status = %q, want revoked", status)
	}
}

func TestDiscovery_ActiveTokenReturnsAllowedLinks(t *testing.T) {
	h := Setup(t)
	owner, projectID, core, runtime := linkFixture(t, h)
	var link models.CellLink
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/cell_links", owner.AccessToken, map[string]any{
		"sourceCellId":    core.ID,
		"targetCellId":    runtime.ID,
		"protocol":        "outbox",
		"allowedCommands": []string{"runtime.runAutomation", "runtime.cancelRun"},
		"allowedEvents":   []string{"runtime.runStarted"},
	}, http.StatusCreated, &link)

	var tok models.ServiceToken
	h.DoJSON(http.MethodPost, "/v1/cell_links/"+link.ID+"/service_tokens", owner.AccessToken,
		map[string]any{"name": "t"}, http.StatusCreated, &tok)

	// Discovery authenticated by the service token (no JWT).
	var disc discoveryResult
	h.DoJSON(http.MethodGet, "/v1/internal/cell_links/discovery", tok.Token, nil, http.StatusOK, &disc)
	if disc.SourceCellID != core.ID {
		t.Errorf("discovery sourceCellId = %q, want %q", disc.SourceCellID, core.ID)
	}
	if len(disc.Links) != 1 {
		t.Fatalf("expected 1 discoverable link, got %d", len(disc.Links))
	}
	dl := disc.Links[0]
	if dl.TargetCellID != runtime.ID || dl.TargetCell.Name != "runtime-prod-br-1" || dl.TargetCell.Kind != "runtime" {
		t.Errorf("target cell wrong: %+v", dl.TargetCell)
	}
	if len(dl.AllowedCommands) != 2 || dl.Endpoint != nil {
		t.Errorf("link payload wrong: cmds=%v endpoint=%v", dl.AllowedCommands, dl.Endpoint)
	}
}

func TestDiscovery_RevokedAndExpiredTokensFail(t *testing.T) {
	h := Setup(t)
	owner, projectID, core, runtime := linkFixture(t, h)
	var link models.CellLink
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/cell_links", owner.AccessToken,
		map[string]any{"sourceCellId": core.ID, "targetCellId": runtime.ID}, http.StatusCreated, &link)

	// Revoked token → 401.
	var revoked models.ServiceToken
	h.DoJSON(http.MethodPost, "/v1/cell_links/"+link.ID+"/service_tokens", owner.AccessToken, map[string]any{}, http.StatusCreated, &revoked)
	h.DoJSON(http.MethodPost, "/v1/service_tokens/"+revoked.ID+"/revoke", owner.AccessToken, map[string]any{}, http.StatusOK, &map[string]any{})
	h.AssertStatus(http.MethodGet, "/v1/internal/cell_links/discovery", revoked.Token, nil, http.StatusUnauthorized)

	// Expired token → 401.
	var expired models.ServiceToken
	h.DoJSON(http.MethodPost, "/v1/cell_links/"+link.ID+"/service_tokens", owner.AccessToken, map[string]any{}, http.StatusCreated, &expired)
	if _, err := h.DB.Exec(context.Background(),
		`UPDATE service_tokens SET expires_at = now() - interval '1 hour' WHERE id = $1`, expired.ID); err != nil {
		t.Fatalf("expire token: %v", err)
	}
	h.AssertStatus(http.MethodGet, "/v1/internal/cell_links/discovery", expired.Token, nil, http.StatusUnauthorized)

	// No bearer → 401.
	h.AssertStatus(http.MethodGet, "/v1/internal/cell_links/discovery", "", nil, http.StatusUnauthorized)
}

func TestDiscovery_IsLinkScoped(t *testing.T) {
	h := Setup(t)
	owner, projectID, core, runtime := linkFixture(t, h)
	// A second target cell + a second link from the SAME source (core).
	integration := createCellViaAPI(t, h, owner.AccessToken, projectID, "integration-prod-br-1", "integration")

	var linkRuntime, linkIntegration models.CellLink
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/cell_links", owner.AccessToken,
		map[string]any{"sourceCellId": core.ID, "targetCellId": runtime.ID, "protocol": "outbox"}, http.StatusCreated, &linkRuntime)
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/cell_links", owner.AccessToken,
		map[string]any{"sourceCellId": core.ID, "targetCellId": integration.ID, "protocol": "outbox"}, http.StatusCreated, &linkIntegration)

	// A token for the runtime link must ONLY discover the runtime link.
	var tok models.ServiceToken
	h.DoJSON(http.MethodPost, "/v1/cell_links/"+linkRuntime.ID+"/service_tokens", owner.AccessToken, map[string]any{}, http.StatusCreated, &tok)

	var disc discoveryResult
	h.DoJSON(http.MethodGet, "/v1/internal/cell_links/discovery", tok.Token, nil, http.StatusOK, &disc)
	if len(disc.Links) != 1 {
		t.Fatalf("link-scoped discovery should return exactly 1 link, got %d", len(disc.Links))
	}
	if disc.Links[0].LinkID != linkRuntime.ID || disc.Links[0].TargetCellID != runtime.ID {
		t.Errorf("token leaked a different link: %+v", disc.Links[0])
	}
}

func TestDiscovery_RequiresDiscoveryReadScope(t *testing.T) {
	h := Setup(t)
	owner, projectID, core, runtime := linkFixture(t, h)
	var link models.CellLink
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/cell_links", owner.AccessToken,
		map[string]any{"sourceCellId": core.ID, "targetCellId": runtime.ID}, http.StatusCreated, &link)

	// A token scoped to commands:send only (no discovery:read).
	var tok models.ServiceToken
	h.DoJSON(http.MethodPost, "/v1/cell_links/"+link.ID+"/service_tokens", owner.AccessToken,
		map[string]any{"scopes": []string{"commands:send"}}, http.StatusCreated, &tok)

	env := h.AssertStatus(http.MethodGet, "/v1/internal/cell_links/discovery", tok.Token, nil, http.StatusForbidden)
	if env.Code != "insufficient_scope" {
		t.Errorf("code = %q, want insufficient_scope", env.Code)
	}
}

func TestServiceToken_DefaultScopeAndExpiredEffectiveStatus(t *testing.T) {
	h := Setup(t)
	owner, projectID, core, runtime := linkFixture(t, h)
	var link models.CellLink
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/cell_links", owner.AccessToken,
		map[string]any{"sourceCellId": core.ID, "targetCellId": runtime.ID}, http.StatusCreated, &link)

	// No scopes → default discovery:read.
	var tok models.ServiceToken
	h.DoJSON(http.MethodPost, "/v1/cell_links/"+link.ID+"/service_tokens", owner.AccessToken, map[string]any{}, http.StatusCreated, &tok)
	if len(tok.Scopes) != 1 || tok.Scopes[0] != "discovery:read" {
		t.Errorf("default scope should be [discovery:read], got %v", tok.Scopes)
	}
	if tok.EffectiveStatus != "active" {
		t.Errorf("fresh token effectiveStatus = %q, want active", tok.EffectiveStatus)
	}

	// Force-expire it; the list must report effectiveStatus=expired even though
	// the stored status is still active.
	if _, err := h.DB.Exec(context.Background(),
		`UPDATE service_tokens SET expires_at = now() - interval '1 hour' WHERE id = $1`, tok.ID); err != nil {
		t.Fatalf("expire token: %v", err)
	}
	var list struct {
		Items []models.ServiceToken `json:"items"`
	}
	h.DoJSON(http.MethodGet, "/v1/cell_links/"+link.ID+"/service_tokens", owner.AccessToken, nil, http.StatusOK, &list)
	if len(list.Items) != 1 {
		t.Fatalf("expected 1 token, got %d", len(list.Items))
	}
	if list.Items[0].Status != "active" || list.Items[0].EffectiveStatus != "expired" {
		t.Errorf("expected stored=active effective=expired, got stored=%q effective=%q",
			list.Items[0].Status, list.Items[0].EffectiveStatus)
	}
}

func TestServiceToken_AuthModeMustBeServiceToken(t *testing.T) {
	h := Setup(t)
	owner, projectID, core, runtime := linkFixture(t, h)
	for _, mode := range []string{"mtls", "none"} {
		var link models.CellLink
		h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/cell_links", owner.AccessToken,
			map[string]any{"sourceCellId": core.ID, "targetCellId": runtime.ID, "protocol": "http", "authMode": mode},
			http.StatusCreated, &link)
		env := h.AssertStatus(http.MethodPost, "/v1/cell_links/"+link.ID+"/service_tokens", owner.AccessToken,
			map[string]any{}, http.StatusBadRequest)
		if env.Code != "auth_mode_not_token" {
			t.Errorf("authMode=%s: code = %q, want auth_mode_not_token", mode, env.Code)
		}
		// Clean up so the next iteration's link doesn't hit the active-uniq
		// constraint (different protocol per iteration avoids it anyway).
		h.DoJSON(http.MethodPost, "/v1/cell_links/"+link.ID+"/disable", owner.AccessToken, map[string]any{}, http.StatusOK, &models.CellLink{})
	}
}

func TestDiscovery_EndpointFromRoute(t *testing.T) {
	h := Setup(t)
	owner, projectID, core, runtime := linkFixture(t, h)
	// Give the runtime cell a primary deployment with an active custom domain.
	depID := h.SeedDeployment(projectID, "runtime-backend", "prod", "running", true, owner.ID, 3401, "")
	h.DoJSON(http.MethodPost, "/v1/cells/"+runtime.ID+"/attach_deployment", owner.AccessToken,
		map[string]any{"deploymentName": "runtime-backend"}, http.StatusOK, &attachResp{})
	seedActiveDomain(t, h, depID, "runtime.example.com", "api")

	var link models.CellLink
	h.DoJSON(http.MethodPost, "/v1/projects/"+projectID+"/cell_links", owner.AccessToken,
		map[string]any{"sourceCellId": core.ID, "targetCellId": runtime.ID}, http.StatusCreated, &link)
	var tok models.ServiceToken
	h.DoJSON(http.MethodPost, "/v1/cell_links/"+link.ID+"/service_tokens", owner.AccessToken, map[string]any{}, http.StatusCreated, &tok)

	var disc discoveryResult
	h.DoJSON(http.MethodGet, "/v1/internal/cell_links/discovery", tok.Token, nil, http.StatusOK, &disc)
	if len(disc.Links) != 1 {
		t.Fatalf("expected 1 link, got %d", len(disc.Links))
	}
	dl := disc.Links[0]
	if dl.EndpointSource != "route" || dl.Endpoint == nil || *dl.Endpoint != "https://runtime.example.com" {
		t.Errorf("endpoint resolution wrong: source=%q endpoint=%v", dl.EndpointSource, dl.Endpoint)
	}
}

func TestCellLinks_RBAC(t *testing.T) {
	h := Setup(t)
	_, projectID, core, runtime := linkFixture(t, h)
	// A stranger with valid auth but no membership in the owner's team.
	stranger := h.RegisterRandomUser()
	h.AssertStatus(http.MethodPost, "/v1/projects/"+projectID+"/cell_links", stranger.AccessToken,
		map[string]any{"sourceCellId": core.ID, "targetCellId": runtime.ID}, http.StatusForbidden)
	h.AssertStatus(http.MethodGet, "/v1/projects/"+projectID+"/cell_links", stranger.AccessToken, nil, http.StatusForbidden)
}
