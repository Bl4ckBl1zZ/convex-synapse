package synapsetest

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/Iann29/synapse/internal/alert"
	"github.com/Iann29/synapse/internal/health"
)

// webhookStub is an httptest receiver that records every POSTed body, so
// tests can assert on the alert payload without real Slack/Discord.
type webhookStub struct {
	mu     sync.Mutex
	bodies [][]byte
	srv    *httptest.Server
}

func newWebhookStub(t *testing.T) *webhookStub {
	t.Helper()
	ws := &webhookStub{}
	ws.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		ws.mu.Lock()
		ws.bodies = append(ws.bodies, raw)
		ws.mu.Unlock()
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(ws.srv.Close)
	return ws
}

func (ws *webhookStub) hits() [][]byte {
	ws.mu.Lock()
	defer ws.mu.Unlock()
	out := make([][]byte, len(ws.bodies))
	copy(out, ws.bodies)
	return out
}

// alertWebhookPayload pins the wire shape of the deployment-down webhook.
// Decoded with DisallowUnknownFields so payload drift fails loudly — same
// policy as the HTTP-response fixtures.
type alertWebhookPayload struct {
	Event          string `json:"event"`
	Status         string `json:"status"`
	PreviousStatus string `json:"previousStatus"`
	Deployment     struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Type string `json:"type"`
	} `json:"deployment"`
	Project struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Slug string `json:"slug"`
	} `json:"project"`
	Team struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Slug string `json:"slug"`
	} `json:"team"`
	DashboardURL string `json:"dashboardUrl"`
	OccurredAt   string `json:"occurredAt"`
	// Pre-rendered one-liners so a single URL works for Slack ("text"),
	// Discord ("content") and generic receivers (structured fields above).
	Text    string `json:"text"`
	Content string `json:"content"`
}

func decodeAlertPayload(t *testing.T, raw []byte) alertWebhookPayload {
	t.Helper()
	var p alertWebhookPayload
	dec := json.NewDecoder(strings.NewReader(string(raw)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		t.Fatalf("decode webhook payload: %v\nraw=%s", err, raw)
	}
	return p
}

// addTeamMember inserts a (non-admin) membership row directly — the invite
// flow is exercised elsewhere; alert tests only need the role distinction.
func addTeamMember(t *testing.T, h *Harness, teamID, userID, role string) {
	t.Helper()
	if _, err := h.DB.Exec(context.Background(),
		`INSERT INTO team_members (team_id, user_id, role) VALUES ($1, $2, $3)`,
		teamID, userID, role); err != nil {
		t.Fatalf("seed team member: %v", err)
	}
}

// newAlertWorker builds a health.Worker wired with a real alert.Notifier —
// the same construction main.go does, against the harness DB + fakes.
func newAlertWorker(h *Harness, n *alert.Notifier, cfg health.Config) *health.Worker {
	return &health.Worker{
		DB:      h.DB,
		Docker:  h.Docker,
		Alerter: n,
		Config:  cfg,
	}
}

// A deployment whose container vanished flips running→stopped and fires
// BOTH channels: webhook POST + one email per team ADMIN (members don't
// get paged). Core happy path.
func TestHealthAlert_EmailAndWebhookOnDown(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Alert Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "App")
	member := h.RegisterRandomUser()
	addTeamMember(t, h, team.ID, member.ID, "member")
	id := h.SeedDeployment(proj.ID, "down-cat-1234", "dev", "running", false, owner.ID, 4100, "k")

	h.Docker.StatusFn = func(_ context.Context, _ string) (string, error) {
		return "", nil // container gone
	}

	ws := newWebhookStub(t)
	sender := &recordingSender{enabled: true}
	n := &alert.Notifier{
		DB:                 h.DB,
		EmailFallback:      sender,
		WebhookURLFallback: ws.srv.URL,
		PublicURL:          "https://panel.example.com",
	}
	w := newAlertWorker(h, n, health.Config{Interval: time.Hour, StatusTimeout: 2 * time.Second})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go w.Run(ctx)

	// The notification is fired from a detached goroutine — poll for it.
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if len(ws.hits()) > 0 && len(sender.sent()) > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	cancel()

	hits := ws.hits()
	if len(hits) != 1 {
		t.Fatalf("webhook hits = %d, want 1", len(hits))
	}
	p := decodeAlertPayload(t, hits[0])
	if p.Event != "deployment.down" {
		t.Errorf("event = %q, want deployment.down", p.Event)
	}
	if p.Status != "stopped" || p.PreviousStatus != "running" {
		t.Errorf("status transition = %q→%q, want running→stopped", p.PreviousStatus, p.Status)
	}
	if p.Deployment.ID != id || p.Deployment.Name != "down-cat-1234" || p.Deployment.Type != "dev" {
		t.Errorf("deployment block = %+v", p.Deployment)
	}
	if p.Project.ID != proj.ID || p.Project.Slug != proj.Slug {
		t.Errorf("project block = %+v", p.Project)
	}
	if p.Team.ID != team.ID || p.Team.Slug != team.Slug {
		t.Errorf("team block = %+v", p.Team)
	}
	wantURL := "https://panel.example.com/teams/" + team.Slug + "/" + proj.Slug
	if p.DashboardURL != wantURL {
		t.Errorf("dashboardUrl = %q, want %q", p.DashboardURL, wantURL)
	}
	if p.OccurredAt == "" {
		t.Error("occurredAt empty")
	}
	if !strings.Contains(p.Text, "down-cat-1234") || p.Text != p.Content {
		t.Errorf("text/content one-liners: text=%q content=%q", p.Text, p.Content)
	}

	msgs := sender.sent()
	if len(msgs) != 1 {
		t.Fatalf("emails sent = %d, want exactly 1 (admin only — the plain member must NOT be paged)", len(msgs))
	}
	m := msgs[0]
	if m.To != owner.Email {
		t.Errorf("email To = %q, want team admin %q", m.To, owner.Email)
	}
	if !strings.Contains(m.Subject, "down-cat-1234") {
		t.Errorf("subject %q should name the deployment", m.Subject)
	}
	if !strings.Contains(m.Text, "stopped") || !strings.Contains(m.HTML, "down-cat-1234") {
		t.Errorf("body missing status/name:\nText=%s", m.Text)
	}
}

