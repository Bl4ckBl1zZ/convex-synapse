package docker

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"strconv"
	"strings"
	"sync"
	"testing"

	"golang.org/x/crypto/ssh"

	"github.com/Iann29/synapse/internal/sshprov"
)

// stubResponse is the canned reply for one execed command match.
type stubResponse struct {
	stdout   string
	stderr   string
	exitCode uint32
}

// remoteStubServer is a minimal in-process sshd shared by remote_test.
// Routes execed commands by exact-match prefix; falls back to a default
// response (exit 0, empty stdout) when no rule matches.
type remoteStubServer struct {
	t        *testing.T
	listener net.Listener
	hostKey  ssh.Signer

	mu        sync.Mutex
	recvCmds  []string
	responder func(cmd string) stubResponse
}

func newRemoteStub(t *testing.T, responder func(cmd string) stubResponse) *remoteStubServer {
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
	s := &remoteStubServer{t: t, listener: l, hostKey: hostSigner, responder: responder}
	go s.serve()
	return s
}

func (s *remoteStubServer) addrParts() (string, int) {
	host, portStr, _ := net.SplitHostPort(s.listener.Addr().String())
	port, _ := strconv.Atoi(portStr)
	return host, port
}

func (s *remoteStubServer) cmds() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, len(s.recvCmds))
	copy(out, s.recvCmds)
	return out
}

func (s *remoteStubServer) close() { _ = s.listener.Close() }

func (s *remoteStubServer) serve() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *remoteStubServer) handle(c net.Conn) {
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
					s.recvCmds = append(s.recvCmds, payload.Command)
					resp := s.responder(payload.Command)
					s.mu.Unlock()
					_ = req.Reply(true, nil)
					if resp.stdout != "" {
						_, _ = channel.Write([]byte(resp.stdout))
					}
					if resp.stderr != "" {
						_, _ = channel.Stderr().Write([]byte(resp.stderr))
					}
					status := struct{ Status uint32 }{Status: resp.exitCode}
					_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(&status))
					return
				}
				_ = req.Reply(false, nil)
			}
		}()
	}
}

