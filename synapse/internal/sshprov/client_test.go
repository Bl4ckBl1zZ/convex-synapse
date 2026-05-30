package sshprov

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// stubServer is a minimal in-process sshd that captures the exec'd
// command and replies with predetermined stdout/exit.
type stubServer struct {
	t        *testing.T
	listener net.Listener
	hostKey  ssh.Signer
	stdout   []byte
	stderr   []byte
	exitCode uint32

	mu      sync.Mutex
	recvCmd string
}

func newStubServer(t *testing.T) *stubServer {
	t.Helper()
	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("host key: %v", err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostPriv)
	if err != nil {
		t.Fatalf("host signer: %v", err)
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	s := &stubServer{t: t, listener: l, hostKey: hostSigner, stdout: []byte("OK\n")}
	go s.serve()
	return s
}

func (s *stubServer) addrParts() (string, int) {
	host, portStr, _ := net.SplitHostPort(s.listener.Addr().String())
	port, _ := strconv.Atoi(portStr)
	return host, port
}

func (s *stubServer) lastCmd() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.recvCmd
}

func (s *stubServer) close() { _ = s.listener.Close() }

func (s *stubServer) serve() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *stubServer) handle(c net.Conn) {
	defer c.Close()
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(conn ssh.ConnMetadata, key ssh.PublicKey) (*ssh.Permissions, error) {
			return nil, nil
		},
	}
	cfg.AddHostKey(s.hostKey)
	_, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	for ch := range chans {
		if ch.ChannelType() != "session" {
			_ = ch.Reject(ssh.UnknownChannelType, "only session")
			continue
		}
		channel, requests, err := ch.Accept()
		if err != nil {
			return
		}
		go func() {
			defer channel.Close()
			for req := range requests {
				if req.Type == "exec" {
					var payload struct{ Command string }
					_ = ssh.Unmarshal(req.Payload, &payload)
					s.mu.Lock()
					s.recvCmd = payload.Command
					s.mu.Unlock()
					_ = req.Reply(true, nil)
					_, _ = channel.Write(s.stdout)
					_, _ = channel.Stderr().Write(s.stderr)
					status := struct{ Status uint32 }{Status: s.exitCode}
					_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(&status))
					return
				}
				_ = req.Reply(false, nil)
			}
		}()
	}
}

func testSigner(t *testing.T) ssh.Signer {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("client key: %v", err)
	}
	s, err := ssh.NewSignerFromKey(priv)
	if err != nil {
		t.Fatalf("client signer: %v", err)
	}
	return s
}

func staticLoader(s ssh.Signer) SignerLoader {
	return func(ctx context.Context, hostID string) (ssh.Signer, error) { return s, nil }
}

func TestClient_Run_HappyPath(t *testing.T) {
	srv := newStubServer(t)
	defer srv.close()
	host, port := srv.addrParts()

	c := NewClient(staticLoader(testSigner(t)))
	defer c.Close()
	res, err := c.Run(context.Background(),
		Target{HostID: "h1", TailnetAddr: host, Port: port, User: "synapse-deployer"},
		nil, "docker", "ps", "-a")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if string(res.Stdout) != "OK\n" {
		t.Errorf("stdout: got %q", res.Stdout)
	}
	if res.ExitCode != 0 {
		t.Errorf("exit: got %d", res.ExitCode)
	}
	if got, want := srv.lastCmd(), "docker ps -a"; got != want {
		t.Errorf("recv cmd: got %q want %q", got, want)
	}
}

func TestClient_Run_ArgvQuoting(t *testing.T) {
	srv := newStubServer(t)
	defer srv.close()
	host, port := srv.addrParts()

	c := NewClient(staticLoader(testSigner(t)))
	defer c.Close()
	_, err := c.Run(context.Background(),
		Target{HostID: "h1", TailnetAddr: host, Port: port},
		nil, "docker", "run", "--name", "convex-foo", "-e", "K=v with space", "image:tag")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	want := `docker run --name convex-foo -e 'K=v with space' image:tag`
	if got := srv.lastCmd(); got != want {
		t.Errorf("recv cmd: got %q want %q", got, want)
	}
}

