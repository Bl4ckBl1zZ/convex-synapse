package api

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/geo"
	"github.com/Iann29/synapse/internal/models"
)

// TopologyHandler returns a "deployments grouped by host" snapshot for
// the project. The dashboard renders this as the Regions panel — each
// host card carries country/region/provider derived from IP
// geolocation, and each deployment row carries the metadata the
// panel surfaces (storage type, replicas, custom domain, etc).
//
// Why a dedicated endpoint instead of enriching list_deployments:
//
//  1. Different response shape — { hosts: [{ deployments: [...] }] }
//     vs flat array.
//  2. Geo lookup is expensive on the first call (~hundreds of ms).
//     Burying it inside list_deployments would slow down every project
//     page paint even when the operator never opens topology.
//  3. The endpoint is purely additive — no changes to existing
//     contracts.
//
// Today every Synapse instance runs on a single VPS, so the response
// has exactly one host. The shape is forward-compatible with the v2.0
// federation work (multiple host rows, one VPS each).
type TopologyHandler struct {
	DB             *pgxpool.Pool
	PublicIP       string
	PublicURL      string
	SynapseVersion string
	Geo            geo.Resolver

	// loadProjectForRequest is used to authorise the call — same
	// behaviour as the other project-scoped endpoints. Wired via the
	// ProjectsHandler dependency in router.go.
	Projects *ProjectsHandler
}

type topologyDeployment struct {
	Name           string  `json:"name"`
	Type           string  `json:"type"`
	Status         string  `json:"status"`
	URL            string  `json:"url,omitempty"`
	URLForm        string  `json:"urlForm"`
	Storage        string  `json:"storage"`
	HAEnabled      bool    `json:"haEnabled"`
	ReplicaCount   int     `json:"replicaCount"`
	HealthyCount   int     `json:"healthyCount"`
	Version        string  `json:"version,omitempty"`
	CustomDomain   string  `json:"customDomain,omitempty"`
	Adopted        bool    `json:"adopted"`
	RunningSinceMS int64   `json:"runningSinceMs,omitempty"`
	IsDefault      bool    `json:"isDefault"`
	Reference      string  `json:"reference,omitempty"`
	LastError      string  `json:"lastError,omitempty"`
	Port           *int    `json:"port,omitempty"`
}

type topologyHost struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	IP             string `json:"ip,omitempty"`
	Country        string `json:"country,omitempty"`
	CountryFlag    string `json:"countryFlag,omitempty"`
	City           string `json:"city,omitempty"`
	Region         string `json:"region,omitempty"`
	Provider       string `json:"provider,omitempty"`
	SynapseVersion string `json:"synapseVersion,omitempty"`
	IsPrimary      bool   `json:"isPrimary"`
	// Aggregate stats so the panel header can show "● 3 running" without
	// recomputing on the client.
	RunningCount      int `json:"runningCount"`
	ProvisioningCount int `json:"provisioningCount"`
	FailedCount       int `json:"failedCount"`

	Deployments []topologyDeployment `json:"deployments"`
}

type topologyResp struct {
	Hosts []topologyHost `json:"hosts"`
}

