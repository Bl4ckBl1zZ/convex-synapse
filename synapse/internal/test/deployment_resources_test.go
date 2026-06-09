package synapsetest

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// Per-deployment CPU/RAM limits (v1.25+) — the self-hosted answer to
// Cloud's deployment classes. Limits ride DeploymentSpec into Docker's
// HostConfig.Resources; NULL/absent = unlimited (pre-feature behavior).

// Create with limits: the values land in the API response, persist on the
// row, flow into the provisioned container spec, and show up in listings.
func TestDeploymentResources_CreateWithLimits(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Limits Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "LimitsProj")

	var got deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken, map[string]any{"type": "dev", "cpus": 0.5, "memoryMb": 512},
		http.StatusCreated, &got)
	if got.CPUs == nil || *got.CPUs != 0.5 {
		t.Errorf("create response cpus = %v, want 0.5", got.CPUs)
	}
	if got.MemoryMB == nil || *got.MemoryMB != 512 {
		t.Errorf("create response memoryMb = %v, want 512", got.MemoryMB)
	}
	waitForStatus(t, h, got.Name, "running", 5*time.Second)

	spec := lastProvisionedSpec(t, h, got.Name)
	if spec.CPUs != 0.5 {
		t.Errorf("spec.CPUs = %v, want 0.5", spec.CPUs)
	}
	if spec.MemoryMB != 512 {
		t.Errorf("spec.MemoryMB = %v, want 512", spec.MemoryMB)
	}

	got = deploymentResp{}
	h.DoJSON(http.MethodGet, "/v1/deployments/"+spec.Name, owner.AccessToken, nil, http.StatusOK, &got)
	if got.CPUs == nil || *got.CPUs != 0.5 || got.MemoryMB == nil || *got.MemoryMB != 512 {
		t.Errorf("GET after create: cpus=%v memoryMb=%v, want 0.5/512", got.CPUs, got.MemoryMB)
	}

	// The project listing carries the limits too (dashboard rows).
	var list []deploymentResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/list_deployments",
		owner.AccessToken, nil, http.StatusOK, &list)
	if len(list) != 1 || list[0].CPUs == nil || *list[0].CPUs != 0.5 ||
		list[0].MemoryMB == nil || *list[0].MemoryMB != 512 {
		t.Errorf("list: %+v, want one row with cpus=0.5 memoryMb=512", list)
	}
}

// No limits requested → unlimited, exactly like before the feature: the
// fields are absent from responses and zero in the container spec.
func TestDeploymentResources_CreateUnlimitedByDefault(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "NoLimits Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "NoLimitsProj")

	var got deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken, map[string]any{"type": "dev"}, http.StatusCreated, &got)
	if got.CPUs != nil || got.MemoryMB != nil {
		t.Errorf("unlimited create returned limits: cpus=%v memoryMb=%v", got.CPUs, got.MemoryMB)
	}
	waitForStatus(t, h, got.Name, "running", 5*time.Second)

	spec := lastProvisionedSpec(t, h, got.Name)
	if spec.CPUs != 0 || spec.MemoryMB != 0 {
		t.Errorf("spec carries limits without a request: cpus=%v memoryMb=%v", spec.CPUs, spec.MemoryMB)
	}
}

// Out-of-range limits are rejected up front with a stable code.
func TestDeploymentResources_Validation(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Valid Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "ValidProj")

	for _, body := range []map[string]any{
		{"type": "dev", "cpus": 0.01},
		{"type": "dev", "cpus": 100},
		{"type": "dev", "cpus": -1},
		{"type": "dev", "memoryMb": 64},
		{"type": "dev", "memoryMb": -5},
		{"type": "dev", "memoryMb": 99999999},
	} {
		env := h.AssertStatus(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
			owner.AccessToken, body, http.StatusBadRequest)
		if env.Code != "invalid_resources" {
			t.Errorf("body %v: code = %q, want invalid_resources", body, env.Code)
		}
	}
}

// Resize: update_resources persists the new limits and recreates the
// container so Docker actually enforces them; clearing reverts to
// unlimited. Restart-in-place isn't enough — HostConfig is fixed at
// container-create time.
func TestDeploymentResources_ResizeRecreates(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Resize Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "ResizeProj")

	var created deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken, map[string]any{"type": "dev"}, http.StatusCreated, &created)
	waitForStatus(t, h, created.Name, "running", 5*time.Second)

	var got deploymentResp
	h.DoJSON(http.MethodPost, "/v1/deployments/"+created.Name+"/update_resources",
		owner.AccessToken, map[string]any{"cpus": 1.0, "memoryMb": 1024},
		http.StatusOK, &got)
	if got.CPUs == nil || *got.CPUs != 1.0 || got.MemoryMB == nil || *got.MemoryMB != 1024 {
		t.Errorf("resize response: cpus=%v memoryMb=%v, want 1/1024", got.CPUs, got.MemoryMB)
	}

	specs := h.Docker.RecreatedSpecs()
	if len(specs) != 1 {
		t.Fatalf("recreated specs = %d, want 1 (resize must recreate the container)", len(specs))
	}
	if specs[0].Name != created.Name || specs[0].CPUs != 1.0 || specs[0].MemoryMB != 1024 {
		t.Errorf("recreated spec = %+v, want name=%s cpus=1 memoryMb=1024", specs[0], created.Name)
	}

	// Clear back to unlimited: both fields absent = no limits.
	got = deploymentResp{}
	h.DoJSON(http.MethodPost, "/v1/deployments/"+created.Name+"/update_resources",
		owner.AccessToken, map[string]any{}, http.StatusOK, &got)
	if got.CPUs != nil || got.MemoryMB != nil {
		t.Errorf("clear resize: cpus=%v memoryMb=%v, want both nil", got.CPUs, got.MemoryMB)
	}
	specs = h.Docker.RecreatedSpecs()
	if len(specs) != 2 {
		t.Fatalf("recreated specs = %d, want 2", len(specs))
	}
	if specs[1].CPUs != 0 || specs[1].MemoryMB != 0 {
		t.Errorf("cleared recreate spec still carries limits: %+v", specs[1])
	}
}

