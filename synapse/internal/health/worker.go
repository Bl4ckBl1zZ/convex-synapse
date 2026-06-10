// Package health runs a periodic reconciler that compares the deployments
// recorded in Postgres against what's actually running on Docker. When a
// container has disappeared from under us (operator removed it manually,
// host reboot, etc.) the worker flips the row to "stopped" so the dashboard
// reflects reality and the port can be safely re-allocated.
//
// Adopted (external) deployments get a parallel pass with a different
// truth source (v1.27+): Synapse owns no container for them, so each
// sweep probes the stored deployment URL over HTTP (GET /version) and
// reconciles running↔stopped from the answer. Same Alerter contract,
// no auto-restart (the operator owns the lifecycle).
//
// Two optional hooks ride the reconciliation: AutoRestart (Config flag +
// Restarter) bounces a replica whose container merely exited, and Alerter
// (v1.26+) notifies team admins / a webhook when a deployment-level status
// transitions to stopped/failed — fired exactly once per down event, and
// never for a blip auto-restart already recovered.
package health

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	synapsedb "github.com/Iann29/synapse/internal/db"
)

// DockerStatusReporter is the subset of the docker provisioner the worker
// needs. The provisioner.Client implements it; tests can pass a fake.
//
// For HA deployments, the worker addresses individual replicas via
// StatusReplica — single-replica (legacy) deployments keep using Status
// so existing tests, fakes, and the *dockerprov.Client all keep their
// non-HA call paths intact.
type DockerStatusReporter interface {
	Status(ctx context.Context, deploymentName string) (string, error)
	StatusReplica(ctx context.Context, deploymentName string, replicaIndex int) (string, error)
}

// Restarter is the optional auto-recovery hook. When the worker reconciles
// a row to "stopped" and AutoRestart is true, it calls Restart(name). The
// docker.Client's Restart implements this; nil disables auto-recovery.
//
// HA deployments use RestartReplica which targets one replica by index.
// A nil Restarter disables auto-restart for both single and HA modes.
type Restarter interface {
	Restart(ctx context.Context, deploymentName string) error
	RestartReplica(ctx context.Context, deploymentName string, replicaIndex int) error
}

// Alerter is the optional deployment-down notification hook. The worker
// calls it AFTER a deployment-level status transition lands in the DB
// (running → stopped/failed) — replica-level flapping that auto-restart
// already recovered never reaches it. Implementations must be best-effort
// and non-blocking (the sweep runs under the fleet-wide advisory lock):
// alert.Notifier detaches into a goroutine internally. nil disables alerts.
type Alerter interface {
	DeploymentDown(ctx context.Context, deploymentID, previousStatus, newStatus string)
}

// RemoteReporter is the subset of *dockerprov.RemoteClient the health
// worker needs for a deployment that runs on a remote host: read the
// container's status over SSH and (when AutoRestart is on) bounce it.
// Remote deployments are single-replica in v1.18, so the non-Replica
// methods suffice.
type RemoteReporter interface {
	Status(ctx context.Context, deploymentName string) (string, error)
	Restart(ctx context.Context, deploymentName string) error
}

// RemoteTarget carries a remote host's SSH coordinates so Worker.RemoteFor
// can bind a reporter to it. Mirrors the fields provisioner.dockerForJob
// feeds into sshprov.Target.
type RemoteTarget struct {
	HostID      string
	TailnetAddr string
	SSHUser     string
	SSHPort     int
}

// replicaRow is one running replica plus the host-routing columns the
// sweep needs to decide local-Docker vs remote-SSH reconciliation.
type replicaRow struct {
	replicaID    string
	deploymentID string
	name         string
	replicaIndex int
	haEnabled    bool
	// Host routing. isRemote=false (host_id NULL) → self-host, use the
	// local Docker reporter. isRemote=true → the container lives on
	// another VPS; reconcile it over SSH via Worker.RemoteFor.
	hostID      string
	isRemote    bool
	tailnetAddr string
	sshUser     string
	sshPort     int
}

