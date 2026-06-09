package synapsetest

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// alertSettingsTestResp mirrors GET/POST/DELETE /v1/admin/alert_settings.
// There is intentionally NO webhookUrl field — the full URL (which often
// embeds a secret, e.g. Slack hook paths) is never echoed; only a masked
// hint comes back (TestAlertSettings_WebhookURLNeverEchoed enforces it).
type alertSettingsTestResp struct {
	Source            string  `json:"source"` // "db" | "env" | "default"
	EmailEnabled      bool    `json:"emailEnabled"`
	WebhookConfigured bool    `json:"webhookConfigured"`
	WebhookHint       string  `json:"webhookHint"`
	UpdatedAt         *string `json:"updatedAt"`
}

// Fresh install, no .env webhook: defaults apply — email alerts on (when
// email is configured), no webhook.
func TestAlertSettings_GetDefault(t *testing.T) {
	h := Setup(t)
	admin := makeAdminUser(t, h)

	var got alertSettingsTestResp
	h.DoJSON(http.MethodGet, "/v1/admin/alert_settings", admin.AccessToken, nil, http.StatusOK, &got)
	if got.Source != "default" {
		t.Errorf("source = %q, want default", got.Source)
	}
	if !got.EmailEnabled {
		t.Error("emailEnabled = false, want true (default)")
	}
	if got.WebhookConfigured || got.WebhookHint != "" {
		t.Errorf("webhook should be unconfigured: %+v", got)
	}
	if got.UpdatedAt != nil {
		t.Error("updatedAt should be null with no DB row")
	}
}

// SYNAPSE_ALERT_WEBHOOK_URL set on the process, no DB row: GET reports the
// .env fallback as the active source.
func TestAlertSettings_EnvFallback(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{AlertWebhookURL: "https://hooks.slack.com/services/T0/B0/envsecret"})
	admin := makeAdminUser(t, h)

	var got alertSettingsTestResp
	h.DoJSON(http.MethodGet, "/v1/admin/alert_settings", admin.AccessToken, nil, http.StatusOK, &got)
	if got.Source != "env" {
		t.Errorf("source = %q, want env", got.Source)
	}
	if !got.WebhookConfigured {
		t.Error("webhookConfigured = false, want true (.env fallback)")
	}
	if strings.Contains(got.WebhookHint, "envsecret") {
		t.Errorf("webhookHint %q leaks the secret path", got.WebhookHint)
	}
}

// Save → read → clear round-trip. The saved row wins (source=db) and the
// hint is masked down to the host.
func TestAlertSettings_SetGetClear(t *testing.T) {
	h := Setup(t)
	admin := makeAdminUser(t, h)

	var got alertSettingsTestResp
	h.DoJSON(http.MethodPost, "/v1/admin/alert_settings", admin.AccessToken,
		map[string]any{"emailEnabled": false, "webhookUrl": "https://hooks.slack.com/services/T1/B1/topsecret"},
		http.StatusOK, &got)
	if got.Source != "db" || got.EmailEnabled || !got.WebhookConfigured {
		t.Fatalf("after set: %+v, want source=db emailEnabled=false webhookConfigured=true", got)
	}
	if !strings.Contains(got.WebhookHint, "hooks.slack.com") {
		t.Errorf("webhookHint %q should keep the host so the operator can recognize the receiver", got.WebhookHint)
	}
	if strings.Contains(got.WebhookHint, "topsecret") {
		t.Errorf("webhookHint %q leaks the secret path", got.WebhookHint)
	}
	if got.UpdatedAt == nil {
		t.Error("updatedAt should be set after save")
	}

	got = alertSettingsTestResp{}
	h.DoJSON(http.MethodGet, "/v1/admin/alert_settings", admin.AccessToken, nil, http.StatusOK, &got)
	if got.Source != "db" || got.EmailEnabled || !got.WebhookConfigured {
		t.Fatalf("after get: %+v", got)
	}

	got = alertSettingsTestResp{}
	h.DoJSON(http.MethodDelete, "/v1/admin/alert_settings", admin.AccessToken, nil, http.StatusOK, &got)
	if got.Source != "default" || !got.EmailEnabled || got.WebhookConfigured {
		t.Fatalf("after clear: %+v, want defaults back", got)
	}
}

