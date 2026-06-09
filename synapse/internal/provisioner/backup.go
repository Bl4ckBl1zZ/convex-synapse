package provisioner

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	dockerprov "github.com/Iann29/synapse/internal/docker"
)

// BackupRunner is the snapshot export/import seam (v1.25+ per-deployment
// backups). *dockerprov.Client implements it with transient CLI
// containers; the test harness injects a fake.
type BackupRunner interface {
	ExportBackup(ctx context.Context, spec dockerprov.BackupExportSpec) error
	ImportBackup(ctx context.Context, spec dockerprov.BackupImportSpec) error
}

// runBackup executes one kind='backup' job: export a snapshot from the
// deployment's backend onto the backups volume and flip the
// deployment_backups row to complete (with the archive size) or failed.
// Backup failures NEVER touch deployments.status — markJobFailed only.
func (w *Worker) runBackup(ctx context.Context, logger *slog.Logger, j claimedJob) {
	failBackup := func(msg string) {
		if _, err := w.DB.Exec(context.Background(), `
			UPDATE deployment_backups
			   SET status = 'failed', error = $1, completed_at = now()
			 WHERE id = $2
		`, truncateErr(msg), j.BackupID); err != nil {
			logger.Error("backup: mark failed", "backup_id", j.BackupID, "err", err)
		}
		w.markJobFailed(j.JobID, msg)
	}

	if j.BackupID == "" {
		w.markJobFailed(j.JobID, "backup job without backup_id")
		return
	}
	if w.Backups == nil {
		failBackup("backups are not configured on this node (no Docker runner)")
		return
	}
	var relPath string
	if err := w.DB.QueryRow(ctx,
		`UPDATE deployment_backups SET status = 'running' WHERE id = $1 RETURNING file_path`,
		j.BackupID,
	).Scan(&relPath); err != nil {
		failBackup("load backup row: " + err.Error())
		return
	}

	sourceURL, err := w.backupEndpointURL(ctx, j)
	if err != nil {
		failBackup(err.Error())
		return
	}
	logger.Info("backup: exporting snapshot",
		"deployment", j.Name, "backup_id", j.BackupID, "source", sourceURL)
	if err := w.Backups.ExportBackup(ctx, dockerprov.BackupExportSpec{
		DeploymentName: j.Name,
		DeploymentID:   j.DeploymentID,
		ProjectID:      j.ProjectID,
		SourceURL:      sourceURL,
		AdminKey:       j.AdminKey,
		RelPath:        relPath,
	}); err != nil {
		failBackup(err.Error())
		return
	}

	// The archive must actually exist on our mount of the shared volume —
	// a "successful" export with no file is a failure, not a zero-byte
	// backup.
	info, err := os.Stat(filepath.Join(w.Config.BackupDir, relPath))
	if err != nil {
		failBackup("archive missing after export: " + err.Error())
		return
	}
	if _, err := w.DB.Exec(ctx, `
		UPDATE deployment_backups
		   SET status = 'complete', size_bytes = $1, completed_at = now(), error = ''
		 WHERE id = $2
	`, info.Size(), j.BackupID); err != nil {
		logger.Error("backup: mark complete", "backup_id", j.BackupID, "err", err)
		w.markJobFailed(j.JobID, "backup exported but row update failed: "+err.Error())
		return
	}
	logger.Info("backup: complete",
		"deployment", j.Name, "backup_id", j.BackupID, "size_bytes", info.Size())
	w.markDone(j.JobID)
}

