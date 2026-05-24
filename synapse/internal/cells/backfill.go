// Package cells holds the Cell Control Plane logic that doesn't belong in an
// HTTP handler — chiefly the startup backfill that turns existing Convex
// deployments into core Cells + placements.
//
// It lives in its own package (not cmd/server) so it's importable from the
// integration test suite: the backfill's idempotency is a hard acceptance
// criterion, and the test calls Backfill directly rather than booting main().
//
// Design rules honoured here:
//   - Purely additive. Reads deployments; writes only the new cells /
//     cell_resources / deployment_placements / hosts tables. Never mutates a
//     deployments row, so existing deployments keep working untouched.
//   - Idempotent. Re-running never duplicates a Cell — a deployment that
//     already has a cell_resources row is skipped. Safe to run on every boot.
//   - Best-effort per deployment. One bad row (e.g. a slug collision with a
//     manually-created Cell) is logged and skipped, not fatal to the rest.
package cells

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/db"
	"github.com/Iann29/synapse/internal/models"
)

// BackfillOpts tunes the backfill. All fields have sane defaults so the
// zero value produces a working (if generically-named) result.
type BackfillOpts struct {
	// HostName is the name for the synthesised local Host (the VPS the
	// control plane runs on). Empty → "current-host".
	HostName string
	// Region is stamped onto the local Host and into Cell names
	// (core-<env>-<region>-N). Empty → "local".
	Region string
	// Provider labels the local Host. Empty → "self-hosted".
	Provider string
	// Logger receives best-effort progress + per-row skip warnings. Nil →
	// slog.Default().
	Logger *slog.Logger
}

// BackfillResult reports what the backfill did, for logging + the test.
type BackfillResult struct {
	HostID        string
	HostCreated   bool
	CellsCreated  int
	CellsExisting int
}

// deploymentRow is the slice of a deployment the backfill needs.
type deploymentRow struct {
	ID             string
	ProjectID      string
	TeamID         string
	DeploymentType string
	Status         string
	HostPort       *int
	ContainerID    *string
	DeploymentURL  *string
	Adopted        bool
}

// Backfill ensures a local Host row exists and that every non-deleted
// deployment has a core Cell + cell_resource + placement. Idempotent.
func Backfill(ctx context.Context, pool *pgxpool.Pool, opts BackfillOpts) (BackfillResult, error) {
	logger := opts.Logger
	if logger == nil {
		logger = slog.Default()
	}
	region := sanitizeRegion(opts.Region)
	if region == "" {
		region = "local"
	}

	var res BackfillResult
	hostID, hostCreated, err := ensureLocalHost(ctx, pool, opts, region)
	if err != nil {
		return res, fmt.Errorf("ensure local host: %w", err)
	}
	res.HostID = hostID
	res.HostCreated = hostCreated

	deployments, err := loadDeployments(ctx, pool)
	if err != nil {
		return res, fmt.Errorf("load deployments: %w", err)
	}

	for _, d := range deployments {
		has, err := deploymentHasCell(ctx, pool, d.ID)
		if err != nil {
			return res, fmt.Errorf("check existing cell for %s: %w", d.ID, err)
		}
		if has {
			res.CellsExisting++
			continue
		}
		created, err := backfillOne(ctx, pool, hostID, d, region)
		if err != nil {
			// Best-effort: log + keep going so one collision doesn't strand
			// the rest. The next boot retries this deployment.
			logger.Warn("cell backfill: skipped deployment",
				"deployment_id", d.ID, "err", err)
			continue
		}
		if created {
			res.CellsCreated++
		} else {
			res.CellsExisting++
		}
	}
	return res, nil
}

