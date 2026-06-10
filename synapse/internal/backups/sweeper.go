// Package backups runs the periodic per-deployment backup sweeper
// (v1.26+): enqueue one daily backup for every deployment that opted in,
// prune complete backups beyond each deployment's retention (files
// included), and fail rows stuck in pending/running. Multi-node safe via
// LockBackupSweeper — one node per tick, followers skip.
package backups

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	synapsedb "github.com/Iann29/synapse/internal/db"
	"github.com/Iann29/synapse/internal/provisioner"
)

type Sweeper struct {
	DB *pgxpool.Pool
	// BackupDir is this process's mount of the synapse-backups volume —
	// retention pruning removes archives through it.
	BackupDir string
	// Interval between sweeps. The daily cadence doesn't need precision;
	// 10 minutes keeps "turned schedule on" latency reasonable.
	Interval time.Duration
	Logger   *slog.Logger
}

func (s *Sweeper) logger() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

// Run blocks until ctx is cancelled, sweeping every Interval under the
// fleet-wide advisory lock.
func (s *Sweeper) Run(ctx context.Context) {
	interval := s.Interval
	if interval <= 0 {
		interval = 10 * time.Minute
	}
	logger := s.logger()
	logger.Info("backup sweeper starting", "interval", interval)
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			logger.Info("backup sweeper stopping")
			return
		case <-t.C:
			acquired, err := synapsedb.WithTryAdvisoryLock(ctx, s.DB, synapsedb.LockBackupSweeper,
				func(ctx context.Context) error {
					s.Tick(ctx)
					return nil
				})
			if err != nil {
				logger.Warn("backup sweeper: advisory-lock acquire failed", "err", err)
			} else if !acquired {
				logger.Debug("backup sweeper: another node holds the lock; skipping tick")
			}
		}
	}
}

// Tick runs one sweep pass. Exported so tests can drive it directly
// without timers or the advisory lock. Errors are logged, never returned
// — one bad deployment must not starve the others.
func (s *Sweeper) Tick(ctx context.Context) {
	s.failStale(ctx)
	s.enqueueScheduled(ctx)
	s.pruneRetention(ctx)
}

// failStale flips rows stuck in pending/running for over an hour — a
// crashed worker or a wedged npx container. The job-side recovery
// (requeueStale) handles the queue; this keeps the operator-facing row
// honest.
func (s *Sweeper) failStale(ctx context.Context) {
	tag, err := s.DB.Exec(ctx, `
		UPDATE deployment_backups
		   SET status = 'failed', error = 'timed out', completed_at = now()
		 WHERE status IN ('pending','running')
		   AND created_at < now() - interval '1 hour'
	`)
	if err != nil {
		s.logger().Warn("backup sweeper: fail stale", "err", err)
		return
	}
	if tag.RowsAffected() > 0 {
		s.logger().Info("backup sweeper: timed out stale backups", "count", tag.RowsAffected())
	}
}

// enqueueScheduled mints one backup per UTC day for every schedule='daily'
// deployment that is eligible (running, managed, local host) and quiet:
// nothing in flight, no complete backup in the last 24h, and no failed
// attempt in the last hour (retry backoff so a broken deployment doesn't
// burn a CLI container every tick).
func (s *Sweeper) enqueueScheduled(ctx context.Context) {
	rows, err := s.DB.Query(ctx, `
		SELECT d.id
		  FROM deployments d
		  LEFT JOIN hosts h ON h.id = d.host_id
		 WHERE d.backup_schedule = 'daily'
		   AND d.status = 'running'
		   AND d.adopted = false
		   AND COALESCE(h.is_remote, false) = false
		   AND NOT EXISTS (
		         SELECT 1 FROM deployment_backups b
		          WHERE b.deployment_id = d.id
		            AND (b.status IN ('pending','running')
		                 OR (b.status = 'complete' AND b.created_at > now() - interval '24 hours')
		                 OR (b.status = 'failed'   AND b.created_at > now() - interval '1 hour')))
	`)
	if err != nil {
		s.logger().Warn("backup sweeper: list scheduled", "err", err)
		return
	}
	var due []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			s.logger().Warn("backup sweeper: scan scheduled", "err", err)
			return
		}
		due = append(due, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		s.logger().Warn("backup sweeper: scheduled rows", "err", err)
		return
	}

	for _, deploymentID := range due {
		if err := s.enqueueOne(ctx, deploymentID); err != nil {
			s.logger().Warn("backup sweeper: enqueue", "deployment_id", deploymentID, "err", err)
			continue
		}
		s.logger().Info("backup sweeper: scheduled backup enqueued", "deployment_id", deploymentID)
	}
}

func (s *Sweeper) enqueueOne(ctx context.Context, deploymentID string) error {
	tx, err := s.DB.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var backupID string
	// requested_by NULL = the scheduler, distinguishable in the panel.
	if err := tx.QueryRow(ctx, `
		INSERT INTO deployment_backups (deployment_id)
		VALUES ($1)
		RETURNING id
	`, deploymentID).Scan(&backupID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`UPDATE deployment_backups SET file_path = $1 WHERE id = $2`,
		deploymentID+"/"+backupID+".zip", backupID); err != nil {
		return err
	}
	if err := provisioner.EnqueueBackup(ctx, tx, deploymentID, backupID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// pruneRetention deletes complete backups beyond each deployment's
// backup_retention, newest kept first. The archive goes before the row —
// a re-run can re-delete a missing file, but a row deleted first would
// orphan its archive forever.
func (s *Sweeper) pruneRetention(ctx context.Context) {
	rows, err := s.DB.Query(ctx, `
		SELECT id, file_path FROM (
			SELECT b.id, b.file_path, d.backup_retention,
			       row_number() OVER (PARTITION BY b.deployment_id ORDER BY b.created_at DESC) AS rn
			  FROM deployment_backups b
			  JOIN deployments d ON d.id = b.deployment_id
			 WHERE b.status = 'complete'
		) ranked
		 WHERE rn > backup_retention
	`)
	if err != nil {
		s.logger().Warn("backup sweeper: list prunable", "err", err)
		return
	}
	type victim struct{ id, filePath string }
	var victims []victim
	for rows.Next() {
		var v victim
		if err := rows.Scan(&v.id, &v.filePath); err != nil {
			rows.Close()
			s.logger().Warn("backup sweeper: scan prunable", "err", err)
			return
		}
		victims = append(victims, v)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		s.logger().Warn("backup sweeper: prunable rows", "err", err)
		return
	}

	for _, v := range victims {
		if v.filePath != "" && s.BackupDir != "" {
			if err := os.Remove(filepath.Join(s.BackupDir, v.filePath)); err != nil && !os.IsNotExist(err) {
				s.logger().Warn("backup sweeper: remove archive", "backup_id", v.id, "err", err)
				continue // keep the row so the next tick retries the file
			}
		}
		if _, err := s.DB.Exec(ctx, `DELETE FROM deployment_backups WHERE id = $1`, v.id); err != nil {
			s.logger().Warn("backup sweeper: delete row", "backup_id", v.id, "err", err)
			continue
		}
	}
	if len(victims) > 0 {
		s.logger().Info("backup sweeper: retention pruned", "count", len(victims))
	}
}
