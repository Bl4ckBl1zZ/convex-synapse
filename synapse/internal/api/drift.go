package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/audit"
	"github.com/Iann29/synapse/internal/auth"
	"github.com/Iann29/synapse/internal/models"
)

// DriftHandler owns the Drift Engine + dry-run planner (Bloco 9b). It COMPARES
// DesiredState against ObservedState and CLASSIFIES the divergence, then turns
// each classification into a *planned* operation step.
//
// Hard contract for this block: nothing here applies anything. No Docker
// create/restart/rm, no proxy mutation, no message to the agent, no change to
// desired_states / observed_states. Operation steps are only planned / no_op /
// skipped; every plan carries applyAllowed=false. An apply=true request body is
// rejected 400 apply_not_supported.
type DriftHandler struct {
	DB       *pgxpool.Pool
	Projects *ProjectsHandler
	Cells    *CellsHandler
	Hosts    *HostsHandler
	// StaleAfter / OfflineAfter mirror HostsHandler — they drive the host
	// effectiveStatus that decides whether observation can be trusted.
	StaleAfter   time.Duration
	OfflineAfter time.Duration

	// Bloco 10 — central-driven apply. ApplyEnabled gates the whole
	// reconcile/apply surface (404 when false). ApplyDangerous is the second
	// gate for stop/remove. HealthcheckViaNetwork is passed through to the
	// reconcile jobs the apply handler enqueues. See docs/CCP_APPLY_PLAN.md.
	ApplyEnabled          bool
	ApplyDangerous        bool
	HealthcheckViaNetwork bool
}

func (h *DriftHandler) staleAfter() time.Duration {
	if h.StaleAfter > 0 {
		return h.StaleAfter
	}
	return 60 * time.Second
}

func (h *DriftHandler) offlineAfter() time.Duration {
	if h.OfflineAfter > 0 {
		return h.OfflineAfter
	}
	return 300 * time.Second
}

// ============================================================
// HTTP handlers — project / cell / host scoped
// ============================================================
//
// RBAC:
//   - latest (view): any project member (project/cell), instance-admin (host).
//   - recompute / dry_run: project admin (project/cell), instance-admin (host,
//     enforced by the HostsHandler route middleware).

func (h *DriftHandler) recomputeProject(w http.ResponseWriter, r *http.Request) {
	p, _, role, ok := h.Projects.loadProjectForRequest(w, r)
	if !ok {
		return
	}
	if !canAdminProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "Recomputing drift requires project admin")
		return
	}
	if h.applyRejected(w, r) {
		return
	}
	h.doRecompute(w, r, driftScope{kind: scopeProject, projectID: p.ID, teamID: p.TeamID})
}

func (h *DriftHandler) latestProject(w http.ResponseWriter, r *http.Request) {
	p, _, _, ok := h.Projects.loadProjectForRequest(w, r)
	if !ok {
		return
	}
	h.doLatest(w, r, driftScope{kind: scopeProject, projectID: p.ID, teamID: p.TeamID})
}

func (h *DriftHandler) dryRunProject(w http.ResponseWriter, r *http.Request) {
	p, _, role, ok := h.Projects.loadProjectForRequest(w, r)
	if !ok {
		return
	}
	if !canAdminProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "Reconcile dry-run requires project admin")
		return
	}
	if h.applyRejected(w, r) {
		return
	}
	h.doDryRun(w, r, driftScope{kind: scopeProject, projectID: p.ID, teamID: p.TeamID})
}

func (h *DriftHandler) recomputeCell(w http.ResponseWriter, r *http.Request) {
	c, role, ok := h.Cells.loadCellForRequest(w, r)
	if !ok {
		return
	}
	if !canAdminProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "Recomputing drift requires project admin")
		return
	}
	if h.applyRejected(w, r) {
		return
	}
	h.doRecompute(w, r, driftScope{kind: scopeCell, cellID: c.ID, projectID: c.ProjectID, teamID: c.TeamID})
}

func (h *DriftHandler) latestCell(w http.ResponseWriter, r *http.Request) {
	c, _, ok := h.Cells.loadCellForRequest(w, r)
	if !ok {
		return
	}
	h.doLatest(w, r, driftScope{kind: scopeCell, cellID: c.ID, projectID: c.ProjectID, teamID: c.TeamID})
}

func (h *DriftHandler) dryRunCell(w http.ResponseWriter, r *http.Request) {
	c, role, ok := h.Cells.loadCellForRequest(w, r)
	if !ok {
		return
	}
	if !canAdminProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "Reconcile dry-run requires project admin")
		return
	}
	if h.applyRejected(w, r) {
		return
	}
	h.doDryRun(w, r, driftScope{kind: scopeCell, cellID: c.ID, projectID: c.ProjectID, teamID: c.TeamID})
}

// Host-scoped handlers are mounted under HostsHandler.Routes(), already gated by
// requireInstanceAdmin — no extra role check needed here.

func (h *DriftHandler) recomputeHost(w http.ResponseWriter, r *http.Request) {
	hst, ok := h.Hosts.loadHost(w, r)
	if !ok {
		return
	}
	if h.applyRejected(w, r) {
		return
	}
	h.doRecompute(w, r, driftScope{kind: scopeHost, hostID: hst.ID})
}

func (h *DriftHandler) latestHost(w http.ResponseWriter, r *http.Request) {
	hst, ok := h.Hosts.loadHost(w, r)
	if !ok {
		return
	}
	h.doLatest(w, r, driftScope{kind: scopeHost, hostID: hst.ID})
}

func (h *DriftHandler) dryRunHost(w http.ResponseWriter, r *http.Request) {
	hst, ok := h.Hosts.loadHost(w, r)
	if !ok {
		return
	}
	if h.applyRejected(w, r) {
		return
	}
	h.doDryRun(w, r, driftScope{kind: scopeHost, hostID: hst.ID})
}

// ---- shared handler bodies ----

type driftResponse struct {
	Report *models.DriftReport `json:"report"`
	Items  []models.DriftItem  `json:"items"`
}

