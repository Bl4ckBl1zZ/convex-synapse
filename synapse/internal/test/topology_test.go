package synapsetest

import (
	"context"
	"net/http"
	"testing"

	"github.com/Iann29/synapse/internal/geo"
)

// stubResolver implements geo.Resolver with a fixed payload — keeps the
// test deterministic and offline.
type stubResolver struct {
	info geo.Info
	err  error
}

func (s *stubResolver) Lookup(_ context.Context, ip string) (geo.Info, error) {
	if s.err != nil {
		return geo.Info{IP: ip}, s.err
	}
	out := s.info
	out.IP = ip
	return out, nil
}

func TestTopology_SingleHost_SingleDeployment(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		PublicURL: "https://synapsepanel.com",
		PublicIP:  "72.60.3.159",
		GeoResolver: &stubResolver{info: geo.Info{
			Country:     "DE",
			CountryFlag: "🇩🇪",
			City:        "Nuremberg",
			Region:      "Bavaria",
			Provider:    "Hetzner",
		}},
	})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Topo Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "ToProj")

	h.SeedDeployment(proj.ID, "brave-dolphin-1060", "dev", "running", true, owner.ID, 3214, "")

	var resp topologyTestResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/topology",
		owner.AccessToken, nil, http.StatusOK, &resp)

	if len(resp.Hosts) != 1 {
		t.Fatalf("hosts: got %d want 1", len(resp.Hosts))
	}
	host := resp.Hosts[0]
	if host.ID != "primary" {
		t.Errorf("id: got %q want primary", host.ID)
	}
	if host.Country != "DE" || host.CountryFlag != "🇩🇪" {
		t.Errorf("country: got %+v", host)
	}
	if host.Provider != "Hetzner" {
		t.Errorf("provider: got %q", host.Provider)
	}
	if host.RunningCount != 1 {
		t.Errorf("runningCount: got %d", host.RunningCount)
	}
	if !host.IsPrimary {
		t.Errorf("isPrimary should be true")
	}
	if len(host.Deployments) != 1 {
		t.Fatalf("deployments: got %d", len(host.Deployments))
	}
	d := host.Deployments[0]
	if d.Name != "brave-dolphin-1060" || d.Type != "dev" {
		t.Errorf("deployment: %+v", d)
	}
	if d.Storage != "sqlite" {
		t.Errorf("storage: got %q want sqlite (non-HA default)", d.Storage)
	}
	if d.ReplicaCount != 1 || d.HealthyCount != 1 {
		t.Errorf("replicas: got %d/%d want 1/1 (single-replica running)", d.HealthyCount, d.ReplicaCount)
	}
}

func TestTopology_StatusAggregation(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		PublicURL: "https://synapsepanel.com",
		PublicIP:  "72.60.3.159",
		GeoResolver: &stubResolver{info: geo.Info{Country: "DE", CountryFlag: "🇩🇪", Provider: "Hetzner"}},
	})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Stats Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "StatsProj")

	// Mixed statuses to exercise the aggregation counters.
	h.SeedDeployment(proj.ID, "run-1", "dev", "running", true, owner.ID, 3214, "")
	h.SeedDeployment(proj.ID, "run-2", "prod", "running", false, owner.ID, 3215, "")
	h.SeedDeployment(proj.ID, "prov-1", "preview", "provisioning", false, owner.ID, 3216, "")
	h.SeedDeployment(proj.ID, "fail-1", "prod", "failed", false, owner.ID, 3217, "")

	var resp topologyTestResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/topology",
		owner.AccessToken, nil, http.StatusOK, &resp)

	if len(resp.Hosts) != 1 {
		t.Fatalf("hosts: %d", len(resp.Hosts))
	}
	if resp.Hosts[0].RunningCount != 2 {
		t.Errorf("running: %d want 2", resp.Hosts[0].RunningCount)
	}
	if resp.Hosts[0].ProvisioningCount != 1 {
		t.Errorf("provisioning: %d want 1", resp.Hosts[0].ProvisioningCount)
	}
	if resp.Hosts[0].FailedCount != 1 {
		t.Errorf("failed: %d want 1", resp.Hosts[0].FailedCount)
	}
}

