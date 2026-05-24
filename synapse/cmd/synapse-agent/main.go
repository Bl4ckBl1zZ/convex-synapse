// synapse-agent — observe-only agent for the Cell Control Plane
// (feat/cell-control-plane, Bloco 6).
//
// Runs on a VPS. `join` exchanges a one-time adoption token for a long-lived
// agent token and writes a local config; `run` sends periodic heartbeats so
// the host shows up "online" in the Synapse dashboard with live facts
// (hostname/os/arch/cpu/mem/disk/docker version).
//
// SAFETY: this binary is strictly observe-only. It NEVER creates, restarts, or
// removes containers or volumes, never touches Caddy/proxy, and never modifies
// any container (labelled or not). The only Docker it runs are READ-ONLY
// `docker version` and `docker ps` probes. The config carries flags
// (allowContainer*) reserved for a future apply mode that does not exist yet.
//
// Dependency-light on purpose: standard library only (no Node, no Docker SDK).
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"
)

// Version is overridden at build time via -ldflags "-X main.Version=...".
var Version = "dev"

func main() {
	if len(os.Args) < 2 {
		printUsage(os.Stderr)
		os.Exit(2)
	}
	rest := os.Args[2:]
	var err error
	switch os.Args[1] {
	case "inspect":
		err = runInspect(rest, os.Stdout)
	case "join":
		err = runJoin(rest, os.Stdout)
	case "run":
		err = runRun(rest, os.Stdout)
	case "config-path":
		err = runConfigPath(rest, os.Stdout)
	case "version", "--version", "-v":
		fmt.Fprintln(os.Stdout, "synapse-agent "+Version)
		return
	case "help", "-h", "--help":
		printUsage(os.Stdout)
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", os.Args[1])
		printUsage(os.Stderr)
		os.Exit(2)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func printUsage(w io.Writer) {
	fmt.Fprint(w, `synapse-agent — observe-only agent for Synapse (Cell Control Plane)

Usage:
  synapse-agent inspect
        Collect and print local host facts as JSON.

  synapse-agent join --control-url <url> --token <token> [--config <path>]
        Exchange a one-time adoption token for an agent token and write config.

  synapse-agent run [--config <path>] [--once]
        Send heartbeats on an interval (or once with --once). Ctrl+C to stop.

  synapse-agent config-path
        Print the default config path for this user.

  synapse-agent version

This agent is observe-only: it never creates, restarts, or removes containers
or volumes, and never modifies any container.
`)
}

// runInspect collects local host facts and prints them as JSON.
func runInspect(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("inspect", flag.ContinueOnError)
	fs.SetOutput(stdout)
	if err := fs.Parse(args); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	return writeJSON(stdout, collect(ctx))
}

// runConfigPath prints the default config path.
func runConfigPath(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("config-path", flag.ContinueOnError)
	fs.SetOutput(stdout)
	if err := fs.Parse(args); err != nil {
		return err
	}
	fmt.Fprintln(stdout, defaultConfigPath())
	return nil
}

// runJoin registers the agent with the control plane and persists the config.
func runJoin(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("join", flag.ContinueOnError)
	fs.SetOutput(stdout)
	controlURL := fs.String("control-url", "", "Synapse control-plane URL (e.g. https://synapsepanel.com)")
	token := fs.String("token", "", "one-time adoption token (syn_...)")
	configPath := fs.String("config", "", "config file path (default: per-user / /etc when root)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if strings.TrimSpace(*controlURL) == "" {
		return errors.New("--control-url is required")
	}
	if strings.TrimSpace(*token) == "" {
		return errors.New("--token is required")
	}
	url := strings.TrimRight(strings.TrimSpace(*controlURL), "/")
	path := *configPath
	if path == "" {
		path = defaultConfigPath()
	}

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	info := collect(ctx)
	resp, err := register(ctx, url, strings.TrimSpace(*token), info)
	if err != nil {
		return fmt.Errorf("register: %w", err)
	}

	cfg := Config{
		ControlURL:               url,
		HostID:                   resp.HostID,
		AgentID:                  resp.AgentID,
		AgentToken:               resp.AgentToken,
		Mode:                     orStr(resp.Config.Mode, "observe-only"),
		HeartbeatIntervalSeconds: orInt(resp.Config.HeartbeatIntervalSeconds, defaultHeartbeatSeconds),
		Docker:                   DockerConfig{Enabled: true},
	}
	if err := saveConfig(path, cfg); err != nil {
		return fmt.Errorf("write config: %w", err)
	}

	// Never print the agent token — it's persisted to the 0600 config only.
	fmt.Fprintf(stdout, "joined host %s\n", resp.HostID)
	fmt.Fprintf(stdout, "config written to %s\n", path)
	fmt.Fprintf(stdout, "next: synapse-agent run --config %s\n", path)
	return nil
}

// runRun sends heartbeats. With --once it sends a single heartbeat and exits;
// otherwise it loops on the configured interval until Ctrl+C / SIGTERM.
func runRun(args []string, stdout io.Writer) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	fs.SetOutput(stdout)
	configPath := fs.String("config", "", "config file path (default: per-user / /etc when root)")
	once := fs.Bool("once", false, "send a single heartbeat and exit")
	if err := fs.Parse(args); err != nil {
		return err
	}
	path := *configPath
	if path == "" {
		path = defaultConfigPath()
	}
	cfg, err := loadConfig(path)
	if err != nil {
		return fmt.Errorf("load config %s: %w", path, err)
	}
	if cfg.AgentToken == "" || cfg.ControlURL == "" {
		return errors.New("config is missing agentToken/controlUrl — run `synapse-agent join` first")
	}
	interval := orInt(cfg.HeartbeatIntervalSeconds, defaultHeartbeatSeconds)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	send := func() error {
		cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		info := collect(cctx)
		return heartbeat(cctx, cfg, info, buildObserved(cctx, info))
	}

	if *once {
		if err := send(); err != nil {
			return err
		}
		fmt.Fprintln(stdout, "heartbeat sent")
		return nil
	}

	fmt.Fprintf(stdout, "agent running (observe-only); heartbeat every %ds; Ctrl+C to stop\n", interval)
	// First beat immediately so the host flips online without waiting a full
	// interval. Network errors are logged, never fatal, in loop mode.
	beat(stdout, send)
	ticker := time.NewTicker(time.Duration(interval) * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			fmt.Fprintln(stdout, "shutting down")
			return nil
		case <-ticker.C:
			beat(stdout, send)
		}
	}
}

func beat(stdout io.Writer, send func() error) {
	if err := send(); err != nil {
		// err is the API message / network error — never contains the token.
		fmt.Fprintln(stdout, "heartbeat error:", err)
		return
	}
	fmt.Fprintln(stdout, "heartbeat ok")
}

func orStr(v, def string) string {
	if strings.TrimSpace(v) == "" {
		return def
	}
	return v
}

func orInt(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}
