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
		"dockerAvailable":          info.DockerAvailable,
		"dockerVersion":            info.DockerVersion,
		"synapseManagedContainers": listSynapseContainers(ctx, info.DockerAvailable),
	}
}

// listSynapseContainers returns the names of containers labelled
// synapse.managed=true. READ-ONLY (`docker ps`); returns an empty slice when
// docker is unavailable or the probe fails. Never an action.
func listSynapseContainers(ctx context.Context, dockerAvailable bool) []string {
	names := []string{}
	if !dockerAvailable {
		return names
	}
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(cctx, "docker", "ps",
		"--filter", "label=synapse.managed=true", "--format", "{{.Names}}").Output()
	if err != nil {
		return names
	}
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if s := strings.TrimSpace(line); s != "" {
			names = append(names, s)
		}
	}
	return names
}

func writeJSON(w io.Writer, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	_, err = w.Write(append(b, '\n'))
	return err
}
