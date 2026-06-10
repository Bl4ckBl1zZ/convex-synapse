package api

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"

	"github.com/Iann29/synapse/internal/audit"
	"github.com/Iann29/synapse/internal/auth"
	"github.com/Iann29/synapse/internal/models"
	"github.com/Iann29/synapse/internal/provisioner"
)

// Per-deployment snapshot backups (v1.26+, migration 000035) — the
// self-hosted answer to Cloud's Backups page. A backup is a real
// `npx convex export` zip landed on the synapse-backups volume; restore
// feeds it back with `convex import --replace`. Export/restore run on the
// provisioning_jobs queue (kind='backup'/'restore'); these handlers only
// gate, persist intent, and stream downloads.
//
// v1 limitations, each with a stable code: adopted deployments (Synapse
// has no admin path to an external backend's snapshot dance we'd trust),
// remote hosts (the transient CLI container runs on the LOCAL daemon and
// can't resolve a remote deployment's container DNS).

// backupsConfigured gates the whole surface on a usable BackupDir.
func (h *DeploymentsHandler) backupsConfigured(w http.ResponseWriter) bool {
	if h.BackupDir == "" {
		writeError(w, http.StatusServiceUnavailable, "backups_not_configured",
			"Backups need the synapse-backups volume mounted (SYNAPSE_BACKUP_DIR)")
		return false
	}
	return true
}

// loadBackupForRequest resolves {backupID} under an already-authorized
// deployment. 404s wrong/foreign ids — the WHERE pins deployment_id so a
// backup can't be addressed through another deployment's URL.
func (h *DeploymentsHandler) loadBackupForRequest(w http.ResponseWriter, r *http.Request, deploymentID string) (*models.DeploymentBackup, string, bool) {
	backupID := chi.URLParam(r, "backupID")
	var b models.DeploymentBackup
	var filePath string
	var requestedBy *string
	err := h.DB.QueryRow(r.Context(), `
		SELECT id, deployment_id, status, file_path, size_bytes, error,
		       requested_by, created_at, completed_at, restored_at
		  FROM deployment_backups
		 WHERE id::text = $1 AND deployment_id = $2
	`, backupID, deploymentID).Scan(
		&b.ID, &b.DeploymentID, &b.Status, &filePath, &b.SizeBytes, &b.Error,
		&requestedBy, &b.CreatedAt, &b.CompletedAt, &b.RestoredAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusNotFound, "backup_not_found", "No such backup for this deployment")
		return nil, "", false
	}
	if err != nil {
		logErr("load backup", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to load backup")
		return nil, "", false
	}
	if requestedBy != nil {
		b.RequestedBy = *requestedBy
	}
	return &b, filePath, true
}

// ---------- GET /v1/deployments/{name}/backups ----------