// Config controls how often the worker scans and what counts as "stale".
type Config struct {
	// Interval between full sweeps. Sub-second values are clamped to 1s.
	Interval time.Duration
	// Per-status-call timeout. Slow Docker daemons shouldn't stall the loop.
	StatusTimeout time.Duration
	// AutoRestart, when true, has the worker attempt to restart a deployment
	// after a sweep flips its status to "stopped". Successful restart flips
	// the row back to "running"; failure leaves it at "failed". Implementer
	// must also set Restarter on the worker.
	AutoRestart bool
	// ProbeRetryDelay is the pause before re-probing an adopted deployment
	// whose first HTTP probe failed (anti-blip: one dropped packet or a
	// rolling restart on the operator's side must not page anyone). Only
	// a second consecutive failure marks the row down. Defaults to 2s.
	ProbeRetryDelay time.Duration
}

func (c Config) sane() Config {
	out := c
	if out.Interval < time.Second {
		out.Interval = 30 * time.Second
	}
	if out.StatusTimeout <= 0 {
		out.StatusTimeout = 5 * time.Second
	}
	if out.ProbeRetryDelay <= 0 {
		out.ProbeRetryDelay = 2 * time.Second
	}
	return out
}

// Worker reconciles deployments.status with Docker reality on a timer.
type Worker struct {
	DB        *pgxpool.Pool
	Docker    DockerStatusReporter
	Restarter Restarter // optional; required when Config.AutoRestart is true
	Alerter   Alerter   // optional; nil = no deployment-down notifications
	Config    Config
	Logger    *slog.Logger
	// RemoteFor returns a reporter bound to a remote host's SSH target,
	// or nil when Remote Hosts is disabled in this process. CRITICAL: a
	// remote deployment's container lives on another VPS — judging it by
	// THIS node's local Docker daemon always reports "gone" and would
	// flip a healthy deployment to "stopped" (the split-brain bug that
	// broke central-proxy routing). When RemoteFor is nil the worker
	// SKIPS remote replicas rather than mis-reconcile them via local
	// Docker. Wired by main.go from the same sshprov.Client the
	// provisioner uses.
	RemoteFor func(RemoteTarget) RemoteReporter
}

// Run blocks until ctx is cancelled. Each tick runs a single sweep and logs
// a summary at INFO level when state changed; a no-op sweep emits a DEBUG
// line so the worker is observable but not noisy.
//
// Multi-node coordination: each tick is wrapped in a session-level
// pg_try_advisory_lock(LockHealthWorker). Exactly one node in the fleet
// runs the sweep at any instant; followers observe acquired=false and
// skip silently. Single-node deployments pay one round-trip per tick.
func (w *Worker) Run(ctx context.Context) {
	cfg := w.Config.sane()
	logger := w.Logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.Info("health worker starting", "interval", cfg.Interval)

	// Run one sweep immediately so a fresh server doesn't wait `interval`
	// before catching a docker mismatch.
	w.tickWithLock(ctx, logger, cfg)

	t := time.NewTicker(cfg.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			logger.Info("health worker stopping")
			return
		case <-t.C:
			w.tickWithLock(ctx, logger, cfg)
		}
	}
}

// tickWithLock acquires the worker's advisory lock and runs one sweep.
// If the lock is held by another node, the tick is a no-op.
func (w *Worker) tickWithLock(ctx context.Context, logger *slog.Logger, cfg Config) {
	acquired, err := synapsedb.WithTryAdvisoryLock(ctx, w.DB, synapsedb.LockHealthWorker,
		func(ctx context.Context) error {
			w.sweep(ctx, logger, cfg)
			return nil
		})
	if err != nil {
		logger.Warn("health: advisory-lock acquire failed", "err", err)
		return
	}
	if !acquired {
		logger.Debug("health: another node holds the sweep lock; skipping tick")
	}
}