// Resize validation reuses the create-side bounds.
func TestDeploymentResources_ResizeValidation(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "RV Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "RVProj")
	h.SeedDeployment(proj.ID, "rv-cat-1234", "dev", "running", false, owner.ID, 4200, "k")

	env := h.AssertStatus(http.MethodPost, "/v1/deployments/rv-cat-1234/update_resources",
		owner.AccessToken, map[string]any{"cpus": 0.01}, http.StatusBadRequest)
	if env.Code != "invalid_resources" {
		t.Errorf("code = %q, want invalid_resources", env.Code)
	}
}

// Gates: project viewers can't resize; adopted / stopped / remote / HA
// deployments are refused with stable codes.
func TestDeploymentResources_ResizeGates(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Gate Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "GateProj")
	h.SeedDeployment(proj.ID, "gate-owl-1234", "dev", "running", false, owner.ID, 4201, "k")

	// Team member downgraded to project viewer → 403.
	viewer := h.RegisterRandomUser()
	addTeamMember(t, h, team.ID, viewer.ID, "member")
	if _, err := h.DB.Exec(context.Background(),
		`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'viewer')`,
		proj.ID, viewer.ID); err != nil {
		t.Fatalf("seed project viewer: %v", err)
	}
	h.AssertStatus(http.MethodPost, "/v1/deployments/gate-owl-1234/update_resources",
		viewer.AccessToken, map[string]any{"cpus": 1.0}, http.StatusForbidden)

	// Adopted: no Synapse-managed container to recreate.
	h.SeedDeployment(proj.ID, "gate-ext-1234", "dev", "running", false, owner.ID, 4202, "k")
	if _, err := h.DB.Exec(context.Background(),
		`UPDATE deployments SET adopted = true WHERE name = 'gate-ext-1234'`); err != nil {
		t.Fatalf("mark adopted: %v", err)
	}
	env := h.AssertStatus(http.MethodPost, "/v1/deployments/gate-ext-1234/update_resources",
		owner.AccessToken, map[string]any{"cpus": 1.0}, http.StatusConflict)
	if env.Code != "cannot_resize_adopted" {
		t.Errorf("adopted: code = %q, want cannot_resize_adopted", env.Code)
	}

	// Not running: the recreate path needs a live container.
	h.SeedDeployment(proj.ID, "gate-stop-1234", "dev", "stopped", false, owner.ID, 4203, "k")
	env = h.AssertStatus(http.MethodPost, "/v1/deployments/gate-stop-1234/update_resources",
		owner.AccessToken, map[string]any{"cpus": 1.0}, http.StatusConflict)
	if env.Code != "deployment_not_running" {
		t.Errorf("stopped: code = %q, want deployment_not_running", env.Code)
	}

	// Remote host: local-recreate path can't reach it (v1 limitation).
	_, _ = h.SeedRemoteDeployment(proj.ID, "gate-rem-1234", "dev", "running", owner.ID, 4204, "k", "")
	env = h.AssertStatus(http.MethodPost, "/v1/deployments/gate-rem-1234/update_resources",
		owner.AccessToken, map[string]any{"cpus": 1.0}, http.StatusConflict)
	if env.Code != "remote_resize_not_supported" {
		t.Errorf("remote: code = %q, want remote_resize_not_supported", env.Code)
	}
}

// HA deployments: resize is refused for now (would need a rolling
// per-replica recreate — tracked, not shipped).
func TestDeploymentResources_ResizeHARefused(t *testing.T) {
	h := SetupHA(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "HA Resize Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "HAResizeProj")

	var created deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken, map[string]any{"type": "dev", "ha": true}, http.StatusCreated, &created)
	waitForStatus(t, h, created.Name, "running", 8*time.Second)

	env := h.AssertStatus(http.MethodPost, "/v1/deployments/"+created.Name+"/update_resources",
		owner.AccessToken, map[string]any{"cpus": 1.0}, http.StatusConflict)
	if env.Code != "ha_resize_not_supported" {
		t.Errorf("ha: code = %q, want ha_resize_not_supported", env.Code)
	}
}

// HA create DOES accept limits — both replicas get them at provision time.
func TestDeploymentResources_HACreateWithLimits(t *testing.T) {
	h := SetupHA(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "HA Limits Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "HALimitsProj")

	var created deploymentResp
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/create_deployment",
		owner.AccessToken, map[string]any{"type": "dev", "ha": true, "cpus": 2.0, "memoryMb": 2048},
		http.StatusCreated, &created)
	waitForStatus(t, h, created.Name, "running", 8*time.Second)

	var withLimits int
	for _, spec := range h.Docker.ProvisionedSpecs() {
		if spec.Name == created.Name && spec.CPUs == 2.0 && spec.MemoryMB == 2048 {
			withLimits++
		}
	}
	if withLimits != 2 {
		t.Errorf("replicas provisioned with limits = %d, want 2", withLimits)
	}
}