func (h *DriftHandler) doRecompute(w http.ResponseWriter, r *http.Request, scope driftScope) {
	uid, _ := auth.UserID(r.Context())
	var actor *string
	if uid != "" {
		actor = &uid
	}
	report, items, err := h.recompute(r.Context(), scope, actor)
	if err != nil {
		logErr("recompute drift", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to recompute drift")
		return
	}
	h.auditDrift(r.Context(), uid, scope, audit.ActionComputeDrift, report.Summary)
	writeJSON(w, http.StatusOK, driftResponse{Report: &report, Items: items})
}

func (h *DriftHandler) doLatest(w http.ResponseWriter, r *http.Request, scope driftScope) {
	report, items, found, err := h.latest(r.Context(), scope)
	if err != nil {
		logErr("latest drift", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to load drift report")
		return
	}
	if !found {
		// No drift has been computed for this scope yet. Return a 200 with an
		// empty report so the dashboard can render "not computed yet" without a
		// 404 round-trip.
		writeJSON(w, http.StatusOK, driftResponse{Report: nil, Items: []models.DriftItem{}})
		return
	}
	writeJSON(w, http.StatusOK, driftResponse{Report: &report, Items: items})
}

func (h *DriftHandler) doDryRun(w http.ResponseWriter, r *http.Request, scope driftScope) {
	uid, _ := auth.UserID(r.Context())
	var actor *string
	if uid != "" {
		actor = &uid
	}
	run, steps, err := h.dryRun(r.Context(), scope, actor)
	if err != nil {
		logErr("reconcile dry-run", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to build reconcile plan")
		return
	}
	h.auditDrift(r.Context(), uid, scope, audit.ActionReconcileDryRun, run.PlanJSON)
	// applyEnabled tells the dashboard whether to surface an Apply button on
	// this plan (Bloco 10). It never changes what dry-run does — dry-run is
	// always read-only; apply is the separate reconcile/apply verb.
	writeJSON(w, http.StatusOK, map[string]any{
		"operationRun": run,
		"steps":        steps,
		"applyEnabled": h.effectiveApplyEnabled(r.Context()),
	})
}

// applyRejected enforces the dry-run-only contract: an explicit apply:true in
// the body is a 400. An empty / apply-less body is fine. Unknown fields are
// tolerated (this is a guard, not a strict decoder).
func (h *DriftHandler) applyRejected(w http.ResponseWriter, r *http.Request) bool {
	var req struct {
		Apply bool `json:"apply,omitempty"`
	}
	if r.Body != nil {
		_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(&req)
	}
	if req.Apply {
		writeError(w, http.StatusBadRequest, "apply_not_supported",
			"Apply is not supported in this release — drift and reconcile are dry-run only")
		return true
	}
	return false
}

func (h *DriftHandler) auditDrift(ctx context.Context, uid string, scope driftScope, action string, meta map[string]any) {
	opts := audit.Options{ActorID: uid, Action: action, Metadata: meta}
	switch scope.kind {
	case scopeHost:
		opts.TargetType = audit.TargetHost
		opts.TargetID = scope.hostID
	case scopeCell:
		opts.TeamID = scope.teamID
		opts.TargetType = audit.TargetCell
		opts.TargetID = scope.cellID
	case scopeProject:
		opts.TeamID = scope.teamID
		opts.TargetType = audit.TargetProject
		opts.TargetID = scope.projectID
	}
	_ = audit.Record(ctx, h.DB, opts)
}

// ============================================================
// scope
// ============================================================

const (
	scopeHost    = "host"
	scopeCell    = "cell"
	scopeProject = "project"
)

type driftScope struct {
	kind      string
	hostID    string
	cellID    string
	projectID string
	teamID    string
}

func (s driftScope) id() string {
	switch s.kind {
	case scopeHost:
		return s.hostID
	case scopeCell:
		return s.cellID
	default:
		return s.projectID
	}
}

// opRunInput builds the OperationRun scope. Cell/project runs carry project_id
// so project members can read them via GET /v1/operation_runs/{id}; host runs
// carry only host_id, keeping them instance-admin-only.
func (s driftScope) opRunInput(typ string, actor *string) opRunInput {
	in := opRunInput{Type: typ, CreatedBy: actor, Input: map[string]any{"scope": s.kind, "scopeId": s.id()}}
	switch s.kind {
	case scopeHost:
		in.HostID = strPtrOrNil(s.hostID)
	case scopeCell:
		in.CellID = strPtrOrNil(s.cellID)
		in.ProjectID = strPtrOrNil(s.projectID)
		in.TeamID = strPtrOrNil(s.teamID)
	case scopeProject:
		in.ProjectID = strPtrOrNil(s.projectID)
		in.TeamID = strPtrOrNil(s.teamID)
	}
	return in
}

func strPtrOrNil(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// ============================================================
// Drift Engine — recompute + persist
// ============================================================

// recompute runs a compute_drift OperationRun: it computes the drift items for
// the scope, persists a DriftReport + its items, and returns them. The compute
// is read-only; only drift_reports / drift_items / operation_runs are written.
func (h *DriftHandler) recompute(ctx context.Context, scope driftScope, actor *string) (models.DriftReport, []models.DriftItem, error) {
	runID, err := startOperationRun(ctx, h.DB, scope.opRunInput(models.OperationTypeComputeDrift, actor))
	if err != nil {
		return models.DriftReport{}, nil, err
	}

	items, summary, err := h.computeDrift(ctx, scope)
	if err != nil {
		finishOperationRun(ctx, h.DB, runID, models.OperationStatusFailed, nil, nil, err.Error())
		return models.DriftReport{}, nil, err
	}
	status := rollupReportStatus(items)

	reportID, err := h.persistReport(ctx, scope, runID, status, summary, items)
	if err != nil {
		finishOperationRun(ctx, h.DB, runID, models.OperationStatusFailed, nil, nil, err.Error())
		return models.DriftReport{}, nil, err
	}
	finishOperationRun(ctx, h.DB, runID, models.OperationStatusSucceeded,
		map[string]any{"driftReportId": reportID, "status": status, "summary": summary}, nil, "")

	report, err := loadDriftReport(ctx, h.DB, reportID)
	if err != nil {
		return models.DriftReport{}, nil, err
	}
	loaded, err := loadDriftItems(ctx, h.DB, reportID)
	if err != nil {
		return models.DriftReport{}, nil, err
	}
	return report, loaded, nil
}

// persistReport writes the report + its items in a single transaction.
func (h *DriftHandler) persistReport(ctx context.Context, scope driftScope, runID, status string, summary map[string]any, items []models.DriftItem) (string, error) {
	tx, err := h.DB.Begin(ctx)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var hostID, projectID, cellID *string
	switch scope.kind {
	case scopeHost:
		hostID = strPtrOrNil(scope.hostID)
	case scopeCell:
		cellID = strPtrOrNil(scope.cellID)
		projectID = strPtrOrNil(scope.projectID)
	case scopeProject:
		projectID = strPtrOrNil(scope.projectID)
	}

	var reportID string
	if err := tx.QueryRow(ctx, `
		INSERT INTO drift_reports (host_id, project_id, cell_id, operation_run_id, status, summary_json)
		VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
	`, hostID, projectID, cellID, runID, status, marshalJSONBMap(summary)).Scan(&reportID); err != nil {
		return "", err
	}

	for _, it := range items {
		if _, err := tx.Exec(ctx, `
			INSERT INTO drift_items (drift_report_id, host_id, cell_id, resource_type, resource_key,
			                         desired_state_id, observed_state_id, drift_status, severity,
			                         diff_json, recommended_action)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		`, reportID, it.HostID, it.CellID, it.ResourceType, it.ResourceKey,
			it.DesiredStateID, it.ObservedStateID, it.DriftStatus, it.Severity,
			marshalJSONBMap(it.Diff), it.RecommendedAction); err != nil {
			return "", err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return "", err
	}
	return reportID, nil
}

// latest returns the most recent DriftReport for the scope + its items.
func (h *DriftHandler) latest(ctx context.Context, scope driftScope) (models.DriftReport, []models.DriftItem, bool, error) {
	col := map[string]string{scopeHost: "host_id", scopeCell: "cell_id", scopeProject: "project_id"}[scope.kind]
	report, err := loadDriftReportBy(ctx, h.DB, col, scope.id())
	if errors.Is(err, pgx.ErrNoRows) {
		return models.DriftReport{}, nil, false, nil
	}
	if err != nil {
		return models.DriftReport{}, nil, false, err
	}
	items, err := loadDriftItems(ctx, h.DB, report.ID)
	if err != nil {
		return models.DriftReport{}, nil, false, err
	}
	return report, items, true, nil
}

// ============================================================
// Drift Engine — the comparison core (read-only, no persistence)
// ============================================================

// desiredCmp is the slim projection of an active convex_deployment desired
// state the comparator needs.
type desiredCmp struct {
	id            string
	hostID        string
	cellID        *string
	projectID     *string
	depID         string
	depName       string // deployment name — used for the legacy-label fallback
	resourceKey   string
	desiredStatus string
}

// observedCmp is the slim projection of an observed docker_container.
type observedCmp struct {
	id          string
	hostID      string
	resourceKey string
	state       string
	managed     bool
	depID       string // synapse.deployment_id (UUID) — primary correlation key
	depName     string // synapse.deployment (name) — legacy fallback key
	cellID      string
	projectID   string
}

// computeDrift loads the scope's desired + observed state, correlates them, and
// returns the classified items + a summary. Pure read — never writes.
func (h *DriftHandler) computeDrift(ctx context.Context, scope driftScope) ([]models.DriftItem, map[string]any, error) {
	desired, err := h.loadDesiredForScope(ctx, scope)
	if err != nil {
		return nil, nil, err
	}
	observed, err := h.loadObservedForScope(ctx, scope)
	if err != nil {
		return nil, nil, err
	}

	// Hosts involved + their facts/liveness, deployment existence.
	hostSet := map[string]bool{}
	for _, d := range desired {
		hostSet[d.hostID] = true
	}
	for _, o := range observed {
		hostSet[o.hostID] = true
	}
	hosts, err := loadHostsByID(ctx, h.DB, keysOf(hostSet))
	if err != nil {
		return nil, nil, err
	}
	facts, err := loadHostFacts(ctx, h.DB, keysOf(hostSet))
	if err != nil {
		return nil, nil, err
	}
	depIDs := map[string]bool{}
	for _, d := range desired {
		if d.depID != "" {
			depIDs[d.depID] = true
		}
	}
	depExists, err := loadDeploymentExistence(ctx, h.DB, keysOf(depIDs))
	if err != nil {
		return nil, nil, err
	}

	// Index observed managed containers by host|deploymentId (primary key).
	observedByHostDep := map[string]*observedCmp{}
	for i := range observed {
		o := &observed[i]
		if o.managed && o.depID != "" {
			observedByHostDep[o.hostID+"|"+o.depID] = o
		}
	}
	// Legacy-label fallback index (Bloco 12.6): managed containers WITHOUT a
	// synapse.deployment_id (pre-12.6 provisioner) keyed by host|name
	// (synapse.deployment). Built from the scoped observed set PLUS — for
	// project/cell scope, whose observed query filters on the
	// synapse.project_id/cell_id label that legacy containers LACK — a
	// host-scoped top-up so pre-fix containers on the project's hosts still
	// correlate. Used for fallback matching only (never for unmanaged
	// detection). Ambiguous (host,name) pairs are dropped so it never guesses.
	legacyPool := make([]*observedCmp, 0)
	seenObsID := map[string]bool{}
	for i := range observed {
		o := &observed[i]
		seenObsID[o.id] = true
		if o.managed && o.depID == "" && o.depName != "" {
			legacyPool = append(legacyPool, o)
		}
	}
	if scope.kind != scopeHost {
		desiredHosts := map[string]bool{}
		for _, d := range desired {
			desiredHosts[d.hostID] = true
		}
		extra, err := loadLegacyContainers(ctx, h.DB, keysOf(desiredHosts))
		if err != nil {
			return nil, nil, err
		}
		for i := range extra {
			o := &extra[i]
			if !seenObsID[o.id] {
				legacyPool = append(legacyPool, o)
			}
		}
	}
	observedByHostName := map[string]*observedCmp{}
	nameSeen := map[string]int{}
	for _, o := range legacyPool {
		key := o.hostID + "|" + o.depName
		nameSeen[key]++
		observedByHostName[key] = o
	}
	for key, n := range nameSeen {
		if n > 1 {
			delete(observedByHostName, key) // ambiguous → no fallback
		}
	}
	matched := map[string]bool{}

	now := time.Now()
	staleAfter, offlineAfter := h.staleAfter(), h.offlineAfter()
	var items []models.DriftItem

	for _, d := range desired {
		dsID := d.id
		// 1. Orphaned: the control-plane wants a deployment that no longer exists.
		if d.depID != "" && !depExists[d.depID] {
			items = append(items, driftItem(d.hostID, d.cellID, d.resourceKey, &dsID, nil,
				models.DriftStatusOrphaned, models.SeverityWarning, models.RecommendedActionInvestigate,
				map[string]any{
					"reason":       "active desired state references a deployment that no longer exists",
					"deploymentId": d.depID,
				}))
			continue
		}

		// 2. Host trust: if observation can't be trusted, never claim "missing".
		hst := hosts[d.hostID]
		tr := hostTrust(hst, facts[d.hostID], staleAfter, offlineAfter, now)
		o := observedByHostDep[d.hostID+"|"+d.depID]
		// Legacy fallback: no deployment_id match, but a managed container on
		// this host carries the matching synapse.deployment NAME (no UUID).
		fallback := false
		if o == nil && d.depName != "" {
			if cand := observedByHostName[d.hostID+"|"+d.depName]; cand != nil && legacyProjectOK(cand, d) {
				o = cand
				fallback = true
			}
		}
		if !tr.ok {
			if o != nil {
				matched[o.id] = true
			}
			items = append(items, annotateDraining(driftItem(d.hostID, d.cellID, d.resourceKey, &dsID, observedID(o),
				models.DriftStatusHostUnreachable, tr.severity, models.RecommendedActionInvestigate,
				map[string]any{
					"reason":        tr.reason,
					"hostStatus":    tr.status,
					"desiredStatus": d.desiredStatus,
				}), tr.draining))
			continue
		}

		// 3. No matching observed container.
		if o == nil {
			switch d.desiredStatus {
			case models.PlacementDesiredRunning:
				items = append(items, annotateDraining(driftItem(d.hostID, d.cellID, d.resourceKey, &dsID, nil,
					models.DriftStatusMissing, models.SeverityCritical, models.RecommendedActionCreate,
					map[string]any{
						"reason":        "desired running but no matching container observed on the host",
						"desiredStatus": d.desiredStatus,
						"deploymentId":  d.depID,
					}), tr.draining))
			default:
				// stopped / absent + no container = the goal (not running) is met.
				items = append(items, annotateDraining(driftItem(d.hostID, d.cellID, d.resourceKey, &dsID, nil,
					models.DriftStatusInSync, models.SeverityInfo, models.RecommendedActionNone,
					map[string]any{"desiredStatus": d.desiredStatus, "observed": "absent"}), tr.draining))
			}
			continue
		}
		matched[o.id] = true

		// 4. Label mismatch — same deployment id, different cell/project label.
		if mm := labelMismatch(d, o); mm != nil {
			items = append(items, annotateDraining(driftItem(d.hostID, d.cellID, d.resourceKey, &dsID, observedID(o),
				models.DriftStatusDrifted, models.SeverityCritical, models.RecommendedActionInvestigate, mm), tr.draining))
			continue
		}

		// 5. State comparison.
		items = append(items, annotateDraining(annotateLegacyFallback(compareState(d, o, dsID), fallback), tr.draining))
	}

	// 6. Unmanaged: observed synapse-managed containers with no active desired,
	// on TRUSTED hosts only (stale data on an untrusted host isn't actionable).
	for i := range observed {
		o := &observed[i]
		if matched[o.id] {
			continue
		}
		if !o.managed {
			// Should never happen (the agent filters synapse.managed=true and the
			// server re-filters), but if it does it's not ours → ignore.
			items = append(items, driftItem(o.hostID, observedCellPtr(o), o.resourceKey, nil, &o.id,
				models.DriftStatusIgnored, models.SeverityInfo, models.RecommendedActionNone,
				map[string]any{"reason": "container is not synapse-managed"}))
			continue
		}
		hst := hosts[o.hostID]
		tr := hostTrust(hst, facts[o.hostID], staleAfter, offlineAfter, now)
		if !tr.ok {
			continue
		}
		diff := map[string]any{
			"reason":        "synapse-managed container has no active desired state on this host",
			"observedState": o.state,
		}
		if o.depID == "" {
			diff["note"] = "container is missing the synapse.deployment_id label"
		} else {
			diff["deploymentId"] = o.depID
		}
		items = append(items, annotateDraining(driftItem(o.hostID, observedCellPtr(o), o.resourceKey, nil, &o.id,
			models.DriftStatusUnmanaged, models.SeverityWarning, models.RecommendedActionInvestigate, diff), tr.draining))
	}

	return items, summarize(items), nil
}

// annotateDraining records the host's lifecycle on an item WITHOUT changing its
// drift classification — a draining host's real drift must still surface, just
// flagged so operators know the host is being wound down.
func annotateDraining(it models.DriftItem, draining bool) models.DriftItem {
	if draining {
		if it.Diff == nil {
			it.Diff = map[string]any{}
		}
		it.Diff["lifecycle"] = models.HostStatusDraining
	}
	return it
}

// legacyProjectOK guards the legacy-label fallback: a name-matched container is
// accepted only if its project label is absent (a true legacy container) or
// matches the desired project. A different project means it's NOT the same
// resource, so the fallback is refused.
func legacyProjectOK(o *observedCmp, d desiredCmp) bool {
	if o.projectID == "" {
		return true
	}
	return d.projectID != nil && o.projectID == *d.projectID
}

// annotateLegacyFallback flags an item that matched via the legacy
// synapse.deployment (name) label instead of synapse.deployment_id (UUID), so
// the operator knows to recreate/upgrade the container to stamp the UUID.
func annotateLegacyFallback(it models.DriftItem, fallback bool) models.DriftItem {
	if fallback {
		if it.Diff == nil {
			it.Diff = map[string]any{}
		}
		it.Diff["legacyLabelFallback"] = true
		it.Diff["legacyLabel"] = "synapse.deployment"
		it.Diff["recommendedLabelRefresh"] = true
	}
	return it
}

// compareState classifies a matched desired/observed pair by container state.
func compareState(d desiredCmp, o *observedCmp, dsID string) models.DriftItem {
	running := o.state == "running"
	switch d.desiredStatus {
	case models.PlacementDesiredRunning:
		if running {
			return driftItem(d.hostID, d.cellID, d.resourceKey, &dsID, &o.id,
				models.DriftStatusInSync, models.SeverityInfo, models.RecommendedActionNone,
				map[string]any{"desiredStatus": d.desiredStatus, "observedState": o.state})
		}
		return driftItem(d.hostID, d.cellID, d.resourceKey, &dsID, &o.id,
			models.DriftStatusDrifted, models.SeverityCritical, models.RecommendedActionRestart,
			map[string]any{
				"reason":        "desired running but observed container is not running",
				"desiredStatus": d.desiredStatus,
				"observedState": o.state,
			})
	case models.PlacementDesiredStopped:
		if running {
			return driftItem(d.hostID, d.cellID, d.resourceKey, &dsID, &o.id,
				models.DriftStatusDrifted, models.SeverityWarning, models.RecommendedActionStop,
				map[string]any{
					"reason":        "desired stopped but observed container is running",
					"desiredStatus": d.desiredStatus,
					"observedState": o.state,
				})
		}
		return driftItem(d.hostID, d.cellID, d.resourceKey, &dsID, &o.id,
			models.DriftStatusInSync, models.SeverityInfo, models.RecommendedActionNone,
			map[string]any{"desiredStatus": d.desiredStatus, "observedState": o.state})
	default: // absent
		return driftItem(d.hostID, d.cellID, d.resourceKey, &dsID, &o.id,
			models.DriftStatusDrifted, models.SeverityWarning, models.RecommendedActionRemove,
			map[string]any{
				"reason":        "desired absent but a matching container still exists",
				"desiredStatus": d.desiredStatus,
				"observedState": o.state,
			})
	}
}

// labelMismatch returns a diff map when the observed container's cell/project
// label disagrees with the desired state's cell/project (both sides present).
func labelMismatch(d desiredCmp, o *observedCmp) map[string]any {
	mismatch := map[string]any{}
	if d.cellID != nil && *d.cellID != "" && o.cellID != "" && o.cellID != *d.cellID {
		mismatch["cellId"] = map[string]any{"desired": *d.cellID, "observed": o.cellID}
	}
	if d.projectID != nil && *d.projectID != "" && o.projectID != "" && o.projectID != *d.projectID {
		mismatch["projectId"] = map[string]any{"desired": *d.projectID, "observed": o.projectID}
	}
	if len(mismatch) == 0 {
		return nil
	}
	return map[string]any{
		"reason":        "observed container labels disagree with desired placement",
		"labelMismatch": mismatch,
	}
}

// hostObsFacts is the slice of the latest host_facts the Drift Engine needs to
// decide whether the host's observed containers can be trusted. nil pointers
// mean "unknown" (a legacy agent that didn't report the field, or no host_facts
// row yet) and are NOT held against the host — liveness still gates it.
type hostObsFacts struct {
	dockerAvailable *bool
	scanSucceeded   *bool
	scanComplete    *bool
}

// scanDegraded is true only when the agent EXPLICITLY reported a `docker ps -a`
// that failed or was incomplete (9b.5). Unknown (nil) is not degraded.
func (f hostObsFacts) scanDegraded() bool {
	return (f.scanSucceeded != nil && !*f.scanSucceeded) ||
		(f.scanComplete != nil && !*f.scanComplete)
}

// trustResult is whether a host's observed state can be believed. draining is
// surfaced separately (lifecycle, not liveness) so it can annotate items
// WITHOUT masking real drift.
type trustResult struct {
	ok       bool
	status   string // the liveness verdict (online/stale/offline) — NOT lifecycle
	reason   string
	severity string
	draining bool
}

// liveness is the heartbeat-only health of a host (online/stale/offline),
// deliberately IGNORING the operator lifecycle (draining) so a drained-but-live
// host's real drift is still diagnosed. The no-heartbeat case is handled by the
// caller (hostTrust).
func liveness(hst models.Host, staleAfter, offlineAfter time.Duration, now time.Time) string {
	if hst.LastHeartbeatAt == nil {
		return models.HostStatusOffline
	}
	age := now.Sub(*hst.LastHeartbeatAt)
	switch {
	case age <= staleAfter:
		return models.HostStatusOnline
	case age <= offlineAfter:
		return models.HostStatusStale
	default:
		return models.HostStatusOffline
	}
}

// hostTrust decides whether a host's observed state can be believed. It splits
// LIVENESS (online/stale/offline, from the heartbeat) from LIFECYCLE (draining,
// operator intent): only liveness + docker/scan health gate trust. A host that
// is draining but still online with a successful scan IS trusted — its real
// drift must be diagnosed, not hidden behind a blanket "unreachable".
func hostTrust(hst models.Host, facts hostObsFacts, staleAfter, offlineAfter time.Duration, now time.Time) trustResult {
	draining := hst.Status == models.HostStatusDraining
	// A host that never sent a heartbeat has no observation to trust — even the
	// synapse self-host (which reads "online") hasn't reported containers.
	if hst.LastHeartbeatAt == nil {
		return trustResult{false, models.HostStatusOffline, "no agent has reported observed state for this host yet", models.SeverityWarning, draining}
	}
	switch liveness(hst, staleAfter, offlineAfter, now) {
	case models.HostStatusStale:
		return trustResult{false, models.HostStatusStale, "host agent heartbeat is stale", models.SeverityWarning, draining}
	case models.HostStatusOffline:
		return trustResult{false, models.HostStatusOffline, "host agent is offline", models.SeverityCritical, draining}
	}
	// Online liveness — but the container observation is only trustworthy if
	// docker is up AND the agent's scan succeeded and was complete.
	if facts.dockerAvailable != nil && !*facts.dockerAvailable {
		return trustResult{false, models.HostStatusOnline, "docker daemon is unavailable on this host", models.SeverityWarning, draining}
	}
	if facts.scanDegraded() {
		return trustResult{false, models.HostStatusOnline, "container scan failed or was incomplete; observation can't be trusted", models.SeverityWarning, draining}
	}
	return trustResult{true, models.HostStatusOnline, "", models.SeverityInfo, draining}
}

// driftItem builds a DriftItem with a redacted diff.
func driftItem(hostID string, cellID *string, resourceKey string, desiredID, observedID *string, status, severity, action string, diff map[string]any) models.DriftItem {
	return models.DriftItem{
		HostID:            strPtrOrNil(hostID),
		CellID:            cellID,
		ResourceType:      models.ResourceTypeConvexDeployment,
		ResourceKey:       resourceKey,
		DesiredStateID:    desiredID,
		ObservedStateID:   observedID,
		DriftStatus:       status,
		Severity:          severity,
		Diff:              redactDiff(diff),
		RecommendedAction: action,
	}
}

func observedID(o *observedCmp) *string {
	if o == nil {
		return nil
	}
	return &o.id
}

func observedCellPtr(o *observedCmp) *string {
	if o.cellID == "" {
		return nil
	}
	c := o.cellID
	return &c
}

// ============================================================
// Dry-run planner
// ============================================================

// planStep is the in-memory plan entry the planner builds from a DriftItem.
type planStep struct {
	Action       string
	ResourceType string
	ResourceKey  string
	Status       string
	Reason       string
	Severity     string
	DriftStatus  string
	Dangerous    bool
}

// planStepView is the API shape returned by the dry-run endpoint.
type planStepView struct {
	Action       string `json:"action"`
	ResourceType string `json:"resourceType"`
	ResourceKey  string `json:"resourceKey"`
	Status       string `json:"status"`
	Reason       string `json:"reason,omitempty"`
	WillApply    bool   `json:"willApply"`
}

// dryRun runs a reconcile_dry_run OperationRun: recompute drift, turn each item
// into a *planned* step, persist the steps + plan, and return them. Nothing is
// executed: every step is planned / no_op / skipped and the plan says
// applyAllowed=false. Never touches desired_states / observed_states / the agent.
func (h *DriftHandler) dryRun(ctx context.Context, scope driftScope, actor *string) (models.OperationRun, []planStepView, error) {
	runID, err := startOperationRun(ctx, h.DB, scope.opRunInput(models.OperationTypeReconcileDryRun, actor))
	if err != nil {
		return models.OperationRun{}, nil, err
	}

	items, _, err := h.computeDrift(ctx, scope)
	if err != nil {
		finishOperationRun(ctx, h.DB, runID, models.OperationStatusFailed, nil, nil, err.Error())
		return models.OperationRun{}, nil, err
	}

	steps := buildPlanSteps(items)
	if err := h.persistSteps(ctx, runID, steps); err != nil {
		finishOperationRun(ctx, h.DB, runID, models.OperationStatusFailed, nil, nil, err.Error())
		return models.OperationRun{}, nil, err
	}

	plan := buildPlanJSON(scope, steps)
	finishOperationRun(ctx, h.DB, runID, models.OperationStatusSucceeded, nil, plan, "")

	run, err := scanOperationRun(h.DB.QueryRow(ctx, `SELECT `+operationRunColumns+` FROM operation_runs WHERE id = $1`, runID))
	if err != nil {
		return models.OperationRun{}, nil, err
	}
	views := make([]planStepView, 0, len(steps))
	for _, s := range steps {
		views = append(views, planStepView{
			Action: s.Action, ResourceType: s.ResourceType, ResourceKey: s.ResourceKey,
			Status: s.Status, Reason: s.Reason, WillApply: false,
		})
	}
	return run, views, nil
}

// buildPlanSteps maps drift items to planned steps. Every step is dry-run only.
func buildPlanSteps(items []models.DriftItem) []planStep {
	steps := make([]planStep, 0, len(items))
	for _, it := range items {
		s := planStep{
			ResourceType: it.ResourceType,
			ResourceKey:  it.ResourceKey,
			Severity:     it.Severity,
			DriftStatus:  it.DriftStatus,
		}
		switch it.DriftStatus {
		case models.DriftStatusInSync:
			s.Action, s.Status, s.Reason = models.StepActionNoOp, models.OperationStepStatusNoOp, "resource already in sync"
		case models.DriftStatusMissing:
			s.Action, s.Status, s.Reason = models.RecommendedActionCreate, models.OperationStepStatusPlanned,
				"desired resource has no matching container; would create"
		case models.DriftStatusDrifted:
			s.Action, s.Status = it.RecommendedAction, models.OperationStepStatusPlanned
			switch it.RecommendedAction {
			case models.RecommendedActionRestart:
				s.Reason = "observed container not running; would restart"
			case models.RecommendedActionStop:
				s.Reason = "observed container running but desired stopped; would stop"
			case models.RecommendedActionRemove:
				s.Reason = "desired absent but container exists; dry-run only — removal not implemented"
				s.Dangerous = true
			default:
				s.Action, s.Reason = models.RecommendedActionInvestigate, "divergence requires investigation"
			}
		case models.DriftStatusUnmanaged:
			s.Action, s.Status, s.Reason = models.RecommendedActionInvestigate, models.OperationStepStatusPlanned,
				"unmanaged synapse container; investigate before any action"
		case models.DriftStatusOrphaned:
			s.Action, s.Status, s.Reason = models.RecommendedActionInvestigate, models.OperationStepStatusPlanned,
				"orphaned control-plane state; investigate"
		case models.DriftStatusHostUnreachable:
			// Can't plan against a host we can't trust — skip it.
			s.Action, s.Status, s.Reason = models.RecommendedActionInvestigate, models.OperationStepStatusSkipped,
				"host unreachable; observation can't be trusted"
		default: // ignored
			s.Action, s.Status, s.Reason = models.StepActionNoOp, models.OperationStepStatusSkipped, "resource ignored"
		}
		steps = append(steps, s)
	}
	return steps
}

func (h *DriftHandler) persistSteps(ctx context.Context, runID string, steps []planStep) error {
	if len(steps) == 0 {
		return nil
	}
	tx, err := h.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	for i, s := range steps {
		input := map[string]any{
			"willApply":   false,
			"dryRunOnly":  true,
			"dangerous":   s.Dangerous,
			"severity":    s.Severity,
			"driftStatus": s.DriftStatus,
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO operation_steps (operation_run_id, step_index, action, resource_type, resource_key,
			                             status, reason, input_json)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		`, runID, i, s.Action, s.ResourceType, s.ResourceKey, s.Status, s.Reason, marshalJSONBMap(input)); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// buildPlanJSON is the persisted dry-run plan. applyAllowed is hard-false.
func buildPlanJSON(scope driftScope, steps []planStep) map[string]any {
	planned, noOp, investigate, dangerous, skipped := 0, 0, 0, 0, 0
	stepList := make([]map[string]any, 0, len(steps))
	for _, s := range steps {
		switch s.Status {
		case models.OperationStepStatusPlanned:
			planned++
		case models.OperationStepStatusNoOp:
			noOp++
		case models.OperationStepStatusSkipped:
			skipped++
		}
		if s.Action == models.RecommendedActionInvestigate {
			investigate++
		}
		if s.Dangerous {
			dangerous++
		}
		stepList = append(stepList, map[string]any{
			"action":       s.Action,
			"resourceType": s.ResourceType,
			"resourceKey":  s.ResourceKey,
			"status":       s.Status,
			"reason":       s.Reason,
			"willApply":    false,
		})
	}
	return map[string]any{
		"mode":         "dry-run",
		"applyAllowed": false,
		"scope":        map[string]any{"type": scope.kind, "id": scope.id()},
		"summary": map[string]any{
			"planned":     planned,
			"noOp":        noOp,
			"skipped":     skipped,
			"investigate": investigate,
			"dangerous":   dangerous,
		},
		"steps": stepList,
	}
}

// ============================================================
// loaders + helpers
// ============================================================

func (h *DriftHandler) loadDesiredForScope(ctx context.Context, scope driftScope) ([]desiredCmp, error) {
	col := map[string]string{scopeHost: "ds.host_id", scopeCell: "ds.cell_id", scopeProject: "ds.project_id"}[scope.kind]
	// LEFT JOIN deployments for the name — the legacy-label fallback correlates
	// an observed container (synapse.deployment=name, no UUID) to its desired.
	rows, err := h.DB.Query(ctx, `
		SELECT ds.id, ds.host_id, ds.cell_id, ds.project_id, COALESCE(ds.resource_id, ''), ds.resource_key,
		       COALESCE(ds.desired_json->>'desiredStatus', 'running'), COALESCE(d.name, '')
		  FROM desired_states ds
		  LEFT JOIN deployments d ON d.id::text = ds.resource_id
		 WHERE ds.status = 'active' AND ds.resource_type = $1 AND `+col+` = $2
	`, models.ResourceTypeConvexDeployment, scope.id())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []desiredCmp
	for rows.Next() {
		var d desiredCmp
		if err := rows.Scan(&d.id, &d.hostID, &d.cellID, &d.projectID, &d.depID, &d.resourceKey, &d.desiredStatus, &d.depName); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (h *DriftHandler) loadObservedForScope(ctx context.Context, scope driftScope) ([]observedCmp, error) {
	var where string
	switch scope.kind {
	case scopeHost:
		where = "host_id::text = $1"
	case scopeCell:
		where = "observed_json->'labels'->>'synapse.cell_id' = $1"
	case scopeProject:
		where = "observed_json->'labels'->>'synapse.project_id' = $1"
	}
	rows, err := h.DB.Query(ctx, `
		SELECT id, host_id, resource_key,
		       COALESCE(observed_json->>'state', ''),
		       COALESCE(observed_json->'labels'->>'synapse.managed', ''),
		       COALESCE(observed_json->'labels'->>'synapse.deployment_id', ''),
		       COALESCE(observed_json->'labels'->>'synapse.deployment', ''),
		       COALESCE(observed_json->'labels'->>'synapse.cell_id', ''),
		       COALESCE(observed_json->'labels'->>'synapse.project_id', '')
		  FROM observed_states
		 WHERE resource_type = '`+models.ResourceTypeDockerContainer+`' AND (`+where+`)
	`, scope.id())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []observedCmp
	for rows.Next() {
		var o observedCmp
		var managed string
		if err := rows.Scan(&o.id, &o.hostID, &o.resourceKey, &o.state, &managed, &o.depID, &o.depName, &o.cellID, &o.projectID); err != nil {
			return nil, err
		}
		o.managed = managed == "true"
		out = append(out, o)
	}
	return out, rows.Err()
}

// loadLegacyContainers returns managed docker_container observed rows on the
// given hosts that have NO synapse.deployment_id but DO carry a
// synapse.deployment (name) label — i.e. pre-12.6 containers. Used to top up
// the legacy-fallback index for project/cell scope (whose primary observed
// query filters on the project/cell label these containers lack).
func loadLegacyContainers(ctx context.Context, pool *pgxpool.Pool, hostIDs []string) ([]observedCmp, error) {
	out := []observedCmp{}
	if len(hostIDs) == 0 {
		return out, nil
	}
	rows, err := pool.Query(ctx, `
		SELECT id, host_id, resource_key,
		       COALESCE(observed_json->>'state', ''),
		       COALESCE(observed_json->'labels'->>'synapse.managed', ''),
		       COALESCE(observed_json->'labels'->>'synapse.deployment', ''),
		       COALESCE(observed_json->'labels'->>'synapse.cell_id', ''),
		       COALESCE(observed_json->'labels'->>'synapse.project_id', '')
		  FROM observed_states
		 WHERE resource_type = '`+models.ResourceTypeDockerContainer+`'
		   AND host_id::text = ANY($1::text[])
		   AND COALESCE(observed_json->'labels'->>'synapse.deployment_id', '') = ''
		   AND COALESCE(observed_json->'labels'->>'synapse.deployment', '') <> ''
	`, hostIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var o observedCmp
		var managed string
		if err := rows.Scan(&o.id, &o.hostID, &o.resourceKey, &o.state, &managed, &o.depName, &o.cellID, &o.projectID); err != nil {
			return nil, err
		}
		o.managed = managed == "true"
		out = append(out, o)
	}
	return out, rows.Err()
}

func loadHostsByID(ctx context.Context, pool *pgxpool.Pool, ids []string) (map[string]models.Host, error) {
	out := map[string]models.Host{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := pool.Query(ctx, `SELECT `+hostColumns+` FROM hosts WHERE id::text = ANY($1::text[])`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		hst, err := scanHost(rows)
		if err != nil {
			return nil, err
		}
		out[hst.ID] = hst
	}
	return out, rows.Err()
}

// loadHostFacts reads the latest host_facts dockerAvailable + container-scan
// outcome per host (9b.5). Absent fields → nil ("unknown", not "false") so a
// legacy agent or a host with no host_facts row isn't penalised.
func loadHostFacts(ctx context.Context, pool *pgxpool.Pool, ids []string) (map[string]hostObsFacts, error) {
	out := map[string]hostObsFacts{}
	if len(ids) == 0 {
		return out, nil
	}
	rows, err := pool.Query(ctx, `
		SELECT host_id::text,
		       observed_json->>'dockerAvailable',
		       observed_json->'containerScan'->>'succeeded',
		       observed_json->'containerScan'->>'complete'
		  FROM observed_states
		 WHERE resource_type = $1 AND host_id::text = ANY($2::text[])
	`, models.ResourceTypeHostFacts, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var hostID string
		var dockerAvail, scanOK, scanDone *string
		if err := rows.Scan(&hostID, &dockerAvail, &scanOK, &scanDone); err != nil {
			return nil, err
		}
		out[hostID] = hostObsFacts{
			dockerAvailable: parseBoolText(dockerAvail),
			scanSucceeded:   parseBoolText(scanOK),
			scanComplete:    parseBoolText(scanDone),
		}
	}
	return out, rows.Err()
}

// parseBoolText maps a JSON text value ("true"/"false"/NULL) to *bool, nil for
// anything else (unknown).
func parseBoolText(s *string) *bool {
	if s == nil {
		return nil
	}
	switch *s {
	case "true":
		b := true
		return &b
	case "false":
		b := false
		return &b
	default:
		return nil
	}
}

func loadDeploymentExistence(ctx context.Context, pool *pgxpool.Pool, ids []string) (map[string]bool, error) {
	out := map[string]bool{}
	if len(ids) == 0 {
		return out, nil
	}
	// status <> 'deleted': a soft-deleted deployment must read as "no longer
	// exists" so drift classifies its lingering desired state as orphaned
	// (operator deleted it) rather than missing→create (engine would recreate).
	rows, err := pool.Query(ctx, `SELECT id::text FROM deployments WHERE id::text = ANY($1::text[]) AND status <> 'deleted'`, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

const driftReportColumns = `id, host_id, project_id, cell_id, operation_run_id, status, summary_json, created_at`

func scanDriftReport(s scannable) (models.DriftReport, error) {
	var rep models.DriftReport
	var summary []byte
	if err := s.Scan(&rep.ID, &rep.HostID, &rep.ProjectID, &rep.CellID, &rep.OperationRunID,
		&rep.Status, &summary, &rep.CreatedAt); err != nil {
		return models.DriftReport{}, err
	}
	rep.Summary = unmarshalJSONBMap(summary)
	return rep, nil
}

func loadDriftReport(ctx context.Context, pool *pgxpool.Pool, id string) (models.DriftReport, error) {
	return scanDriftReport(pool.QueryRow(ctx, `SELECT `+driftReportColumns+` FROM drift_reports WHERE id = $1`, id))
}

func loadDriftReportBy(ctx context.Context, pool *pgxpool.Pool, col, val string) (models.DriftReport, error) {
	return scanDriftReport(pool.QueryRow(ctx,
		`SELECT `+driftReportColumns+` FROM drift_reports WHERE `+col+` = $1 ORDER BY created_at DESC LIMIT 1`, val))
}

func loadDriftItems(ctx context.Context, pool *pgxpool.Pool, reportID string) ([]models.DriftItem, error) {
	rows, err := pool.Query(ctx, `
		SELECT id, drift_report_id, host_id, cell_id, resource_type, resource_key,
		       desired_state_id, observed_state_id, drift_status, severity, diff_json,
		       recommended_action, created_at
		  FROM drift_items WHERE drift_report_id = $1
		 ORDER BY resource_key, drift_status
	`, reportID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]models.DriftItem, 0)
	for rows.Next() {
		var it models.DriftItem
		var diff []byte
		if err := rows.Scan(&it.ID, &it.DriftReportID, &it.HostID, &it.CellID, &it.ResourceType, &it.ResourceKey,
			&it.DesiredStateID, &it.ObservedStateID, &it.DriftStatus, &it.Severity, &diff,
			&it.RecommendedAction, &it.CreatedAt); err != nil {
			return nil, err
		}
		it.Diff = unmarshalJSONBMap(diff)
		items = append(items, it)
	}
	return items, rows.Err()
}

// rollupReportStatus is the report verdict: any critical issue → drifted, any
// other non-sync issue → warning, otherwise clean.
func rollupReportStatus(items []models.DriftItem) string {
	hasCritical, hasIssue := false, false
	for _, it := range items {
		if it.DriftStatus == models.DriftStatusInSync || it.DriftStatus == models.DriftStatusIgnored {
			continue
		}
		hasIssue = true
		if it.Severity == models.SeverityCritical {
			hasCritical = true
		}
	}
	switch {
	case hasCritical:
		return models.DriftReportStatusDrifted
	case hasIssue:
		return models.DriftReportStatusWarning
	default:
		return models.DriftReportStatusClean
	}
}

// summarize produces the per-status / per-severity counts (all keys present).
func summarize(items []models.DriftItem) map[string]any {
	statusKey := map[string]string{
		models.DriftStatusInSync:          "inSync",
		models.DriftStatusMissing:         "missing",
		models.DriftStatusDrifted:         "drifted",
		models.DriftStatusUnmanaged:       "unmanaged",
		models.DriftStatusOrphaned:        "orphaned",
		models.DriftStatusHostUnreachable: "hostUnreachable",
		models.DriftStatusIgnored:         "ignored",
	}
	counts := map[string]int{
		"total": 0, "inSync": 0, "missing": 0, "drifted": 0, "unmanaged": 0,
		"orphaned": 0, "hostUnreachable": 0, "ignored": 0,
		"critical": 0, "warning": 0, "info": 0,
	}
	for _, it := range items {
		counts["total"]++
		if k, ok := statusKey[it.DriftStatus]; ok {
			counts[k]++
		}
		counts[it.Severity]++
	}
	out := make(map[string]any, len(counts))
	for k, v := range counts {
		out[k] = v
	}
	return out
}

// redactDiff is a defense-in-depth pass over a diff map: even though the engine
// only ever builds diffs from safe fields, any suspiciously-named key is
// redacted before it reaches a client.
func redactDiff(m map[string]any) map[string]any {
	if m == nil {
		return nil
	}
	out := make(map[string]any, len(m))
	for k, v := range m {
		if isSensitiveKey(k) {
			out[k] = "[redacted]"
			continue
		}
		if sub, ok := v.(map[string]any); ok {
			out[k] = redactDiff(sub)
		} else {
			out[k] = v
		}
	}
	return out
}

func isSensitiveKey(k string) bool {
	lk := strings.ToLower(k)
	for _, bad := range []string{"token", "secret", "password", "adminkey", "admin_key",
		"instancesecret", "instance_secret", "database", "authorization", "env"} {
		if strings.Contains(lk, bad) {
			return true
		}
	}
	return false
}

func keysOf(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