func TestClient_Run_QuotesSingleQuote(t *testing.T) {
	srv := newStubServer(t)
	defer srv.close()
	host, port := srv.addrParts()

	c := NewClient(staticLoader(testSigner(t)))
	defer c.Close()
	_, err := c.Run(context.Background(),
		Target{HostID: "h1", TailnetAddr: host, Port: port},
		nil, "docker", "run", "-e", "K=it's")
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	// The POSIX-portable idiom for embedding a single quote inside a
	// single-quoted string is: '...'\''...'
	want := `docker run -e 'K=it'\''s'`
	if got := srv.lastCmd(); got != want {
		t.Errorf("recv cmd: got %q want %q", got, want)
	}
}

func TestClient_Run_WhitelistRefused_ExitCode99(t *testing.T) {
	srv := newStubServer(t)
	defer srv.close()
	srv.exitCode = 99
	srv.stderr = []byte("synapse-deployer-exec: subcommand 'badcmd' not permitted\n")
	host, port := srv.addrParts()

	c := NewClient(staticLoader(testSigner(t)))
	defer c.Close()
	_, err := c.Run(context.Background(),
		Target{HostID: "h1", TailnetAddr: host, Port: port},
		nil, "docker", "badcmd")
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("expected *Error, got %T: %v", err, err)
	}
	if !e.WhitelistRefused() {
		t.Errorf("WhitelistRefused() should be true on exit 99 (got code %d)", e.ExitCode)
	}
	if !strings.Contains(e.Stderr, "not permitted") {
		t.Errorf("stderr captured: %q", e.Stderr)
	}
}

func TestClient_Run_ContextCancel(t *testing.T) {
	srv := newStubServer(t)
	defer srv.close()
	host, port := srv.addrParts()

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // already cancelled
	c := NewClient(staticLoader(testSigner(t)))
	defer c.Close()
	_, err := c.Run(ctx, Target{HostID: "h1", TailnetAddr: host, Port: port}, nil, "docker", "ps")
	if err == nil {
		t.Fatal("expected context error")
	}
}

func TestClient_LoaderError_PropagatesAsError(t *testing.T) {
	loader := func(ctx context.Context, hostID string) (ssh.Signer, error) {
		return nil, errors.New("no key for host")
	}
	c := NewClient(loader)
	defer c.Close()
	_, err := c.Run(context.Background(),
		Target{HostID: "missing", TailnetAddr: "127.0.0.1", Port: 1},
		nil, "docker", "ps")
	var e *Error
	if !errors.As(err, &e) {
		t.Fatalf("expected *Error wrapping loader err, got %T: %v", err, err)
	}
	if !strings.Contains(err.Error(), "no key for host") {
		t.Errorf("err should wrap loader cause: %v", err)
	}
}

func TestPool_ReusesConnection(t *testing.T) {
	srv := newStubServer(t)
	defer srv.close()
	host, port := srv.addrParts()

	var dials int
	var dialMu sync.Mutex
	p := newPool(staticLoader(testSigner(t)), time.Minute)
	p.dial = func(ctx context.Context, network, addr string, cfg *ssh.ClientConfig) (*ssh.Client, error) {
		dialMu.Lock()
		dials++
		dialMu.Unlock()
		return defaultDial(ctx, network, addr, cfg)
	}
	c := NewClientWith(p)
	defer c.Close()

	target := Target{HostID: "h1", TailnetAddr: host, Port: port}
	for i := 0; i < 3; i++ {
		if _, err := c.Run(context.Background(), target, nil, "docker", "ps"); err != nil {
			t.Fatalf("Run %d: %v", i, err)
		}
	}
	dialMu.Lock()
	got := dials
	dialMu.Unlock()
	if got != 1 {
		t.Errorf("expected 1 dial across 3 Runs, got %d", got)
	}
}

