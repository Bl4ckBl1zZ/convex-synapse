package api

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/audit"
	"github.com/Iann29/synapse/internal/auth"
)

// AlertSettingsHandler exposes the instance deployment-down alert settings
// under /v1/admin/alert_settings, so an operator can configure the channels
// from the dashboard instead of editing .env on the host. Two channels:
// email to team admins (riding the email_settings/Resend config — nothing
// alert-specific to store) and a generic webhook (Slack / Discord / custom).
//
// Singleton + precedence mirror email_settings: when the alert_settings row
// is absent the defaults apply (email on, webhook from
// SYNAPSE_ALERT_WEBHOOK_URL); when present it wins ENTIRELY — including an
// empty webhook_url silencing the .env fallback. The health worker's
// Notifier re-reads the row at send time, so changes apply without restart.
//
// The webhook URL is stored in plaintext (the operator's own DB; alerting
// must work without SYNAPSE_STORAGE_KEY) but responses only ever carry a
// masked hint — Slack/Discord hook paths embed a secret.
//
// Auth: mounted under /v1/admin → requireInstanceAdmin.
type AlertSettingsHandler struct {
	DB *pgxpool.Pool
	// EnvWebhookURL is the .env fallback (SYNAPSE_ALERT_WEBHOOK_URL),
	// reported as source="env" in GET when no DB row exists.
	EnvWebhookURL string
}

func (h *AlertSettingsHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Get("/", h.get)
	r.Post("/", h.set)
	r.Delete("/", h.clear)
	return r
}

// alertSettingsResp is the GET/POST/DELETE shape — never the webhook URL,
// only a masked hint. Source distinguishes a dashboard-saved row ("db")
// from the .env fallback ("env") from the built-in defaults ("default").
type alertSettingsResp struct {
	Source            string     `json:"source"` // "db" | "env" | "default"
	EmailEnabled      bool       `json:"emailEnabled"`
	WebhookConfigured bool       `json:"webhookConfigured"`
	WebhookHint       string     `json:"webhookHint"`
	UpdatedAt         *time.Time `json:"updatedAt"`
}

// webhookHint masks a webhook URL down to scheme+host — enough for the
// operator to recognize the receiver, never enough to post to it.
func webhookHint(raw string) string {
	if raw == "" {
		return ""
	}
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return "(configured)"
	}
	return u.Scheme + "://" + u.Host + "/…"
}

// status reads the current settings (DB row, else .env fallback, else
// defaults) into the response shape. Shared by get/set/clear so the three
// always agree.
func (h *AlertSettingsHandler) status(ctx context.Context) (alertSettingsResp, error) {
	var (
		emailEnabled bool
		webhookURL   string
		updatedAt    time.Time
	)
	err := h.DB.QueryRow(ctx,
		`SELECT email_enabled, webhook_url, updated_at FROM alert_settings WHERE id = true`,
	).Scan(&emailEnabled, &webhookURL, &updatedAt)
	if err == nil {
		return alertSettingsResp{
			Source:            "db",
			EmailEnabled:      emailEnabled,
			WebhookConfigured: webhookURL != "",
			WebhookHint:       webhookHint(webhookURL),
			UpdatedAt:         &updatedAt,
		}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return alertSettingsResp{}, err
	}
	// No DB row → defaults, with the .env webhook fallback if set.
	if h.EnvWebhookURL != "" {
		return alertSettingsResp{
			Source:            "env",
			EmailEnabled:      true,
			WebhookConfigured: true,
			WebhookHint:       webhookHint(h.EnvWebhookURL),
		}, nil
	}
	return alertSettingsResp{Source: "default", EmailEnabled: true}, nil
}

func (h *AlertSettingsHandler) get(w http.ResponseWriter, r *http.Request) {
	resp, err := h.status(r.Context())
	if err != nil {
		logErr("alert_settings get", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to read alert settings")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

type setAlertSettingsReq struct {
	EmailEnabled bool `json:"emailEnabled"`
	// WebhookURL is a pointer on purpose: GET never returns the full URL,
	// so the dashboard can't resend it on an email-only toggle. Absent
	// (nil) = keep the saved webhook; "" = clear it; non-empty = replace.
	WebhookURL *string `json:"webhookUrl"`
}

func (h *AlertSettingsHandler) set(w http.ResponseWriter, r *http.Request) {
	var req setAlertSettingsReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	var webhook *string
	if req.WebhookURL != nil {
		trimmed := strings.TrimSpace(*req.WebhookURL)
		// Empty webhook is valid (email-only alerting). Non-empty must be
		// an absolute http(s) URL so the Notifier's POST can't silently
		// no-op.
		if trimmed != "" {
			u, err := url.Parse(trimmed)
			if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
				writeError(w, http.StatusBadRequest, "invalid_webhook_url",
					"webhookUrl must be an absolute http(s) URL, e.g. https://hooks.slack.com/services/…")
				return
			}
		}
		webhook = &trimmed
	}

	uid, _ := auth.UserID(r.Context())
	var updatedBy any
	if uid != "" {
		updatedBy = uid
	}
	// nil $2 (webhookUrl omitted) keeps the row's current webhook on
	// conflict, and inserts '' on first save.
	_, err := h.DB.Exec(r.Context(), `
		INSERT INTO alert_settings (id, email_enabled, webhook_url, updated_by, updated_at)
		VALUES (true, $1, COALESCE($2, ''), $3, now())
		ON CONFLICT (id) DO UPDATE
		   SET email_enabled = EXCLUDED.email_enabled,
		       webhook_url   = COALESCE($2, alert_settings.webhook_url),
		       updated_by    = EXCLUDED.updated_by,
		       updated_at    = now()
	`, req.EmailEnabled, webhook, updatedBy)
	if err != nil {
		logErr("upsert alert settings", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to save alert settings")
		return
	}

	resp, err := h.status(r.Context())
	if err != nil {
		logErr("alert_settings status after set", err)
		writeError(w, http.StatusInternalServerError, "internal", "Saved but failed to re-read")
		return
	}

	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    uid,
		Action:     audit.ActionUpdateAlertSettings,
		TargetType: audit.TargetAlertSettings,
		Metadata:   map[string]any{"emailEnabled": resp.EmailEnabled, "webhookConfigured": resp.WebhookConfigured},
	})

	writeJSON(w, http.StatusOK, resp)
}

func (h *AlertSettingsHandler) clear(w http.ResponseWriter, r *http.Request) {
	if _, err := h.DB.Exec(r.Context(), `DELETE FROM alert_settings WHERE id = true`); err != nil {
		logErr("clear alert settings", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to clear alert settings")
		return
	}
	uid, _ := auth.UserID(r.Context())
	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    uid,
		Action:     audit.ActionClearAlertSettings,
		TargetType: audit.TargetAlertSettings,
	})
	// Report the post-clear state (reverts to .env fallback, or defaults).
	resp, err := h.status(r.Context())
	if err != nil {
		logErr("alert_settings status after clear", err)
		writeError(w, http.StatusInternalServerError, "internal", "Cleared but failed to re-read")
		return
	}
	writeJSON(w, http.StatusOK, resp)
}