// Saving with an empty webhookUrl is valid (email-only alerting) — and a
// DB row with an empty webhook DISABLES the .env fallback (row wins).
func TestAlertSettings_EmptyWebhookOverridesEnv(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{AlertWebhookURL: "https://hooks.slack.com/services/T0/B0/envsecret"})
	admin := makeAdminUser(t, h)

	var got alertSettingsTestResp
	h.DoJSON(http.MethodPost, "/v1/admin/alert_settings", admin.AccessToken,
		map[string]any{"emailEnabled": true, "webhookUrl": ""},
		http.StatusOK, &got)
	if got.Source != "db" {
		t.Errorf("source = %q, want db", got.Source)
	}
	if got.WebhookConfigured {
		t.Error("webhookConfigured = true, want false — the DB row (empty webhook) must beat the .env fallback")
	}
}

// Omitting webhookUrl in the POST keeps the saved webhook. Required for a
// non-destructive email toggle: GET never returns the full URL, so the
// dashboard CAN'T resend it — absent must mean "keep", empty means "clear".
func TestAlertSettings_OmittedWebhookKeepsExisting(t *testing.T) {
	h := Setup(t)
	admin := makeAdminUser(t, h)

	h.DoJSON(http.MethodPost, "/v1/admin/alert_settings", admin.AccessToken,
		map[string]any{"emailEnabled": true, "webhookUrl": "https://hooks.slack.com/services/T2/B2/keepme"},
		http.StatusOK, &alertSettingsTestResp{})

	// Toggle email off WITHOUT the webhookUrl key.
	var got alertSettingsTestResp
	h.DoJSON(http.MethodPost, "/v1/admin/alert_settings", admin.AccessToken,
		map[string]any{"emailEnabled": false},
		http.StatusOK, &got)
	if got.EmailEnabled {
		t.Error("emailEnabled should be false after toggle")
	}
	if !got.WebhookConfigured {
		t.Error("webhookConfigured = false — omitting webhookUrl must keep the saved webhook")
	}
}

// Webhook URL validation: must be absolute http(s).
func TestAlertSettings_InvalidWebhookURL(t *testing.T) {
	h := Setup(t)
	admin := makeAdminUser(t, h)

	for _, bad := range []string{"not-a-url", "ftp://x.example/hook", "http://"} {
		env := h.AssertStatus(http.MethodPost, "/v1/admin/alert_settings", admin.AccessToken,
			map[string]any{"emailEnabled": true, "webhookUrl": bad}, http.StatusBadRequest)
		if env.Code != "invalid_webhook_url" {
			t.Errorf("webhookUrl=%q: code = %q, want invalid_webhook_url", bad, env.Code)
		}
	}
}

// The full webhook URL must never appear in any response body.
func TestAlertSettings_WebhookURLNeverEchoed(t *testing.T) {
	h := Setup(t)
	admin := makeAdminUser(t, h)
	const secretPath = "/services/T9/B9/supersecrettoken"

	h.DoJSON(http.MethodPost, "/v1/admin/alert_settings", admin.AccessToken,
		map[string]any{"emailEnabled": true, "webhookUrl": "https://hooks.slack.com" + secretPath},
		http.StatusOK, &alertSettingsTestResp{})

	for _, method := range []string{http.MethodGet, http.MethodPost} {
		var reqBody any
		if method == http.MethodPost {
			reqBody = map[string]any{"emailEnabled": true, "webhookUrl": "https://hooks.slack.com" + secretPath}
		}
		resp := h.Do(method, "/v1/admin/alert_settings", admin.AccessToken, reqBody)
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if strings.Contains(string(raw), "supersecrettoken") {
			t.Errorf("%s response leaked the webhook URL: %s", method, raw)
		}
	}
}

// Every alert-settings endpoint is instance-admin-gated (and authed).
func TestAlertSettings_RequiresInstanceAdmin(t *testing.T) {
	h := Setup(t)
	_ = makeAdminUser(t, h)         // first user = instance admin
	other := h.RegisterRandomUser() // subsequent user = NOT instance admin

	h.AssertStatus(http.MethodGet, "/v1/admin/alert_settings", other.AccessToken, nil, http.StatusForbidden)
	h.AssertStatus(http.MethodPost, "/v1/admin/alert_settings", other.AccessToken,
		map[string]any{"emailEnabled": true, "webhookUrl": ""}, http.StatusForbidden)
	h.AssertStatus(http.MethodDelete, "/v1/admin/alert_settings", other.AccessToken, nil, http.StatusForbidden)

	h.AssertStatus(http.MethodGet, "/v1/admin/alert_settings", "", nil, http.StatusUnauthorized)
}