func (h *TopologyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.Projects == nil {
		writeError(w, http.StatusServiceUnavailable, "not_configured",
			"ProjectsHandler not wired; cannot authorise")
		return
	}
	p, _, _, ok := h.Projects.loadProjectForRequest(w, r)
	if !ok {
		return
	}

	deployments, err := h.loadDeployments(r.Context(), p.ID)
	if err != nil {
		logErr("topology: load deployments", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to load deployments")
		return
	}

	domainsByDep, err := h.loadActiveCustomDomains(r.Context(), p.ID)
	if err != nil {
		// Non-fatal — render topology without custom-domain info rather
		// than 500 the operator. The active-domain map will be empty.
		logErr("topology: load domains", err)
		domainsByDep = map[string]string{}
	}

	replicaCounts, err := h.loadReplicaHealth(r.Context(), p.ID)
	if err != nil {
		logErr("topology: load replicas", err)
		replicaCounts = map[string]int{}
	}

	// Single-host today: derive the host metadata from SYNAPSE_PUBLIC_*
	// env values. Future multi-VPS will produce N rows here.
	host := h.buildPrimaryHost(r.Context())

	// Wire deployments into the host. Adopted deployments don't live on
	// the Synapse VPS, so they'd go under a separate "Adopted" pseudo-
	// host if the project has any — kept inline below for clarity.
	//
	// Why we rewrite DeploymentURL before mapping: the DB stores the
	// internal loopback form ("http://127.0.0.1:<port>") so the host
	// healthcheck worker can reach the container. The topology card
	// must show the PUBLIC form (wildcard / custom-domain / etc) so
	// it's consistent with the deployments list above. Same rewrite
	// list_deployments does — we just borrow the helper.
	var adopted []topologyDeployment
	for _, d := range deployments {
		if h.Projects != nil && h.Projects.Deployments != nil {
			d.DeploymentURL = h.Projects.Deployments.publicDeploymentURL(r.Context(), &d)
		}
		td := mapDeployment(d, domainsByDep, replicaCounts, h.PublicURL)
		if d.Adopted {
			adopted = append(adopted, td)
			continue
		}
		bumpStats(&host, td.Status)
		host.Deployments = append(host.Deployments, td)
	}

	resp := topologyResp{}
	if len(host.Deployments) > 0 || len(adopted) == 0 {
		resp.Hosts = append(resp.Hosts, host)
	}
	if len(adopted) > 0 {
		adoptedHost := topologyHost{
			ID:          "adopted",
			Name:        "External (adopted)",
			IsPrimary:   false,
			Deployments: adopted,
		}
		for _, d := range adopted {
			bumpStats(&adoptedHost, d.Status)
		}
		resp.Hosts = append(resp.Hosts, adoptedHost)
	}

	writeJSON(w, http.StatusOK, resp)
}

func bumpStats(host *topologyHost, status string) {
	switch status {
	case models.DeploymentStatusRunning:
		host.RunningCount++
	case models.DeploymentStatusProvisioning:
		host.ProvisioningCount++
	case models.DeploymentStatusFailed:
		host.FailedCount++
	}
}

// loadDeployments pulls the slice of deployments for the project with
// every column the topology mapper needs. Mirrors list_deployments
// but loads ALL non-deleted rows (no pagination — topology shows the
// whole project; if you have 500 deployments you'll feel it, but
// pagination would make the visual map confusing).
func (h *TopologyHandler) loadDeployments(ctx context.Context, projectID string) ([]models.Deployment, error) {
	rows, err := h.DB.Query(ctx, `
		SELECT id, project_id, name, deployment_type, status,
		       deployment_url, is_default, reference, creator_user_id, created_at,
		       adopted, ha_enabled, replica_count, host_port, last_deploy_at
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
		var url, ref, creator *string
		var hostPort *int
		var lastDeploy *time.Time
		if err := rows.Scan(&d.ID, &d.ProjectID, &d.Name, &d.DeploymentType, &d.Status,
			&url, &d.IsDefault, &ref, &creator, &d.CreatedAt, &d.Adopted, &d.HAEnabled, &d.ReplicaCount,
			&hostPort, &lastDeploy); err != nil {
			return nil, err
		}
		if url != nil {
			d.DeploymentURL = *url
		}
		if ref != nil {
			d.Reference = *ref
		}
		if creator != nil {
			d.CreatorUserID = *creator
		}
		if hostPort != nil {
			d.HostPort = *hostPort
		}
		d.LastDeployAt = lastDeploy
		out = append(out, d)
	}
	return out, rows.Err()
}

// loadActiveCustomDomains returns a map[deployment_name]domain for the
// active 'api' role domain on each deployment in the project. Same
// query shape the embed page uses; cached server-side via Postgres,
// no separate cache layer needed because the topology endpoint is
// already SWR'd by the client.
func (h *TopologyHandler) loadActiveCustomDomains(ctx context.Context, projectID string) (map[string]string, error) {
	rows, err := h.DB.Query(ctx, `
		SELECT d.name, dd.domain
		  FROM deployment_domains dd
		  JOIN deployments d ON d.id = dd.deployment_id
		 WHERE d.project_id = $1
		   AND d.status <> 'deleted'
		   AND dd.status = 'active'
		   AND dd.role = 'api'
	`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var name, domain string
		if err := rows.Scan(&name, &domain); err != nil {
			return nil, err
		}
		out[name] = domain
	}
	return out, rows.Err()
}

// loadReplicaHealth returns a map[deployment_id]healthy-count. Only
// HA-enabled deployments have replica rows; the rest return 1 when
// running, 0 otherwise (computed at the mapper).
func (h *TopologyHandler) loadReplicaHealth(ctx context.Context, projectID string) (map[string]int, error) {
	rows, err := h.DB.Query(ctx, `
		SELECT d.id, COUNT(*) FILTER (WHERE r.status = 'running')
		  FROM deployments d
		  LEFT JOIN deployment_replicas r ON r.deployment_id = d.id
		 WHERE d.project_id = $1 AND d.status <> 'deleted' AND d.ha_enabled = true
		 GROUP BY d.id
	`, projectID)
	if err != nil {
		// Older installs may not have the deployment_replicas table on
		// a brand-new migration. Treat as empty, callers fall back.
		if isMissingTable(err) {
			return map[string]int{}, nil
		}
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var id string
		var healthy int
		if err := rows.Scan(&id, &healthy); err != nil {
			return nil, err
		}
		out[id] = healthy
	}
	return out, rows.Err()
}

func isMissingTable(err error) bool {
	if err == nil {
		return false
	}
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) {
		return pgErr.Code == "42P01"
	}
	return strings.Contains(err.Error(), "42P01") ||
		strings.Contains(err.Error(), "does not exist")
}

// buildPrimaryHost resolves the host card metadata from env + geo
// lookup. Best-effort: a failed geo call returns the IP with empty
// country/region/provider so the dashboard renders gracefully.
func (h *TopologyHandler) buildPrimaryHost(ctx context.Context) topologyHost {
	hostname := extractHostFromURL(h.PublicURL)
	if hostname == "" {
		hostname = strings.TrimSpace(os.Getenv("SYNAPSE_DOMAIN"))
	}
	if hostname == "" {
		hostname = "Synapse host"
	}

	host := topologyHost{
		ID:             "primary",
		Name:           hostname,
		IP:             h.PublicIP,
		SynapseVersion: h.SynapseVersion,
		IsPrimary:      true,
		Deployments:    []topologyDeployment{},
	}

	if h.Geo != nil && h.PublicIP != "" {
		gctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		if info, err := h.Geo.Lookup(gctx, h.PublicIP); err == nil {
			host.Country = info.Country
			host.CountryFlag = info.CountryFlag
			host.City = info.City
			host.Region = info.Region
			host.Provider = info.Provider
		}
	}
	return host
}

// mapDeployment converts the DB row into the topology DTO shape the
// dashboard expects. Pure function — no DB calls, no IO.
func mapDeployment(d models.Deployment, domains map[string]string, replicas map[string]int, publicURL string) topologyDeployment {
	storage := "sqlite"
	if d.HAEnabled {
		storage = "postgres + s3"
	}
	if d.Adopted {
		storage = "external"
	}

	replicaCount := d.ReplicaCount
	if !d.HAEnabled {
		replicaCount = 1
	}
	healthy := replicas[d.ID]
	if !d.HAEnabled {
		// Single-replica: healthy iff status is running. Adopted treated
		// the same — operator owns the lifecycle but if we marked it
		// running we trust that signal.
		if d.Status == models.DeploymentStatusRunning {
			healthy = 1
		}
	}

	var port *int
	if d.HostPort > 0 {
		hp := d.HostPort
		port = &hp
	}

	var runningSince int64
	if d.LastDeployAt != nil && d.Status == models.DeploymentStatusRunning {
		runningSince = d.LastDeployAt.UnixMilli()
	} else if d.Status == models.DeploymentStatusRunning {
		runningSince = d.CreatedAt.UnixMilli()
	}

	return topologyDeployment{
		Name:           d.Name,
		Type:           d.DeploymentType,
		Status:         d.Status,
		URL:            d.DeploymentURL,
		URLForm:        classifyURLForm(d.DeploymentURL, publicURL),
		Storage:        storage,
		HAEnabled:      d.HAEnabled,
		ReplicaCount:   replicaCount,
		HealthyCount:   healthy,
		CustomDomain:   domains[d.Name],
		Adopted:        d.Adopted,
		RunningSinceMS: runningSince,
		IsDefault:      d.IsDefault,
		Reference:      d.Reference,
		Port:           port,
	}
}

// classifyURLForm mirrors the dashboard's urlForm() heuristic so the
// status badge ("wildcard" / "custom" / "path" / "host") is consistent
// with what the operator already sees on the deployment card above.
//
// Inputs:
//   - url:       the deployment's public URL (e.g. https://X.app.synapsepanel.com)
//   - publicURL: this Synapse host's PublicURL env value (e.g. https://synapsepanel.com)
func classifyURLForm(url, publicURL string) string {
	if url == "" {
		return "unknown"
	}
	host := extractHostFromURL(url)
	if host == "" {
		return "unknown"
	}
	// Path-prefix form: "/d/<name>" — emitted before wildcard mode is set.
	if i := strings.Index(url, "://"); i >= 0 {
		rest := url[i+3:]
		if slash := strings.Index(rest, "/"); slash >= 0 {
			path := rest[slash:]
			if strings.HasPrefix(path, "/d/") {
				return "path"
			}
		}
	}
	// host:port form — fallback when neither wildcard nor custom is configured.
	// Anything that isn't a known-good port (443/80/6791) AND isn't localhost
	// counts as "host" — same heuristic the dashboard urlForm() uses.
	if colon := strings.LastIndex(host, ":"); colon >= 0 {
		host = host[:colon]
	}
	if hasNonStandardPort(url) {
		return "host"
	}
	pubHost := extractHostFromURL(publicURL)
	if pubHost == "" {
		return "custom"
	}
	if host == pubHost {
		return "custom"
	}
	if strings.HasSuffix(host, "."+pubHost) {
		return "wildcard"
	}
	return "custom"
}

func hasNonStandardPort(url string) bool {
	i := strings.Index(url, "://")
	if i < 0 {
		return false
	}
	rest := url[i+3:]
	// Strip path
	if slash := strings.Index(rest, "/"); slash >= 0 {
		rest = rest[:slash]
	}
	// Look for :digits
	colon := strings.LastIndex(rest, ":")
	if colon < 0 {
		return false
	}
	port := rest[colon+1:]
	if port == "" {
		return false
	}
	for _, r := range port {
		if r < '0' || r > '9' {
			return false
		}
	}
	switch port {
	case "443", "80", "6791":
		return false
	}
	// localhost / 127.x.x.x are still browser-reachable for ops.
	hostname := rest[:colon]
	if hostname == "localhost" || strings.HasPrefix(hostname, "127.") {
		return false
	}
	return true
}
