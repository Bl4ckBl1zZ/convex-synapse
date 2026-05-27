package synapsetest

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/Iann29/synapse/internal/convexenv"
)

type projectResp struct {
	ID         string    `json:"id"`
	TeamID     string    `json:"teamId"`
	TeamSlug   string    `json:"teamSlug,omitempty"`
	Name       string    `json:"name"`
	Slug       string    `json:"slug"`
	IsDemo     bool      `json:"isDemo"`
	CreateTime time.Time `json:"createTime"`
}

type createProjectResp struct {
	ProjectID   string      `json:"projectId"`
	ProjectSlug string      `json:"projectSlug"`
	Project     projectResp `json:"project"`
}

// createProject is a small helper used across tests in this file.
func createProject(t *testing.T, h *Harness, bearer, teamSlug, name string) projectResp {
	t.Helper()
	var got createProjectResp
	h.DoJSON(http.MethodPost, "/v1/teams/"+teamSlug+"/create_project", bearer,
		map[string]string{"projectName": name}, http.StatusCreated, &got)
	return got.Project
}

func TestProjects_CreateAndList(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Proj Co")

	proj := createProject(t, h, owner.AccessToken, team.Slug, "Web App")
	if proj.Name != "Web App" {
		t.Errorf("project name mismatch: got %q", proj.Name)
	}
	if proj.TeamID != team.ID {
		t.Errorf("team id mismatch: got %s want %s", proj.TeamID, team.ID)
	}

	var listed []projectResp
	h.DoJSON(http.MethodGet, "/v1/teams/"+team.Slug+"/list_projects",
		owner.AccessToken, nil, http.StatusOK, &listed)
	if len(listed) != 1 || listed[0].ID != proj.ID {
		t.Errorf("expected 1 project in list, got %+v", listed)
	}
}

func TestProjects_GetByID(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Get Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "Project A")

	var got projectResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID, owner.AccessToken,
		nil, http.StatusOK, &got)
	if got.ID != proj.ID || got.Name != "Project A" {
		t.Errorf("get project mismatch: %+v", got)
	}
}

func TestProjects_GetUnknown(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	env := h.AssertStatus(http.MethodGet,
		"/v1/projects/00000000-0000-0000-0000-000000000000", owner.AccessToken,
		nil, http.StatusNotFound)
	if env.Code != "project_not_found" {
		t.Errorf("expected project_not_found, got %q", env.Code)
	}
}

func TestProjects_NonMember403(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	stranger := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Closed Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "Internal")

	env := h.AssertStatus(http.MethodGet, "/v1/projects/"+proj.ID, stranger.AccessToken,
		nil, http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Errorf("got code %q want forbidden", env.Code)
	}
}

