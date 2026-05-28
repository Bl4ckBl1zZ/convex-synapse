package synapsetest

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// The Remote Hosts one-liner does
// `curl <PublicURL>/v1/install_agent/script | sudo bash`. v1.18→v1.19
// never served the script anywhere — the bare /install-agent.sh path
// landed on the Next.js dashboard and 404'd. v1.19.4 serves it under
// /v1 (Caddy routes /v1/* to the api) from a read-only mount.

func TestInstallAgentScript_ServesMountedFile(t *testing.T) {
	dir := t.TempDir()
	scriptPath := filepath.Join(dir, "install-agent.sh")
	content := "#!/usr/bin/env bash\necho synapse-agent-installer\n"
	if err := os.WriteFile(scriptPath, []byte(content), 0o644); err != nil {
		t.Fatalf("write script: %v", err)
	}

	h := SetupWithOpts(t, SetupOpts{InstallAgentScriptPath: scriptPath})

	// Public + unauth — the new VPS has no token yet.
	resp, err := http.Get(h.Server.URL + "/v1/install_agent/script")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status: got %d want 200", resp.StatusCode)
	}
	body, _ := io.ReadAll(resp.Body)
	if string(body) != content {
		t.Errorf("body: got %q want %q", string(body), content)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/x-shellscript; charset=utf-8" {
		t.Errorf("content-type: got %q", ct)
	}
}

func TestInstallAgentScript_503WhenMissing(t *testing.T) {
	// Point at a path that doesn't exist → 503 with a clear code,
	// not a panic or a 200 of nothing.
	h := SetupWithOpts(t, SetupOpts{
		InstallAgentScriptPath: filepath.Join(t.TempDir(), "nope.sh"),
	})
	resp, err := http.Get(h.Server.URL + "/v1/install_agent/script")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status: got %d want 503", resp.StatusCode)
	}
}
