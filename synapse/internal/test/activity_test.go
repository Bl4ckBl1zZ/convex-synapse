package synapsetest

import (
	"context"
	"net/http"
	"testing"
	"time"
)

// activityTestResp matches the /v1/projects/{id}/activity response
// shape. DoJSON uses DisallowUnknownFields so this struct has to
// enumerate every field returned by the handler.
type activityTestResp struct {
	Events []struct {
		ID         string         `json:"id"`
		CreateTime time.Time      `json:"createTime"`
		Action     string         `json:"action"`
		ActorID    string         `json:"actorId"`
		ActorEmail string         `json:"actorEmail"`
		ActorName  string         `json:"actorName"`
		TargetType string         `json:"targetType"`
		TargetID   string         `json:"targetId"`
		TargetName string         `json:"targetName"`
		Metadata   map[string]any `json:"metadata"`
	} `json:"events"`
	NextCursor string `json:"nextCursor"`
}

// seedAuditEvent inserts a single audit_events row directly. Cheaper +
// more deterministic than going through the handler-instrumented audit
// chain for tests that only care about read-back behaviour.
func seedAuditEvent(t *testing.T, h *Harness, teamID, actorID, action, targetType, targetID string, metadata map[string]any) int64 {
	t.Helper()
	var id int64
	var mdRaw any
	if metadata != nil {
		mdRaw = metadata
	}
	if err := h.DB.QueryRow(context.Background(), `
		INSERT INTO audit_events (team_id, actor_id, action, target_type, target_id, metadata)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id
	`, teamID, actorID, action, targetType, targetID, mdRaw).Scan(&id); err != nil {
		t.Fatalf("seed audit_event: %v", err)
	}
	return id
}

func TestActivity_HappyPath_ProjectAndDeploymentEvents(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Activity Co")
	// createProject (helper → handler → audit) auto-emits a
	// "createProject" event, so we already have 1 in the table at this
	// point. Tests below count from there.
	proj := createProject(t, h, owner.AccessToken, team.Slug, "ActivityProj")
	depID := h.SeedDeployment(proj.ID, "brave-dolphin-1060", "dev", "running", true, owner.ID, 3214, "")
	seedAuditEvent(t, h, team.ID, owner.ID, "createDeployment", "deployment", depID, map[string]any{"type": "dev"})

	// Different project — its events must NOT show up in proj's feed.
	otherProj := createProject(t, h, owner.AccessToken, team.Slug, "OtherProj")
	otherDepID := h.SeedDeployment(otherProj.ID, "wise-otter-2201", "prod", "running", true, owner.ID, 3215, "")
	seedAuditEvent(t, h, team.ID, owner.ID, "createDeployment", "deployment", otherDepID, map[string]any{"type": "prod"})

	var resp activityTestResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/activity",
		owner.AccessToken, nil, http.StatusOK, &resp)

	// Two events expected: createProject (from helper) + createDeployment
	// (manually seeded). OtherProj's events must NOT bleed in.
	if len(resp.Events) != 2 {
		t.Fatalf("events: got %d want 2 (other project should NOT bleed in)", len(resp.Events))
	}

	// Newest first — the deployment was seeded after the project so it
	// sorts first in DESC(created_at, id).
	if resp.Events[0].Action != "createDeployment" {
		t.Errorf("first event: got %q want createDeployment", resp.Events[0].Action)
	}
	if resp.Events[0].TargetName != "brave-dolphin-1060" {
		t.Errorf("targetName resolved: got %q want brave-dolphin-1060", resp.Events[0].TargetName)
	}
	if resp.Events[1].Action != "createProject" {
		t.Errorf("second event: got %q want createProject", resp.Events[1].Action)
	}
	if resp.Events[1].TargetName != "ActivityProj" {
		t.Errorf("project name resolved: got %q", resp.Events[1].TargetName)
	}
}

func TestActivity_NonMember403(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	stranger := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Closed Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "ClosedProj")

	env := h.AssertStatus(http.MethodGet, "/v1/projects/"+proj.ID+"/activity",
		stranger.AccessToken, nil, http.StatusForbidden)
	if env.Code != "forbidden" {
		t.Errorf("code: %q want forbidden", env.Code)
	}
}