func TestProjects_UpdateAdminOnly(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	member := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Update Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "Old Name")

	// Seed `member` as a non-admin team_member.
	if _, err := h.DB.Exec(h.rootCtx,
		`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
		team.ID, member.ID); err != nil {
		t.Fatalf("seed member: %v", err)
	}

	// Member: forbidden
	env := h.AssertStatus(http.MethodPut, "/v1/projects/"+proj.ID, member.AccessToken,
		map[string]any{"name": "New Name"}, http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Errorf("got code %q want forbidden", env.Code)
	}

	// Admin: succeeds
	var updated projectResp
	h.DoJSON(http.MethodPut, "/v1/projects/"+proj.ID, owner.AccessToken,
		map[string]any{"name": "New Name"}, http.StatusOK, &updated)
	if updated.Name != "New Name" {
		t.Errorf("expected updated name 'New Name', got %q", updated.Name)
	}
}

func TestProjects_UpdateMissingName(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Validate Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "Whatever")

	env := h.AssertStatus(http.MethodPut, "/v1/projects/"+proj.ID, owner.AccessToken,
		map[string]any{"name": "  "}, http.StatusBadRequest)
	if env.Code != "missing_name" {
		t.Errorf("got code %q want missing_name", env.Code)
	}
}

func TestProjects_UpdateSlugOnly(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Slug Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "Original")

	var updated projectResp
	h.DoJSON(http.MethodPut, "/v1/projects/"+proj.ID, owner.AccessToken,
		map[string]any{"slug": "renamed-slug"}, http.StatusOK, &updated)
	if updated.Slug != "renamed-slug" {
		t.Errorf("slug=%q want renamed-slug", updated.Slug)
	}
	if updated.Name != "Original" {
		t.Errorf("name unexpectedly changed: %q", updated.Name)
	}
}

func TestProjects_UpdateNameAndSlug(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Both Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "Old")

	var updated projectResp
	h.DoJSON(http.MethodPut, "/v1/projects/"+proj.ID, owner.AccessToken,
		map[string]any{"name": "New Name", "slug": "new-slug"},
		http.StatusOK, &updated)
	if updated.Name != "New Name" || updated.Slug != "new-slug" {
		t.Errorf("got name=%q slug=%q", updated.Name, updated.Slug)
	}
}

func TestProjects_UpdateInvalidSlug(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Bad Slug Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "X")

	env := h.AssertStatus(http.MethodPut, "/v1/projects/"+proj.ID, owner.AccessToken,
		map[string]any{"slug": "Has Spaces"}, http.StatusBadRequest)
	if env.Code != "invalid_slug" {
		t.Errorf("code=%q want invalid_slug", env.Code)
	}
}

func TestProjects_UpdateSlugConflict(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Conf Co")
	first := createProject(t, h, owner.AccessToken, team.Slug, "First")
	second := createProject(t, h, owner.AccessToken, team.Slug, "Second")

	env := h.AssertStatus(http.MethodPut, "/v1/projects/"+second.ID, owner.AccessToken,
		map[string]any{"slug": first.Slug}, http.StatusConflict)
	if env.Code != "slug_taken" {
		t.Errorf("code=%q want slug_taken", env.Code)
	}
}

func TestProjects_UpdateEmptyBodyNoOp(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "NoOp Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "Same")

	var got projectResp
	h.DoJSON(http.MethodPut, "/v1/projects/"+proj.ID, owner.AccessToken,
		map[string]any{}, http.StatusOK, &got)
	if got.Name != "Same" || got.Slug != proj.Slug {
		t.Errorf("expected unchanged project, got %+v", got)
	}
}

func TestProjects_DeleteCascadesEnvVars(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Del Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "Doomed")

	// Set an env var.
	type envVarChange struct {
		Op              string   `json:"op"`
		Name            string   `json:"name"`
		Value           string   `json:"value,omitempty"`
		DeploymentTypes []string `json:"deploymentTypes,omitempty"`
	}
	type updateEnvVarsReq struct {
		Changes []envVarChange `json:"changes"`
	}
	h.DoJSON(http.MethodPost,
		"/v1/projects/"+proj.ID+"/update_default_environment_variables",
		owner.AccessToken,
		updateEnvVarsReq{Changes: []envVarChange{{Op: "set", Name: "API_KEY", Value: "sekret"}}},
		http.StatusOK, &map[string]any{})

	// Confirm row exists pre-delete.
	var pre int
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT count(*) FROM project_env_vars WHERE project_id = $1`, proj.ID).Scan(&pre); err != nil {
		t.Fatalf("count env vars: %v", err)
	}
	// v1.17.1+: `set` without explicit deploymentTypes fans out to all
	// three types (dev/prod/preview) as separate rows, so the seed row
	// becomes 3. Pre-v1.17.1 it was 1 row with a 3-element array column.
	if pre != 3 {
		t.Fatalf("expected 3 env var rows pre-delete (one per default type), got %d", pre)
	}

	// Delete project.
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/delete", owner.AccessToken,
		nil, http.StatusOK, &map[string]string{})

	// Cascade should have wiped the env vars.
	var post int
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT count(*) FROM project_env_vars WHERE project_id = $1`, proj.ID).Scan(&post); err != nil {
		t.Fatalf("count env vars post-delete: %v", err)
	}
	if post != 0 {
		t.Errorf("expected env vars to cascade-delete, got %d", post)
	}

	// And the project itself is gone.
	var projects int
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT count(*) FROM projects WHERE id = $1`, proj.ID).Scan(&projects); err != nil {
		t.Fatalf("count projects: %v", err)
	}
	if projects != 0 {
		t.Errorf("expected project row to be removed, got %d", projects)
	}
}

func TestProjects_DeleteAdminOnly(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	member := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Delete Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "Survive")

	if _, err := h.DB.Exec(h.rootCtx,
		`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')`,
		team.ID, member.ID); err != nil {
		t.Fatalf("seed member: %v", err)
	}

	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+proj.ID+"/delete",
		member.AccessToken, nil, http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Errorf("got code %q want forbidden", env.Code)
	}
}

