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
// Docker call is a READ-ONLY `docker ps` filtered to synapse-managed
// containers — the agent never mutates anything.
func buildObserved(ctx context.Context, info SystemInfo) map[string]any {
	return map[string]any{
		"dockerAvailable": info.DockerAvailable,
		"dockerVersion":   info.DockerVersion,
		"containers":      observeContainers(ctx, info.DockerAvailable),
	}
}

// dockerPSLine is the subset of `docker ps --format {{json .}}` we parse. We
// deliberately do NOT read Command (can carry secrets) or any env.
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

// observeContainers returns SAFE metadata for containers labelled
// synapse.managed=true. READ-ONLY (`docker ps`). Never env, command, or
// non-synapse labels. Empty slice when docker is unavailable / the probe
// fails. Never an action.
func observeContainers(ctx context.Context, dockerAvailable bool) []map[string]any {
	out := []map[string]any{}
	if !dockerAvailable {
		return out
	}
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	raw, err := exec.CommandContext(cctx, "docker", "ps",
		"--filter", "label=synapse.managed=true", "--format", "{{json .}}").Output()
	if err != nil {
		return out
	}
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var p dockerPSLine
		if json.Unmarshal([]byte(line), &p) != nil {
			continue
		}
		out = append(out, map[string]any{
			"id":        shortDockerID(p.ID),
			"name":      p.Names,
			"image":     p.Image,
			"state":     p.State,
			"status":    p.Status,
			"labels":    parseSynapseLabels(p.Labels),
			"ports":     p.Ports,
			"createdAt": p.CreatedAt,
		})
	}
	return out
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