func (h *DeploymentsHandler) listBackups(w http.ResponseWriter, r *http.Request) {
	d, _, _, _, ok := h.loadDeploymentForRequest(w, r)
	if !ok {
		return
	}
	rows, err := h.DB.Query(r.Context(), `
		SELECT id, deployment_id, status, size_bytes, error,
		       requested_by, created_at, completed_at, restored_at
		  FROM deployment_backups
		 WHERE deployment_id = $1
		 ORDER BY created_at DESC
		 LIMIT 100
	`, d.ID)
	if err != nil {
		logErr("list backups", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to list backups")
		return
	}
	defer rows.Close()
	out := make([]models.DeploymentBackup, 0, 8)
	for rows.Next() {
		var b models.DeploymentBackup
		var requestedBy *string
		if err := rows.Scan(&b.ID, &b.DeploymentID, &b.Status, &b.SizeBytes, &b.Error,
			&requestedBy, &b.CreatedAt, &b.CompletedAt, &b.RestoredAt); err != nil {
			logErr("scan backup", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to scan backups")
			return
		}
		if requestedBy != nil {
			b.RequestedBy = *requestedBy
		}
		out = append(out, b)
	}
	if err := rows.Err(); err != nil {
		logErr("list backups rows", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to list backups")
		return
	}
	writeJSON(w, http.StatusOK, out)
}

// ---------- POST /v1/deployments/{name}/backups ----------

func (h *DeploymentsHandler) createBackup(w http.ResponseWriter, r *http.Request) {
	d, _, t, role, ok := h.loadDeploymentForRequest(w, r)
	if !ok {
		return
	}
	if !canEditProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "You do not have permission to back up this deployment")
		return
	}
	if !h.backupsConfigured(w) {
		return
	}
	if code, msg := backupEligibility(d); code != "" {
		writeError(w, http.StatusConflict, code, msg)
		return
	}

	uid, _ := auth.UserID(r.Context())
	var requestedBy any
	if uid != "" {
		requestedBy = uid
	}
	var b models.DeploymentBackup
	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		logErr("begin create backup", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to request backup")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// One in-flight backup per deployment: exports hammer the backend,
	// and a pile-up of npx containers helps nobody.
	var inflight bool
	if err := tx.QueryRow(r.Context(), `
		SELECT EXISTS(SELECT 1 FROM deployment_backups
		               WHERE deployment_id = $1 AND status IN ('pending','running'))
	`, d.ID).Scan(&inflight); err != nil {
		logErr("check inflight backup", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to request backup")
		return
	}
	if inflight {
		writeError(w, http.StatusConflict, "backup_in_progress",
			"A backup for this deployment is already in progress")
		return
	}

	if err := tx.QueryRow(r.Context(), `
		INSERT INTO deployment_backups (deployment_id, requested_by)
		VALUES ($1, $2)
		RETURNING id, created_at
	`, d.ID, requestedBy).Scan(&b.ID, &b.CreatedAt); err != nil {
		logErr("insert backup", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to request backup")
		return
	}
	// file_path is server-derived from the two UUIDs — never user input.
	if _, err := tx.Exec(r.Context(),
		`UPDATE deployment_backups SET file_path = $1 WHERE id = $2`,
		d.ID+"/"+b.ID+".zip", b.ID); err != nil {
		logErr("set backup path", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to request backup")
		return
	}
	if err := provisioner.EnqueueBackup(r.Context(), tx, d.ID, b.ID); err != nil {
		logErr("enqueue backup", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to request backup")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		logErr("commit create backup", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to request backup")
		return
	}

	b.DeploymentID = d.ID
	b.Status = "pending"
	b.RequestedBy = uid
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		TeamID:     t.ID,
		ActorID:    uid,
		Action:     audit.ActionRequestBackup,
		TargetType: audit.TargetDeployment,
		TargetID:   d.ID,
		Metadata:   map[string]any{"name": d.Name, "backupId": b.ID},
	})
	writeJSON(w, http.StatusAccepted, b)
}

// backupEligibility returns a (code, message) refusal, or "" when the
// deployment can be backed up / restored. Shared by create + restore so
// the two gates can't drift.
func backupEligibility(d *models.Deployment) (string, string) {
	switch {
	case d.Adopted:
		return "cannot_backup_adopted",
			"Adopted (external) deployments aren't managed by Synapse — run `npx convex export` against it directly"
	case d.HostIsRemote:
		return "remote_backup_not_supported",
			"Backups for deployments on remote hosts aren't supported yet"
	case d.Status != models.DeploymentStatusRunning:
		return "deployment_not_running",
			"The deployment must be running (the snapshot is exported from the live backend)"
	}
	return "", ""
}

// ---------- GET /v1/deployments/{name}/backups/{backupID}/download ----------

func (h *DeploymentsHandler) downloadBackup(w http.ResponseWriter, r *http.Request) {
	d, _, _, role, ok := h.loadDeploymentForRequest(w, r)
	if !ok {
		return
	}
	// A snapshot archive is the whole database — same trust level as the
	// admin key, which members already get via /cli_credentials.
	if !canEditProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "You do not have permission to download backups")
		return
	}
	if !h.backupsConfigured(w) {
		return
	}
	b, filePath, ok := h.loadBackupForRequest(w, r, d.ID)
	if !ok {
		return
	}
	if b.Status != "complete" || filePath == "" {
		writeError(w, http.StatusConflict, "backup_not_complete", "This backup has no downloadable archive (status="+b.Status+")")
		return
	}
	f, err := os.Open(filepath.Join(h.BackupDir, filePath))
	if err != nil {
		logErr("open backup archive", err)
		writeError(w, http.StatusNotFound, "archive_missing",
			"The archive is gone from the backups volume (pruned or volume replaced)")
		return
	}
	defer f.Close()
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Content-Disposition",
		fmt.Sprintf("attachment; filename=%q", d.Name+"-"+b.CreatedAt.UTC().Format("20060102-150405")+".zip"))
	if info, err := f.Stat(); err == nil {
		w.Header().Set("Content-Length", fmt.Sprintf("%d", info.Size()))
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, f)
}

// ---------- POST /v1/deployments/{name}/backups/{backupID}/restore ----------

