package health

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeDocker lets a test script the responses of Status(name) per call.
type fakeDocker struct {
	mu     sync.Mutex
	byName map[string]string
	errFn  func(name string) error
	calls  atomic.Int64
}

func (f *fakeDocker) Status(_ context.Context, name string) (string, error) {
	f.calls.Add(1)
	if f.errFn != nil {
		if err := f.errFn(name); err != nil {
			return "", err
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.byName[name], nil
}

// StatusReplica satisfies DockerStatusReporter so fakeDocker can stand in
// for Worker.Docker. The local fake doesn't model per-replica containers;
// it just reuses the by-name map.
func (f *fakeDocker) StatusReplica(ctx context.Context, name string, _ int) (string, error) {
	return f.Status(ctx, name)
}

func (f *fakeDocker) set(name, status string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.byName == nil {
		f.byName = make(map[string]string)
	}
	f.byName[name] = status
}

// classify is the pure function — easy to fully cover without any DB.

func TestClassify(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"", "stopped"},
		{"exited", "stopped"},
		{"dead", "failed"},
		{"paused", "stopped"},
		{"running", ""},
		{"created", ""},
		{"restarting", ""},
		{"unknown-state", ""},
	}
	for _, tc := range cases {
		got := classify(tc.in)
		if got != tc.want {
			t.Errorf("classify(%q) = %q; want %q", tc.in, got, tc.want)
		}
	}
}

func TestConfigSane(t *testing.T) {
	got := Config{Interval: 0}.sane()
	if got.Interval != 30*time.Second {
		t.Errorf("expected 30s default interval; got %v", got.Interval)
	}
	if got.StatusTimeout != 5*time.Second {
		t.Errorf("expected 5s default status timeout; got %v", got.StatusTimeout)
	}

	got = Config{Interval: 100 * time.Millisecond}.sane()
	if got.Interval != 30*time.Second {
		t.Errorf("sub-second interval should be clamped to default; got %v", got.Interval)
	}

	got = Config{Interval: 5 * time.Minute, StatusTimeout: time.Second}.sane()
	if got.Interval != 5*time.Minute || got.StatusTimeout != time.Second {
		t.Errorf("explicit values should pass through; got %+v", got)
	}
}

// fakeDocker behaviour test — independent of the worker plumbing.
func TestFakeDockerStatus(t *testing.T) {
	f := &fakeDocker{}
	f.set("foo", "running")
	if got, _ := f.Status(context.Background(), "foo"); got != "running" {
		t.Errorf("expected running, got %q", got)
	}
	if got, _ := f.Status(context.Background(), "missing"); got != "" {
		t.Errorf("expected empty for missing, got %q", got)
	}
	if calls := f.calls.Load(); calls != 2 {
		t.Errorf("expected 2 calls, got %d", calls)
	}
}

// fakeDocker error path.
func TestFakeDockerError(t *testing.T) {
	want := errors.New("daemon down")
	f := &fakeDocker{
		errFn: func(string) error { return want },
	}
	if _, err := f.Status(context.Background(), "any"); !errors.Is(err, want) {
		t.Errorf("expected error, got %v", err)
	}
}

// reconcile() / sweep() / Run() tests need a postgres pool. Those live
// alongside the existing internal/test integration suite — see
// internal/test/health_test.go for the full-stack worker checks.

// remoteReporterStub stands in for *dockerprov.RemoteClient: scripts the
// status returned over "SSH" and records whether the worker consulted it.
type remoteReporterStub struct {
	status      string
	statusErr   error
	statusCalls atomic.Int64
	restarts    atomic.Int64
}

func (r *remoteReporterStub) Status(context.Context, string) (string, error) {
	r.statusCalls.Add(1)
	return r.status, r.statusErr
}

func (r *remoteReporterStub) Restart(context.Context, string) error {
	r.restarts.Add(1)
	return nil
}

// TestReconcileReplica_RemoteUsesRemoteReporter is the regression for the
// v1.18 split-brain bug: a deployment running on a remote host was judged
// by THIS node's local Docker daemon (which can't see it), so a healthy
// remote replica got flipped to "stopped" and the central proxy 404'd it.
// The worker MUST observe the remote container via RemoteFor and leave a
// running replica untouched — never touching the local Docker reporter.
func TestReconcileReplica_RemoteUsesRemoteReporter(t *testing.T) {
	local := &fakeDocker{} // returns "" (gone) for any name
	remote := &remoteReporterStub{status: "running"}
	var gotTarget RemoteTarget
	w := &Worker{
		Docker: local,
		RemoteFor: func(tg RemoteTarget) RemoteReporter {
			gotTarget = tg
			return remote
		},
		Config: Config{StatusTimeout: time.Second},
	}
	rr := replicaRow{
		replicaID: "r1", deploymentID: "d1", name: "remote-dep",
		isRemote: true, hostID: "h1", tailnetAddr: "100.64.0.9",
		sshUser: "synapse-deployer", sshPort: 22,
	}
	if w.reconcileReplica(context.Background(), slog.Default(), w.Config, rr) {
		t.Fatal("healthy remote replica must not be reconciled to a new status")
	}
	if got := remote.statusCalls.Load(); got != 1 {
		t.Errorf("remote reporter Status calls = %d; want 1", got)
	}
	if got := local.calls.Load(); got != 0 {
		t.Errorf("local Docker MUST NOT be consulted for a remote replica; got %d calls", got)
	}
	if gotTarget.TailnetAddr != "100.64.0.9" || gotTarget.SSHUser != "synapse-deployer" {
		t.Errorf("RemoteFor got wrong target: %+v", gotTarget)
	}
}

// TestReconcileReplica_RemoteNilFactorySkips: when Remote Hosts is disabled
// (RemoteFor == nil) but a remote replica somehow exists, the worker must
// SKIP it — never fall back to the local Docker daemon, which would
// mis-flip it to "stopped".
func TestReconcileReplica_RemoteNilFactorySkips(t *testing.T) {
	local := &fakeDocker{}
	w := &Worker{Docker: local, RemoteFor: nil, Config: Config{StatusTimeout: time.Second}}
	rr := replicaRow{replicaID: "r1", name: "remote-dep", isRemote: true, hostID: "h1"}
	if w.reconcileReplica(context.Background(), slog.Default(), w.Config, rr) {
		t.Fatal("remote replica must be skipped when RemoteFor is nil")
	}
	if got := local.calls.Load(); got != 0 {
		t.Errorf("local Docker MUST NOT be consulted; got %d calls", got)
	}
}