// sweep runs one reconciliation pass. Errors are logged, never returned —
// a transient DB or Docker hiccup must not kill the loop.
//
// The worker iterates deployment_replicas rows (one per running replica)
// rather than deployments — that way HA deployments with N replicas
// reconcile each replica independently and the deployment-level status
// is recomputed as an aggregate. For pre-v0.5 single-replica deployments
// (replica_count=1, ha_enabled=false), the migration backfilled exactly
// one replica row each, so the iteration is structurally identical to
// the old "iterate deployments" loop.
func (w *Worker) sweep(ctx context.Context, logger *slog.Logger, cfg Config) {
	// Adopted deployments are excluded HERE because this loop judges
	// health by Docker, and Synapse never started (or even knows) their
	// container. They get their own pass — sweepAdopted, below — which
	// probes the stored external URL over HTTP instead.
	rows, err := w.DB.Query(ctx, `
		SELECT r.id, d.id, d.name, r.replica_index, d.ha_enabled,
		       COALESCE(d.host_id::text, ''), COALESCE(h.is_remote, false),
		       COALESCE(h.tailnet_addr, ''), COALESCE(h.ssh_user, ''),
		       COALESCE(h.ssh_port, 0)
		  FROM deployment_replicas r
		  JOIN deployments d ON d.id = r.deployment_id
		  LEFT JOIN hosts h ON h.id = d.host_id
		 WHERE r.status = 'running'
		   AND d.adopted = false
		   AND d.status <> 'deleted'
	`)
	if err != nil {
		logger.Error("health: list running replicas", "err", err)
		return
	}

	var items []replicaRow
	for rows.Next() {
		var it replicaRow
		if err := rows.Scan(&it.replicaID, &it.deploymentID, &it.name,
			&it.replicaIndex, &it.haEnabled, &it.hostID, &it.isRemote,
			&it.tailnetAddr, &it.sshUser, &it.sshPort); err != nil {
			logger.Error("health: scan row", "err", err)
			rows.Close()
			return
		}
		items = append(items, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		logger.Error("health: rows err", "err", err)
		return
	}

	// Track which deployments had any replica change. Each one needs a
	// status-recompute pass at the end; without that, the deployment
	// row's status drifts from the aggregate of its replicas.
	deploymentsTouched := make(map[string]bool)
	var changed int
	for _, it := range items {
		if w.reconcileReplica(ctx, logger, cfg, it) {
			changed++
			deploymentsTouched[it.deploymentID] = true
		}
	}
	for did := range deploymentsTouched {
		w.recomputeDeploymentStatus(ctx, logger, did)
	}
	if changed > 0 {
		logger.Info("health sweep", "checked", len(items), "changed", changed)
	} else {
		logger.Debug("health sweep", "checked", len(items))
	}

	w.sweepAdopted(ctx, logger, cfg)
}

// adoptedProbeClient is shared by every adopted-deployment probe. No
// global timeout (each probe carries a ctx deadline) and redirects are
// not followed — same posture as the adopt-time probe in the API: the
// stored URL must answer /version itself, and a worker that re-fetches
// operator-supplied URLs forever shouldn't be bounceable elsewhere.
var adoptedProbeClient = &http.Client{
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		return http.ErrUseLastResponse
	},
}