func remoteTestSigner(t *testing.T) ssh.Signer {
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

func newRemoteClientForTest(t *testing.T, srv *remoteStubServer) *RemoteClient {
	t.Helper()
	host, port := srv.addrParts()
	signer := remoteTestSigner(t)
	c := sshprov.NewClient(func(ctx context.Context, hostID string) (ssh.Signer, error) {
		return signer, nil
	})
	t.Cleanup(func() { _ = c.Close() })
	return NewRemoteClient(c,
		sshprov.Target{HostID: "h1", TailnetAddr: host, Port: port},
		"convex/backend:test", "synapse-network")
}

func TestRemoteClient_Provision_BuildsCorrectArgv(t *testing.T) {
	containerID := "sha256:abc123def456"
	responder := func(cmd string) stubResponse {
		switch {
		case strings.HasPrefix(cmd, "docker volume create"):
			return stubResponse{stdout: "synapse-data-foo\n"}
		case strings.HasPrefix(cmd, "docker run"):
			return stubResponse{stdout: containerID + "\n"}
		case strings.HasPrefix(cmd, "docker inspect"):
			return stubResponse{stdout: containerID + "\n"}
		}
		return stubResponse{}
	}
	srv := newRemoteStub(t, responder)
	defer srv.close()
	rc := newRemoteClientForTest(t, srv)

	host, _ := srv.addrParts()
	spec := DeploymentSpec{
		Name:           "foo",
		DeploymentID:   "dep-uuid",
		ProjectID:      "proj-uuid",
		InstanceSecret: "deadbeef",
		HostPort:       4321,
		EnvVars:        map[string]string{"X_EXTRA": "1"},
	}
	info, err := rc.Provision(context.Background(), spec)
	if err != nil {
		t.Fatalf("Provision: %v", err)
	}
	if info.ContainerID != containerID {
		t.Errorf("ContainerID: got %q want %q", info.ContainerID, containerID)
	}
	if info.HostAddr != host {
		t.Errorf("HostAddr: got %q want %q", info.HostAddr, host)
	}
	if info.HostPort != 4321 {
		t.Errorf("HostPort: got %d", info.HostPort)
	}

	cmds := srv.cmds()
	if len(cmds) != 3 {
		t.Fatalf("expected 3 commands (volume create, run, inspect), got %d: %#v", len(cmds), cmds)
	}

	runCmd := cmds[1]
	wantSubstrings := []string{
		"docker run -d",
		"--name convex-foo",
		"--restart unless-stopped",
		"--label synapse.managed=true",
		"--label synapse.deployment=foo",
		"--label synapse.deployment_id=dep-uuid",
		"--label synapse.project_id=proj-uuid",
		"--volume synapse-data-foo:/convex/data",
		// tailnet IP binding — the whole point of remote provisioning
		"--publish " + host + ":4321:3210",
		"-e INSTANCE_NAME=foo",
		"-e INSTANCE_SECRET=deadbeef",
		// The origin is the CONTAINER's listen port (3210), not the
		// published host port (4321): the publish binding exists on the
		// host, not in the container's network namespace, and this value
		// is consumed from inside the container (node action callbacks,
		// storage URLs, JWKS). See ContainerLoopbackOrigin.
		"-e CONVEX_CLOUD_ORIGIN=http://127.0.0.1:3210",
		// No site URL configured, so the site origin falls back to the
		// cloud origin's /http prefix — where the backend actually mounts
		// HTTP actions. See SiteOriginFallback.
		"-e CONVEX_SITE_ORIGIN=http://127.0.0.1:3210/http",
		"-e X_EXTRA=1",
		"convex/backend:test",
	}
	for _, want := range wantSubstrings {
		if !strings.Contains(runCmd, want) {
			t.Errorf("docker run cmd missing %q\nfull cmd: %s", want, runCmd)
		}
	}

	if got, want := cmds[0], "docker volume create synapse-data-foo"; got != want {
		t.Errorf("volume create cmd: got %q want %q", got, want)
	}
	if got, want := cmds[2], "docker inspect --format "+singleQuote("{{.Id}}")+" convex-foo"; got != want {
		t.Errorf("inspect cmd: got %q want %q", got, want)
	}
}

// singleQuote wraps s in shell single quotes for assertion equality with
// the wire-format quoting the client emits.
func singleQuote(s string) string { return "'" + s + "'" }

func TestRemoteClient_Destroy_NoSuchContainer_NoError(t *testing.T) {
	responder := func(cmd string) stubResponse {
		switch {
		case strings.HasPrefix(cmd, "docker rm"):
			return stubResponse{stderr: "Error: No such container: convex-foo\n", exitCode: 1}
		case strings.HasPrefix(cmd, "docker volume rm"):
			return stubResponse{stderr: "Error: No such volume: synapse-data-foo\n", exitCode: 1}
		}
		return stubResponse{}
	}
	srv := newRemoteStub(t, responder)
	defer srv.close()
	rc := newRemoteClientForTest(t, srv)

	if err := rc.Destroy(context.Background(), "foo"); err != nil {
		t.Fatalf("Destroy should swallow 'No such ...': got %v", err)
	}
}

func TestRemoteClient_Status_Missing(t *testing.T) {
	responder := func(cmd string) stubResponse {
		return stubResponse{stderr: "Error: No such container: convex-foo\n", exitCode: 1}
	}
	srv := newRemoteStub(t, responder)
	defer srv.close()
	rc := newRemoteClientForTest(t, srv)

	got, err := rc.Status(context.Background(), "foo")
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if got != "" {
		t.Errorf("Status missing container: got %q want \"\"", got)
	}
}

func TestRemoteClient_Status_HappyPath(t *testing.T) {
	responder := func(cmd string) stubResponse {
		return stubResponse{stdout: "running\n"}
	}
	srv := newRemoteStub(t, responder)
	defer srv.close()
	rc := newRemoteClientForTest(t, srv)

	got, err := rc.Status(context.Background(), "foo")
	if err != nil {
		t.Fatalf("Status: %v", err)
	}
	if got != "running" {
		t.Errorf("Status: got %q want %q", got, "running")
	}
}

func TestRemoteClient_HAReplica_Rejected(t *testing.T) {
	responder := func(cmd string) stubResponse { return stubResponse{} }
	srv := newRemoteStub(t, responder)
	defer srv.close()
	rc := newRemoteClientForTest(t, srv)

	_, err := rc.Provision(context.Background(), DeploymentSpec{
		Name: "foo", InstanceSecret: "s", HostPort: 1234, HAReplica: true,
	})
	if err == nil || !strings.Contains(err.Error(), "HA replicas not supported") {
		t.Errorf("expected HA rejection, got %v", err)
	}
}