// Anti-spam: the transition fires EXACTLY once. Subsequent sweeps see the
// replica already at 'stopped' (the sweep only selects status='running')
// so no second notification goes out.
func TestHealthAlert_NoRepeatOnSecondSweep(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Alert Once Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "App")
	h.SeedDeployment(proj.ID, "once-fox-1234", "dev", "running", false, owner.ID, 4101, "k")

	h.Docker.StatusFn = func(_ context.Context, _ string) (string, error) {
		return "", nil
	}

	ws := newWebhookStub(t)
	sender := &recordingSender{enabled: true}
	n := &alert.Notifier{DB: h.DB, EmailFallback: sender, WebhookURLFallback: ws.srv.URL}
	// Tight interval so several sweeps run within the test window.
	w := newAlertWorker(h, n, health.Config{Interval: time.Second, StatusTimeout: 2 * time.Second})

	ctx, cancel := context.WithTimeout(context.Background(), 3500*time.Millisecond)
	defer cancel()
	w.Run(ctx) // blocks ~3.5s → initial sweep + ~3 ticks

	if got := len(ws.hits()); got != 1 {
		t.Errorf("webhook hits = %d, want exactly 1 across repeated sweeps", got)
	}
	if got := len(sender.sent()); got != 1 {
		t.Errorf("emails = %d, want exactly 1 across repeated sweeps", got)
	}
}

// Auto-restart succeeds → the replica is back to running BEFORE the
// deployment-level recompute, so there is no deployment transition and
// NOBODY gets paged for a blip the worker already fixed.
func TestHealthAlert_AutoRestartSuccessNoAlert(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Alert AR Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "App")
	id := h.SeedDeployment(proj.ID, "blip-owl-1234", "dev", "running", false, owner.ID, 4102, "k")

	h.Docker.StatusFn = func(_ context.Context, _ string) (string, error) {
		return "exited", nil
	}
	restarter := &fakeRestarter{fn: func(_ context.Context, _ string) error { return nil }}

	ws := newWebhookStub(t)
	sender := &recordingSender{enabled: true}
	n := &alert.Notifier{DB: h.DB, EmailFallback: sender, WebhookURLFallback: ws.srv.URL}
	w := &health.Worker{
		DB:        h.DB,
		Docker:    h.Docker,
		Restarter: restarter,
		Alerter:   n,
		Config:    health.Config{Interval: time.Hour, StatusTimeout: 2 * time.Second, AutoRestart: true},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	w.Run(ctx)

	if got := len(ws.hits()); got != 0 {
		t.Errorf("webhook hits = %d, want 0 (auto-restart recovered the replica)", got)
	}
	if got := len(sender.sent()); got != 0 {
		t.Errorf("emails = %d, want 0 (auto-restart recovered the replica)", got)
	}
	s, _ := health.LookupRow(context.Background(), h.DB, id)
	if s != "running" {
		t.Errorf("deployment status = %q, want running", s)
	}
}

