// Package alert delivers deployment-down notifications. The health worker
// detects the transition (running → stopped/failed) and hands it to a
// Notifier, which fans out to two best-effort channels:
//
//   - email to the owning team's admins, via the same Resend settings the
//     invite path uses (DB-configured key wins over the .env fallback);
//   - a generic webhook POST whose payload carries both "text" (Slack) and
//     "content" (Discord) plus structured fields, so one URL works for
//     Slack, Discord and custom receivers alike.
//
// Channel configuration follows the alert_settings singleton (migration
// 000032): when the row exists it wins entirely; otherwise email defaults
// to on and the webhook comes from SYNAPSE_ALERT_WEBHOOK_URL.
//
// Everything here is best-effort by contract — a notification failure is
// logged and dropped, never propagated to the health worker's sweep.
package alert

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/email"
)

// notifyTimeout bounds one whole notification fan-out (settings read +
// context load + webhook POST + N admin emails). Generous because Resend
// sends are sequential, but finite so a hung receiver can't pile up
// goroutines across sweeps.
const notifyTimeout = 30 * time.Second

// Notifier implements health.Alerter. Zero-value channels degrade to "off":
// nil EmailFallback + empty WebhookURLFallback + no DB row means
// DeploymentDown is a no-op.
type Notifier struct {
	DB *pgxpool.Pool
	// EmailFallback is the .env-configured Sender (same instance the invite
	// path uses). The DB email_settings row, when present, wins at send time.
	EmailFallback email.Sender
	// Crypto decrypts the DB-stored Resend key. nil → DB email settings are
	// ignored and EmailFallback is used as-is.
	Crypto email.Decrypter
	// WebhookURLFallback is SYNAPSE_ALERT_WEBHOOK_URL. An alert_settings row
	// (even with an empty webhook_url) overrides it.
	WebhookURLFallback string
	// PublicURL builds the dashboardUrl link in the payload/email. Empty →
	// no link.
	PublicURL string
	Logger    *slog.Logger
	// HTTPClient posts the webhook. nil → a default client with a sane
	// timeout.
	HTTPClient *http.Client
}

// DeploymentDown notifies the configured channels that a deployment just
// transitioned to stopped/failed. Detached + best-effort: the work happens
// in a goroutine with its own context and timeout, so the health sweep
// (which runs under the fleet-wide advisory lock) is never blocked by a
// slow receiver — a host reboot flipping N deployments at once costs the
// sweep nothing.
func (n *Notifier) DeploymentDown(_ context.Context, deploymentID, previousStatus, newStatus string) {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), notifyTimeout)
		defer cancel()
		n.notify(ctx, deploymentID, previousStatus, newStatus)
	}()
}

// settings is the resolved channel configuration for one notification.
type settings struct {
	emailEnabled bool
	webhookURL   string
}

// loadSettings reads the alert_settings row; absent → defaults (email on,
// .env webhook). A read error degrades to the defaults too — alerting
// shouldn't go fully dark because of a transient DB hiccup.
func (n *Notifier) loadSettings(ctx context.Context) settings {
	out := settings{emailEnabled: true, webhookURL: n.WebhookURLFallback}
	var (
		emailEnabled bool
		webhookURL   string
	)
	err := n.DB.QueryRow(ctx,
		`SELECT email_enabled, webhook_url FROM alert_settings WHERE id = true`,
	).Scan(&emailEnabled, &webhookURL)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			n.logger().Warn("alert: read alert_settings", "err", err)
		}
		return out
	}
	// Row wins entirely — including an empty webhook_url silencing the
	// .env fallback (the operator cleared it from the dashboard).
	return settings{emailEnabled: emailEnabled, webhookURL: webhookURL}
}

// downContext is everything the channels render: the deployment plus its
// project/team lineage and the team-admin recipient list.
type downContext struct {
	deploymentName string
	deploymentType string
	projectID      string
	projectName    string
	projectSlug    string
	teamID         string
	teamName       string
	teamSlug       string
	adminEmails    []string
}

