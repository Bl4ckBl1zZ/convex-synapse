package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/audit"
	"github.com/Iann29/synapse/internal/auth"
	"github.com/Iann29/synapse/internal/email"
)

// EmailSettingsHandler exposes the instance transactional-email settings
// (Resend) under /v1/admin/email_settings, so an operator can configure the
// API key from the dashboard instead of editing .env on the host. The key
// is stored ENCRYPTED via the same SecretBox (SYNAPSE_STORAGE_KEY) that
// dns_credentials uses; the plaintext key never leaves the server — GET
// returns only metadata (configured + From address + source).
//
// Singleton: email config is instance-wide (one email_settings row). When
// the row is absent the .env fallback (EnvFallback, from SYNAPSE_RESEND_API_KEY
// + SYNAPSE_EMAIL_FROM) applies; when present it wins. See resolveEmailSender.
//
// Auth: mounted under /v1/admin → requireInstanceAdmin.
type EmailSettingsHandler struct {
	DB     *pgxpool.Pool
	Crypto SecretEnvelope
	// EnvFallback is the .env-configured Sender (TeamsHandler.Email shares
	// the same instance). Used to report "configured via .env" in GET when
	// no DB row exists. nil/disabled = .env email off.
	EnvFallback email.Sender
}

func (h *EmailSettingsHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.get)
	r.Post("/", h.set)
	r.Delete("/", h.clear)
	return r
}

// emailSettingsResp is the GET/POST shape — metadata only, never the key.
// Source distinguishes a dashboard-set key ("db") from the .env fallback
// ("env") from nothing ("none") so the dashboard renders the right state.
type emailSettingsResp struct {
	Configured  bool       `json:"configured"`
	Source      string     `json:"source"` // "db" | "env" | "none"
	Provider    string     `json:"provider"`
	FromAddress string     `json:"fromAddress"`
	UpdatedAt   *time.Time `json:"updatedAt"`
}

// status reads the current settings (DB row, else .env fallback) into the
// response shape. Shared by get/set/clear so the three always agree.
func (h *EmailSettingsHandler) status(ctx context.Context) (emailSettingsResp, error) {
	var (
		from      string
		updatedAt time.Time
	)
	err := h.DB.QueryRow(ctx,
		`SELECT from_address, updated_at FROM email_settings WHERE id = true`,
	).Scan(&from, &updatedAt)
	if err == nil {
		return emailSettingsResp{
			Configured: true, Source: "db", Provider: "resend",
			FromAddress: from, UpdatedAt: &updatedAt,
		}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return emailSettingsResp{}, err
	}
	// No DB row → report the .env fallback.
	if h.EnvFallback != nil && h.EnvFallback.Enabled() {
		return emailSettingsResp{Configured: true, Source: "env", Provider: "resend"}, nil
	}
	return emailSettingsResp{Configured: false, Source: "none", Provider: "resend"}, nil
}

func (h *EmailSettingsHandler) get(w http.ResponseWriter, r *http.Request) {
	resp, err := h.status(r.Context())
	if err != nil {
		logErr("email_settings get", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to read email settings")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

type setEmailSettingsReq struct {
	APIKey      string `json:"apiKey"`
	FromAddress string `json:"fromAddress"`
}

func (h *EmailSettingsHandler) set(w http.ResponseWriter, r *http.Request) {
	if h.Crypto == nil {
		// Without a SecretBox we won't persist the key in plaintext.
		writeError(w, http.StatusServiceUnavailable, "crypto_not_configured",
			"Email settings require SYNAPSE_STORAGE_KEY to be set on the Synapse host")
		return
	}
	var req setEmailSettingsReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	apiKey := strings.TrimSpace(req.APIKey)
	from := strings.TrimSpace(req.FromAddress)
	if apiKey == "" {
		writeError(w, http.StatusBadRequest, "missing_api_key", "apiKey is required")
		return
	}
	if from == "" || !strings.Contains(from, "@") {
		writeError(w, http.StatusBadRequest, "invalid_from",
			"fromAddress must be a sender like \"Synapse <no-reply@you.com>\"")
		return
	}

	encrypted, err := h.Crypto.EncryptString(apiKey)
	if err != nil {
		logErr("encrypt resend key", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to encrypt key")
		return
	}

	uid, _ := auth.UserID(r.Context())
	var updatedBy any
	if uid != "" {
		updatedBy = uid
	}
	_, err = h.DB.Exec(r.Context(), `
		INSERT INTO email_settings (id, provider, api_key_encrypted, from_address, updated_by, updated_at)
		VALUES (true, 'resend', $1, $2, $3, now())
		ON CONFLICT (id) DO UPDATE
		   SET api_key_encrypted = EXCLUDED.api_key_encrypted,
		       from_address      = EXCLUDED.from_address,
		       updated_by        = EXCLUDED.updated_by,
		       updated_at        = now()
	`, encrypted, from, updatedBy)
	if err != nil {
		logErr("upsert email settings", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to save email settings")
		return
	}

	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    uid,
		Action:     audit.ActionUpdateEmailSettings,
		TargetType: audit.TargetEmailSettings,
		Metadata:   map[string]any{"provider": "resend", "fromAddress": from},
	})

	resp, err := h.status(r.Context())
	if err != nil {
		logErr("email_settings status after set", err)
		writeError(w, http.StatusInternalServerError, "internal", "Saved but failed to re-read")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

func (h *EmailSettingsHandler) clear(w http.ResponseWriter, r *http.Request) {
	if _, err := h.DB.Exec(r.Context(), `DELETE FROM email_settings WHERE id = true`); err != nil {
		logErr("clear email settings", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to clear email settings")
		return
	}
	uid, _ := auth.UserID(r.Context())
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    uid,
		Action:     audit.ActionClearEmailSettings,
		TargetType: audit.TargetEmailSettings,
		Metadata:   map[string]any{"provider": "resend"},
	})
	// Report the post-clear state (reverts to .env fallback, or none).
	resp, err := h.status(r.Context())
	if err != nil {
		logErr("email_settings status after clear", err)
		writeError(w, http.StatusInternalServerError, "internal", "Cleared but failed to re-read")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// resolveEmailSender returns the active Sender: the DB-configured Resend
// settings if present (decrypted), else the .env fallback. Read at
// send-time so a dashboard change takes effect without a restart. Any
// failure (no crypto, no row, decrypt error) degrades to the fallback —
// invites are best-effort, never blocked by an email-config hiccup.
func resolveEmailSender(ctx context.Context, db *pgxpool.Pool, crypto SecretEnvelope, fallback email.Sender) email.Sender {
	if crypto == nil {
		return fallback
	}
	var (
		keyEnc []byte
		from   string
	)
	err := db.QueryRow(ctx,
		`SELECT api_key_encrypted, from_address FROM email_settings WHERE id = true`,
	).Scan(&keyEnc, &from)
	if err != nil {
		return fallback // no row (or transient error) → .env fallback
	}
	key, derr := crypto.DecryptString(keyEnc)
	if derr != nil {
		logErr("decrypt resend key", derr)
		return fallback
	}
	return email.New(key, from)
}