// Auto-restart FAILS (container gone for good) → replica is promoted to
// 'failed', the deployment transitions, and the alert says status=failed.
func TestHealthAlert_AutoRestartFailureAlertsFailed(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Alert ARF Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "App")
	h.SeedDeployment(proj.ID, "dead-bat-1234", "dev", "running", false, owner.ID, 4103, "k")

	h.Docker.StatusFn = func(_ context.Context, _ string) (string, error) {
		return "exited", nil
	}
	restarter := &fakeRestarter{fn: func(_ context.Context, _ string) error {
		return errors.New("container not found")
	}}

	ws := newWebhookStub(t)
	n := &alert.Notifier{DB: h.DB, WebhookURLFallback: ws.srv.URL}
	w := &health.Worker{
		DB:        h.DB,
		Docker:    h.Docker,
		Restarter: restarter,
		Alerter:   n,
		Config:    health.Config{Interval: time.Hour, StatusTimeout: 2 * time.Second, AutoRestart: true},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	go w.Run(ctx)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if len(ws.hits()) > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	cancel()

	hits := ws.hits()
	if len(hits) != 1 {
		t.Fatalf("webhook hits = %d, want 1", len(hits))
	}
	p := decodeAlertPayload(t, hits[0])
	if p.Status != "failed" {
		t.Errorf("status = %q, want failed (restart-on-missing-container promotes)", p.Status)
	}
}

// A dashboard-saved alert_settings row WINS over the process wiring:
// email_enabled=false silences email even with a live sender, and the DB
// webhook_url replaces the .env fallback entirely.
func TestHealthAlert_DBSettingsOverride(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Alert DB Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "App")
	h.SeedDeployment(proj.ID, "dbwin-elk-1234", "dev", "running", false, owner.ID, 4104, "k")

	envHook := newWebhookStub(t) // wired as the .env fallback — must stay silent
	dbHook := newWebhookStub(t)  // saved in alert_settings — must receive the alert
	if _, err := h.DB.Exec(context.Background(),
		`INSERT INTO alert_settings (id, email_enabled, webhook_url) VALUES (true, false, $1)`,
		dbHook.srv.URL); err != nil {
		t.Fatalf("seed alert_settings: %v", err)
	}

	h.Docker.StatusFn = func(_ context.Context, _ string) (string, error) {
		return "", nil
	}

	sender := &recordingSender{enabled: true}
	n := &alert.Notifier{DB: h.DB, EmailFallback: sender, WebhookURLFallback: envHook.srv.URL}
	w := newAlertWorker(h, n, health.Config{Interval: time.Hour, StatusTimeout: 2 * time.Second})

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	go w.Run(ctx)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if len(dbHook.hits()) > 0 {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	cancel()

	if got := len(dbHook.hits()); got != 1 {
		t.Fatalf("DB-configured webhook hits = %d, want 1", got)
	}
	if got := len(envHook.hits()); got != 0 {
		t.Errorf(".env fallback webhook hits = %d, want 0 (DB row wins)", got)
	}
	if got := len(sender.sent()); got != 0 {
		t.Errorf("emails = %d, want 0 (email_enabled=false in DB row)", got)
	}
}

// Best-effort: an unreachable webhook + failing sender must not stop the
// worker from reconciling status (alerting never breaks the sweep).
func TestHealthAlert_NotificationFailureBestEffort(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Alert BE Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "App")
	id := h.SeedDeployment(proj.ID, "noisy-yak-1234", "dev", "running", false, owner.ID, 4105, "k")

	h.Docker.StatusFn = func(_ context.Context, _ string) (string, error) {
		return "", nil
	}

	sender := &recordingSender{enabled: true, sendErr: errors.New("resend down")}
	n := &alert.Notifier{
		DB:                 h.DB,
		EmailFallback:      sender,
		WebhookURLFallback: "http://127.0.0.1:1/unreachable", // nothing listens on port 1
	}
	w := newAlertWorker(h, n, health.Config{Interval: time.Hour, StatusTimeout: 2 * time.Second})

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	go w.Run(ctx)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if s, _ := health.LookupRow(context.Background(), h.DB, id); s == "stopped" {
			return // reconciled despite both channels failing — that's the contract
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("status never reconciled to stopped — notification failure must not block the sweep")
}
