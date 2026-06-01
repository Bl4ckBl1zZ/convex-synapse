package synapsetest

import (
	"io"
	"net/http"
	"strings"
	"testing"
)

// emailSettingsTestResp mirrors GET/POST/DELETE /v1/admin/email_settings.
// Note: there is intentionally NO apiKey field — the plaintext key must
// never be echoed (TestEmailSettings_KeyNeverEchoed enforces it on the wire).
type emailSettingsTestResp struct {
	Configured  bool    `json:"configured"`
	Source      string  `json:"source"`
	Provider    string  `json:"provider"`
	FromAddress string  `json:"fromAddress"`
	UpdatedAt   *string `json:"updatedAt"`
}

// v1.22: an instance admin configures the Resend key from the dashboard.
// The key is encrypted at rest; GET reports configured + source + from.
func TestEmailSettings_SetGetClear(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{DNSEnvelope: freshCryptoBox(t)})
	admin := makeAdminUser(t, h)

	var got emailSettingsTestResp
	h.DoJSON(http.MethodGet, "/v1/admin/email_settings", admin.AccessToken, nil, http.StatusOK, &got)
	if got.Configured || got.Source != "none" {
		t.Fatalf("initial: got %+v, want configured=false source=none", got)
	}

	got = emailSettingsTestResp{}
	h.DoJSON(http.MethodPost, "/v1/admin/email_settings", admin.AccessToken,
		map[string]string{"apiKey": "re_secret_123", "fromAddress": "Synapse <no-reply@x.com>"},
		http.StatusOK, &got)
	if !got.Configured || got.Source != "db" || got.FromAddress != "Synapse <no-reply@x.com>" {
		t.Fatalf("after set: got %+v", got)
	}
	if got.UpdatedAt == nil {
		t.Error("after set: updatedAt should be populated")
	}

	got = emailSettingsTestResp{}
	h.DoJSON(http.MethodGet, "/v1/admin/email_settings", admin.AccessToken, nil, http.StatusOK, &got)
	if !got.Configured || got.Source != "db" || got.FromAddress != "Synapse <no-reply@x.com>" {
		t.Fatalf("after get: got %+v", got)
	}

	got = emailSettingsTestResp{}
	h.DoJSON(http.MethodDelete, "/v1/admin/email_settings", admin.AccessToken, nil, http.StatusOK, &got)
	if got.Configured || got.Source != "none" {
		t.Fatalf("after clear: got %+v (no .env fallback in this harness, so source=none)", got)
	}
}

// The plaintext Resend key must NEVER appear in any response body.
func TestEmailSettings_KeyNeverEchoed(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{DNSEnvelope: freshCryptoBox(t)})
	admin := makeAdminUser(t, h)
	const secret = "re_super_secret_value_xyz"

	h.DoJSON(http.MethodPost, "/v1/admin/email_settings", admin.AccessToken,
		map[string]string{"apiKey": secret, "fromAddress": "Synapse <no-reply@x.com>"},
		http.StatusOK, &emailSettingsTestResp{})

	for _, method := range []string{http.MethodGet, http.MethodPost} {
		body := map[string]string{"apiKey": secret, "fromAddress": "Synapse <no-reply@x.com>"}
		var reqBody any
		if method == http.MethodPost {
			reqBody = body
		}
		resp := h.Do(method, "/v1/admin/email_settings", admin.AccessToken, reqBody)
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if strings.Contains(string(raw), secret) {
			t.Errorf("%s response leaked the API key: %s", method, raw)
		}
	}
}

// Every email-settings endpoint is instance-admin-gated.
func TestEmailSettings_RequiresInstanceAdmin(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{DNSEnvelope: freshCryptoBox(t)})
	_ = makeAdminUser(t, h)              // first user = instance admin
	other := h.RegisterRandomUser()      // subsequent user = NOT instance admin

	h.AssertStatus(http.MethodGet, "/v1/admin/email_settings", other.AccessToken, nil, http.StatusForbidden)
	h.AssertStatus(http.MethodPost, "/v1/admin/email_settings", other.AccessToken,
		map[string]string{"apiKey": "re_x", "fromAddress": "a@b.com"}, http.StatusForbidden)
	h.AssertStatus(http.MethodDelete, "/v1/admin/email_settings", other.AccessToken, nil, http.StatusForbidden)
}

// Without a SecretBox (SYNAPSE_STORAGE_KEY) we refuse to store the key
// rather than persist it in plaintext.
func TestEmailSettings_CryptoNotConfigured(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{}) // DNSEnvelope omitted → no crypto
	admin := makeAdminUser(t, h)

	env := h.AssertStatus(http.MethodPost, "/v1/admin/email_settings", admin.AccessToken,
		map[string]string{"apiKey": "re_x", "fromAddress": "a@b.com"},
		http.StatusServiceUnavailable)
	if env.Code != "crypto_not_configured" {
		t.Errorf("code: got %q want crypto_not_configured", env.Code)
	}
}

// Validation: missing key / bad from address are 400s.
func TestEmailSettings_Validation(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{DNSEnvelope: freshCryptoBox(t)})
	admin := makeAdminUser(t, h)

	h.AssertStatus(http.MethodPost, "/v1/admin/email_settings", admin.AccessToken,
		map[string]string{"apiKey": "", "fromAddress": "a@b.com"}, http.StatusBadRequest)
	h.AssertStatus(http.MethodPost, "/v1/admin/email_settings", admin.AccessToken,
		map[string]string{"apiKey": "re_x", "fromAddress": "not-an-email"}, http.StatusBadRequest)
}
