// Package sshprov is a thin SSH client used by the Remote Hosts feature
// (v1.18+) to dispatch Docker commands to VPSes managed via Headscale.
//
// SECURITY model:
//   - One ed25519 private key per remote host, stored encrypted in
//     hosts.ssh_privkey_encrypted (Phase 3A). Decrypted on demand here
//     via the injected SignerLoader, held in memory ONLY for the
//     dial + SSH handshake.
//   - Host-side sshd has the matching pubkey in synapse-deployer's
//     authorized_keys with `command="/usr/local/bin/synapse-deployer-exec",
//     restrict` — every command we send hits the wrapper which validates
//     against a docker-subcommand whitelist (Phase 2C).
//   - Connection pool: one *ssh.Client per (hostID, tailnetAddr) tuple.
//     Reused across Provision/Destroy/etc on the same host; idle timeout
//     closes after 5min. Re-dial on stale connection.
//   - StrictHostKeyChecking: we use ssh.InsecureIgnoreHostKey() because
//     hosts on the tailnet are identified by tailnet IP + Headscale ACL;
//     the SSH host key would be a second auth layer that's complex to
//     manage (fingerprint pinning per-host). Trade-off documented:
//     adversary on the tailnet could MITM only with Headscale ACL bypass.
package sshprov

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"

	"golang.org/x/crypto/ssh"
)

// Target identifies the SSH endpoint. TailnetAddr is the 100.x.x.x
// Headscale assigned the host; User/Port default to synapse-deployer/22
// per Phase 2C, but the persisted hosts row may override.
type Target struct {
	HostID      string
	TailnetAddr string
	User        string
	Port        int
}

func (t Target) addr() string {
	port := t.Port
	if port == 0 {
		port = 22
	}
	return net.JoinHostPort(t.TailnetAddr, strconv.Itoa(port))
}

func (t Target) user() string {
	if t.User == "" {
		return "synapse-deployer"
	}
	return t.User
}

// Result is the outcome of a remote command.
type Result struct {
	Stdout   []byte
	Stderr   []byte
	ExitCode int
}

// Error wraps a remote-command failure. Includes the captured stderr
// so callers can surface "why" to the operator (e.g.
// synapse-deployer-exec exit 99 = whitelist refusal).
type Error struct {
	HostID   string
	Cmd      string
	ExitCode int
	Stderr   string
	Cause    error
}

func (e *Error) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("sshprov: %s on %s: %v", e.Cmd, e.HostID, e.Cause)
	}
	return fmt.Sprintf("sshprov: %s on %s exit %d: %s", e.Cmd, e.HostID, e.ExitCode, e.Stderr)
}

func (e *Error) Unwrap() error { return e.Cause }

// WhitelistRefused returns true when the host-side synapse-deployer-exec
// wrapper refused the command (exit 99). Distinct error for dashboards.
func (e *Error) WhitelistRefused() bool { return e.ExitCode == 99 }

// SignerLoader fetches the *ssh.Signer for a given hostID. Constructor
// injection: Phase 4 wiring will pass a closure that calls
// hostssh.LoadPrivKey + ssh.ParsePrivateKey. Tests pass an in-memory
// signer directly.
type SignerLoader func(ctx context.Context, hostID string) (ssh.Signer, error)

// Client is the public surface. Construct via NewClient or NewClientWith
// (test seam). Goroutine-safe: the underlying pool serialises per-host
// connections.
type Client struct {
	pool *pool
}

// NewClient builds a Client with default 5min idle timeout.
func NewClient(loader SignerLoader) *Client {
	return &Client{pool: newPool(loader, defaultIdleTimeout)}
}

// NewClientWith lets tests inject a custom pool (e.g. with shorter
// timeouts or a dial hook).
func NewClientWith(p *pool) *Client {
	return &Client{pool: p}
}