// Viewer access is intentional — activity feed is the project's "pulse"
// and viewers benefit from seeing it. Distinct from /v1/teams/{ref}/audit_log
// which stays admin-only for compliance reasons.
func TestActivity_ViewerCanRead(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	viewer := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Open Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "OpenProj")

	// Seed viewer as a team member with viewer override on the project.
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

	// The helper-created project already produced 1 audit event.
	var resp activityTestResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/activity",
		viewer.AccessToken, nil, http.StatusOK, &resp)
	if len(resp.Events) != 1 {
		t.Errorf("viewer should see 1 event (createProject), got %d", len(resp.Events))
	}
	if len(resp.Events) > 0 && resp.Events[0].Action != "createProject" {
		t.Errorf("viewer event action: %q", resp.Events[0].Action)
	}
}

func TestActivity_PaginationCursor(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Paged Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "PagedProj")

	// createProject helper already inserted 1 event; seed 4 more to
	// reach a clean 5-event total, paginated 2/2/1 with limit=2.
	for i := 0; i < 4; i++ {
		seedAuditEvent(t, h, team.ID, owner.ID, "createProject", "project", proj.ID, map[string]any{"i": i})
	}

	var first activityTestResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/activity?limit=2",
		owner.AccessToken, nil, http.StatusOK, &first)
	if len(first.Events) != 2 {
		t.Errorf("page 1: got %d want 2", len(first.Events))
	}
	if first.NextCursor == "" {
		t.Fatal("page 1 should expose nextCursor")
	}

	var second activityTestResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/activity?limit=2&cursor="+first.NextCursor,
		owner.AccessToken, nil, http.StatusOK, &second)
	if len(second.Events) != 2 {
		t.Errorf("page 2: got %d want 2", len(second.Events))
	}
	if second.NextCursor == "" {
		t.Errorf("page 2 should still expose a cursor (5 events / 2 per page)")
	}

	// Page 3 — 1 event left, no further cursor.
	var third activityTestResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/activity?limit=2&cursor="+second.NextCursor,
		owner.AccessToken, nil, http.StatusOK, &third)
	if len(third.Events) != 1 {
		t.Errorf("page 3: got %d want 1", len(third.Events))
	}
	if third.NextCursor != "" {
		t.Errorf("page 3 should NOT expose a cursor (last page)")
	}
}

func TestActivity_InvalidCursor(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Cur Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "CurProj")

	env := h.AssertStatus(http.MethodGet, "/v1/projects/"+proj.ID+"/activity?cursor=notanumber",
		owner.AccessToken, nil, http.StatusBadRequest)
	if env.Code != "invalid_cursor" {
		t.Errorf("code: %q want invalid_cursor", env.Code)
	}
}

func TestActivity_DomainEventsResolveTargetName(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Dom Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "DomProj")
	depID := h.SeedDeployment(proj.ID, "tame-llama-9090", "prod", "running", true, owner.ID, 3220, "")

	// Insert a deployment_domains row + an audit event referencing it.
	var domainID string
	if err := h.DB.QueryRow(h.rootCtx, `
		INSERT INTO deployment_domains (deployment_id, domain, role, status)
		VALUES ($1, $2, 'api', 'active')
		RETURNING id
	`, depID, "api.example.com").Scan(&domainID); err != nil {
		t.Fatalf("seed domain: %v", err)
	}
	seedAuditEvent(t, h, team.ID, owner.ID, "domain.added", "domain", domainID, map[string]any{"deploymentId": depID})

	var resp activityTestResp
	h.DoJSON(http.MethodGet, "/v1/projects/"+proj.ID+"/activity",
		owner.AccessToken, nil, http.StatusOK, &resp)
	// 2 events expected: createProject (helper) + domain.added (manual).
	if len(resp.Events) != 2 {
		t.Fatalf("events: got %d want 2 (createProject + domain.added)", len(resp.Events))
	}
	// The domain.added event sorts first (newer). Verify its
	// targetName was resolved from the deployment_domains JOIN.
	var domainEvent *struct {
		ID         string         `json:"id"`
		CreateTime time.Time      `json:"createTime"`
		Action     string         `json:"action"`
		ActorID    string         `json:"actorId"`
		ActorEmail string         `json:"actorEmail"`
		ActorName  string         `json:"actorName"`
		TargetType string         `json:"targetType"`
		TargetID   string         `json:"targetId"`
		TargetName string         `json:"targetName"`
		Metadata   map[string]any `json:"metadata"`
	}
	for i := range resp.Events {
		if resp.Events[i].Action == "domain.added" {
			domainEvent = &resp.Events[i]
			break
		}
	}
	if domainEvent == nil {
		t.Fatalf("expected a domain.added event")
	}
	if domainEvent.TargetName != "api.example.com" {
		t.Errorf("targetName for domain event: got %q want api.example.com", domainEvent.TargetName)
	}
}