func TestTopology_EmptyProject(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		PublicURL: "https://synapsepanel.com",
		PublicIP:  "",
		GeoResolver: &stubResolver{info: geo.Info{}},
	})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Empty Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "EmptyProj")

	var resp topologyTestResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/topology",
		owner.AccessToken, nil, http.StatusOK, &resp)

	// Empty project still returns one host (the primary) so the UI has
	// somewhere to render "no deployments yet" rather than a blank page.
	if len(resp.Hosts) != 1 {
		t.Fatalf("expected 1 host shell, got %d", len(resp.Hosts))
	}
	if len(resp.Hosts[0].Deployments) != 0 {
		t.Errorf("expected zero deployments, got %d", len(resp.Hosts[0].Deployments))
	}
}

func TestTopology_NonMember403(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{PublicURL: "https://synapsepanel.com"})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Closed Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "Closed")

	stranger := h.RegisterRandomUser()
	env := h.AssertStatus(http.MethodGet, "/v1/projects/"+proj.ID+"/topology",
		stranger.AccessToken, nil, http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Errorf("code: %q want forbidden", env.Code)
	}
}

func TestTopology_GeoFailureGraceful(t *testing.T) {
	// Stub returns an error → handler still serves the topology with
	// host card populated by IP but empty country/region/provider.
	h := SetupWithOpts(t, SetupOpts{
		PublicURL:   "https://synapsepanel.com",
		PublicIP:    "72.60.3.159",
		GeoResolver: &stubResolver{err: errResolverDown{}},
	})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Geoff Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "GeoffProj")

	var resp topologyTestResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/topology",
		owner.AccessToken, nil, http.StatusOK, &resp)

	if len(resp.Hosts) != 1 {
		t.Fatalf("hosts: %d", len(resp.Hosts))
	}
	if resp.Hosts[0].IP != "72.60.3.159" {
		t.Errorf("IP preserved on geo failure: got %q", resp.Hosts[0].IP)
	}
	if resp.Hosts[0].Country != "" {
		t.Errorf("country should be empty on geo failure, got %q", resp.Hosts[0].Country)
	}
}

type errResolverDown struct{}

func (errResolverDown) Error() string { return "resolver down" }

// topologyTestResp mirrors the full /v1/projects/{id}/topology shape.
// We decode through DisallowUnknownFields, so the struct has to enumerate
// every field — drift between handler + this test is a feature.
type topologyTestResp struct {
	Hosts []struct {
		ID                string `json:"id"`
		Name              string `json:"name"`
		IP                string `json:"ip"`
		Country           string `json:"country"`
		CountryFlag       string `json:"countryFlag"`
		City              string `json:"city"`
		Region            string `json:"region"`
		Provider          string `json:"provider"`
		SynapseVersion    string `json:"synapseVersion"`
		IsPrimary         bool   `json:"isPrimary"`
		RunningCount      int    `json:"runningCount"`
		ProvisioningCount int    `json:"provisioningCount"`
		FailedCount       int    `json:"failedCount"`
		Deployments       []struct {
			Name           string `json:"name"`
			Type           string `json:"type"`
			Status         string `json:"status"`
			URL            string `json:"url"`
			URLForm        string `json:"urlForm"`
			Storage        string `json:"storage"`
			HAEnabled      bool   `json:"haEnabled"`
			ReplicaCount   int    `json:"replicaCount"`
			HealthyCount   int    `json:"healthyCount"`
			Version        string `json:"version"`
			CustomDomain   string `json:"customDomain"`
			Adopted        bool   `json:"adopted"`
			RunningSinceMS int64  `json:"runningSinceMs"`
			IsDefault      bool   `json:"isDefault"`
			Reference      string `json:"reference"`
			LastError      string `json:"lastError"`
			Port           *int   `json:"port"`
		} `json:"deployments"`
	} `json:"hosts"`
}