func TestProjects_EnvVarsRoundTrip(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Env Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "EnvProj")

	type envVarChange struct {
		Op              string   `json:"op"`
		Name            string   `json:"name"`
		Value           string   `json:"value,omitempty"`
		DeploymentTypes []string `json:"deploymentTypes,omitempty"`
	}
	type updateEnvVarsReq struct {
		Changes []envVarChange `json:"changes"`
	}
	type envConfig struct {
		Name            string   `json:"name"`
		Value           string   `json:"value"`
		DeploymentTypes []string `json:"deploymentTypes"`
	}
	type listResp struct {
		Configs []envConfig `json:"configs"`
	}
	type syncFunctionResultLite struct {
		Total   int    `json:"total"`
		Synced  int    `json:"synced"`
		Skipped int    `json:"skipped"`
		Failed  []any  `json:"failed"`
		Notice  string `json:"notice"`
	}
	type updateResp struct {
		Applied    int                    `json:"applied"`
		SyncResult syncFunctionResultLite `json:"syncResult"`
	}

	// Empty list to start.
	var initial listResp
	h.DoJSON(http.MethodGet,
		"/v1/projects/"+proj.ID+"/list_default_environment_variables",
		owner.AccessToken, nil, http.StatusOK, &initial)
	if len(initial.Configs) != 0 {
		t.Errorf("expected empty initial env vars, got %+v", initial.Configs)
	}

	// Set two vars in one batch. Post-v1.17.1 the schema is one row per
	// (project_id, name, deployment_type), so FOO (default types =
	// [dev,prod,preview]) expands to 3 rows and BAR (types=[prod])
	// stays at 1 row -- 4 configs total. Each returned config wraps a
	// single type in a one-element deploymentTypes array (legacy shape
	// preserved; dashboard groups by name client-side).
	var setResp updateResp
	h.DoJSON(http.MethodPost,
		"/v1/projects/"+proj.ID+"/update_default_environment_variables",
		owner.AccessToken,
		updateEnvVarsReq{Changes: []envVarChange{
			{Op: "set", Name: "FOO", Value: "1"},
			{Op: "set", Name: "BAR", Value: "two", DeploymentTypes: []string{"prod"}},
		}},
		http.StatusOK, &setResp)
	if setResp.Applied != 2 {
		t.Errorf("expected applied=2, got %d", setResp.Applied)
	}

	// List confirms both names; FOO×3 + BAR×1 = 4 single-type rows.
	var listed listResp
	h.DoJSON(http.MethodGet,
		"/v1/projects/"+proj.ID+"/list_default_environment_variables",
		owner.AccessToken, nil, http.StatusOK, &listed)
	if len(listed.Configs) != 4 {
		t.Fatalf("expected 4 env var rows (FOO×3 + BAR×1) after set, got %+v", listed.Configs)
	}
	type key struct{ name, depType string }
	byKey := map[key]envConfig{}
	for _, c := range listed.Configs {
		if len(c.DeploymentTypes) != 1 {
			t.Errorf("each config must carry exactly one deployment type post-v1.17.1, got %+v", c)
			continue
		}
		byKey[key{c.Name, c.DeploymentTypes[0]}] = c
	}
	for _, dt := range []string{"dev", "prod", "preview"} {
		got, ok := byKey[key{"FOO", dt}]
		if !ok || got.Value != "1" {
			t.Errorf("FOO/%s missing or wrong value: %+v", dt, got)
		}
	}
	if bar, ok := byKey[key{"BAR", "prod"}]; !ok || bar.Value != "two" {
		t.Errorf("BAR/prod missing or wrong: %+v", bar)
	}
	if _, ok := byKey[key{"BAR", "dev"}]; ok {
		t.Errorf("BAR should NOT exist for dev (was prod-only)")
	}

	// Delete BAR (no deploymentTypes => wipe every row for that name).
	h.DoJSON(http.MethodPost,
		"/v1/projects/"+proj.ID+"/update_default_environment_variables",
		owner.AccessToken,
		updateEnvVarsReq{Changes: []envVarChange{{Op: "delete", Name: "BAR"}}},
		http.StatusOK, &updateResp{})

	var afterDelete listResp
	h.DoJSON(http.MethodGet,
		"/v1/projects/"+proj.ID+"/list_default_environment_variables",
		owner.AccessToken, nil, http.StatusOK, &afterDelete)
	if len(afterDelete.Configs) != 3 {
		t.Fatalf("expected 3 env var rows (FOO across dev/prod/preview) after deleting BAR, got %+v", afterDelete.Configs)
	}
	for _, c := range afterDelete.Configs {
		if c.Name != "FOO" {
			t.Errorf("expected only FOO rows after delete, got %+v", c)
		}
	}
}