// sweepAdopted reconciles adopted (external) deployments by HTTP: GET
// <deployment_url>/version, the same liveness check adopt_deployment ran
// when the row was created. 2xx → running; anything else, confirmed by a
// second probe ProbeRetryDelay later → stopped. Without this pass an
// adopted row kept the status stamped at adoption forever — a dead
// external backend stayed green on the dashboard and deployment-down
// alerts never fired for exactly the deployments Synapse can't restart.
//
// Only running↔stopped transitions apply: adopted rows are never
// 'provisioning' or 'failed', and 'deleted' is terminal. The down
// transition uses the same UPDATE…RETURNING prev.status shape as
// recomputeDeploymentStatus so the Alerter fires exactly once per down
// event even with concurrent sweeps. There's no auto-restart leg —
// Synapse doesn't own the container.
func (w *Worker) sweepAdopted(ctx context.Context, logger *slog.Logger, cfg Config) {
	rows, err := w.DB.Query(ctx, `
		SELECT id, name, COALESCE(deployment_url, ''), status
		  FROM deployments
		 WHERE adopted = true
		   AND status IN ('running', 'stopped')
	`)
	if err != nil {
		logger.Error("health: list adopted deployments", "err", err)
		return
	}
	type adoptedRow struct {
		id, name, url, status string
	}
	var items []adoptedRow
	for rows.Next() {
		var it adoptedRow
		if err := rows.Scan(&it.id, &it.name, &it.url, &it.status); err != nil {
			logger.Error("health: scan adopted row", "err", err)
			rows.Close()
			return
		}
		items = append(items, it)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		logger.Error("health: adopted rows err", "err", err)
		return
	}

	var changed int
	for _, it := range items {
		if it.url == "" {
			// Shouldn't happen (the adopt probe requires a reachable
			// URL) but a row we can't probe must not flap to stopped.
			continue
		}
		up := w.probeAdopted(ctx, cfg, it.url)
		if !up && it.status == "running" {
			// Anti-blip: only a second consecutive failure takes a
			// running deployment down. The recovery direction needs no
			// debounce — a single good probe proves liveness.
			select {
			case <-ctx.Done():
				return
			case <-time.After(cfg.ProbeRetryDelay):
			}
			up = w.probeAdopted(ctx, cfg, it.url)
		}
		target := "stopped"
		if up {
			target = "running"
		}
		if target == it.status {
			continue
		}
		var prevStatus string
		err := w.DB.QueryRow(ctx, `
			UPDATE deployments d
			   SET status = $1
			  FROM (SELECT id, status FROM deployments WHERE id = $2) prev
			 WHERE d.id = prev.id
			   AND d.adopted = true
			   AND d.status IN ('running', 'stopped')
			   AND d.status <> $1
			RETURNING prev.status
		`, target, it.id).Scan(&prevStatus)
		if errors.Is(err, pgx.ErrNoRows) {
			continue // raced another sweep / a delete — nothing to report
		}
		if err != nil {
			logger.Error("health: update adopted status",
				"deployment", it.name, "err", err)
			continue
		}
		changed++
		logger.Info("health: reconciled adopted deployment",
			"deployment", it.name,
			"old_status", prevStatus,
			"new_status", target)
		if w.Alerter != nil && target == "stopped" {
			w.Alerter.DeploymentDown(ctx, it.id, prevStatus, target)
		}
	}
	if changed > 0 {
		logger.Info("health sweep (adopted)", "checked", len(items), "changed", changed)
	} else if len(items) > 0 {
		logger.Debug("health sweep (adopted)", "checked", len(items))
	}
}

// probeAdopted reports whether the adopted deployment's external URL
// answers GET /version with a 2xx within StatusTimeout. Body content is
// ignored — reachability and a healthy status class are the contract,
// matching what adopt_deployment validated at registration time.
func (w *Worker) probeAdopted(ctx context.Context, cfg Config, baseURL string) bool {
	probeCtx, cancel := context.WithTimeout(ctx, cfg.StatusTimeout)
	defer cancel()
	url := strings.TrimRight(baseURL, "/") + "/version"
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, url, nil)
	if err != nil {
		return false
	}
	resp, err := adoptedProbeClient.Do(req)
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode/100 == 2
}

