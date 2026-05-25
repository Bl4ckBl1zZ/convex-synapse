package api

import (
	"context"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/auth"
	"github.com/Iann29/synapse/internal/models"
)

// CellTopologyHandler serves GET /v1/projects/{id}/cell_topology — the REAL
// Cell Control Plane topology (Bloco 8): Host → Cell → Deployment, plus the
// CellLink edges and read-only warnings (drift / missing host / missing
// endpoint / offline host …).
//
// It's a NEW endpoint alongside the legacy /topology (which stays untouched as
// the synthetic deployments-by-host view). When a project has no cells yet the
// response carries mode="legacy_synthetic" and empty real data so the
// dashboard falls back to the legacy panel — existing deployments never break.
//
// RBAC: any project member sees the topology; sensitive host fields (IPs) are
// stripped for non-instance-admins. No secrets are ever returned (service
// tokens appear only as counts; agent payloads are never exposed).
type CellTopologyHandler struct {
	DB       *pgxpool.Pool
	Projects *ProjectsHandler
	// Host effectiveStatus thresholds (shared with HostsHandler). Zero →
	// 60s/300s defaults.
	StaleAfter   time.Duration
	OfflineAfter time.Duration
}

func (h *CellTopologyHandler) staleAfter() time.Duration {
	if h.StaleAfter > 0 {
		return h.StaleAfter
	}
	return 60 * time.Second
}
func (h *CellTopologyHandler) offlineAfter() time.Duration {
	if h.OfflineAfter > 0 {
		return h.OfflineAfter
	}
	return 300 * time.Second
}

// ---- response shape ----

type ctProject struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Slug string `json:"slug"`
}

type ctAgentSummary struct {
	Online  int `json:"online"`
	Offline int `json:"offline"`
	Revoked int `json:"revoked"`
}

type ctHost struct {
	ID              string         `json:"id"`
	Name            string         `json:"name"`
	Provider        string         `json:"provider"`
	Region          string         `json:"region"`
	PublicIP        string         `json:"publicIp,omitempty"`  // admin-only
	PrivateIP       string         `json:"privateIp,omitempty"` // admin-only
	Status          string         `json:"status"`
	EffectiveStatus string         `json:"effectiveStatus"`
	IsSynapseHost   bool           `json:"isSynapseHost"`
	LastHeartbeatAt *time.Time     `json:"lastHeartbeatAt,omitempty"`
	AgentCount      int            `json:"agentCount"`
	AgentsSummary   ctAgentSummary `json:"agentsSummary"`
}

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