// TestProjects_EnvVars_DifferentValuesPerType locks the v1.17.1 bug fix:
// setting NAME=A for dev and then NAME=B for prod must NOT collapse to a
// single row -- both values must survive independently. Pre-v1.17.1 the
// schema's UNIQUE(project_id, name) + ON CONFLICT (project_id, name) DO
// UPDATE replaced the dev value with the prod value (and vice versa).
func TestProjects_EnvVars_DifferentValuesPerType(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "PerType Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "PerType")

	type envVarChange struct {
		Op              string   `json:"op"`
		Name            string   `json:"name"`
		Value           string   `json:"value,omitempty"`
		DeploymentTypes []string `json:"deploymentTypes,omitempty"`
	}
	type updateEnvVarsReq struct {
		Changes []envVarChange `json:"changes"`
	}
	type envConfig struct {
		Name            string   `json:"name"`
		Value           string   `json:"value"`
		DeploymentTypes []string `json:"deploymentTypes"`
	}
	type listResp struct {
		Configs []envConfig `json:"configs"`
	}

	// Step 1: BETTER_AUTH_SECRET=dev-secret for dev only.
	h.DoJSON(http.MethodPost,
		"/v1/projects/"+proj.ID+"/update_default_environment_variables",
		owner.AccessToken,
		updateEnvVarsReq{Changes: []envVarChange{
			{Op: "set", Name: "BETTER_AUTH_SECRET", Value: "dev-secret", DeploymentTypes: []string{"dev"}},
		}},
		http.StatusOK, nil)

	// Step 2: BETTER_AUTH_SECRET=prod-secret for prod only. The pre-fix
	// bug: this would REPLACE the dev row -- dev would suddenly read
	// "prod-secret". Post-fix: both rows survive independently.
	h.DoJSON(http.MethodPost,
		"/v1/projects/"+proj.ID+"/update_default_environment_variables",
		owner.AccessToken,
		updateEnvVarsReq{Changes: []envVarChange{
			{Op: "set", Name: "BETTER_AUTH_SECRET", Value: "prod-secret", DeploymentTypes: []string{"prod"}},
		}},
		http.StatusOK, nil)

	var got listResp
	h.DoJSON(http.MethodGet,
		"/v1/projects/"+proj.ID+"/list_default_environment_variables",
		owner.AccessToken, nil, http.StatusOK, &got)

	if len(got.Configs) != 2 {
		t.Fatalf("want 2 configs (dev + prod), got %d: %+v", len(got.Configs), got.Configs)
	}
	byType := map[string]envConfig{}
	for _, c := range got.Configs {
		if c.Name != "BETTER_AUTH_SECRET" {
			t.Errorf("unexpected name %q", c.Name)
			continue
		}
		if len(c.DeploymentTypes) != 1 {
			t.Errorf("each config should be one-type post-v1.17.1, got %+v", c.DeploymentTypes)
			continue
		}
		byType[c.DeploymentTypes[0]] = c
	}
	if dev, ok := byType["dev"]; !ok || dev.Value != "dev-secret" {
		t.Errorf("dev value: got %+v want dev-secret", dev)
	}
	if prod, ok := byType["prod"]; !ok || prod.Value != "prod-secret" {
		t.Errorf("prod value: got %+v want prod-secret", prod)
	}

	// Step 3: delete only the prod row -- dev must survive.
	h.DoJSON(http.MethodPost,
		"/v1/projects/"+proj.ID+"/update_default_environment_variables",
		owner.AccessToken,
		updateEnvVarsReq{Changes: []envVarChange{
			{Op: "delete", Name: "BETTER_AUTH_SECRET", DeploymentTypes: []string{"prod"}},
		}},
		http.StatusOK, nil)

	got = listResp{}
	h.DoJSON(http.MethodGet,
		"/v1/projects/"+proj.ID+"/list_default_environment_variables",
		owner.AccessToken, nil, http.StatusOK, &got)
	if len(got.Configs) != 1 || got.Configs[0].DeploymentTypes[0] != "dev" || got.Configs[0].Value != "dev-secret" {
		t.Fatalf("after deleting prod: want dev still present, got %+v", got.Configs)
	}

	// Step 4: bulk delete without deploymentTypes wipes every row.
	h.DoJSON(http.MethodPost,
		"/v1/projects/"+proj.ID+"/update_default_environment_variables",
		owner.AccessToken,
		updateEnvVarsReq{Changes: []envVarChange{
			{Op: "delete", Name: "BETTER_AUTH_SECRET"},
		}},
		http.StatusOK, nil)

	got = listResp{}
	h.DoJSON(http.MethodGet,
		"/v1/projects/"+proj.ID+"/list_default_environment_variables",
		owner.AccessToken, nil, http.StatusOK, &got)
	if len(got.Configs) != 0 {
		t.Fatalf("bulk delete should wipe all rows, got %+v", got.Configs)
	}
}

func TestProjects_Transfer_HappyPath(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	src := createTeam(t, h, owner.AccessToken, "Source Co")
	dst := createTeam(t, h, owner.AccessToken, "Dest Co")
	proj := createProject(t, h, owner.AccessToken, src.Slug, "Movable")

	// Transfer succeeds; status 204 + empty body.
	resp := h.Do(http.MethodPost, "/v1/projects/"+proj.ID+"/transfer", owner.AccessToken,
		map[string]string{"destinationTeamId": dst.ID})
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status=%d want 204", resp.StatusCode)
	}
	resp.Body.Close()

	// GET reflects the new team_id.
	var got projectResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID, owner.AccessToken, nil, http.StatusOK, &got)
	if got.TeamID != dst.ID {
		t.Errorf("team id mismatch: got %s want %s", got.TeamID, dst.ID)
	}
}

