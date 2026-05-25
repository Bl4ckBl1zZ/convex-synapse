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
	DockerAvailable bool                `json:"dockerAvailable"`
	DockerVersion   string              `json:"dockerVersion"`
	Containers      []observedContainer `json:"containers"`
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

	// host_facts.
	facts := map[string]any{
		"hostname":        req.Hostname,
		"os":              req.OS,
		"arch":            req.Arch,
		"dockerAvailable": p.DockerAvailable,
		"dockerVersion":   p.DockerVersion,
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
	for _, c := range p.Containers {
		labels := safeSynapseLabels(c.Labels)
		depID := labels["synapse.deployment_id"]
		key := c.Name
		var resID *string
		if depID != "" {
			key = depID
			resID = &depID
		}
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
			models.ResourceTypeDockerContainer+":"+key, observed); err != nil {
			return err
		}
	}
	return nil
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
