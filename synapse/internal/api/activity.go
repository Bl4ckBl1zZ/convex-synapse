package api

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ActivityHandler serves GET /v1/projects/{id}/activity — the
// project-scoped "feed" view of audit_events. Distinct from
// /v1/teams/{ref}/audit_log:
//
//  1. Scoped to events that touch THIS project (direct project
//     actions + deployment actions for deployments in the project +
//     domain actions for those deployments).
//  2. Visible to any project member (admin / member / viewer) instead
//     of admin-only. Activity is the operator-facing "what happened
//     here" view; audit_log is the compliance / forensic view.
//  3. Returns target_name resolved server-side (deployment name,
//     project name, domain hostname) so the client can render
//     "brave-dolphin-1060 created" without an extra fetch per event.
//
// Pagination uses keyset on (created_at DESC, id DESC) — same shape
// as the team audit_log endpoint.
type ActivityHandler struct {
	DB       *pgxpool.Pool
	Projects *ProjectsHandler
}

type activityEvent struct {
	ID         string         `json:"id"`
	CreateTime time.Time      `json:"createTime"`
	Action     string         `json:"action"`
	ActorID    string         `json:"actorId,omitempty"`
	ActorEmail string         `json:"actorEmail,omitempty"`
	ActorName  string         `json:"actorName,omitempty"`
	TargetType string         `json:"targetType,omitempty"`
	TargetID   string         `json:"targetId,omitempty"`
	TargetName string         `json:"targetName,omitempty"`
	Metadata   map[string]any `json:"metadata,omitempty"`
}

type activityResp struct {
	Events     []activityEvent `json:"events"`
	NextCursor string          `json:"nextCursor,omitempty"`
}

func (h *ActivityHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.Projects == nil {
		writeError(w, http.StatusServiceUnavailable, "not_configured", "ProjectsHandler not wired")
		return
	}
	// loadProjectForRequest already enforces "viewer or above". The
	// activity endpoint matches that — any member can see what's
	// happening on their project.
	p, t, _, ok := h.Projects.loadProjectForRequest(w, r)
	if !ok {
		return
	}

	limit := 30
	if s := r.URL.Query().Get("limit"); s != "" {
		n, err := strconv.Atoi(s)
		if err != nil || n <= 0 {
			writeError(w, http.StatusBadRequest, "invalid_limit", "limit must be a positive integer")
			return
		}
		if n > 200 {
			n = 200
		}
		limit = n
	}

	cursor := r.URL.Query().Get("cursor")
	var cursorID int64
	var cursorAt time.Time
	hasCursor := false
	if cursor != "" {
		parsed, err := strconv.ParseInt(cursor, 10, 64)
		if err != nil {
			writeError(w, http.StatusBadRequest, "invalid_cursor", "Cursor must be a numeric event id")
			return
		}
		cursorID = parsed
		err = h.DB.QueryRow(r.Context(),
			`SELECT created_at FROM audit_events WHERE id = $1 AND team_id = $2`,
			cursorID, t.ID).Scan(&cursorAt)
		if errors.Is(err, pgx.ErrNoRows) {
			writeError(w, http.StatusBadRequest, "invalid_cursor", "Cursor does not refer to an event for this team")
			return
		}
		if err != nil {
			logErr("activity: resolve cursor", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to resolve cursor")
			return
		}
		hasCursor = true
	}

	// Project-scoped audit query. Three OR branches cover every event
	// kind that touches a project:
	//   1. target_type='project' AND target_id = project          (rename, transfer, env-var changes, ...)
	//   2. target_type='deployment' AND deployment.project_id     (create/delete/adopt deploy keys, etc)
	//   3. target_type='domain' AND domain→deployment→project     (custom domains)
	// All other event kinds (account, dns_credential, synapse, ...)
	// are excluded from this scope on purpose — they belong on the
	// team or instance audit log, not the project activity feed.
	baseSQL := `
		SELECT e.id, e.created_at, e.action, e.actor_id, u.email, u.name,
		       e.target_type, e.target_id, e.metadata,
		       COALESCE(p.name, d.name, dd.domain, '') AS target_name
		  FROM audit_events e
		  LEFT JOIN users u ON u.id = e.actor_id
		  LEFT JOIN projects p ON e.target_type = 'project' AND p.id = e.target_id
		  LEFT JOIN deployments d ON e.target_type = 'deployment' AND d.id = e.target_id
		  LEFT JOIN deployment_domains dd ON e.target_type = 'domain' AND dd.id = e.target_id
		  LEFT JOIN deployments dd_dep ON dd.deployment_id = dd_dep.id
		 WHERE e.team_id = $1
		   AND (
		     (e.target_type = 'project' AND e.target_id = $2)
		     OR (e.target_type = 'deployment' AND d.project_id = $2)
		     OR (e.target_type = 'domain' AND dd_dep.project_id = $2)
		   )`

	var rows pgx.Rows
	var err error
	if !hasCursor {
		rows, err = h.DB.Query(r.Context(), baseSQL+`
			 ORDER BY e.created_at DESC, e.id DESC
			 LIMIT $3
		`, t.ID, p.ID, limit+1)
	} else {
		rows, err = h.DB.Query(r.Context(), baseSQL+`
			   AND (e.created_at, e.id) < ($3, $4)
			 ORDER BY e.created_at DESC, e.id DESC
			 LIMIT $5
		`, t.ID, p.ID, cursorAt, cursorID, limit+1)
	}
	if err != nil {
		logErr("activity: list events", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to list activity")
		return
	}
	defer rows.Close()

	events := make([]activityEvent, 0, limit)
	for rows.Next() {
		var (
			id         int64
			createTime time.Time
			action     string
			actorID    *string
			actorEmail *string
			actorName  *string
			targetType *string
			targetID   *string
			metadata   []byte
			targetName string
		)
		if err := rows.Scan(&id, &createTime, &action, &actorID, &actorEmail, &actorName,
			&targetType, &targetID, &metadata, &targetName); err != nil {
			logErr("activity: scan", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to scan activity events")
			return
		}
		ev := activityEvent{
			ID:         strconv.FormatInt(id, 10),
			CreateTime: createTime,
			Action:     action,
			TargetName: targetName,
		}
		if actorID != nil {
			ev.ActorID = *actorID
		}
		if actorEmail != nil {
			ev.ActorEmail = *actorEmail
		}
		if actorName != nil {
			ev.ActorName = *actorName
		}
		if targetType != nil {
			ev.TargetType = *targetType
		}
		if targetID != nil {
			ev.TargetID = *targetID
		}
		if len(metadata) > 0 {
			var m map[string]any
			if err := json.Unmarshal(metadata, &m); err == nil {
				ev.Metadata = m
			}
		}
		events = append(events, ev)
	}
	if err := rows.Err(); err != nil {
		logErr("activity: rows iter", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to read activity events")
		return
	}

	resp := activityResp{Events: events}
	if len(events) > limit {
		// We over-fetched by one row to know whether to surface a
		// cursor. Trim the extra row and cursor on the LAST item we
		// actually return (its id is the next page's starting point).
		resp.Events = events[:limit]
		resp.NextCursor = events[limit-1].ID
	}
	writeJSON(w, http.StatusOK, resp)
}