// reconcileReplica returns true if the replica row's status changed.
// Recomputing the deployment-level status is the caller's job (sweep
// batches it so a single deployment with N changed replicas gets one
// recompute, not N).
func (w *Worker) reconcileReplica(ctx context.Context, logger *slog.Logger, cfg Config, rr replicaRow) bool {
	statusCtx, cancel := context.WithTimeout(ctx, cfg.StatusTimeout)
	defer cancel()

	var dockerStatus string
	var err error
	switch {
	case rr.isRemote:
		// The container runs on another VPS, reachable only over SSH.
		// NEVER fall back to w.Docker (this node's local daemon) — it
		// reports "gone" for every remote container and would flip a
		// healthy deployment to "stopped".
		if w.RemoteFor == nil {
			return false
		}
		reporter := w.RemoteFor(RemoteTarget{
			HostID:      rr.hostID,
			TailnetAddr: rr.tailnetAddr,
			SSHUser:     rr.sshUser,
			SSHPort:     rr.sshPort,
		})
		if reporter == nil {
			return false
		}
		dockerStatus, err = reporter.Status(statusCtx, rr.name)
	case rr.haEnabled:
		dockerStatus, err = w.Docker.StatusReplica(statusCtx, rr.name, rr.replicaIndex)
	default:
		dockerStatus, err = w.Docker.Status(statusCtx, rr.name)
	}
	if err != nil {
		logger.Warn("health: docker status",
			"deployment", rr.name, "replica", rr.replicaIndex, "remote", rr.isRemote, "err", err)
		return false
	}

	target := classify(dockerStatus)
	if target == "" {
		return false
	}

	tag, err := w.DB.Exec(ctx, `
		UPDATE deployment_replicas
		   SET status = $1
		 WHERE id = $2
		   AND status = 'running'
	`, target, rr.replicaID)
	if err != nil {
		logger.Error("health: update replica status",
			"deployment", rr.name, "replica", rr.replicaIndex, "err", err)
		return false
	}
	if tag.RowsAffected() == 0 {
		return false
	}
	logger.Info("health: reconciled replica",
		"deployment", rr.name,
		"replica", rr.replicaIndex,
		"docker_status", dockerStatus,
		"new_status", target)

	if cfg.AutoRestart && target == "stopped" {
		w.tryRestartReplica(ctx, logger, cfg, rr)
	}
	return true
}

// recomputeDeploymentStatus reads the deployment's replica statuses and
// rolls them up into the deployment-level status:
//
//	any replica running     →  running
//	all replicas stopped    →  stopped
//	all replicas failed     →  failed
//	mixed stopped + failed  →  failed   (worst-wins; operator should look)
//	mixed running + others  →  running  (covered by the first rule)
//
// Single-replica deployments degenerate to "the replica's status is the
// deployment's status" — which is exactly the pre-v0.5 behavior.
func (w *Worker) recomputeDeploymentStatus(ctx context.Context, logger *slog.Logger, deploymentID string) {
	var anyRunning, anyFailed, total int
	err := w.DB.QueryRow(ctx, `
		SELECT
		    count(*) FILTER (WHERE status = 'running'),
		    count(*) FILTER (WHERE status = 'failed'),
		    count(*)
		  FROM deployment_replicas
		 WHERE deployment_id = $1
	`, deploymentID).Scan(&anyRunning, &anyFailed, &total)
	if err != nil {
		logger.Error("health: recompute aggregate", "deployment_id", deploymentID, "err", err)
		return
	}
	if total == 0 {
		// Nothing to do — orphaned deployment with no replicas.
		return
	}
	var target string
	switch {
	case anyRunning > 0:
		target = "running"
	case anyFailed > 0:
		target = "failed"
	default:
		target = "stopped"
	}
	// Don't touch deployments already terminally 'deleted'; only flip
	// active rows. Also avoid clobbering 'failed' with 'stopped' — once
	// flipped to failed (via the worker or the provisioner) the deployment
	// stays there until the operator intervenes.
	//
	// The self-join captures the pre-update status in the same statement
	// (RETURNING prev.status): the alert below fires only on a real
	// deployment-level transition, and reads old → new atomically — a
	// separate SELECT would race other nodes' sweeps. ErrNoRows = the WHERE
	// filtered everything out (no change) = no alert.
	var prevStatus string
	err = w.DB.QueryRow(ctx, `
		UPDATE deployments d
		   SET status = $1
		  FROM (SELECT id, status FROM deployments WHERE id = $2) prev
		 WHERE d.id = prev.id
		   AND d.status NOT IN ('deleted','failed')
		   AND d.status <> $1
		RETURNING prev.status
	`, target, deploymentID).Scan(&prevStatus)
	if errors.Is(err, pgx.ErrNoRows) {
		return // no deployment-level change
	}
	if err != nil {
		logger.Error("health: update aggregate", "deployment_id", deploymentID, "err", err)
		return
	}
	logger.Info("health: deployment status recomputed",
		"deployment_id", deploymentID,
		"old_status", prevStatus,
		"new_status", target,
		"replicas_total", total,
		"replicas_running", anyRunning,
		"replicas_failed", anyFailed)

	// Deployment went down (stopped or failed) — page somebody. The
	// running→running and *→running directions stay silent, and replica
	// blips that auto-restart already recovered never reach this point
	// (the replica is back to 'running' before the batched recompute).
	if w.Alerter != nil && (target == "stopped" || target == "failed") {
		w.Alerter.DeploymentDown(ctx, deploymentID, prevStatus, target)
	}
}

