package synapsetest

import (
	"net/http"
	"testing"
)

// v1.23 — the dashboard apply toggle (apply_settings). The DB value wins over
// the .env default and flips the reconcile/apply gate + the dry-run's
// applyEnabled flag without a restart. Mirrors email_settings.

type applySettingsResp struct {
	Enabled   bool    `json:"enabled"`
	Dangerous bool    `json:"dangerous"`
	Source    string  `json:"source"`
	UpdatedAt *string `json:"updatedAt"`
}

func TestApplySettings_ToggleFlipsGate(t *testing.T) {
	h := Setup(t) // ApplyEnabled defaults false (env)
	admin := h.RegisterRandomUser()
	team := createTeam(t, h, admin.AccessToken, "Apply Toggle")
	proj := createProject(t, h, admin.AccessToken, team.Slug, "at")

	// Default: disabled, sourced from .env.
	var s applySettingsResp
	h.DoJSON(http.MethodGet, "/v1/admin/apply_settings", admin.AccessToken, nil, http.StatusOK, &s)
	if s.Enabled || s.Source != "env" {
		t.Fatalf("default should be disabled/env, got %+v", s)
	}
	// Apply endpoint is 404 + dry-run reports applyEnabled=false.
	h.AssertStatus(http.MethodPost, "/v1/projects/"+proj.ID+"/reconcile/apply",
		admin.AccessToken, map[string]any{}, http.StatusNotFound)
	var dry dryRunResult
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/reconcile/dry_run",
		admin.AccessToken, map[string]any{}, http.StatusOK, &dry)
	if dry.ApplyEnabled {
		t.Fatalf("dry-run applyEnabled should be false before toggle")
	}

	// Toggle ON via the dashboard endpoint.
	h.DoJSON(http.MethodPost, "/v1/admin/apply_settings",
		admin.AccessToken, map[string]any{"enabled": true}, http.StatusOK, &s)
	if !s.Enabled || s.Source != "db" {
		t.Fatalf("after enable: %+v", s)
	}
	// The gate flips WITHOUT a restart: apply endpoint now 202, dry-run true.
	h.AssertStatus(http.MethodPost, "/v1/projects/"+proj.ID+"/reconcile/apply",
		admin.AccessToken, map[string]any{}, http.StatusAccepted)
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/reconcile/dry_run",
		admin.AccessToken, map[string]any{}, http.StatusOK, &dry)
	if !dry.ApplyEnabled {
		t.Fatalf("dry-run applyEnabled should be true after enable")
	}

	// Toggle OFF → back to 404.
	h.DoJSON(http.MethodPost, "/v1/admin/apply_settings",
		admin.AccessToken, map[string]any{"enabled": false}, http.StatusOK, &s)
	if s.Enabled {
		t.Fatalf("after disable should be false, got %+v", s)
	}
	h.AssertStatus(http.MethodPost, "/v1/projects/"+proj.ID+"/reconcile/apply",
		admin.AccessToken, map[string]any{}, http.StatusNotFound)
}

func TestApplySettings_RequiresInstanceAdmin(t *testing.T) {
	h := Setup(t)
	_ = h.RegisterRandomUser()         // first user = instance admin
	stranger := h.RegisterRandomUser() // second user = NOT instance admin
	if stranger.IsInstanceAdmin {
		t.Fatalf("second user should not be instance admin")
	}
	h.AssertStatus(http.MethodGet, "/v1/admin/apply_settings", stranger.AccessToken, nil, http.StatusForbidden)
	h.AssertStatus(http.MethodPost, "/v1/admin/apply_settings",
		stranger.AccessToken, map[string]any{"enabled": true}, http.StatusForbidden)
	h.AssertStatus(http.MethodGet, "/v1/admin/apply_settings", "", nil, http.StatusUnauthorized)
}
