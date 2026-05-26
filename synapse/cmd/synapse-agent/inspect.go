package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"time"
)

// SystemInfo is the local host snapshot the agent collects. Memory/disk are
// best-effort (0 when the platform-specific probe can't read them); docker
// fields come from a read-only `docker version` probe.
type SystemInfo struct {
	Hostname        string `json:"hostname"`
	OS              string `json:"os"`
	Arch            string `json:"arch"`
	CPUCores        int    `json:"cpuCores"`
	MemoryMb        int64  `json:"memoryMb"`
	DiskGb          int64  `json:"diskGb"`
	DockerAvailable bool   `json:"dockerAvailable"`
	DockerVersion   string `json:"dockerVersion,omitempty"`
}

// collect gathers local facts. Never fails — unreadable values default to
// zero/false so `inspect` and heartbeats always produce a payload.
func collect(ctx context.Context) SystemInfo {
	hostname, _ := os.Hostname()
	info := SystemInfo{
		Hostname: hostname,
		OS:       runtime.GOOS,
		Arch:     runtime.GOARCH,
		CPUCores: runtime.NumCPU(),
		MemoryMb: memTotalMb(),     // platform-specific (sysinfo_*.go)
		DiskGb:   diskTotalGb("/"), // platform-specific (sysinfo_*.go)
	}
	if v, ok := dockerVersion(ctx); ok {
		info.DockerAvailable = true
		info.DockerVersion = v
	}
	return info
}

// dockerVersion runs the READ-ONLY `docker version` probe with a short
// timeout. Returns ok=false when docker is absent or unreachable.
func dockerVersion(ctx context.Context) (string, bool) {
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, "docker", "version", "--format", "{{.Server.Version}}").Output()
	if err != nil {
		return "", false
	}
	v := strings.TrimSpace(string(out))
	if v == "" {
		return "", false
	}
	return v, true
}

// buildObserved is the observe-only payload sent on every heartbeat. The only
// Docker call is a READ-ONLY `docker ps -a` filtered to synapse-managed
// containers — the agent never mutates anything. containerScan tells the
// control plane whether the listing actually succeeded, so it can prune stale
// observed state safely (a failed scan must NOT be read as "everything gone").
func buildObserved(ctx context.Context, info SystemInfo) map[string]any {
	containers, scan := scanContainers(ctx, info.DockerAvailable, realDockerRunner)
	return map[string]any{
		"dockerAvailable": info.DockerAvailable,
		"dockerVersion":   info.DockerVersion,
		"containers":      containers,
		"containerScan":   scan,
	}
}

// dockerRunner runs a READ-ONLY docker command and returns its stdout. Injected
// so tests can exercise the scan/parse without a docker daemon.
type dockerRunner func(ctx context.Context, args ...string) ([]byte, error)

func realDockerRunner(ctx context.Context, args ...string) ([]byte, error) {
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	return exec.CommandContext(cctx, "docker", args...).Output()
}

// dockerPSLine is the subset of `docker ps --format {{json .}}` we parse. We
// deliberately do NOT read Command (can carry secrets), env, or mounts.
type dockerPSLine struct {
	ID        string `json:"ID"`
	Names     string `json:"Names"`
	Image     string `json:"Image"`
	State     string `json:"State"`
	Status    string `json:"Status"`
	Labels    string `json:"Labels"`
	Ports     string `json:"Ports"`
	CreatedAt string `json:"CreatedAt"`
}

// scanContainers returns SAFE metadata for ALL synapse.managed=true containers
// — running AND exited/created/stopped (`docker ps -a`) — so the Drift Engine
// can tell "stopped, needs restart" from "gone, needs create". READ-ONLY.
// Never env, command, mounts, or non-synapse labels.
//
// The second return value is the scan outcome:
//   - docker absent          → {attempted, !succeeded, !complete, "docker_unavailable"}
//   - `docker ps -a` errored  → {attempted, !succeeded, !complete, "docker_scan_failed"}
//   - listing succeeded       → {attempted, succeeded, complete, ""}
//
// Only a succeeded+complete scan authorises the server to prune vanished
// containers; a failed scan keeps the previous observation.
func scanContainers(ctx context.Context, dockerAvailable bool, run dockerRunner) ([]map[string]any, map[string]any) {
	out := []map[string]any{}
	if !dockerAvailable {
		return out, scanResult(false, false, "docker_unavailable")
	}
	raw, err := run(ctx, "ps", "-a", "--filter", "label=synapse.managed=true", "--format", "{{json .}}")
	if err != nil {
		return out, scanResult(false, false, "docker_scan_failed")
	}
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if c, ok := parseContainerLine(line); ok {
			out = append(out, c)
		}
	}
	return out, scanResult(true, true, "")
}

// parseContainerLine turns one `docker ps --format {{json .}}` line into the
// SAFE observed shape (synapse.* labels only; never command/env/mounts).
func parseContainerLine(line string) (map[string]any, bool) {
	var p dockerPSLine
	if json.Unmarshal([]byte(line), &p) != nil {
		return nil, false
	}
	return map[string]any{
		"id":        shortDockerID(p.ID),
		"name":      p.Names,
		"image":     p.Image,
		"state":     p.State,
		"status":    p.Status,
		"labels":    parseSynapseLabels(p.Labels),
		"ports":     p.Ports,
		"createdAt": p.CreatedAt,
	}, true
}

// scanResult builds the containerScan object. attempted is always true (the
// agent always tries when it runs a heartbeat); error is null on success.
func scanResult(succeeded, complete bool, errCode string) map[string]any {
	m := map[string]any{"attempted": true, "succeeded": succeeded, "complete": complete}
	if errCode == "" {
		m["error"] = nil
	} else {
		m["error"] = errCode
	}
	return m
}

// parseSynapseLabels parses docker's "k=v,k2=v2" label string and keeps ONLY
// synapse.* labels — never echoes arbitrary operator labels.
func parseSynapseLabels(s string) map[string]string {
	out := map[string]string{}
	for _, kv := range strings.Split(s, ",") {
		k, v, ok := strings.Cut(kv, "=")
		k = strings.TrimSpace(k)
		if ok && strings.HasPrefix(k, "synapse.") {
			out[k] = strings.TrimSpace(v)
		}
	}
	return out
}

func shortDockerID(id string) string {
	if len(id) > 12 {
		return id[:12]
	}
	return id
}

func writeJSON(w io.Writer, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	_, err = w.Write(append(b, '\n'))
	return err
}
