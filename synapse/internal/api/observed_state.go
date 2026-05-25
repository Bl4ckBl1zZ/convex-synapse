package api

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/models"
)

// observedPayload is the SAFE subset the agent reports in heartbeat.observed.
// No env vars, no full command, no tokens — see the agent's buildObserved.
type observedPayload struct {
	DockerAvailable bool                  `json:"dockerAvailable"`
	DockerVersion   string                `json:"dockerVersion"`
	Containers      []observedContainer   `json:"containers"`
	ContainerScan   *containerScanPayload `json:"containerScan,omitempty"`
}

// containerScanPayload tells us whether the agent's `docker ps -a` actually
// succeeded (9b.5). Pruning + drift trust it instead of guessing from an empty
// container list — a failed scan must never be read as "everything vanished".
type containerScanPayload struct {
	Attempted bool   `json:"attempted"`
	Succeeded bool   `json:"succeeded"`
	Complete  bool   `json:"complete"`
	Error     string `json:"error,omitempty"`
}

type observedContainer struct {
	ID        string            `json:"id"`
	Name      string            `json:"name"`
	Image     string            `json:"image"`
	State     string            `json:"state"`
	Status    string            `json:"status"`
	Labels    map[string]string `json:"labels"`
	Ports     string            `json:"ports"`
	CreatedAt string            `json:"createdAt"`
}

// recordObservedStates writes the host_facts + docker_container observed
// states from a heartbeat. Best-effort (callers ignore errors so liveness is
// never blocked). NEVER stores env vars / commands / secrets; container labels
// are re-filtered server-side to synapse.* only as defense in depth.
func recordObservedStates(ctx context.Context, pool *pgxpool.Pool, hostID string, agentID *string, req agentHeartbeatReq) error {
	var p observedPayload
	if len(req.Observed) > 0 {
		_ = json.Unmarshal(req.Observed, &p)
	}

	scanSucceeded, scanComplete, scanErr := resolveContainerScan(p)

	// host_facts — includes the container-scan outcome so the Drift Engine can
	// decide whether the observed container set can be trusted.
	facts := map[string]any{
		"hostname":        req.Hostname,
		"os":              req.OS,
		"arch":            req.Arch,
		"dockerAvailable": p.DockerAvailable,
		"dockerVersion":   p.DockerVersion,
		"containerScan": map[string]any{
			"attempted": true,
			"succeeded": scanSucceeded,
			"complete":  scanComplete,
			"error":     nullStr(scanErr),
		},
	}
	if req.CPUCores != nil {
		facts["cpuCores"] = *req.CPUCores
	}
	if req.MemoryMb != nil {
		facts["memoryMb"] = *req.MemoryMb
	}
	if req.DiskGb != nil {
		facts["diskGb"] = *req.DiskGb
	}
	if err := upsertObserved(ctx, pool, hostID, agentID, models.ResourceTypeHostFacts, nil, "host:"+hostID, facts); err != nil {
		return err
	}

	// docker_container (synapse-managed only).
	seenKeys := make([]string, 0, len(p.Containers))
	for _, c := range p.Containers {
		labels := safeSynapseLabels(c.Labels)
		depID := labels["synapse.deployment_id"]
		key := c.Name
		var resID *string
		if depID != "" {
			key = depID
			resID = &depID
		}
		resourceKey := models.ResourceTypeDockerContainer + ":" + key
		seenKeys = append(seenKeys, resourceKey)
		observed := map[string]any{
			"id":        c.ID,
			"name":      c.Name,
			"image":     c.Image,
			"state":     c.State,
			"status":    c.Status,
			"labels":    labels,
			"ports":     c.Ports,
			"createdAt": c.CreatedAt,
		}
		if err := upsertObserved(ctx, pool, hostID, agentID, models.ResourceTypeDockerContainer, resID,
			resourceKey, observed); err != nil {
			return err
		}
	}

	// Prune vanished containers so observed_states mirrors the latest snapshot
	// instead of accumulating ghost rows (a removed container must read as
	// "missing" in drift, not a stale state=running forever). ONLY when the
	// agent's scan actually SUCCEEDED and was COMPLETE (9b.5): a failed or
	// docker-unavailable scan reports an empty list, and deleting everything
	// then would manufacture false "missing" drift during a transient outage.
	// host_facts is never pruned.
	if scanSucceeded && scanComplete {
		if err := pruneObservedContainers(ctx, pool, hostID, seenKeys); err != nil {
			return err
		}
	}
	return nil
}