func TestProjects_Transfer_SameTeamNoOp(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Solo Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "Stays")

	resp := h.Do(http.MethodPost, "/v1/projects/"+proj.ID+"/transfer", owner.AccessToken,
		map[string]string{"destinationTeamId": team.ID})
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("self-transfer status=%d want 204", resp.StatusCode)
	}
	resp.Body.Close()
}

func TestProjects_Transfer_NonAdminSource403(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	mover := h.RegisterRandomUser()
	src := createTeam(t, h, owner.AccessToken, "Source")
	dst := createTeam(t, h, owner.AccessToken, "Dest")
	proj := createProject(t, h, owner.AccessToken, src.Slug, "Forbidden")

	// Add mover as plain member of both teams (not admin of source).
	if _, err := h.DB.Exec(h.rootCtx,
		`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member'), ($3, $2, 'admin')`,
		src.ID, mover.ID, dst.ID); err != nil {
		t.Fatalf("seed members: %v", err)
	}

	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+proj.ID+"/transfer",
		mover.AccessToken, map[string]string{"destinationTeamId": dst.ID},
		http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Errorf("got code %q want forbidden", env.Code)
	}
}

func TestProjects_Transfer_NonAdminDest403(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	mover := h.RegisterRandomUser()
	src := createTeam(t, h, owner.AccessToken, "OurSource")
	dst := createTeam(t, h, owner.AccessToken, "OurDest")
	proj := createProject(t, h, owner.AccessToken, src.Slug, "Almost")

	// Admin of source, plain member of dest.
	if _, err := h.DB.Exec(h.rootCtx,
		`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'admin'), ($3, $2, 'member')`,
		src.ID, mover.ID, dst.ID); err != nil {
		t.Fatalf("seed members: %v", err)
	}

	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+proj.ID+"/transfer",
		mover.AccessToken, map[string]string{"destinationTeamId": dst.ID},
		http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Errorf("got code %q want forbidden", env.Code)
	}
}

func TestProjects_Transfer_DestTeamNotFound(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Lonely Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "Orphan")

	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+proj.ID+"/transfer",
		owner.AccessToken,
		map[string]string{"destinationTeamId": "00000000-0000-0000-0000-000000000000"},
		http.StatusNotFound)
	if env.Code != "team_not_found" {
		t.Errorf("got code %q want team_not_found", env.Code)
	}
}

func TestProjects_Transfer_StrangerToDestTeam403(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	stranger := h.RegisterRandomUser()
	src := createTeam(t, h, owner.AccessToken, "Mine")
	dst := createTeam(t, h, stranger.AccessToken, "TheirsAlone")
	proj := createProject(t, h, owner.AccessToken, src.Slug, "Trying")

	// owner is admin of src, totally outside dst.
	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+proj.ID+"/transfer",
		owner.AccessToken, map[string]string{"destinationTeamId": dst.ID},
		http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Errorf("got code %q want forbidden", env.Code)
	}
}

func TestProjects_Transfer_SlugCollision409(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	src := createTeam(t, h, owner.AccessToken, "Source X")
	dst := createTeam(t, h, owner.AccessToken, "Dest X")

	// Same name → same slug in both teams. UNIQUE(team_id, slug) bites the
	// transfer.
	moving := createProject(t, h, owner.AccessToken, src.Slug, "Same Name")
	_ = createProject(t, h, owner.AccessToken, dst.Slug, "Same Name")

	env := h.AssertStatus(http.MethodPost, "/v1/projects/"+moving.ID+"/transfer",
		owner.AccessToken, map[string]string{"destinationTeamId": dst.ID},
		http.StatusConflict)
	if env.Code != "slug_taken" {
		t.Errorf("got code %q want slug_taken", env.Code)
	}
}