func (h *DeploymentsHandler) restoreBackup(w http.ResponseWriter, r *http.Request) {
	d, _, t, role, ok := h.loadDeploymentForRequest(w, r)
	if !ok {
		return
	}
	// Destructive: `convex import --replace` wipes the deployment's
	// current data. Admin-grade, like delete.
	if !canAdminProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "Only project admins can restore a backup")
		return
	}
	if !h.backupsConfigured(w) {
		return
	}
	if code, msg := backupEligibility(d); code != "" {
		writeError(w, http.StatusConflict, code, msg)
		return
	}
	b, _, ok := h.loadBackupForRequest(w, r, d.ID)
	if !ok {
		return
	}
	if b.Status != "complete" {
		writeError(w, http.StatusConflict, "backup_not_complete", "Only complete backups can be restored (status="+b.Status+")")
		return
	}
	if err := provisioner.EnqueueRestore(r.Context(), h.DB, d.ID, b.ID); err != nil {
		logErr("enqueue restore", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to request restore")
		return
	}
	uid, _ := auth.UserID(r.Context())
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		TeamID:     t.ID,
		ActorID:    uid,
		Action:     audit.ActionRestoreBackup,
		TargetType: audit.TargetDeployment,
		TargetID:   d.ID,
		Metadata:   map[string]any{"name": d.Name, "backupId": b.ID},
	})
	writeJSON(w, http.StatusAccepted, map[string]any{"ok": true, "backupId": b.ID})
}

// ---------- POST /v1/deployments/{name}/backups/{backupID}/delete ----------

func (h *DeploymentsHandler) deleteBackup(w http.ResponseWriter, r *http.Request) {
	d, _, t, role, ok := h.loadDeploymentForRequest(w, r)
	if !ok {
		return
	}
	if !canAdminProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "Only project admins can delete a backup")
		return
	}
	if !h.backupsConfigured(w) {
		return
	}
	b, filePath, ok := h.loadBackupForRequest(w, r, d.ID)
	if !ok {
		return
	}
	if b.Status == "pending" || b.Status == "running" {
		writeError(w, http.StatusConflict, "backup_in_progress",
			"Wait for the backup to finish (or fail) before deleting it")
		return
	}
	// Archive first, row second — a re-run can re-delete a file that's
	// already gone, but a row deleted before its file would orphan the
	// archive forever (nothing references it anymore).
	if filePath != "" {
		if err := os.Remove(filepath.Join(h.BackupDir, filePath)); err != nil && !os.IsNotExist(err) {
			logErr("remove backup archive", err)
			writeError(w, http.StatusInternalServerError, "internal", "Failed to remove the archive")
			return
		}
	}
	if _, err := h.DB.Exec(r.Context(),
		`DELETE FROM deployment_backups WHERE id = $1`, b.ID); err != nil {
		logErr("delete backup row", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to delete backup")
		return
	}
	uid, _ := auth.UserID(r.Context())
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		TeamID:     t.ID,
		ActorID:    uid,
		Action:     audit.ActionDeleteBackup,
		TargetType: audit.TargetDeployment,
		TargetID:   d.ID,
		Metadata:   map[string]any{"name": d.Name, "backupId": b.ID},
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// ---------- POST /v1/deployments/{name}/backup_settings ----------

type backupSettingsReq struct {
	Schedule  string `json:"schedule"`  // "none" | "daily"
	Retention int    `json:"retention"` // 1..90 complete backups kept
}

func (h *DeploymentsHandler) updateBackupSettings(w http.ResponseWriter, r *http.Request) {
	d, _, t, role, ok := h.loadDeploymentForRequest(w, r)
	if !ok {
		return
	}
	if !canAdminProject(role) {
		writeError(w, http.StatusForbidden, "forbidden", "Only project admins can change backup settings")
		return
	}
	var req backupSettingsReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	if req.Schedule != "none" && req.Schedule != "daily" {
		writeError(w, http.StatusBadRequest, "invalid_schedule", `schedule must be "none" or "daily"`)
		return
	}
	if req.Retention < 1 || req.Retention > 90 {
		writeError(w, http.StatusBadRequest, "invalid_retention", "retention must be between 1 and 90")
		return
	}
	if req.Schedule == "daily" {
		if code, msg := backupEligibility(d); code != "" {
			writeError(w, http.StatusConflict, code, msg)
			return
		}
	}
	if _, err := h.DB.Exec(r.Context(), `
		UPDATE deployments SET backup_schedule = $1, backup_retention = $2 WHERE id = $3
	`, req.Schedule, req.Retention, d.ID); err != nil {
		logErr("update backup settings", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to save backup settings")
		return
	}
	uid, _ := auth.UserID(r.Context())
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		TeamID:     t.ID,
		ActorID:    uid,
		Action:     audit.ActionUpdateBackupSettings,
		TargetType: audit.TargetDeployment,
		TargetID:   d.ID,
		Metadata:   map[string]any{"name": d.Name, "schedule": req.Schedule, "retention": req.Retention},
	})
	writeJSON(w, http.StatusOK, map[string]any{
		"backupSchedule":  req.Schedule,
		"backupRetention": req.Retention,
	})
}