// Run dispatches a single command on the target host via the
// synapse-deployer-exec wrapper. The full argv becomes the SSH "exec"
// request — sshd forwards it as SSH_ORIGINAL_COMMAND to the wrapper,
// which parses + validates against its subcommand whitelist.
//
// argv[0] MUST be "docker". argv[1] MUST be in the wrapper whitelist
// (run/stop/rm/start/restart/inspect/ps/logs/version). The wrapper
// itself enforces this; we pass through what the caller provides.
//
// stdin: passed verbatim to the remote command (unused in v1.18 but
// available for future needs).
func (c *Client) Run(ctx context.Context, t Target, stdin io.Reader, argv ...string) (Result, error) {
	if len(argv) == 0 {
		return Result{}, errors.New("sshprov: empty argv")
	}
	client, err := c.pool.get(ctx, t)
	if err != nil {
		return Result{}, &Error{HostID: t.HostID, Cmd: argv[0], Cause: err}
	}
	sess, err := client.NewSession()
	if err != nil {
		// Stale connection — evict + retry once.
		c.pool.evict(t)
		client, err = c.pool.get(ctx, t)
		if err != nil {
			return Result{}, &Error{HostID: t.HostID, Cmd: argv[0], Cause: err}
		}
		sess, err = client.NewSession()
		if err != nil {
			return Result{}, &Error{HostID: t.HostID, Cmd: argv[0], Cause: err}
		}
	}
	defer sess.Close()

	var stdoutBuf, stderrBuf bytes.Buffer
	sess.Stdout = &stdoutBuf
	sess.Stderr = &stderrBuf
	if stdin != nil {
		sess.Stdin = stdin
	}

	cmdStr := shellQuoteArgv(argv)
	runCh := make(chan error, 1)
	go func() { runCh <- sess.Run(cmdStr) }()

	select {
	case <-ctx.Done():
		_ = sess.Signal(ssh.SIGTERM)
		<-runCh
		return Result{Stdout: stdoutBuf.Bytes(), Stderr: stderrBuf.Bytes()}, ctx.Err()
	case err := <-runCh:
		res := Result{Stdout: stdoutBuf.Bytes(), Stderr: stderrBuf.Bytes()}
		if err == nil {
			res.ExitCode = 0
			return res, nil
		}
		var exitErr *ssh.ExitError
		if errors.As(err, &exitErr) {
			res.ExitCode = exitErr.ExitStatus()
			return res, &Error{
				HostID:   t.HostID,
				Cmd:      argv[0],
				ExitCode: res.ExitCode,
				Stderr:   stderrBuf.String(),
			}
		}
		return res, &Error{HostID: t.HostID, Cmd: argv[0], Cause: err}
	}
}

// Close drains the connection pool. Call on graceful shutdown.
func (c *Client) Close() error {
	return c.pool.closeAll()
}

// shellQuoteArgv escapes argv for the SSH exec channel. The remote
// synapse-deployer-exec wrapper parses $SSH_ORIGINAL_COMMAND with a
// POSIX-shell tokenizer, so single-word args don't need quoting BUT any
// arg containing whitespace, $, backtick, etc. MUST be single-quoted.
// We single-quote any arg outside the portable shell-safe alphabet.
func shellQuoteArgv(argv []string) string {
	var out bytes.Buffer
	for i, a := range argv {
		if i > 0 {
			out.WriteByte(' ')
		}
		if needsQuote(a) {
			out.WriteByte('\'')
			// Escape single quotes by closing the quoted string, emitting
			// an escaped quote, reopening. Standard portable POSIX idiom.
			for _, r := range a {
				if r == '\'' {
					out.WriteString(`'\''`)
				} else {
					out.WriteRune(r)
				}
			}
			out.WriteByte('\'')
		} else {
			out.WriteString(a)
		}
	}
	return out.String()
}

func needsQuote(s string) bool {
	if s == "" {
		return true
	}
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z':
		case r >= 'A' && r <= 'Z':
		case r >= '0' && r <= '9':
		case r == '_' || r == '-' || r == '.' || r == '/' || r == ':' || r == '=' || r == ',':
		default:
			return true
		}
	}
	return false
}