// resolveContainerScan derives the scan outcome. A 9b.5+ agent sends an
// explicit containerScan; a legacy agent (pre-9b.5) doesn't, so we fall back to
// dockerAvailable (its old, coarser signal) — succeeded+complete only when
// docker was up, matching the original Bloco 9b pruning behaviour.
func resolveContainerScan(p observedPayload) (succeeded, complete bool, errCode string) {
	if p.ContainerScan != nil {
		return p.ContainerScan.Succeeded, p.ContainerScan.Complete, p.ContainerScan.Error
	}
	if p.DockerAvailable {
		return true, true, ""
	}
	return false, false, "docker_unavailable"
}

// pruneObservedContainers deletes the host's docker_container observed rows
// whose resource_key is not in the current heartbeat snapshot. keepKeys may be
// empty (host legitimately runs zero managed containers → drop them all).
func pruneObservedContainers(ctx context.Context, pool *pgxpool.Pool, hostID string, keepKeys []string) error {
	_, err := pool.Exec(ctx, `
		DELETE FROM observed_states
		 WHERE host_id = $1
		   AND resource_type = $2
		   AND NOT (resource_key = ANY($3::text[]))
	`, hostID, models.ResourceTypeDockerContainer, keepKeys)
	return err
}

// safeSynapseLabels keeps only synapse.* labels — never echoes arbitrary
// operator labels that could carry sensitive values.
func safeSynapseLabels(in map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range in {
		if strings.HasPrefix(k, "synapse.") {
			out[k] = v
		}
	}
	return out
}

func upsertObserved(ctx context.Context, pool *pgxpool.Pool, hostID string, agentID *string, resourceType string, resourceID *string, resourceKey string, observed map[string]any) error {
	_, err := pool.Exec(ctx, `
		INSERT INTO observed_states (host_id, agent_id, resource_type, resource_id, resource_key,
		                             observed_json, observed_hash, source)
		VALUES ($1, $2, $3, $4, $5, $6, $7, 'agent')
		ON CONFLICT (host_id, resource_type, resource_key) DO UPDATE
		   SET agent_id = EXCLUDED.agent_id,
		       resource_id = EXCLUDED.resource_id,
		       observed_json = EXCLUDED.observed_json,
		       observed_hash = EXCLUDED.observed_hash,
		       observed_at = now(),
		       updated_at = now()
	`, hostID, agentID, resourceType, resourceID, resourceKey, marshalJSONBMap(observed), canonicalHash(observed))
	return err
}

const observedStateColumns = `id, host_id, agent_id, resource_type, resource_id, resource_key,
	observed_json, observed_hash, observed_at, source, created_at, updated_at`

func scanObservedState(s scannable) (models.ObservedState, error) {
	var o models.ObservedState
	var observed []byte
	if err := s.Scan(&o.ID, &o.HostID, &o.AgentID, &o.ResourceType, &o.ResourceID, &o.ResourceKey,
		&observed, &o.ObservedHash, &o.ObservedAt, &o.Source, &o.CreatedAt, &o.UpdatedAt); err != nil {
		return models.ObservedState{}, err
	}
	o.ObservedJSON = unmarshalJSONBMap(observed)
	return o, nil
}

func loadObservedByHost(ctx context.Context, pool *pgxpool.Pool, hostID string) ([]models.ObservedState, error) {
	rows, err := pool.Query(ctx, `SELECT `+observedStateColumns+` FROM observed_states WHERE host_id = $1 ORDER BY resource_type, resource_key`, hostID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := make([]models.ObservedState, 0)
	for rows.Next() {
		o, err := scanObservedState(rows)
		if err != nil {
			return nil, err
		}
		items = append(items, o)
	}
	return items, rows.Err()
}
