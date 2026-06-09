package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/audit"
	"github.com/Iann29/synapse/internal/auth"
)

// ApplySettingsHandler exposes the instance Cell-Control-Plane APPLY toggle
// under /v1/admin/apply_settings, so an instance admin can enable/disable
// reconcile apply from the dashboard instead of editing .env + restarting.
//
// Singleton: apply config is instance-wide (one apply_settings row). When the
// row is absent the .env fallback (EnvEnabled / EnvDangerous, from
// SYNAPSE_APPLY_ENABLED / SYNAPSE_APPLY_DANGEROUS) applies; when present it
// wins. See resolveApplySettings — read per-request so a toggle takes effect
// without a restart. Mirrors EmailSettingsHandler.
//
// Auth: mounted under /v1/admin → requireInstanceAdmin.
type ApplySettingsHandler struct {
	DB *pgxpool.Pool
	// EnvEnabled / EnvDangerous are the .env-configured defaults (the values
	// DriftHandler also holds). Used as the fallback when no DB row exists.
	EnvEnabled   bool
	EnvDangerous bool
}

func (h *ApplySettingsHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.get)
	r.Post("/", h.set)
	return r
}

// applySettingsResp is the GET/POST shape. Source distinguishes a dashboard
// value ("db") from the .env fallback ("env") so the dashboard renders the
// right state (e.g. "managed via .env" when source=env).
type applySettingsResp struct {
	Enabled   bool       `json:"enabled"`
	Dangerous bool       `json:"dangerous"`
	Source    string     `json:"source"` // "db" | "env"
	UpdatedAt *time.Time `json:"updatedAt"`
}

func (h *ApplySettingsHandler) status(ctx context.Context) (applySettingsResp, error) {
	var (
		enabled   bool
		dangerous bool
		updatedAt time.Time
	)
	err := h.DB.QueryRow(ctx,
		`SELECT apply_enabled, apply_dangerous, updated_at FROM apply_settings WHERE id = true`,
	).Scan(&enabled, &dangerous, &updatedAt)
	if err == nil {
		return applySettingsResp{
			Enabled: enabled, Dangerous: dangerous, Source: "db", UpdatedAt: &updatedAt,
		}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return applySettingsResp{}, err
	}
	// No DB row → report the .env fallback.
	return applySettingsResp{Enabled: h.EnvEnabled, Dangerous: h.EnvDangerous, Source: "env"}, nil
}

func (h *ApplySettingsHandler) get(w http.ResponseWriter, r *http.Request) {
	resp, err := h.status(r.Context())
	if err != nil {
		logErr("apply_settings get", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to read apply settings")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

type setApplySettingsReq struct {
	Enabled   bool `json:"enabled"`
	Dangerous bool `json:"dangerous"`
}

func (h *ApplySettingsHandler) set(w http.ResponseWriter, r *http.Request) {
	var req setApplySettingsReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	uid, _ := auth.UserID(r.Context())
	var updatedBy any
	if uid != "" {
		updatedBy = uid
	}
	if _, err := h.DB.Exec(r.Context(), `
		INSERT INTO apply_settings (id, apply_enabled, apply_dangerous, updated_by, updated_at)
		VALUES (true, $1, $2, $3, now())
		ON CONFLICT (id) DO UPDATE
		   SET apply_enabled   = EXCLUDED.apply_enabled,
		       apply_dangerous = EXCLUDED.apply_dangerous,
		       updated_by      = EXCLUDED.updated_by,
		       updated_at      = now()
	`, req.Enabled, req.Dangerous, updatedBy); err != nil {
		logErr("upsert apply settings", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to save apply settings")
		return
	}

	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    uid,
		Action:     audit.ActionUpdateApplySettings,
		TargetType: audit.TargetApplySettings,
		Metadata:   map[string]any{"applyEnabled": req.Enabled, "applyDangerous": req.Dangerous},
	})

	resp, err := h.status(r.Context())
	if err != nil {
		logErr("apply_settings status after set", err)
		writeError(w, http.StatusInternalServerError, "internal", "Saved but failed to re-read")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// resolveApplySettings returns the effective apply enable/dangerous flags: the
// dashboard-set DB row if present, else the .env defaults. Read at gate-time
// (dry-run + apply) so a dashboard toggle takes effect without a restart.
//
// Error handling is deliberately asymmetric and fail-closed:
//   - no row yet (pgx.ErrNoRows) → legitimately fall back to the .env default;
//     a fresh install simply hasn't been toggled.
//   - any OTHER error (transient DB hiccup, pool exhausted) → return
//     (false, false). It must NOT fall back to the env default here: if the
//     operator provisioned with SYNAPSE_APPLY_ENABLED=true and then turned
//     apply OFF in the dashboard (DB row = false), an env-fallback on a read
//     error would silently RE-ENABLE apply — exactly the flip this gate is
//     meant to prevent. A read we can't trust means "don't mutate".
func resolveApplySettings(ctx context.Context, db *pgxpool.Pool, envEnabled, envDangerous bool) (enabled, dangerous bool) {
	var e, d bool
	err := db.QueryRow(ctx,
		`SELECT apply_enabled, apply_dangerous FROM apply_settings WHERE id = true`,
	).Scan(&e, &d)
	if err == nil {
		return e, d
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return envEnabled, envDangerous // no row → .env default
	}
	return false, false // transient error → fail closed, never re-enable on a hiccup
}
