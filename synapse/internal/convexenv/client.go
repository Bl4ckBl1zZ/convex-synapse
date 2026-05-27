package convexenv

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// HTTPDoer is the subset of *http.Client the Client uses. Pulled out
// behind an interface so tests can stub it without spinning a real
// httptest server (and so a future caller can plug in a custom transport
// with retries / rate limiting).
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// defaultTimeout: env-var calls are cheap (single Postgres write inside
// the backend, no compaction) but a stuck deployment shouldn't block
// the operator's UI for minutes. 5s is generous for any healthy box
// and forces fast-failure on a wedged one.
const defaultTimeout = 5 * time.Second

// Client talks to a single Convex backend's HTTP API for environment
// variables. Stateless; safe to share across goroutines. Construct one
// per Synapse process and reuse.
type Client struct {
	http HTTPDoer
}

// NewClient builds a Client with a sane-default HTTP client (defaultTimeout).
func NewClient() *Client {
	return &Client{http: &http.Client{Timeout: defaultTimeout}}
}

// NewClientWith lets tests inject a stub HTTPDoer (or a custom transport).
func NewClientWith(doer HTTPDoer) *Client { return &Client{http: doer} }

// Error wraps a failed call from the Convex backend's env API. Status is
// the HTTP status code; Body is the response body (capped to 4 KiB so a
// runaway server can't blow up logs).
type Error struct {
	Status int
	Body   string
	Op     string // "update" or "list" — helps debugging
}

func (e *Error) Error() string {
	return fmt.Sprintf("convexenv: %s failed with status %d: %s", e.Op, e.Status, e.Body)
}

// Unauthorized is true when the call's adminKey was rejected (401).
func (e *Error) Unauthorized() bool { return e.Status == http.StatusUnauthorized }

// Update sets or unsets one or many env vars in a single atomic batch.
// deploymentURL is the cloud origin of the backend ("https://<name>.<base>"
// in custom-domain mode, or "http://127.0.0.1:<port>" in host-port mode).
// adminKey is the deployment's admin key (never logged).
//
// An empty changes slice is a no-op and returns nil without an HTTP call.
func (c *Client) Update(ctx context.Context, deploymentURL, adminKey string, changes []Change) error {
	if len(changes) == 0 {
		return nil
	}
	if deploymentURL == "" {
		return errors.New("convexenv: deploymentURL is required")
	}
	if adminKey == "" {
		return errors.New("convexenv: adminKey is required")
	}

	body, err := json.Marshal(struct {
		Changes []Change `json:"changes"`
	}{Changes: changes})
	if err != nil {
		return fmt.Errorf("convexenv: marshal: %w", err)
	}

	url := strings.TrimRight(deploymentURL, "/") + "/api/update_environment_variables"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return fmt.Errorf("convexenv: request: %w", err)
	}
	req.Header.Set("Authorization", "Convex "+adminKey)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("convexenv: do: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return &Error{Op: "update", Status: resp.StatusCode, Body: string(bodyBytes)}
	}
	return nil
}

// List returns every env var currently set in the deployment's function
// runtime store. Useful for diffing / reconciliation. Values are returned
// in plaintext — caller decides what to do with them (NEVER log).
func (c *Client) List(ctx context.Context, deploymentURL, adminKey string) (map[string]string, error) {
	if deploymentURL == "" {
		return nil, errors.New("convexenv: deploymentURL is required")
	}
	if adminKey == "" {
		return nil, errors.New("convexenv: adminKey is required")
	}

	url := strings.TrimRight(deploymentURL, "/") + "/api/list_environment_variables"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("convexenv: request: %w", err)
	}
	req.Header.Set("Authorization", "Convex "+adminKey)
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("convexenv: do: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, &Error{Op: "list", Status: resp.StatusCode, Body: string(bodyBytes)}
	}

	var wire struct {
		EnvironmentVariables map[string]string `json:"environment_variables"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&wire); err != nil {
		return nil, fmt.Errorf("convexenv: decode: %w", err)
	}
	return wire.EnvironmentVariables, nil
}
