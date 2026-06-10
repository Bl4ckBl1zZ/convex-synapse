package synapsetest

import (
	"context"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/Iann29/synapse/internal/health"
)

// captureAlerter records DeploymentDown calls so the tests can assert
// the exactly-once contract. Thread-safe — the worker calls it from its
// sweep goroutine.
type captureAlerter struct {
	mu    sync.Mutex
	calls []struct{ id, prev, next string }
}

func (a *captureAlerter) DeploymentDown(_ context.Context, id, prev, next string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, struct{ id, prev, next string }{id, prev, next})
}

func (a *captureAlerter) snapshot() []struct{ id, prev, next string } {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make([]struct{ id, prev, next string }, len(a.calls))
	copy(out, a.calls)
	return out
}

// adoptForHealth registers a fake backend via the real adopt API and
// returns the fixture pieces the health tests need.
func adoptForHealth(t *testing.T, h *Harness, suffix string) (*fakeConvexBackend, deploymentJSON) {
	t.Helper()
	u := h.RegisterRandomUser()
	_, projID := projectFor(t, h, u, "HealthAdoptCo"+suffix, "App"+suffix)
	backend := newFakeConvexBackend(t, "hk-"+suffix)
	var d deploymentJSON
	h.DoJSON(http.MethodPost, "/v1/projects/"+projID+"/adopt_deployment", u.AccessToken,
		map[string]any{"deploymentUrl": backend.server.URL, "adminKey": "hk-" + suffix},
		http.StatusCreated, &d)
	return backend, d
}

func pollStatus(t *testing.T, h *Harness, id, want string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last string
	for time.Now().Before(deadline) {
		s, err := health.LookupRow(context.Background(), h.DB, id)
		if err != nil {
			t.Fatalf("lookup: %v", err)
		}
		last = s
		if s == want {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("expected status=%q, still %q after %s", want, last, timeout)
}

// TestHealthAdopted_DownAlertsOnceAndRecovers is the headline G1 test:
// an adopted backend that stops answering /version flips to 'stopped'
// (firing the deployment-down alert exactly once), and a backend that
// answers again flips back to 'running' (silently).
func TestHealthAdopted_DownAlertsOnceAndRecovers(t *testing.T) {
	h := Setup(t)
	backend, d := adoptForHealth(t, h, "1")

	alerter := &captureAlerter{}
	w := &health.Worker{
		DB:      h.DB,
		Docker:  h.Docker,
		Alerter: alerter,
		Config: health.Config{
			Interval:        1 * time.Second, // floor — sub-second clamps to 1s
			StatusTimeout:   2 * time.Second,
			ProbeRetryDelay: 50 * time.Millisecond,
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	go w.Run(ctx)

	// Backend dies. Two consecutive failed probes (anti-blip) → stopped.
	backend.setDown(true)
	pollStatus(t, h, d.ID, "stopped", 5*time.Second)

	// The down transition alerted exactly once, with the right shape.
	// Give follow-up sweeps a beat to prove they DON'T re-alert (the row
	// is already stopped — no transition, no page).
	time.Sleep(1500 * time.Millisecond)
	calls := alerter.snapshot()
	if len(calls) != 1 {
		t.Fatalf("alerts: got %d want exactly 1 (%v)", len(calls), calls)
	}
	if calls[0].id != d.ID || calls[0].prev != "running" || calls[0].next != "stopped" {
		t.Errorf("alert shape: got %+v want {%s running stopped}", calls[0], d.ID)
	}

	// Backend comes back. One good probe → running, no recovery alert.
	backend.setDown(false)
	pollStatus(t, h, d.ID, "running", 5*time.Second)
	if got := len(alerter.snapshot()); got != 1 {
		t.Errorf("alerts after recovery: got %d want still 1", got)
	}
}

// TestHealthAdopted_SingleBlipDoesNotFlap: one failed probe followed by a
// healthy retry keeps the row 'running' and pages nobody — transient
// network blips and rolling restarts on the operator's side must not
// generate alert noise.
func TestHealthAdopted_SingleBlipDoesNotFlap(t *testing.T) {
	h := Setup(t)
	backend, d := adoptForHealth(t, h, "2")

	// Arm the blip BEFORE the worker starts so the immediate first sweep
	// is the one that eats it: probe fails once, the retry succeeds.
	backend.failNextVersions(1)

	alerter := &captureAlerter{}
	w := &health.Worker{
		DB:      h.DB,
		Docker:  h.Docker,
		Alerter: alerter,
		Config: health.Config{
			Interval:        1 * time.Second,
			StatusTimeout:   2 * time.Second,
			ProbeRetryDelay: 50 * time.Millisecond,
		},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	w.Run(ctx) // blocks ~4s → immediate sweep (the blip) + a few clean ones

	s, err := health.LookupRow(context.Background(), h.DB, d.ID)
	if err != nil {
		t.Fatalf("lookup: %v", err)
	}
	if s != "running" {
		t.Errorf("status after single blip: got %q want running", s)
	}
	if got := len(alerter.snapshot()); got != 0 {
		t.Errorf("alerts after single blip: got %d want 0", got)
	}
}