// v1.9.2: sync_env_to_deployments — re-creates running deployments so
// they pick up the current project_env_vars values. Validated against
// the FakeDocker harness, so we cover the wiring (auth → DB query →
// iteration → audit) but the actual container recreate is mocked.
// v1.17+: sync_env_to_deployments now pushes via the Convex env API
// (no container recreate). The default harness leaves SetupOpts.ConvexEnv
// nil, which means the helper logs + skips per-deployment — so the
// expected outcome here is total=2, synced=0, skipped=2. A separate
// test (TestProjects_UpdateEnvVars_AutoSync) wires a stub backend and
// asserts the actual push path with synced=1.
//
// We still cover the wiring (auth → DB query → iteration → audit) and
// the legacy `recreated` alias that the dashboard + CLI still read.
func TestProjects_SyncEnvToDeployments_HappyPath(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Sync Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "Sync")

	// Seed two RUNNING deployments directly so the test is deterministic
	// — we want to exercise the iteration path, not the async
	// provisioning worker (which has its own integration tests).
	h.SeedDeployment(proj.ID, "sync-dev-1234", "dev", "running", true, owner.ID, 3501, "")
	h.SeedDeployment(proj.ID, "sync-prod-5678", "prod", "running", true, owner.ID, 3502, "")

	// Add an env var so the sync has something meaningful to push.
	type envVarChange struct {
		Op    string `json:"op"`
		Name  string `json:"name"`
		Value string `json:"value,omitempty"`
	}
	type updateEnvVarsReq struct {
		Changes []envVarChange `json:"changes"`
	}
	h.DoJSON(http.MethodPost,
		"/v1/projects/"+proj.ID+"/update_default_environment_variables",
		owner.AccessToken,
		updateEnvVarsReq{Changes: []envVarChange{{Op: "set", Name: "API_KEY", Value: "x"}}},
		http.StatusOK, &map[string]any{})

	type syncFailure struct {
		DeploymentID   string `json:"deploymentId"`
		DeploymentName string `json:"deploymentName"`
		Reason         string `json:"reason"`
	}
	type syncResp struct {
		Total     int           `json:"total"`
		Recreated int           `json:"recreated"` // legacy alias of `synced`; kept until v2.0.0
		Synced    int           `json:"synced"`
		Skipped   int           `json:"skipped"`
		Failed    []syncFailure `json:"failed"`
		Notice    string        `json:"notice"`
	}
	var resp syncResp
	h.DoJSON(http.MethodPost,
		"/v1/projects/"+proj.ID+"/sync_env_to_deployments",
		owner.AccessToken, map[string]any{}, http.StatusOK, &resp)

	if resp.Total != 2 {
		t.Errorf("total: want 2, got %d", resp.Total)
	}
	// Default harness: no ConvexEnv → helper skips every deployment.
	if resp.Synced != 0 {
		t.Errorf("synced: want 0 (nil ConvexEnv), got %d", resp.Synced)
	}
	if resp.Recreated != resp.Synced {
		t.Errorf("recreated must mirror synced for legacy compat; got recreated=%d synced=%d",
			resp.Recreated, resp.Synced)
	}
	if resp.Skipped != 2 {
		t.Errorf("skipped: want 2, got %d", resp.Skipped)
	}
	if len(resp.Failed) != 0 {
		t.Errorf("failed: want empty, got %+v", resp.Failed)
	}
	// FakeDocker.Recreate must NOT be called anymore — env sync no
	// longer rebuilds containers.
	if specs := h.Docker.RecreatedSpecs(); len(specs) != 0 {
		t.Errorf("v1.17+ sync must not Recreate containers; got %d", len(specs))
	}
}

func TestProjects_SyncEnvToDeployments_ViewerForbidden(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	viewer := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Sync RBAC")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")

	if _, err := h.DB.Exec(h.rootCtx, `
		INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member')
	`, team.ID, viewer.ID); err != nil {
		t.Fatalf("seed team member: %v", err)
	}
	if _, err := h.DB.Exec(h.rootCtx, `
		INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'viewer')
	`, proj.ID, viewer.ID); err != nil {
		t.Fatalf("seed viewer override: %v", err)
	}

	env := h.AssertStatus(http.MethodPost,
		"/v1/projects/"+proj.ID+"/sync_env_to_deployments",
		viewer.AccessToken, map[string]any{}, http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Errorf("got code %q want forbidden", env.Code)
	}
}

func TestProjects_SyncEnvToDeployments_NoDeployments(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Empty Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "Empty")

	type syncResp struct {
		Total     int    `json:"total"`
		Recreated int    `json:"recreated"`
		Synced    int    `json:"synced"`
		Skipped   int    `json:"skipped"`
		Failed    []any  `json:"failed"`
		Notice    string `json:"notice"`
	}
	var resp syncResp
	h.DoJSON(http.MethodPost,
		"/v1/projects/"+proj.ID+"/sync_env_to_deployments",
		owner.AccessToken, map[string]any{}, http.StatusOK, &resp)

	if resp.Total != 0 || resp.Recreated != 0 || resp.Synced != 0 || resp.Skipped != 0 {
		t.Errorf("expected zeros for empty project, got %+v", resp)
	}
}

