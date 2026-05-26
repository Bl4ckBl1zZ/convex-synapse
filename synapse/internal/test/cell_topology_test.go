package synapsetest

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/Iann29/synapse/internal/models"
)

// Real Cell Control Plane topology (feat/cell-control-plane, Bloco 8).

type ctRoute struct {
	Domain string `json:"domain"`
	Role   string `json:"role"`
	Status string `json:"status"`
}

type ctPlacement struct {
	HostID         *string `json:"hostId,omitempty"`
	CellID         string  `json:"cellId"`
	DesiredStatus  string  `json:"desiredStatus"`
	ObservedStatus string  `json:"observedStatus"`
}

type ctDeployment struct {
	ID        string       `json:"id"`
	Name      string       `json:"name"`
	Type      string       `json:"type"`
	Status    string       `json:"status"`
	URL       string       `json:"url,omitempty"`
	Adopted   bool         `json:"adopted"`
	Placement *ctPlacement `json:"placement,omitempty"`
	Routes    []ctRoute    `json:"routes"`
}

type ctLinkRef struct {
	ID           string `json:"id"`
	SourceCellID string `json:"sourceCellId"`
	TargetCellID string `json:"targetCellId"`
	Protocol     string `json:"protocol"`
	Status       string `json:"status"`
}

type ctCell struct {
	ID                  string         `json:"id"`
	Name                string         `json:"name"`
	Slug                string         `json:"slug"`
	Kind                string         `json:"kind"`
	Environment         string         `json:"environment"`
	Region              string         `json:"region"`
	IsolationTier       string         `json:"isolationTier"`
	Status              string         `json:"status"`
	PrimaryDeploymentID *string        `json:"primaryDeploymentId,omitempty"`
	PrimaryHostID       *string        `json:"primaryHostId,omitempty"`
	Deployments         []ctDeployment `json:"deployments"`
	Routes              []ctRoute      `json:"routes"`
	OutgoingLinks       []ctLinkRef    `json:"outgoingLinks"`
	IncomingLinks       []ctLinkRef    `json:"incomingLinks"`
	Warnings            []string       `json:"warnings"`
}

type ctHostNode struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	Provider        string     `json:"provider"`
	Region          string     `json:"region"`
	PublicIP        string     `json:"publicIp,omitempty"`
	PrivateIP       string     `json:"privateIp,omitempty"`
	Status          string     `json:"status"`
	EffectiveStatus string     `json:"effectiveStatus"`
	IsSynapseHost   bool       `json:"isSynapseHost"`
	LastHeartbeatAt *time.Time `json:"lastHeartbeatAt,omitempty"`
	AgentCount      int        `json:"agentCount"`
	AgentsSummary   struct {
		Online  int `json:"online"`
		Offline int `json:"offline"`
		Revoked int `json:"revoked"`
	} `json:"agentsSummary"`
}

type ctLinkEdge struct {
	ID                   string `json:"id"`
	SourceCellID         string `json:"sourceCellId"`
	TargetCellID         string `json:"targetCellId"`
	Protocol             string `json:"protocol"`
	AuthMode             string `json:"authMode"`
	Status               string `json:"status"`
	AllowedCommandsCount int    `json:"allowedCommandsCount"`
	AllowedEventsCount   int    `json:"allowedEventsCount"`
	ActiveTokenCount     int    `json:"activeTokenCount"`
	HasEndpoint          bool   `json:"hasEndpoint"`
	EndpointSource       string `json:"endpointSource,omitempty"`
}

type ctResp struct {
	Mode    string `json:"mode"`
	Project struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Slug string `json:"slug"`
	} `json:"project"`
	Hosts                 []ctHostNode   `json:"hosts"`
	Cells                 []ctCell       `json:"cells"`
	UnassignedDeployments []ctDeployment `json:"unassignedDeployments"`
	Links                 []ctLinkEdge   `json:"links"`
	Warnings              []string       `json:"warnings"`
}

func cellByName(cells []ctCell, name string) *ctCell {
	for i := range cells {
		if cells[i].Name == name {
			return &cells[i]
		}
	}
	return nil
}

func TestCellTopology_LegacyFallback(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Amage IA")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "amagejumpy")

	var resp ctResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/cell_topology", owner.AccessToken, nil, http.StatusOK, &resp)
	if resp.Mode != "legacy_synthetic" {
		t.Errorf("no-cells project should be legacy_synthetic, got %q", resp.Mode)
	}
	if len(resp.Cells) != 0 {
		t.Errorf("expected no cells, got %d", len(resp.Cells))
	}
}

