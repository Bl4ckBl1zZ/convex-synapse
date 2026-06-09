package synapsetest

import (
	"context"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/Iann29/synapse/internal/api"
)

// Gap 4 — best-effort remote decommission on host delete.
//
// deleteHost, for a remote host, dispatches a box-side agent teardown over
// SSH and deregisters the Headscale node BEFORE dropping the registry row.
// Both are best-effort: an unreachable VPS or a Headscale hiccup must never
// strand the host row. ?skip_teardown=true is the pure-registry escape hatch.

// makeRemoteHost creates a host via the API then promotes it to a remote
// host (is_remote=true + tailnet/ssh coords) directly in the DB, the way
// install-agent.sh's register would. Returns the host id.
func makeRemoteHost(t *testing.T, h *Harness, admin *User, name, tailnet string) string {
	t.Helper()
	host := createHostViaAPI(t, h, admin, name)
	if _, err := h.DB.Exec(h.rootCtx,
		`UPDATE hosts SET is_remote = TRUE, tailnet_addr = $1,
		        ssh_user = 'synapse-deployer', ssh_port = 22
		   WHERE id = $2`, tailnet, host.ID); err != nil {
		t.Fatalf("promote host to remote: %v", err)
	}
	return host.ID
}

type deleteHostResp struct {
	ID      string            `json:"id"`
	Status  string            `json:"status"`
	Cleanup map[string]string `json:"cleanup"`
}

// 1. Deleting a remote host dispatches the box-side teardown over SSH and
//    reports the outcome in cleanup.
func TestDeleteHost_RemoteTeardown_Dispatched(t *testing.T) {
	var calls int32
	var gotTarget api.RemoteTarget
	h := SetupWithOpts(t, SetupOpts{
		RemoteTeardownFn: func(_ context.Context, tgt api.RemoteTarget) (api.HostTeardownResult, error) {
			atomic.AddInt32(&calls, 1)
			gotTarget = tgt
			return api.HostTeardownResult{Status: "ok"}, nil
		},
	})
	admin := h.RegisterRandomUser()
	hostID := makeRemoteHost(t, h, admin, "host-teardown-ok", "100.64.0.7")

	var out deleteHostResp
	h.DoJSON(http.MethodPost, "/v1/hosts/"+hostID+"/delete", admin.AccessToken, nil, http.StatusOK, &out)

	if atomic.LoadInt32(&calls) != 1 {
		t.Fatalf("expected RemoteTeardown called once, got %d", calls)
	}
	if gotTarget.TailnetAddr != "100.64.0.7" || gotTarget.HostID != hostID {
		t.Fatalf("teardown target wrong: %+v", gotTarget)
	}
	if out.Cleanup["sshTeardown"] != "ok" {
		t.Fatalf("cleanup.sshTeardown: got %q want ok", out.Cleanup["sshTeardown"])
	}
	if out.Cleanup["headscale"] != "skipped" {
		t.Fatalf("cleanup.headscale: got %q want skipped (nil headscale)", out.Cleanup["headscale"])
	}
	if hostCount(t, h, hostID) != 0 {
		t.Fatalf("remote host row should be gone after delete")
	}
}

// 2. A failing teardown (unreachable VPS) is best-effort — the row is still
//    deleted; the failure is surfaced in cleanup, not raised to the caller.
func TestDeleteHost_RemoteTeardown_FailureDoesNotBlock(t *testing.T) {
	h := SetupWithOpts(t, SetupOpts{
		RemoteTeardownFn: func(_ context.Context, _ api.RemoteTarget) (api.HostTeardownResult, error) {
			return api.HostTeardownResult{Status: "failed", Detail: "dial timeout"}, context.DeadlineExceeded
		},
	})
	admin := h.RegisterRandomUser()
	hostID := makeRemoteHost(t, h, admin, "host-teardown-fail", "100.64.0.8")

	var out deleteHostResp
	h.DoJSON(http.MethodPost, "/v1/hosts/"+hostID+"/delete", admin.AccessToken, nil, http.StatusOK, &out)

	if out.Status != "deleted" {
		t.Fatalf("delete must proceed despite teardown failure, got status %q", out.Status)
	}
	if out.Cleanup["sshTeardown"] != "failed" {
		t.Fatalf("cleanup.sshTeardown: got %q want failed", out.Cleanup["sshTeardown"])
	}
	if hostCount(t, h, hostID) != 0 {
		t.Fatalf("host row should be gone even when teardown failed")
	}
}

// 3. ?skip_teardown=true bypasses remote cleanup entirely (escape hatch for
//    re-adopting the same box) — no SSH dispatch, no cleanup summary.
func TestDeleteHost_SkipTeardown(t *testing.T) {
	var calls int32
	h := SetupWithOpts(t, SetupOpts{
		RemoteTeardownFn: func(_ context.Context, _ api.RemoteTarget) (api.HostTeardownResult, error) {
			atomic.AddInt32(&calls, 1)
			return api.HostTeardownResult{Status: "ok"}, nil
		},
	})
	admin := h.RegisterRandomUser()
	hostID := makeRemoteHost(t, h, admin, "host-teardown-skip", "100.64.0.9")

	var out deleteHostResp
	h.DoJSON(http.MethodPost, "/v1/hosts/"+hostID+"/delete?skip_teardown=true",
		admin.AccessToken, nil, http.StatusOK, &out)

	if atomic.LoadInt32(&calls) != 0 {
		t.Fatalf("skip_teardown must NOT dispatch teardown, got %d calls", calls)
	}
	if len(out.Cleanup) != 0 {
		t.Fatalf("skip_teardown should produce no cleanup summary, got %+v", out.Cleanup)
	}
	if hostCount(t, h, hostID) != 0 {
		t.Fatalf("host row should be gone")
	}
}

// 4. A non-remote host delete never dispatches teardown (no cleanup summary).
func TestDeleteHost_LocalHost_NoTeardown(t *testing.T) {
	var calls int32
	h := SetupWithOpts(t, SetupOpts{
		RemoteTeardownFn: func(_ context.Context, _ api.RemoteTarget) (api.HostTeardownResult, error) {
			atomic.AddInt32(&calls, 1)
			return api.HostTeardownResult{Status: "ok"}, nil
		},
	})
	admin := h.RegisterRandomUser()
	host := createHostViaAPI(t, h, admin, "host-local-noteardown") // is_remote=false

	var out deleteHostResp
	h.DoJSON(http.MethodPost, "/v1/hosts/"+host.ID+"/delete", admin.AccessToken, nil, http.StatusOK, &out)

	if atomic.LoadInt32(&calls) != 0 {
		t.Fatalf("local host delete must not dispatch teardown, got %d calls", calls)
	}
	if len(out.Cleanup) != 0 {
		t.Fatalf("local host delete should have no cleanup summary, got %+v", out.Cleanup)
	}
}