func TestProjects_EnvVars_MembersAllowed_ViewersBlocked(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	member := h.RegisterRandomUser()
	viewer := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "EnvRBAC Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")

	// Both extras start as plain team members (no project override).
	if _, err := h.DB.Exec(h.rootCtx, `
		INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')
	`, team.ID, member.ID, viewer.ID); err != nil {
		t.Fatalf("seed members: %v", err)
	}
	// Downgrade `viewer` via a project_members override — this is the
	// v1.0+ RBAC promise: a team member can be locked down to read-only
	// on one specific project.
	if _, err := h.DB.Exec(h.rootCtx, `
		INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'viewer')
	`, proj.ID, viewer.ID); err != nil {
		t.Fatalf("seed viewer override: %v", err)
	}

	type envVarChange struct {
		Op    string `json:"op"`
		Name  string `json:"name"`
		Value string `json:"value,omitempty"`
	}
	type updateEnvVarsReq struct {
		Changes []envVarChange `json:"changes"`
	}
	type listResp struct {
		Configs []any `json:"configs"`
	}

	// Member can write — was admin-only before v1.0 RBAC, now any
	// editor (admin or member) is fine.
	h.DoJSON(http.MethodPost,
		"/v1/projects/"+proj.ID+"/update_default_environment_variables",
		member.AccessToken,
		updateEnvVarsReq{Changes: []envVarChange{{Op: "set", Name: "X", Value: "y"}}},
		http.StatusOK, &map[string]any{})

	// Viewer is blocked from writes…
	env := h.AssertStatus(http.MethodPost,
		"/v1/projects/"+proj.ID+"/update_default_environment_variables",
		viewer.AccessToken,
		updateEnvVarsReq{Changes: []envVarChange{{Op: "set", Name: "X", Value: "y"}}},
		http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Errorf("got code %q want forbidden", env.Code)
	}

	// …but reads stay open for everyone with project access.
	h.DoJSON(http.MethodGet,
		"/v1/projects/"+proj.ID+"/list_default_environment_variables",
		viewer.AccessToken, nil, http.StatusOK, &listResp{})
	h.DoJSON(http.MethodGet,
		"/v1/projects/"+proj.ID+"/list_default_environment_variables",
		member.AccessToken, nil, http.StatusOK, &listResp{})
}

// Deleting a project must tear down the container of every managed deployment
// in it — the cascade removes the rows, so without an explicit Destroy the
// containers would be orphaned and keep squatting their host ports.
func TestDeleteProject_TearsDownDeploymentContainers(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Teardown Team")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "teardown-proj")
	h.SeedDeployment(proj.ID, "happy-otter-1111", "dev", "running", true, owner.ID, 3210, "")
	h.SeedDeployment(proj.ID, "brave-lynx-2222", "prod", "running", false, owner.ID, 3211, "")

	h.Docker.Destroyed = nil
	h.DoJSON(http.MethodPost, "/v1/projects/"+proj.ID+"/delete", owner.AccessToken, map[string]any{}, http.StatusOK, &map[string]string{})

	got := map[string]bool{}
	for _, n := range h.Docker.DestroyedNames() {
		got[n] = true
	}
	for _, name := range []string{"happy-otter-1111", "brave-lynx-2222"} {
		if !got[name] {
			t.Errorf("deleteProject must destroy the container for %q (Destroyed=%v)", name, h.Docker.DestroyedNames())
		}
	}

	var n int
	if err := h.DB.QueryRow(h.rootCtx, `SELECT count(*) FROM projects WHERE id::text = $1`, proj.ID).Scan(&n); err != nil {
		t.Fatalf("count project: %v", err)
	}
	if n != 0 {
		t.Errorf("project should be deleted, %d remain", n)
	}
}

