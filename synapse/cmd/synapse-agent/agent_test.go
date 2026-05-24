package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
)

func TestCollectDoesNotCrash(t *testing.T) {
	info := collect(context.Background())
	if info.OS != runtime.GOOS {
		t.Errorf("os = %q, want %q", info.OS, runtime.GOOS)
	}
	if info.Arch != runtime.GOARCH {
		t.Errorf("arch = %q, want %q", info.Arch, runtime.GOARCH)
	}
	if info.CPUCores < 1 {
		t.Errorf("cpuCores = %d, want >= 1", info.CPUCores)
	}
	// memory/disk are best-effort (0 off-linux); just assert non-negative.
	if info.MemoryMb < 0 || info.DiskGb < 0 {
		t.Errorf("negative mem/disk: %+v", info)
	}
}

func TestRunInspectEmitsJSON(t *testing.T) {
	var buf bytes.Buffer
	if err := runInspect(nil, &buf); err != nil {
		t.Fatalf("inspect: %v", err)
	}
	var info SystemInfo
	if err := json.Unmarshal(buf.Bytes(), &info); err != nil {
		t.Fatalf("inspect output is not valid JSON: %v\n%s", err, buf.String())
	}
}

func TestConfigPath(t *testing.T) {
	p := defaultConfigPath()
	if !strings.HasSuffix(p, "config.json") {
		t.Errorf("config path %q should end in config.json", p)
	}
}

func TestSaveLoadConfigRoundTripAndPerms(t *testing.T) {
	path := filepath.Join(t.TempDir(), "synapse-agent", "config.json")
	cfg := Config{
		ControlURL:               "http://localhost:8080",
		HostID:                   "host-1",
		AgentID:                  "agent-1",
		AgentToken:               "syn_agent_secret",
		Mode:                     "observe-only",
		HeartbeatIntervalSeconds: 15,
		Docker:                   DockerConfig{Enabled: true},
	}
	if err := saveConfig(path, cfg); err != nil {
		t.Fatalf("saveConfig: %v", err)
	}
	if fi, err := os.Stat(path); err != nil {
		t.Fatalf("stat: %v", err)
	} else if perm := fi.Mode().Perm(); perm != 0o600 {
		t.Errorf("config perm = %o, want 0600 (it holds the agent token)", perm)
	}
	got, err := loadConfig(path)
	if err != nil {
		t.Fatalf("loadConfig: %v", err)
	}
	if got.AgentToken != cfg.AgentToken || got.HostID != cfg.HostID || got.HeartbeatIntervalSeconds != 15 {
		t.Errorf("round-trip mismatch: %+v", got)
	}
}

func TestJoinAgainstStub(t *testing.T) {
	var registered atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/v1/agents/register" {
			registered.Store(true)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"hostId":     "host-xyz",
				"agentId":    "agent-xyz",
				"agentToken": "syn_agent_TOPSECRET",
				"config": map[string]any{
					"controlUrl":               srv0(r),
					"heartbeatIntervalSeconds": 15,
					"mode":                     "observe-only",
				},
			})
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	path := filepath.Join(t.TempDir(), "config.json")
	var out bytes.Buffer
	if err := runJoin([]string{"--control-url", srv.URL, "--token", "syn_adopt", "--config", path}, &out); err != nil {
		t.Fatalf("join: %v", err)
	}
	if !registered.Load() {
		t.Error("register endpoint was not called")
	}
	// The agent token must NEVER be printed.
	if strings.Contains(out.String(), "TOPSECRET") {
		t.Errorf("agent token leaked to stdout:\n%s", out.String())
	}
	cfg, err := loadConfig(path)
	if err != nil {
		t.Fatalf("loadConfig after join: %v", err)
	}
	if cfg.AgentToken != "syn_agent_TOPSECRET" || cfg.HostID != "host-xyz" || cfg.AgentID != "agent-xyz" {
		t.Errorf("config not persisted from register response: %+v", cfg)
	}
	if fi, _ := os.Stat(path); fi != nil && fi.Mode().Perm() != 0o600 {
		t.Errorf("config perm = %o, want 0600", fi.Mode().Perm())
	}
}

func TestRunOnceAgainstStub(t *testing.T) {
	var beats atomic.Int32
	var gotBearer atomic.Value
	gotBearer.Store("")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == "/v1/agents/heartbeat" {
			beats.Add(1)
			gotBearer.Store(r.Header.Get("Authorization"))
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`{"ok":true}`))
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer srv.Close()

	path := filepath.Join(t.TempDir(), "config.json")
	if err := saveConfig(path, Config{
		ControlURL:               srv.URL,
		HostID:                   "host-1",
		AgentID:                  "agent-1",
		AgentToken:               "syn_agent_HBTOKEN",
		HeartbeatIntervalSeconds: 15,
		Docker:                   DockerConfig{Enabled: true},
	}); err != nil {
		t.Fatalf("saveConfig: %v", err)
	}

	var out bytes.Buffer
	if err := runRun([]string{"--config", path, "--once"}, &out); err != nil {
		t.Fatalf("run --once: %v", err)
	}
	if n := beats.Load(); n != 1 {
		t.Errorf("expected exactly 1 heartbeat, got %d", n)
	}
	if b := gotBearer.Load().(string); b != "Bearer syn_agent_HBTOKEN" {
		t.Errorf("heartbeat bearer = %q, want the agent token", b)
	}
}

// srv0 echoes the request's Host as a control URL — keeps the stubbed
// register response self-consistent without threading the server URL in.
func srv0(r *http.Request) string {
	return "http://" + r.Host
}