// runRestore executes one kind='restore' job: feed the stored archive
// back into the deployment with `convex import --replace`. Success stamps
// deployment_backups.restored_at; failure marks only the JOB failed (the
// backup row stays complete — the archive is still good).
func (w *Worker) runRestore(ctx context.Context, logger *slog.Logger, j claimedJob) {
	if j.BackupID == "" {
		w.markJobFailed(j.JobID, "restore job without backup_id")
		return
	}
	if w.Backups == nil {
		w.markJobFailed(j.JobID, "backups are not configured on this node (no Docker runner)")
		return
	}
	var relPath, status string
	if err := w.DB.QueryRow(ctx,
		`SELECT file_path, status FROM deployment_backups WHERE id = $1`, j.BackupID,
	).Scan(&relPath, &status); err != nil {
		w.markJobFailed(j.JobID, "load backup row: "+err.Error())
		return
	}
	if status != "complete" {
		w.markJobFailed(j.JobID, "backup is not complete (status="+status+")")
		return
	}

	targets, err := w.restoreTargetURLs(ctx, j)
	if err != nil {
		w.markJobFailed(j.JobID, err.Error())
		return
	}
	logger.Info("backup: restoring snapshot",
		"deployment", j.Name, "backup_id", j.BackupID, "targets", len(targets))
	if err := w.Backups.ImportBackup(ctx, dockerprov.BackupImportSpec{
		DeploymentName: j.Name,
		DeploymentID:   j.DeploymentID,
		ProjectID:      j.ProjectID,
		TargetURLs:     targets,
		AdminKey:       j.AdminKey,
		RelPath:        relPath,
	}); err != nil {
		w.markJobFailed(j.JobID, err.Error())
		return
	}
	if _, err := w.DB.Exec(ctx,
		`UPDATE deployment_backups SET restored_at = now() WHERE id = $1`, j.BackupID); err != nil {
		logger.Error("backup: stamp restored_at", "backup_id", j.BackupID, "err", err)
	}
	logger.Info("backup: restore complete", "deployment", j.Name, "backup_id", j.BackupID)
	w.markDone(j.JobID)
}

// backupEndpointURL picks the in-network URL of a RUNNING replica to
// export from. Single-replica → the legacy convex-<name> container; HA →
// the lowest-index running replica (shared Postgres+S3 state, any live
// replica serves a consistent snapshot).
func (w *Worker) backupEndpointURL(ctx context.Context, j claimedJob) (string, error) {
	if !j.HAEnabled {
		return "http://" + dockerprov.ContainerName(j.Name, 0, false) + ":3210", nil
	}
	var idx int
	err := w.DB.QueryRow(ctx, `
		SELECT replica_index FROM deployment_replicas
		 WHERE deployment_id = $1 AND status = 'running'
		 ORDER BY replica_index ASC LIMIT 1
	`, j.DeploymentID).Scan(&idx)
	if err != nil {
		return "", fmt.Errorf("no running replica to export from: %w", err)
	}
	return "http://" + dockerprov.ContainerName(j.Name, idx, true) + ":3210", nil
}

// restoreTargetURLs lists the live endpoints an import may land on — the
// first one that accepts wins (mirrors MigrateSnapshot semantics).
func (w *Worker) restoreTargetURLs(ctx context.Context, j claimedJob) ([]string, error) {
	if !j.HAEnabled {
		return []string{"http://" + dockerprov.ContainerName(j.Name, 0, false) + ":3210"}, nil
	}
	rows, err := w.DB.Query(ctx, `
		SELECT replica_index FROM deployment_replicas
		 WHERE deployment_id = $1 AND status = 'running'
		 ORDER BY replica_index ASC
	`, j.DeploymentID)
	if err != nil {
		return nil, fmt.Errorf("list running replicas: %w", err)
	}
	defer rows.Close()
	var targets []string
	for rows.Next() {
		var idx int
		if err := rows.Scan(&idx); err != nil {
			return nil, err
		}
		targets = append(targets, "http://"+dockerprov.ContainerName(j.Name, idx, true)+":3210")
	}
	if len(targets) == 0 {
		return nil, fmt.Errorf("no running replica to restore into")
	}
	return targets, rows.Err()
}

// truncateErr bounds operator-visible error text stored on the row and
// strips anything Postgres TEXT can't hold (NUL bytes, invalid UTF-8) —
// container output is not guaranteed clean even after demuxing.
func truncateErr(s string) string {
	s = strings.ToValidUTF8(strings.ReplaceAll(s, "\x00", ""), "")
	if len(s) > 2000 {
		return s[:2000]
	}
	return s
}
