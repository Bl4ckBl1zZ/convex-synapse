package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
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

func TestParseSynapseLabelsFiltersNonSynapse(t *testing.T) {
	got := parseSynapseLabels("synapse.managed=true,synapse.deployment_id=d1,com.secret=NOPE,maintainer=x")
	if got["synapse.managed"] != "true" || got["synapse.deployment_id"] != "d1" {
		t.Errorf("synapse labels missing: %+v", got)
	}
	if _, leaked := got["com.secret"]; leaked {
		t.Errorf("non-synapse label leaked: %+v", got)
	}
	if _, leaked := got["maintainer"]; leaked {
		t.Errorf("non-synapse label leaked: %+v", got)
	}
}

func TestBuildObservedHasNoSecretKeys(t *testing.T) {
	// dockerAvailable=false → no docker call, containers empty; deterministic in CI.
	obs := buildObserved(context.Background(), SystemInfo{DockerAvailable: false})
	for _, bad := range []string{"env", "command", "environment", "secrets"} {
		if _, ok := obs[bad]; ok {
			t.Errorf("buildObserved leaked top-level %q", bad)
		}
	}
	if _, ok := obs["containers"]; !ok {
		t.Errorf("buildObserved should include containers")
	}
	// 9b.5: scan outcome is always reported; docker-down → explicit unavailable.
	scan, ok := obs["containerScan"].(map[string]any)
	if !ok {
		t.Fatalf("buildObserved should include containerScan")
	}
	if scan["attempted"] != true || scan["succeeded"] != false || scan["error"] != "docker_unavailable" {
		t.Errorf("docker-down scan = %+v, want attempted/!succeeded/docker_unavailable", scan)
	}
}

// 9b.5 — agent uses `docker ps -a` so exited containers are observed, and
// reports an explicit scan outcome so the server can prune safely.

func argsContain(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func TestScanContainersUsesPsAllAndReportsState(t *testing.T) {
	var gotArgs []string
	run := func(_ context.Context, args ...string) ([]byte, error) {
		gotArgs = args
		lines := []string{
			`{"ID":"abc123def456","Names":"convex-a","Image":"img","State":"running","Status":"Up 2 min","Labels":"synapse.managed=true,synapse.deployment_id=dep-a,com.secret=NOPE","Ports":"3210/tcp","CreatedAt":"2026-01-01"}`,
			`{"ID":"def456abc123","Names":"convex-b","Image":"img","State":"exited","Status":"Exited (0) 1 min ago","Labels":"synapse.managed=true,synapse.deployment_id=dep-b","Ports":"","CreatedAt":"2026-01-01"}`,
		}
		return []byte(strings.Join(lines, "\n")), nil
	}
	containers, scan := scanContainers(context.Background(), true, run)

	if !argsContain(gotArgs, "ps") || !argsContain(gotArgs, "-a") {
		t.Errorf("expected `docker ps -a`, got args %v", gotArgs)
	}
	if scan["succeeded"] != true || scan["complete"] != true || scan["error"] != nil {
		t.Errorf("scan should be succeeded+complete, got %+v", scan)
	}
	if len(containers) != 2 {
		t.Fatalf("expected 2 containers (running + exited), got %d", len(containers))
	}
	states := map[string]bool{}
	for _, c := range containers {
		states[c["state"].(string)] = true
		labels := c["labels"].(map[string]string)
		if _, leaked := labels["com.secret"]; leaked {
			t.Errorf("non-synapse label leaked: %+v", labels)
		}
		for _, bad := range []string{"command", "env", "environment", "mounts"} {
			if _, ok := c[bad]; ok {
				t.Errorf("container leaked unsafe field %q", bad)
			}
		}
	}
	if !states["running"] || !states["exited"] {
		t.Errorf("both running and exited must be observed, got %+v", states)
	}
}

func TestScanContainersDockerUnavailable(t *testing.T) {
	run := func(_ context.Context, _ ...string) ([]byte, error) {
		t.Fatal("runner must not be called when docker is unavailable")
		return nil, nil
	}
	containers, scan := scanContainers(context.Background(), false, run)
	if len(containers) != 0 {
		t.Errorf("expected no containers, got %d", len(containers))
	}
	if scan["succeeded"] != false || scan["complete"] != false || scan["error"] != "docker_unavailable" {
		t.Errorf("scan = %+v, want docker_unavailable", scan)
	}
}

func TestScanContainersScanFailed(t *testing.T) {
	run := func(_ context.Context, _ ...string) ([]byte, error) {
		return nil, errors.New("docker ps boom")
	}
	containers, scan := scanContainers(context.Background(), true, run)
	if len(containers) != 0 {
		t.Errorf("expected no containers on scan failure, got %d", len(containers))
	}
	if scan["succeeded"] != false || scan["complete"] != false || scan["error"] != "docker_scan_failed" {
		t.Errorf("scan = %+v, want docker_scan_failed", scan)
	}
}

func TestParseContainerLineExitedSafe(t *testing.T) {
	line := `{"ID":"abcdef123456","Names":"convex-x","Image":"img","State":"exited","Status":"Exited","Labels":"synapse.managed=true,maintainer=ops","Ports":"","CreatedAt":"2026"}`
	c, ok := parseContainerLine(line)
	if !ok {
		t.Fatal("parseContainerLine failed on a valid line")
	}
	if c["state"] != "exited" {
		t.Errorf("state = %v, want exited", c["state"])
	}
	labels := c["labels"].(map[string]string)
	if labels["synapse.managed"] != "true" {
		t.Errorf("synapse.managed label missing: %+v", labels)
	}
	if _, leaked := labels["maintainer"]; leaked {
		t.Errorf("non-synapse label leaked: %+v", labels)
	}
}