// TestProjects_UpdateEnvVars_AutoSync covers Slice 2.4: after the DB
// write commits, updateEnvVars MUST fan out the changes to every
// running deployment's Convex FUNCTION runtime env store via the
// convexenv API. The response includes a syncResult breakdown so the
// dashboard can render per-row status without a second round-trip.
//
// We wire SetupOpts.ConvexEnv with a stub HTTP doer that captures the
// raw POST body and replies 200 OK, so we both (a) prove the auto-sync
// fires synchronously and (b) verify the on-wire payload matches what
// the operator entered (minus CLI-managed names, which the helper
// filters before pushing).
func TestProjects_UpdateEnvVars_AutoSync(t *testing.T) {
	var (
		mu       sync.Mutex
		captured [][]byte
		authHdr  string
	)
	// Stub Convex backend: capture everything pushed to
	// /api/update_environment_variables, reply 200. We deliberately use
	// httptest.Server (not just a Doer) so the URL is real and the
	// authorization header gets to flow through the live http stack.
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/update_environment_variables" {
			http.NotFound(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		captured = append(captured, body)
		authHdr = r.Header.Get("Authorization")
		mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	defer stub.Close()

	// Build the per-process Client against the stub. NewClient's
	// default 5s timeout is fine; we override the transport via
	// NewClientWith so the URL the helper computes lands on the stub.
	// But cliDeploymentURL falls back to the deployments.deployment_url
	// column when PublicURL is empty — SeedDeployment writes
	// "http://127.0.0.1:<port>" there, NOT our stub URL. The cleanest
	// way to point the helper at the stub is to use NewClientWith with
	// a doer that retargets every request to the stub's URL.
	client := convexenv.NewClientWith(&retargetDoer{base: stub.URL})

	h := SetupWithOpts(t, SetupOpts{ConvexEnv: client})
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "AutoSync Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "AutoSyncProj")

	// Seed ONE running deployment with a known admin key so we can
	// assert it on the captured Authorization header.
	const adminKey = "test-admin-key-1234"
	h.SeedDeployment(proj.ID, "auto-sync-1234", "dev", "running", true, owner.ID, 3601, adminKey)

	// POST: one regular var + one CLI-managed name that must be
	// filtered before the push (operator paste-mistake).
	type envVarChange struct {
		Op    string `json:"op"`
		Name  string `json:"name"`
		Value string `json:"value,omitempty"`
	}
	type updateEnvVarsReq struct {
		Changes []envVarChange `json:"changes"`
	}
	type syncFailure struct {
		DeploymentID   string `json:"deploymentId"`
		DeploymentName string `json:"deploymentName"`
		Reason         string `json:"reason"`
	}
	type syncResult struct {
		Total   int           `json:"total"`
		Synced  int           `json:"synced"`
		Skipped int           `json:"skipped"`
		Failed  []syncFailure `json:"failed"`
		Notice  string        `json:"notice"`
	}
	type updateResp struct {
		Applied    int        `json:"applied"`
		SyncResult syncResult `json:"syncResult"`
	}

	var resp updateResp
	h.DoJSON(http.MethodPost,
		"/v1/projects/"+proj.ID+"/update_default_environment_variables",
		owner.AccessToken,
		updateEnvVarsReq{Changes: []envVarChange{
			{Op: "set", Name: "BETTER_AUTH_SECRET", Value: "s3kret"},
			// CLI-managed — filter MUST drop this before pushing.
			{Op: "set", Name: "CONVEX_DEPLOY_KEY", Value: "should-be-dropped"},
		}},
		http.StatusOK, &resp)

	if resp.Applied != 2 {
		t.Errorf("applied: want 2, got %d", resp.Applied)
	}
	if resp.SyncResult.Total != 1 {
		t.Errorf("syncResult.total: want 1, got %d", resp.SyncResult.Total)
	}
	if resp.SyncResult.Synced != 1 {
		t.Errorf("syncResult.synced: want 1, got %d (skipped=%d failed=%+v)",
			resp.SyncResult.Synced, resp.SyncResult.Skipped, resp.SyncResult.Failed)
	}
	if len(resp.SyncResult.Failed) != 0 {
		t.Errorf("syncResult.failed: want empty, got %+v", resp.SyncResult.Failed)
	}

	// Stub recording: exactly one POST captured.
	mu.Lock()
	defer mu.Unlock()
	if len(captured) != 1 {
		t.Fatalf("expected exactly one push to /api/update_environment_variables, got %d", len(captured))
	}
	if got, want := authHdr, "Convex "+adminKey; got != want {
		t.Errorf("authorization header: want %q, got %q", want, got)
	}
	// Payload: must include BETTER_AUTH_SECRET=s3kret, must NOT include
	// CONVEX_DEPLOY_KEY (dropped by FilterManaged).
	var payload struct {
		Changes []struct {
			Name  string  `json:"name"`
			Value *string `json:"value"`
		} `json:"changes"`
	}
	if err := json.Unmarshal(captured[0], &payload); err != nil {
		t.Fatalf("decode pushed body: %v\nraw=%s", err, string(captured[0]))
	}
	if len(payload.Changes) != 1 {
		t.Fatalf("expected exactly 1 change pushed (CLI-managed name filtered), got %d: %+v",
			len(payload.Changes), payload.Changes)
	}
	c := payload.Changes[0]
	if c.Name != "BETTER_AUTH_SECRET" {
		t.Errorf("pushed change name: want BETTER_AUTH_SECRET, got %q", c.Name)
	}
	if c.Value == nil || *c.Value != "s3kret" {
		t.Errorf("pushed change value: want s3kret, got %v", c.Value)
	}
}

// retargetDoer rewrites every Request's URL host+scheme to base while
// preserving path + query. Lets the test point the convexenv client at
// an httptest.Server without caring what URL the helper computed.
type retargetDoer struct{ base string }

func (d *retargetDoer) Do(req *http.Request) (*http.Response, error) {
	base, err := url.Parse(d.base)
	if err != nil {
		return nil, err
	}
	req.URL.Scheme = base.Scheme
	req.URL.Host = base.Host
	req.Host = base.Host
	return http.DefaultClient.Do(req)
}