func (n *Notifier) loadContext(ctx context.Context, deploymentID string) (downContext, error) {
	var dc downContext
	err := n.DB.QueryRow(ctx, `
		SELECT d.name, d.deployment_type, p.id, p.name, p.slug, t.id, t.name, t.slug
		  FROM deployments d
		  JOIN projects p ON p.id = d.project_id
		  JOIN teams t ON t.id = p.team_id
		 WHERE d.id = $1
	`, deploymentID).Scan(&dc.deploymentName, &dc.deploymentType,
		&dc.projectID, &dc.projectName, &dc.projectSlug,
		&dc.teamID, &dc.teamName, &dc.teamSlug)
	if err != nil {
		return dc, fmt.Errorf("load deployment context: %w", err)
	}
	rows, err := n.DB.Query(ctx, `
		SELECT u.email
		  FROM team_members tm
		  JOIN users u ON u.id = tm.user_id
		 WHERE tm.team_id = $1 AND tm.role = 'admin'
	`, dc.teamID)
	if err != nil {
		return dc, fmt.Errorf("load team admins: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var e string
		if err := rows.Scan(&e); err != nil {
			return dc, fmt.Errorf("scan admin email: %w", err)
		}
		dc.adminEmails = append(dc.adminEmails, e)
	}
	return dc, rows.Err()
}

func (n *Notifier) notify(ctx context.Context, deploymentID, previousStatus, newStatus string) {
	cfg := n.loadSettings(ctx)
	wantWebhook := cfg.webhookURL != ""
	if !cfg.emailEnabled && !wantWebhook {
		return // nothing configured — stay silent
	}

	dc, err := n.loadContext(ctx, deploymentID)
	if err != nil {
		n.logger().Warn("alert: load context", "deployment_id", deploymentID, "err", err)
		return
	}

	dashboardURL := ""
	if n.PublicURL != "" {
		dashboardURL = strings.TrimRight(n.PublicURL, "/") + "/teams/" + dc.teamSlug + "/" + dc.projectSlug
	}
	line := fmt.Sprintf("⚠️ Synapse: deployment %s (%s) in project %s is down — %s → %s",
		dc.deploymentName, dc.deploymentType, dc.projectName, previousStatus, newStatus)
	if dashboardURL != "" {
		line += " — " + dashboardURL
	}

	if wantWebhook {
		n.postWebhook(ctx, cfg.webhookURL, webhookPayload{
			Event:          "deployment.down",
			Status:         newStatus,
			PreviousStatus: previousStatus,
			Deployment:     refBlock{ID: deploymentID, Name: dc.deploymentName, Type: dc.deploymentType},
			Project:        refBlock{ID: dc.projectID, Name: dc.projectName, Slug: dc.projectSlug},
			Team:           refBlock{ID: dc.teamID, Name: dc.teamName, Slug: dc.teamSlug},
			DashboardURL:   dashboardURL,
			OccurredAt:     time.Now().UTC().Format(time.RFC3339),
			Text:           line,
			Content:        line,
		})
	}

	if cfg.emailEnabled {
		n.sendEmails(ctx, dc, previousStatus, newStatus, dashboardURL)
	}
}

// refBlock is the {id,name,...} shape shared by the payload's deployment /
// project / team blocks. Type is deployment-only, Slug is project/team-only;
// omitempty keeps each block to its own fields.
type refBlock struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Type string `json:"type,omitempty"`
	Slug string `json:"slug,omitempty"`
}

// webhookPayload is the wire shape POSTed to the configured webhook. Text
// (Slack) and Content (Discord) carry the same pre-rendered one-liner so a
// single URL works for either; custom receivers read the structured fields.
type webhookPayload struct {
	Event          string   `json:"event"`
	Status         string   `json:"status"`
	PreviousStatus string   `json:"previousStatus"`
	Deployment     refBlock `json:"deployment"`
	Project        refBlock `json:"project"`
	Team           refBlock `json:"team"`
	DashboardURL   string   `json:"dashboardUrl"`
	OccurredAt     string   `json:"occurredAt"`
	Text           string   `json:"text"`
	Content        string   `json:"content"`
}

func (n *Notifier) postWebhook(ctx context.Context, url string, payload webhookPayload) {
	body, err := json.Marshal(payload)
	if err != nil {
		n.logger().Error("alert: marshal webhook payload", "err", err)
		return
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		n.logger().Warn("alert: build webhook request", "err", err)
		return
	}
	req.Header.Set("Content-Type", "application/json")
	client := n.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	resp, err := client.Do(req)
	if err != nil {
		// Don't log the URL — webhook paths embed secrets (Slack/Discord).
		n.logger().Warn("alert: webhook post failed", "deployment", payload.Deployment.Name, "err", errors.Unwrap(err))
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		n.logger().Warn("alert: webhook post rejected",
			"deployment", payload.Deployment.Name, "status", resp.StatusCode)
	}
}

func (n *Notifier) sendEmails(ctx context.Context, dc downContext, previousStatus, newStatus, dashboardURL string) {
	sender := email.ResolveSender(ctx, n.DB, n.Crypto, n.EmailFallback)
	if sender == nil || !sender.Enabled() {
		return
	}
	if len(dc.adminEmails) == 0 {
		return
	}
	for _, to := range dc.adminEmails {
		msg := buildDownEmail(to, dc, previousStatus, newStatus, dashboardURL)
		if err := sender.Send(ctx, msg); err != nil {
			n.logger().Warn("alert: email send failed", "deployment", dc.deploymentName, "err", err)
		}
	}
}

func (n *Notifier) logger() *slog.Logger {
	if n.Logger != nil {
		return n.Logger
	}
	return slog.Default()
}