func TestCellTopology_RealTree(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Amage IA")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "amagejumpy")
	core := createCellViaAPI(t, h, owner.AccessToken, proj.ID, "core-prod-br-1", "core")
	runtime := createCellViaAPI(t, h, owner.AccessToken, proj.ID, "runtime-prod-br-1", "runtime")

	// A host, attached to the core cell, then a deployment placed there.
	var host models.Host
	h.DoJSON(http.MethodPost, "/v1/hosts", owner.AccessToken,
		map[string]any{"name": "vps-br-1", "region": "br", "publicIp": "203.0.113.10"}, http.StatusCreated, &host)
	h.DoJSON(http.MethodPost, "/v1/cells/"+core.ID+"/attach_host", owner.AccessToken,
		map[string]any{"hostId": host.ID}, http.StatusOK, &models.Cell{})
	depID := h.SeedDeployment(proj.ID, "lush-heron-4656", "prod", "running", true, owner.ID, 3501, "")
	h.DoJSON(http.MethodPost, "/v1/cells/"+core.ID+"/attach_deployment", owner.AccessToken,
		map[string]any{"deploymentName": "lush-heron-4656"}, http.StatusOK, &attachResp{})

	// core → runtime link.
	var link models.CellLink
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/cell_links", owner.AccessToken,
		map[string]any{"sourceCellId": core.ID, "targetCellId": runtime.ID, "protocol": "outbox",
			"allowedCommands": []string{"runtime.runAutomation"}}, http.StatusCreated, &link)

	var resp ctResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/cell_topology", owner.AccessToken, nil, http.StatusOK, &resp)

	if resp.Mode != "cell_control_plane" {
		t.Fatalf("mode = %q, want cell_control_plane", resp.Mode)
	}
	if len(resp.Cells) != 2 {
		t.Fatalf("expected 2 cells, got %d", len(resp.Cells))
	}
	coreNode := cellByName(resp.Cells, "core-prod-br-1")
	runtimeNode := cellByName(resp.Cells, "runtime-prod-br-1")
	if coreNode == nil || runtimeNode == nil {
		t.Fatalf("missing core/runtime cell in topology")
	}
	// core: deployment lush-heron-4656 + placed on the host.
	if len(coreNode.Deployments) != 1 || coreNode.Deployments[0].ID != depID {
		t.Fatalf("core cell should have lush-heron-4656, got %+v", coreNode.Deployments)
	}
	if coreNode.PrimaryHostID == nil || *coreNode.PrimaryHostID != host.ID {
		t.Errorf("core cell should be placed on the host")
	}
	if coreNode.Deployments[0].Placement == nil || coreNode.Deployments[0].Placement.HostID == nil || *coreNode.Deployments[0].Placement.HostID != host.ID {
		t.Errorf("deployment placement host wrong: %+v", coreNode.Deployments[0].Placement)
	}
	// Link edge core → runtime, and the cells carry out/in refs.
	if len(resp.Links) != 1 || resp.Links[0].SourceCellID != core.ID || resp.Links[0].TargetCellID != runtime.ID {
		t.Fatalf("expected 1 link edge core→runtime, got %+v", resp.Links)
	}
	if resp.Links[0].AllowedCommandsCount != 1 {
		t.Errorf("link allowedCommandsCount = %d, want 1", resp.Links[0].AllowedCommandsCount)
	}
	if len(coreNode.OutgoingLinks) != 1 || len(runtimeNode.IncomingLinks) != 1 {
		t.Errorf("expected core outgoing + runtime incoming link refs")
	}
	// The host appears (referenced by the core cell).
	if len(resp.Hosts) != 1 || resp.Hosts[0].ID != host.ID {
		t.Fatalf("expected the attached host in topology, got %+v", resp.Hosts)
	}
	// Owner is instance admin → IP present.
	if resp.Hosts[0].PublicIP != "203.0.113.10" {
		t.Errorf("admin should see host publicIp, got %q", resp.Hosts[0].PublicIP)
	}
	// runtime has no deployment + the link has no endpoint/token → warnings.
	if !containsSubstr(resp.Warnings, "no primary deployment") {
		t.Errorf("expected a no-primary-deployment warning, got %v", resp.Warnings)
	}
	if !containsSubstr(resp.Warnings, "no resolved endpoint") {
		t.Errorf("expected a no-endpoint warning for the link, got %v", resp.Warnings)
	}
	if !containsSubstr(resp.Warnings, "no active service token") {
		t.Errorf("expected a no-active-token warning, got %v", resp.Warnings)
	}
}