// tryRestartReplica attempts a one-shot recovery on a stopped replica.
// Same shape as the legacy tryRestart, just scoped to one replica row
// instead of the whole deployment.
func (w *Worker) tryRestartReplica(ctx context.Context, logger *slog.Logger, cfg Config, rr replicaRow) {
	startCtx, cancel := context.WithTimeout(ctx, cfg.StatusTimeout)
	defer cancel()

	var err error
	switch {
	case rr.isRemote:
		if w.RemoteFor == nil {
			return
		}
		reporter := w.RemoteFor(RemoteTarget{
			HostID:      rr.hostID,
			TailnetAddr: rr.tailnetAddr,
			SSHUser:     rr.sshUser,
			SSHPort:     rr.sshPort,
		})
		if reporter == nil {
			return
		}
		err = reporter.Restart(startCtx, rr.name)
	case w.Restarter == nil:
		return
	case rr.haEnabled:
		err = w.Restarter.RestartReplica(startCtx, rr.name, rr.replicaIndex)
	default:
		err = w.Restarter.Restart(startCtx, rr.name)
	}
	if err != nil {
		logger.Warn("health: auto-restart failed",
			"deployment", rr.name, "replica", rr.replicaIndex, "err", err)
		if err.Error() == "container not found" {
			_, _ = w.DB.Exec(ctx,
				`UPDATE deployment_replicas SET status = 'failed' WHERE id = $1 AND status = 'stopped'`,
				rr.replicaID)
		}
		return
	}

	if _, err := w.DB.Exec(ctx,
		`UPDATE deployment_replicas SET status = 'running' WHERE id = $1 AND status = 'stopped'`,
		rr.replicaID); err != nil {
		logger.Error("health: post-restart update",
			"deployment", rr.name, "replica", rr.replicaIndex, "err", err)
		return
	}
	logger.Info("health: auto-restarted replica",
		"deployment", rr.name, "replica", rr.replicaIndex)
}

// classify maps Docker's container state strings to our deployments.status
// vocabulary. Returns "" when the row should stay unchanged.
//
//	docker          → ours
//	"" (gone)       → "stopped"
//	"exited"        → "stopped"
//	"dead"          → "failed"
//	"running"       → ""  (no change)
//	"created"       → ""  (about to start, give it time)
//	"restarting"    → ""  (transient — the daemon is recovering)
//	"paused"        → "stopped"
//	other           → ""  (be conservative)
func classify(dockerStatus string) string {
	switch dockerStatus {
	case "":
		return "stopped"
	case "exited":
		return "stopped"
	case "dead":
		return "failed"
	case "paused":
		return "stopped"
	}
	return ""
}

// LookupRow is a tiny helper for tests that want to read a deployment's
// current persisted status. Lives here (not in models) to avoid widening
// the public API for a single test affordance.
func LookupRow(ctx context.Context, db *pgxpool.Pool, id string) (string, error) {
	var status string
	err := db.QueryRow(ctx, `SELECT status FROM deployments WHERE id = $1`, id).Scan(&status)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", fmt.Errorf("deployment %s not found", id)
	}
	return status, err
}
