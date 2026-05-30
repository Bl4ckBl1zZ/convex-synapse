package synapsetest

import (
	"context"
	"net/http"
	"testing"
	"time"

	"github.com/Iann29/synapse/internal/api"
)

// blockingRemote models a remote host whose VPS is unreachable: Destroy /
// Restart block until the caller's ctx is cancelled, then return ctx.Err().
// This is the shape that used to wedge the delete modal forever — the real
// sshprov path blocks on a dead socket, and r.Context() carries no deadline.
// The handler's remoteOpTimeout (here shrunk via SetupOpts) is what must
// save us.
type blockingRemote struct{}

func (blockingRemote) Destroy(ctx context.Context, _ string) error {
	<-ctx.Done()
	return ctx.Err()
}
func (blockingRemote) Restart(ctx context.Context, _ string) error {
	<-ctx.Done()
	return ctx.Err()
}

// failingRemote returns immediately with an error — the deterministic stand-in
// for "host reachable but teardown refused" / "host gone". Lets the force +
// error-code assertions run without waiting on any timeout.
type failingRemote struct{}

func (failingRemote) Destroy(context.Context, string) error { return errBoom }
func (failingRemote) Restart(context.Context, string) error { return errBoom }

func remoteOpts(t *testing.T, d api.RemoteDeployer, timeout time.Duration) SetupOpts {
	t.Helper()
	return SetupOpts{
		RemoteDockerFn:  func(api.RemoteTarget) api.RemoteDeployer { return d },
		RemoteOpTimeout: timeout,
	}
}

func mustStatus(t *testing.T, h *Harness, name string) string {
	t.Helper()
	var status string
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT status FROM deployments WHERE name = $1`, name).Scan(&status); err != nil {
		t.Fatalf("read status of %q: %v", name, err)
	}
	return status
}

// TestDeployments_DeleteRemoteUnreachable_TimesOut is the regression for the
// reported bug: a FAILED deployment on a remote VPS that's down. Delete must
// NOT hang — it returns 502 remote_teardown_failed within the bounded
// deadline, and the row stays so the operator can retry (or force).
func TestDeployments_DeleteRemoteUnreachable_TimesOut(t *testing.T) {
	h := SetupWithOpts(t, remoteOpts(t, blockingRemote{}, 150*time.Millisecond))
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Remote Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	h.SeedRemoteDeployment(proj.ID, "bright-raccoon-5185", "dev", "failed",
		owner.ID, 3219, "", "")

	start := time.Now()
	env := h.AssertStatus(http.MethodPost, "/v1/deployments/bright-raccoon-5185/delete",
		owner.AccessToken, nil, http.StatusBadGateway)
	elapsed := time.Since(start)

	if env.Code != "remote_teardown_failed" {
		t.Errorf("code = %q, want remote_teardown_failed", env.Code)
	}
	// The whole point: the request returns near the 150ms bound, not after
	// the multi-minute kernel TCP timeout the bug used to wait on.
	if elapsed > 5*time.Second {
		t.Fatalf("delete blocked %s — teardown is not deadline-bounded", elapsed)
	}
	if got := mustStatus(t, h, "bright-raccoon-5185"); got != "failed" {
		t.Errorf("status = %q, want failed (row must survive a teardown failure)", got)
	}
}

// TestDeployments_DeleteRemote_Force removes the record even though teardown
// fails — the escape hatch for a deployment stranded on a permanently dead
// host. The row goes to 'deleted' and the audit trail marks it orphaned.
func TestDeployments_DeleteRemote_Force(t *testing.T) {
	h := SetupWithOpts(t, remoteOpts(t, failingRemote{}, 0))
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Remote Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	depID, _ := h.SeedRemoteDeployment(proj.ID, "bright-raccoon-5185", "dev", "failed",
		owner.ID, 3219, "", "")

	// Without force the same request is refused (proving force is load-bearing).
	env := h.AssertStatus(http.MethodPost, "/v1/deployments/bright-raccoon-5185/delete",
		owner.AccessToken, nil, http.StatusBadGateway)
	if env.Code != "remote_teardown_failed" {
		t.Fatalf("pre-force code = %q, want remote_teardown_failed", env.Code)
	}

	// With force the record is dropped despite the teardown failure.
	h.DoJSON(http.MethodPost, "/v1/deployments/bright-raccoon-5185/delete?force=true",
		owner.AccessToken, nil, http.StatusOK, &map[string]string{})

	if got := mustStatus(t, h, "bright-raccoon-5185"); got != "deleted" {
		t.Errorf("status = %q, want deleted after force", got)
	}

	var orphaned *string
	if err := h.DB.QueryRow(h.rootCtx,
		`SELECT metadata->>'orphaned' FROM audit_events
		  WHERE target_id::text = $1 ORDER BY id DESC LIMIT 1`, depID).Scan(&orphaned); err != nil {
		t.Fatalf("read audit metadata: %v", err)
	}
	if orphaned == nil || *orphaned != "true" {
		t.Errorf("audit metadata.orphaned = %v, want \"true\"", orphaned)
	}
}

// TestDeployments_DeleteLocalDockerError_StaysStrict guards that the new
// remote/force plumbing didn't loosen the LOCAL contract: a local teardown
// failure still 500s destroy_failed and leaves the row for a retry.
func TestDeployments_DeleteLocalDockerError_StaysStrict(t *testing.T) {
	h := Setup(t)
	owner := h.RegisterRandomUser()
	team := createTeam(t, h, owner.AccessToken, "Local Co")
	proj := createProject(t, h, owner.AccessToken, team.Slug, "P")
	h.SeedDeployment(proj.ID, "local-bee-1212", "dev", "running", true, owner.ID, 3220, "")
	h.Docker.DestroyFn = func(context.Context, string) error { return errBoom }

	env := h.AssertStatus(http.MethodPost, "/v1/deployments/local-bee-1212/delete",
		owner.AccessToken, nil, http.StatusInternalServerError)
	if env.Code != "destroy_failed" {
		t.Errorf("code = %q, want destroy_failed", env.Code)
	}
	if got := mustStatus(t, h, "local-bee-1212"); got != "running" {
		t.Errorf("status = %q, want running (local failure must not delete the row)", got)
	}
}