func TestCellTopology_UnassignedDeployment(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Amage IA")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "amagejumpy")
	_ = createCellViaAPI(t, h, owner.AccessToken, proj.ID, "core-prod-br-1", "core")
	// A deployment that is NOT attached to any cell.
	h.SeedDeployment(proj.ID, "orphan-dep-1", "dev", "running", false, owner.ID, 3510, "")

	var resp ctResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/cell_topology", owner.AccessToken, nil, http.StatusOK, &resp)
	if len(resp.UnassignedDeployments) != 1 || resp.UnassignedDeployments[0].Name != "orphan-dep-1" {
		t.Fatalf("expected orphan-dep-1 in unassignedDeployments, got %+v", resp.UnassignedDeployments)
	}
	if !containsSubstr(resp.Warnings, "orphan-dep-1 is not assigned to any cell") {
		t.Errorf("expected unassigned warning, got %v", resp.Warnings)
	}
}

func TestCellTopology_HostStaleWarning(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Amage IA")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "amagejumpy")
	core := createCellViaAPI(t, h, owner.AccessToken, proj.ID, "core-prod-br-1", "core")
	var host models.Host
	h.DoJSON(http.MethodPost, "/v1/hosts", owner.AccessToken, map[string]any{"name": "vps-br-1"}, http.StatusCreated, &host)
	h.DoJSON(http.MethodPost, "/v1/cells/"+core.ID+"/attach_host", owner.AccessToken,
		map[string]any{"hostId": host.ID}, http.StatusOK, &models.Cell{})
	// Make the host look offline (old heartbeat).
	if _, err := h.DB.Exec(context.Background(),
		`UPDATE hosts SET last_heartbeat_at = now() - interval '600 seconds' WHERE id = $1`, host.ID); err != nil {
		t.Fatalf("age host: %v", err)
	}

	var resp ctResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/cell_topology", owner.AccessToken, nil, http.StatusOK, &resp)
	if len(resp.Hosts) != 1 || resp.Hosts[0].EffectiveStatus != models.HostStatusOffline {
		t.Fatalf("host should be offline, got %+v", resp.Hosts)
	}
	if !containsSubstr(resp.Warnings, "is offline but has active cells") {
		t.Errorf("expected host-offline warning, got %v", resp.Warnings)
	}
}

func TestCellTopology_NonAdminStripsHostIP(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser() // first user → instance admin
	team := createTeam(t, h, owner.AccessToken, "Amage IA")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "amagejumpy")
	core := createCellViaAPI(t, h, owner.AccessToken, proj.ID, "core-prod-br-1", "core")
	var host models.Host
	h.DoJSON(http.MethodPost, "/v1/hosts", owner.AccessToken,
		map[string]any{"name": "vps-br-1", "publicIp": "203.0.113.10"}, http.StatusCreated, &host)
	h.DoJSON(http.MethodPost, "/v1/cells/"+core.ID+"/attach_host", owner.AccessToken,
		map[string]any{"hostId": host.ID}, http.StatusOK, &models.Cell{})

	// A non-admin team member.
	member := h.RegisterRandomUser()
	seedTeamMember(t, h, team.ID, member.ID, "member")

	var asMember ctResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/cell_topology", member.AccessToken, nil, http.StatusOK, &asMember)
	if len(asMember.Hosts) != 1 {
		t.Fatalf("member should see the host, got %d", len(asMember.Hosts))
	}
	if asMember.Hosts[0].PublicIP != "" {
		t.Errorf("non-admin must NOT see host publicIp, got %q", asMember.Hosts[0].PublicIP)
	}
	// But the non-admin still sees name/region/effectiveStatus.
	if asMember.Hosts[0].Name != "vps-br-1" {
		t.Errorf("member should see host name")
	}
}

func containsSubstr(haystack []string, needle string) bool {
	for _, s := range haystack {
		if strings.Contains(s, needle) {
			return true
		}
	}
	return false
}