// ensureLocalHost finds-or-creates the single is_synapse_host row. The
// partial unique index hosts_one_synapse_host_idx guarantees there's at most
// one; we treat a unique violation on insert as "another node won the race"
// and re-select.
func ensureLocalHost(ctx context.Context, pool *pgxpool.Pool, opts BackfillOpts, region string) (string, bool, error) {
	var id string
	err := pool.QueryRow(ctx, `SELECT id FROM hosts WHERE is_synapse_host LIMIT 1`).Scan(&id)
	if err == nil {
		return id, false, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return "", false, err
	}

	name := strings.TrimSpace(opts.HostName)
	if name == "" {
		name = "current-host"
	}
	provider := strings.TrimSpace(opts.Provider)
	if provider == "" {
		provider = "self-hosted"
	}

	err = pool.QueryRow(ctx, `
		INSERT INTO hosts (name, provider, region, status, is_synapse_host)
		VALUES ($1, $2, $3, $4, true)
		RETURNING id
	`, name, provider, region, models.HostStatusOnline).Scan(&id)
	if err == nil {
		return id, true, nil
	}
	if db.IsUniqueViolation(err) {
		// Lost the race (another node inserted it, or the name collides).
		// Re-select the canonical self-host row.
		if selErr := pool.QueryRow(ctx, `SELECT id FROM hosts WHERE is_synapse_host LIMIT 1`).Scan(&id); selErr == nil {
			return id, false, nil
		}
	}
	return "", false, err
}

func loadDeployments(ctx context.Context, pool *pgxpool.Pool) ([]deploymentRow, error) {
	rows, err := pool.Query(ctx, `
		SELECT d.id, d.project_id, p.team_id, d.deployment_type, d.status,
		       d.host_port, d.container_id, d.deployment_url, d.adopted
		  FROM deployments d
		  JOIN projects p ON p.id = d.project_id
		 WHERE d.status <> 'deleted'
		 ORDER BY d.project_id, d.created_at ASC, d.id ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []deploymentRow
	for rows.Next() {
		var d deploymentRow
		if err := rows.Scan(&d.ID, &d.ProjectID, &d.TeamID, &d.DeploymentType, &d.Status,
			&d.HostPort, &d.ContainerID, &d.DeploymentURL, &d.Adopted); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func deploymentHasCell(ctx context.Context, pool *pgxpool.Pool, deploymentID string) (bool, error) {
	var exists bool
	err := pool.QueryRow(ctx, `
		SELECT EXISTS(
			SELECT 1 FROM cell_resources
			 WHERE resource_type = $1 AND resource_id = $2
		)
	`, models.CellResourceConvexDeployment, deploymentID).Scan(&exists)
	return exists, err
}

// backfillOne creates the Cell + cell_resource + placement for a single
// deployment, in one transaction. Returns created=false (nil err) when the
// deployment turns out to already be attached (lost a race). Retries the
// Cell name on a (project_id, slug) collision so a pre-existing manually-
// created Cell with the computed name doesn't strand the deployment.
func backfillOne(ctx context.Context, pool *pgxpool.Pool, hostID string, d deploymentRow, region string) (bool, error) {
	env := mapEnv(d.DeploymentType)
	desired := models.PlacementDesiredRunning
	if d.Status == models.DeploymentStatusStopped {
		desired = models.PlacementDesiredStopped
	}
	observed := mapObserved(d.Status)

	// Adopted (external) deployments don't run on a host we manage.
	var placementHostID *string
	var cellHostID *string
	if !d.Adopted {
		placementHostID = &hostID
		cellHostID = &hostID
	}

	const maxNameAttempts = 50
	for attempt := 0; attempt < maxNameAttempts; attempt++ {
		n, err := nextCellIndex(ctx, pool, d.ProjectID, env)
		if err != nil {
			return false, fmt.Errorf("compute cell index: %w", err)
		}
		name := fmt.Sprintf("core-%s-%s-%d", env, region, n+attempt)

		created, retry, err := tryInsertCell(ctx, pool, name, hostID, cellHostID, placementHostID, d, env, region, desired, observed)
		if err != nil {
			return false, err
		}
		if retry {
			continue // slug collision — bump the index and try again
		}
		return created, nil
	}
	return false, fmt.Errorf("could not find a free cell name after %d attempts", maxNameAttempts)
}

// tryInsertCell runs the 3-insert transaction once. retry=true means the cell
// name collided (caller should bump and retry); created=false+retry=false
// means the deployment got attached concurrently (treat as already-existing).
func tryInsertCell(
	ctx context.Context, pool *pgxpool.Pool,
	name, hostID string, cellHostID, placementHostID *string,
	d deploymentRow, env, region, desired, observed string,
) (created bool, retry bool, err error) {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return false, false, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var cellID string
	// name + slug are the same string here but must be DISTINCT bind params:
	// name is TEXT, slug is CITEXT, so sharing one placeholder makes Postgres
	// fail to deduce a single type (SQLSTATE 42P08).
	err = tx.QueryRow(ctx, `
		INSERT INTO cells (team_id, project_id, name, slug, kind, environment,
		                   region, status, primary_deployment_id, primary_host_id,
		                   description)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
		RETURNING id
	`,
		d.TeamID, d.ProjectID, name, name,
		models.CellKindCore, env, region, models.CellStatusActive,
		d.ID, cellHostID,
		fmt.Sprintf("Backfilled core Cell for deployment %s", d.ID),
	).Scan(&cellID)
	if err != nil {
		if db.IsUniqueViolation(err) {
			return false, true, nil // (project_id, slug) taken — retry with a new name
		}
		return false, false, err
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO cell_resources (cell_id, resource_type, resource_id, role)
		VALUES ($1, $2, $3, $4)
	`, cellID, models.CellResourceConvexDeployment, d.ID, models.CellResourceRolePrimary)
	if err != nil {
		if db.IsUniqueViolation(err) {
			// Deployment got attached to a Cell concurrently. Abandon this
			// Cell; the other one wins.
			return false, false, nil
		}
		return false, false, err
	}

	_, err = tx.Exec(ctx, `
		INSERT INTO deployment_placements (deployment_id, cell_id, host_id,
		                                   desired_status, observed_status,
		                                   docker_container_id, internal_port,
		                                   public_url, last_observed_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
	`, d.ID, cellID, placementHostID, desired, observed,
		d.ContainerID, d.HostPort, d.DeploymentURL, time.Now())
	if err != nil {
		if db.IsUniqueViolation(err) {
			return false, false, nil // placement already exists for this deployment
		}
		return false, false, err
	}

	if err := tx.Commit(ctx); err != nil {
		return false, false, err
	}
	return true, false, nil
}