type ctLink struct {
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

type cellTopologyResp struct {
	Mode                  string         `json:"mode"`
	Project               ctProject      `json:"project"`
	Hosts                 []ctHost       `json:"hosts"`
	Cells                 []ctCell       `json:"cells"`
	UnassignedDeployments []ctDeployment `json:"unassignedDeployments"`
	Links                 []ctLink       `json:"links"`
	Warnings              []string       `json:"warnings"`
}

func (h *CellTopologyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.Projects == nil {
		writeError(w, http.StatusServiceUnavailable, "not_configured", "ProjectsHandler not wired")
		return
	}
	p, _, _, ok := h.Projects.loadProjectForRequest(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	isAdmin := h.isInstanceAdmin(ctx)

	cells, err := h.loadCells(ctx, p.ID)
	if err != nil {
		logErr("cell_topology load cells", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to load topology")
		return
	}

	resp := cellTopologyResp{
		Project:               ctProject{ID: p.ID, Name: p.Name, Slug: p.Slug},
		Hosts:                 []ctHost{},
		Cells:                 []ctCell{},
		UnassignedDeployments: []ctDeployment{},
		Links:                 []ctLink{},
		Warnings:              []string{},
	}

	// No cells → legacy fallback. The dashboard's CellTopologyPanel hides and
	// the legacy TopologyPanel renders the synthetic view.
	if len(cells) == 0 {
		resp.Mode = "legacy_synthetic"
		writeJSON(w, http.StatusOK, resp)
		return
	}
	resp.Mode = "cell_control_plane"

	if err := h.assemble(ctx, p.ID, isAdmin, cells, &resp); err != nil {
		logErr("cell_topology assemble", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to assemble topology")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *CellTopologyHandler) isInstanceAdmin(ctx context.Context) bool {
	uid, err := auth.UserID(ctx)
	if err != nil || uid == "" {
		return false
	}
	var ok bool
	if err := h.DB.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM users WHERE id = $1 AND is_instance_admin)`, uid).Scan(&ok); err != nil {
		return false
	}
	return ok
}

func (h *CellTopologyHandler) loadCells(ctx context.Context, projectID string) ([]models.Cell, error) {
	rows, err := h.DB.Query(ctx, `SELECT `+cellColumns+` FROM cells WHERE project_id = $1 ORDER BY kind, environment, created_at ASC`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []models.Cell
	for rows.Next() {
		c, err := scanCell(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// assemble does the heavy lifting: deployments, placements, routes, links, and
// hosts, wired into the cell tree + warnings.
func (h *CellTopologyHandler) assemble(ctx context.Context, projectID string, isAdmin bool, cells []models.Cell, resp *cellTopologyResp) error {
	now := time.Now()

	// 1. Deployments for the project.
	deps, err := h.loadDeployments(ctx, projectID)
	if err != nil {
		return err
	}
	// 2. Which cell each deployment belongs to (cell_resources, convex).
	depCell, err := h.loadDeploymentCellMap(ctx, projectID)
	if err != nil {
		return err
	}
	// 3. Placement per deployment.
	placements, err := h.loadPlacements(ctx, projectID)
	if err != nil {
		return err
	}
	// 4. Active-ish routes (domains) per deployment.
	routes, err := h.loadRoutes(ctx, projectID)
	if err != nil {
		return err
	}

	// Build deployment nodes, grouped by cell.
	depNodesByCell := map[string][]ctDeployment{}
	depHasPlacement := map[string]bool{}
	for _, d := range deps {
		node := ctDeployment{
			ID: d.ID, Name: d.Name, Type: d.DeploymentType, Status: d.Status,
			Adopted: d.Adopted, Routes: routes[d.ID],
		}
		if node.Routes == nil {
			node.Routes = []ctRoute{}
		}
		// Public URL via the same rewrite list_deployments uses.
		dd := d
		if h.Projects != nil && h.Projects.Deployments != nil {
			node.URL = h.Projects.Deployments.publicDeploymentURL(ctx, &dd)
		}
		if pl, ok := placements[d.ID]; ok {
			node.Placement = &pl
			depHasPlacement[d.ID] = true
		}
		cellID, assigned := depCell[d.ID]
		if !assigned {
			resp.UnassignedDeployments = append(resp.UnassignedDeployments, node)
			resp.Warnings = append(resp.Warnings, "Deployment "+d.Name+" is not assigned to any cell")
			continue
		}
		depNodesByCell[cellID] = append(depNodesByCell[cellID], node)
	}

	// 5. Links (edges) + per-cell in/out refs.
	links, outByCell, inByCell, err := h.loadLinks(ctx, projectID)
	if err != nil {
		return err
	}
	resp.Links = links
	for _, l := range links {
		if l.Status != models.CellLinkStatusActive {
			continue
		}
		if !l.HasEndpoint {
			resp.Warnings = append(resp.Warnings, "Cell link "+shortID(l.SourceCellID)+" → "+shortID(l.TargetCellID)+" has no resolved endpoint")
		}
		if l.AuthMode == models.CellLinkAuthServiceToken && l.ActiveTokenCount == 0 {
			resp.Warnings = append(resp.Warnings, "Cell link "+shortID(l.SourceCellID)+" → "+shortID(l.TargetCellID)+" has no active service token")
		}
	}

	// 6. Cell nodes.
	hostHasActiveCell := map[string]bool{}
	for _, c := range cells {
		node := ctCell{
			ID: c.ID, Name: c.Name, Slug: c.Slug, Kind: c.Kind, Environment: c.Environment,
			Region: c.Region, IsolationTier: c.IsolationTier, Status: c.Status,
			PrimaryDeploymentID: c.PrimaryDeploymentID, PrimaryHostID: c.PrimaryHostID,
			Deployments:   depNodesByCell[c.ID],
			OutgoingLinks: outByCell[c.ID],
			IncomingLinks: inByCell[c.ID],
			Warnings:      []string{},
		}
		if node.Deployments == nil {
			node.Deployments = []ctDeployment{}
		}
		if node.OutgoingLinks == nil {
			node.OutgoingLinks = []ctLinkRef{}
		}
		if node.IncomingLinks == nil {
			node.IncomingLinks = []ctLinkRef{}
		}
		// Aggregate the cell's routes from its deployments.
		node.Routes = []ctRoute{}
		for _, d := range node.Deployments {
			node.Routes = append(node.Routes, d.Routes...)
		}

		// Cell warnings.
		if c.PrimaryDeploymentID == nil {
			node.Warnings = append(node.Warnings, "no primary deployment")
			resp.Warnings = append(resp.Warnings, "Cell "+c.Name+" has no primary deployment")
		}
		if c.PrimaryHostID == nil {
			node.Warnings = append(node.Warnings, "not placed on a host")
			resp.Warnings = append(resp.Warnings, "Cell "+c.Name+" is not placed on a host")
		} else if c.Status == models.CellStatusActive {
			hostHasActiveCell[*c.PrimaryHostID] = true
		}
		// Deployment attached but no placement row.
		for _, d := range node.Deployments {
			if !depHasPlacement[d.ID] {
				node.Warnings = append(node.Warnings, "deployment "+d.Name+" has no placement")
				resp.Warnings = append(resp.Warnings, "Deployment "+d.Name+" is attached to cell "+c.Name+" but has no placement")
			}
		}
		resp.Cells = append(resp.Cells, node)
	}

	// 7. Hosts referenced by the project's cells/placements.
	hostIDs := referencedHostIDs(cells, placements)
	hosts, err := h.loadHosts(ctx, hostIDs, isAdmin, now)
	if err != nil {
		return err
	}
	resp.Hosts = hosts
	for _, hn := range hosts {
		if (hn.EffectiveStatus == models.HostStatusStale || hn.EffectiveStatus == models.HostStatusOffline) && hostHasActiveCell[hn.ID] {
			resp.Warnings = append(resp.Warnings, "Host "+hn.Name+" is "+hn.EffectiveStatus+" but has active cells")
		}
	}
	return nil
}

func (h *CellTopologyHandler) loadDeployments(ctx context.Context, projectID string) ([]models.Deployment, error) {
	rows, err := h.DB.Query(ctx, `
		SELECT id, project_id, name, deployment_type, status, deployment_url,
		       is_default, adopted, host_port
		  FROM deployments
		 WHERE project_id = $1 AND status <> 'deleted'
		 ORDER BY created_at ASC
	`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []models.Deployment
	for rows.Next() {
		var d models.Deployment
		var url *string
		var hostPort *int
		if err := rows.Scan(&d.ID, &d.ProjectID, &d.Name, &d.DeploymentType, &d.Status,
			&url, &d.IsDefault, &d.Adopted, &hostPort); err != nil {
			return nil, err
		}
		if url != nil {
			d.DeploymentURL = *url
		}
		if hostPort != nil {
			d.HostPort = *hostPort
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func (h *CellTopologyHandler) loadDeploymentCellMap(ctx context.Context, projectID string) (map[string]string, error) {
	rows, err := h.DB.Query(ctx, `
		SELECT cr.resource_id, cr.cell_id
		  FROM cell_resources cr JOIN cells c ON c.id = cr.cell_id
		 WHERE c.project_id = $1 AND cr.resource_type = $2
	`, projectID, models.CellResourceConvexDeployment)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var depID, cellID string
		if err := rows.Scan(&depID, &cellID); err != nil {
			return nil, err
		}
		out[depID] = cellID
	}
	return out, rows.Err()
}

func (h *CellTopologyHandler) loadPlacements(ctx context.Context, projectID string) (map[string]ctPlacement, error) {
	rows, err := h.DB.Query(ctx, `
		SELECT dp.deployment_id, dp.cell_id, dp.host_id, dp.desired_status, dp.observed_status
		  FROM deployment_placements dp JOIN cells c ON c.id = dp.cell_id
		 WHERE c.project_id = $1
	`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]ctPlacement{}
	for rows.Next() {
		var depID string
		var pl ctPlacement
		if err := rows.Scan(&depID, &pl.CellID, &pl.HostID, &pl.DesiredStatus, &pl.ObservedStatus); err != nil {
			return nil, err
		}
		out[depID] = pl
	}
	return out, rows.Err()
}

func (h *CellTopologyHandler) loadRoutes(ctx context.Context, projectID string) (map[string][]ctRoute, error) {
	rows, err := h.DB.Query(ctx, `
		SELECT dd.deployment_id, dd.domain, dd.role, dd.status
		  FROM deployment_domains dd JOIN deployments d ON d.id = dd.deployment_id
		 WHERE d.project_id = $1
		 ORDER BY dd.created_at ASC
	`, projectID)
	if err != nil {
		// deployment_domains always exists by this migration; treat a missing
		// table defensively (older snapshots) as "no routes".
		if isMissingTable(err) {
			return map[string][]ctRoute{}, nil
		}
		return nil, err
	}
	defer rows.Close()
	out := map[string][]ctRoute{}
	for rows.Next() {
		var depID string
		var rt ctRoute
		if err := rows.Scan(&depID, &rt.Domain, &rt.Role, &rt.Status); err != nil {
			return nil, err
		}
		out[depID] = append(out[depID], rt)
	}
	return out, rows.Err()
}

func (h *CellTopologyHandler) loadLinks(ctx context.Context, projectID string) ([]ctLink, map[string][]ctLinkRef, map[string][]ctLinkRef, error) {
	rows, err := h.DB.Query(ctx, `
		SELECT cl.id, cl.source_cell_id, cl.target_cell_id, cl.protocol, cl.auth_mode, cl.status,
		       cl.allowed_commands, cl.allowed_events,
		       (SELECT COUNT(*) FROM service_tokens st WHERE st.cell_link_id = cl.id AND st.status = 'active')
		  FROM cell_links cl
		 WHERE cl.project_id = $1
		 ORDER BY cl.created_at ASC
	`, projectID)
	if err != nil {
		return nil, nil, nil, err
	}
	defer rows.Close()
	var links []ctLink
	out := map[string][]ctLinkRef{}
	in := map[string][]ctLinkRef{}
	for rows.Next() {
		var l ctLink
		var cmds, events []string
		if err := rows.Scan(&l.ID, &l.SourceCellID, &l.TargetCellID, &l.Protocol, &l.AuthMode, &l.Status,
			&cmds, &events, &l.ActiveTokenCount); err != nil {
			return nil, nil, nil, err
		}
		l.AllowedCommandsCount = len(cmds)
		l.AllowedEventsCount = len(events)
		ep, src := resolveCellEndpoint(ctx, h.DB, l.TargetCellID)
		l.HasEndpoint = ep != nil
		if l.HasEndpoint {
			l.EndpointSource = src
		}
		links = append(links, l)
		ref := ctLinkRef{ID: l.ID, SourceCellID: l.SourceCellID, TargetCellID: l.TargetCellID, Protocol: l.Protocol, Status: l.Status}
		out[l.SourceCellID] = append(out[l.SourceCellID], ref)
		in[l.TargetCellID] = append(in[l.TargetCellID], ref)
	}
	if links == nil {
		links = []ctLink{}
	}
	return links, out, in, rows.Err()
}

func (h *CellTopologyHandler) loadHosts(ctx context.Context, hostIDs []string, isAdmin bool, now time.Time) ([]ctHost, error) {
	if len(hostIDs) == 0 {
		return []ctHost{}, nil
	}
	// Agent counts per host, by status.
	agentCounts := map[string]*ctAgentSummary{}
	agentTotal := map[string]int{}
	acRows, err := h.DB.Query(ctx, `SELECT host_id, status, COUNT(*) FROM host_agents WHERE host_id = ANY($1) GROUP BY host_id, status`, hostIDs)
	if err != nil {
		return nil, err
	}
	for acRows.Next() {
		var hid, status string
		var n int
		if err := acRows.Scan(&hid, &status, &n); err != nil {
			acRows.Close()
			return nil, err
		}
		if agentCounts[hid] == nil {
			agentCounts[hid] = &ctAgentSummary{}
		}
		agentTotal[hid] += n
		switch status {
		case models.HostAgentStatusOnline:
			agentCounts[hid].Online += n
		case models.HostAgentStatusOffline:
			agentCounts[hid].Offline += n
		case models.HostAgentStatusRevoked:
			agentCounts[hid].Revoked += n
		}
	}
	acRows.Close()
	if err := acRows.Err(); err != nil {
		return nil, err
	}

	rows, err := h.DB.Query(ctx, `SELECT `+hostColumns+` FROM hosts WHERE id = ANY($1) ORDER BY is_synapse_host DESC, name ASC`, hostIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ctHost{}
	for rows.Next() {
		hst, err := scanHost(rows)
		if err != nil {
			return nil, err
		}
		node := ctHost{
			ID: hst.ID, Name: hst.Name, Provider: hst.Provider, Region: hst.Region,
			Status:          hst.Status,
			EffectiveStatus: effectiveHostStatus(hst, h.staleAfter(), h.offlineAfter(), now),
			IsSynapseHost:   hst.IsSynapseHost,
			LastHeartbeatAt: hst.LastHeartbeatAt,
			AgentCount:      agentTotal[hst.ID],
		}
		if s := agentCounts[hst.ID]; s != nil {
			node.AgentsSummary = *s
		}
		// Sensitive fields: admin-only.
		if isAdmin {
			node.PublicIP = hst.PublicIP
			node.PrivateIP = hst.PrivateIP
		}
		out = append(out, node)
	}
	return out, rows.Err()
}

// referencedHostIDs collects the host ids the project touches: cells'
// primary_host_id + placements' host_id (deduped).
func referencedHostIDs(cells []models.Cell, placements map[string]ctPlacement) []string {
	seen := map[string]bool{}
	var ids []string
	add := func(id *string) {
		if id == nil || *id == "" || seen[*id] {
			return
		}
		seen[*id] = true
		ids = append(ids, *id)
	}
	for _, c := range cells {
		add(c.PrimaryHostID)
	}
	for _, pl := range placements {
		add(pl.HostID)
	}
	return ids
}

func shortID(id string) string {
	if len(id) > 8 {
		return id[:8]
	}
	return id
}