// Sanity: verify the Target helpers used in argv quoting paths above.
func TestTarget_Defaults(t *testing.T) {
	tgt := Target{HostID: "h", TailnetAddr: "100.64.0.1"}
	if got, want := tgt.user(), "synapse-deployer"; got != want {
		t.Errorf("user default: got %q want %q", got, want)
	}
	if got, want := tgt.addr(), "100.64.0.1:22"; got != want {
		t.Errorf("addr default: got %q want %q", got, want)
	}
	tgt2 := Target{HostID: "h", TailnetAddr: "::1", Port: 2222, User: "alice"}
	if got, want := tgt2.user(), "alice"; got != want {
		t.Errorf("user override: got %q want %q", got, want)
	}
	if got, want := tgt2.addr(), "[::1]:2222"; got != want {
		t.Errorf("addr override: got %q want %q", got, want)
	}
}

// stallServer completes the SSH handshake but never Accepts or Rejects
// an incoming channel, so a client's NewSession() blocks waiting for the
// channel-open confirmation that never comes — and the connection stays
// open, so it can't fail fast either. Models a remote host reachable
// enough to handshake (or a pooled connection to a host that has since
// wedged) but unable to service new sessions: the exact shape that used
// to hang delete/restart indefinitely before Run bounded NewSession by
// ctx.
type stallServer struct {
	listener net.Listener
	hostKey  ssh.Signer
}

func newStallServer(t *testing.T) *stallServer {
	t.Helper()
	_, hostPriv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("host key: %v", err)
	}
	hostSigner, err := ssh.NewSignerFromKey(hostPriv)
	if err != nil {
		t.Fatalf("host signer: %v", err)
	}
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	s := &stallServer{listener: l, hostKey: hostSigner}
	go s.serve()
	return s
}

func (s *stallServer) addrParts() (string, int) {
	host, portStr, _ := net.SplitHostPort(s.listener.Addr().String())
	port, _ := strconv.Atoi(portStr)
	return host, port
}

func (s *stallServer) close() { _ = s.listener.Close() }

func (s *stallServer) serve() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *stallServer) handle(c net.Conn) {
	defer c.Close()
	cfg := &ssh.ServerConfig{
		PublicKeyCallback: func(ssh.ConnMetadata, ssh.PublicKey) (*ssh.Permissions, error) {
			return nil, nil
		},
	}
	cfg.AddHostKey(s.hostKey)
	_, chans, reqs, err := ssh.NewServerConn(c, cfg)
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)
	// Drain channel-open requests without ever Accept/Reject-ing them.
	// Returns (unblocking) only when the client closes the transport.
	for range chans {
	}
}

// TestClient_Run_ContextTimeout_StallsOnSessionOpen proves Run honours ctx
// during the NewSession() phase, not just during the command. The stall
// server lets the dial + handshake succeed (so we get past pool.get) and
// then never confirms the session channel. Before the fix, NewSession was
// called outside the ctx select and blocked on the socket until the OS TCP
// timeout, hanging the caller (and the delete modal) for minutes. Run must
// now return shortly after the ctx deadline.
func TestClient_Run_ContextTimeout_StallsOnSessionOpen(t *testing.T) {
	srv := newStallServer(t)
	defer srv.close()
	host, port := srv.addrParts()

	c := NewClient(staticLoader(testSigner(t)))
	defer c.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
	defer cancel()

	start := time.Now()
	_, err := c.Run(ctx, Target{HostID: "h1", TailnetAddr: host, Port: port}, nil,
		"docker", "rm", "-f", "convex-stuck")
	elapsed := time.Since(start)

	if err == nil {
		t.Fatal("expected ctx timeout error, got nil")
	}
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err = %v, want it to wrap context.DeadlineExceeded", err)
	}
	// Generous ceiling: the point is it returns near the 250ms deadline,
	// not after the multi-minute kernel TCP timeout.
	if elapsed > 5*time.Second {
		t.Fatalf("Run blocked %s — NewSession is not ctx-bounded", elapsed)
	}
}