// nextCellIndex returns the count of existing core Cells for (project, env),
// so the caller can name the next one core-<env>-<region>-<count+1>.
func nextCellIndex(ctx context.Context, pool *pgxpool.Pool, projectID, env string) (int, error) {
	var n int
	err := pool.QueryRow(ctx, `
		SELECT COUNT(*) FROM cells
		 WHERE project_id = $1 AND kind = $2 AND environment = $3
	`, projectID, models.CellKindCore, env).Scan(&n)
	return n + 1, err
}

// mapEnv maps a deployment_type to a Cell environment. custom has no Cell
// environment counterpart; it lands in dev as the safe non-prod default.
func mapEnv(deploymentType string) string {
	switch deploymentType {
	case models.DeploymentTypeProd:
		return models.CellEnvProd
	case models.DeploymentTypePreview:
		return models.CellEnvPreview
	case models.DeploymentTypeDev:
		return models.CellEnvDev
	default: // custom or anything unexpected
		return models.CellEnvDev
	}
}

func mapObserved(deploymentStatus string) string {
	switch deploymentStatus {
	case models.DeploymentStatusRunning:
		return models.PlacementObservedRunning
	case models.DeploymentStatusStopped:
		return models.PlacementObservedStopped
	case models.DeploymentStatusFailed:
		return models.PlacementObservedFailed
	default: // provisioning, or anything else we haven't observed yet
		return models.PlacementObservedUnknown
	}
}

// sanitizeRegion keeps the region a clean slug fragment (lowercase letters,
// digits, hyphens) so core-<env>-<region>-N stays a valid Cell slug.
func sanitizeRegion(region string) string {
	var b strings.Builder
	prevDash := false
	for _, r := range strings.ToLower(strings.TrimSpace(region)) {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9'):
			b.WriteRune(r)
			prevDash = false
		case r == '-' || r == '_' || r == ' ':
			if !prevDash && b.Len() > 0 {
				b.WriteByte('-')
				prevDash = true
			}
		}
	}
	return strings.Trim(b.String(), "-")
}
