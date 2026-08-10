package synapsetest

import (
	"context"
	"net/http"
	"testing"
	"time"

	dockerprov "github.com/Iann29/synapse/internal/docker"
)

// TestConvexOrigin_BakedFromPublicURL: v1.6.15. The provisioner must
// emit CONVEX_CLOUD_ORIGIN / CONVEX_SITE_ORIGIN matching the CLI-
// reachable URL the dashboard hands operators — not the legacy
// "http://127.0.0.1:<port>" form which leaks into function-spec.url
// and breaks CONVEX_SITE_URL inside httpAction handlers.
//
// With PublicURL set + ProxyEnabled=true the worker should still hand
// the CLI-anchored URL ("<host>:<HostPort>") to the spec because the
// official `npx convex` CLI strips paths via new URL("/api/...", base).
func TestConvexOrigin_BakedFromPublicURL(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		PublicURL:    "https://synapse.example.com",
		ProxyEnabled: true,
	})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Origin Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "OriginProj")

	var got deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken, map[string]string{"type": "dev"}, http.StatusCreated, &got)
	waitForStatus(t, h, got.Name, "running", 5*time.Second)

	spec := lastProvisionedSpec(t, h, got.Name)
	want := "https://synapse.example.com:" + itoa(spec.HostPort)
	if spec.PublicURL != want {
		t.Errorf("spec.PublicURL: got %q want %q", spec.PublicURL, want)
	}
}

// TestConvexOrigin_BaseDomainWinsOverPublicURL: BaseDomain is the v1.0+
// preferred shape — pretty per-deployment subdomain. The worker should
// produce "https://<name>.<BaseDomain>" so the container's
// CONVEX_CLOUD_ORIGIN agrees with what `synapse convex` puts in
// CONVEX_SELF_HOSTED_URL.
func TestConvexOrigin_BaseDomainWinsOverPublicURL(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		PublicURL:    "https://synapse.example.com",
		ProxyEnabled: true,
		BaseDomain:   "synapse.example.com",
	})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Base-Origin Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "BaseOrigin")

	var got deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken, map[string]string{"type": "dev"}, http.StatusCreated, &got)
	waitForStatus(t, h, got.Name, "running", 5*time.Second)

	spec := lastProvisionedSpec(t, h, got.Name)
	want := "https://" + got.Name + ".synapse.example.com"
	if spec.PublicURL != want {
		t.Errorf("spec.PublicURL: got %q want %q", spec.PublicURL, want)
	}
}

// TestConvexOrigin_NoConfigFallsBackToLoopback: with neither PublicURL
// nor BaseDomain wired, the worker must emit "" — the docker layer then
// defaults to docker.ContainerLoopbackOrigin ("http://127.0.0.1:3210"),
// the backend's own listen port, which is the only address reachable
// from inside the container for local dev / CI.
func TestConvexOrigin_NoConfigFallsBackToLoopback(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Loopback Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "Loopback")

	var got deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken, map[string]string{"type": "dev"}, http.StatusCreated, &got)
	waitForStatus(t, h, got.Name, "running", 5*time.Second)

	spec := lastProvisionedSpec(t, h, got.Name)
	if spec.PublicURL != "" {
		t.Errorf("spec.PublicURL: got %q want empty (loopback fallback)", spec.PublicURL)
	}
}

// TestSiteOrigin_BaseDomainProducesSiteHost: with a base domain the
// provisioner must bake CONVEX_SITE_ORIGIN = "https://<name>.site.<base>"
// — the deployment's dedicated site-proxy host (Convex port 3211, where
// HTTP actions live at natural paths), distinct from the cloud origin.
// See docs/CONVEX_SITE_ORIGIN.md.
func TestSiteOrigin_BaseDomainProducesSiteHost(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		PublicURL:    "https://synapse.example.com",
		ProxyEnabled: true,
		BaseDomain:   "synapse.example.com",
	})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Site-Origin Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "SiteOrigin")

	var got deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken, map[string]string{"type": "dev"}, http.StatusCreated, &got)
	waitForStatus(t, h, got.Name, "running", 5*time.Second)

	spec := lastProvisionedSpec(t, h, got.Name)
	want := "https://" + got.Name + ".site.synapse.example.com"
	if spec.SiteURL != want {
		t.Errorf("spec.SiteURL: got %q want %q", spec.SiteURL, want)
	}
	// Cloud and site origins must differ — that's the whole point.
	if spec.PublicURL == spec.SiteURL {
		t.Errorf("PublicURL and SiteURL must differ (cloud vs site); both = %q", spec.PublicURL)
	}
}

// TestSiteOrigin_NoConfigEmpty: without a base domain or a role='site'
// custom domain there is no externally-reachable site URL, so the worker
// emits "" and the docker layer keeps CONVEX_SITE_ORIGIN == cloud origin
// (host-port mode, where 3211 isn't published anyway).
func TestSiteOrigin_NoConfigEmpty(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "NoSite Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "NoSite")

	var got deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken, map[string]string{"type": "dev"}, http.StatusCreated, &got)
	waitForStatus(t, h, got.Name, "running", 5*time.Second)

	spec := lastProvisionedSpec(t, h, got.Name)
	if spec.SiteURL != "" {
		t.Errorf("spec.SiteURL: got %q want empty (host-port fallback)", spec.SiteURL)
	}
}

// lastProvisionedSpec polls FakeDocker until it sees a Provision call
// for the named deployment, then returns the recorded spec. Returns
// after the worker has caught up so callers can assert on env shape.
func lastProvisionedSpec(t *testing.T, h *Harness, name string) dockerprov.DeploymentSpec {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		for _, s := range h.Docker.ProvisionedSpecs() {
			if s.Name == name {
				return s
			}
		}
		select {
		case <-time.After(20 * time.Millisecond):
		case <-context.Background().Done():
		}
	}
	t.Fatalf("Provision was never called for %q", name)
	return dockerprov.DeploymentSpec{}
}
