package headscale

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// HTTPDoer mirrors convexenv.HTTPDoer for the same test-seam reason:
// tests stub it without spinning a real httptest server, and a future
// caller can plug in a custom transport with retries / rate limiting.
type HTTPDoer interface {
	Do(req *http.Request) (*http.Response, error)
}

// defaultTimeout: Headscale API calls are cheap (a single DB write or
// read). 5s is generous for any healthy box; forces fast-failure on a
// wedged one.
const defaultTimeout = 5 * time.Second

// defaultExpiration: pre-auth keys minted by Synapse expire in 1h by
// default. Operator has plenty of time to paste the one-liner into
// the new VPS's SSH session, and a forgotten key can't be claimed
// hours later by a stranger.
const defaultExpiration = time.Hour

// Client wraps Headscale's HTTP API. Stateless; safe to share across
// goroutines. Construct one per Synapse process and reuse.
type Client struct {
	baseURL string
	apiKey  string
	http    HTTPDoer
}

// New builds a Client with the default HTTP timeout. baseURL is the
// API base (e.g. "http://synapse-headscale:8080"), apiKey is the
// admin API key minted by `headscale apikeys create`.
func New(baseURL, apiKey string) *Client {
	return &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		apiKey:  apiKey,
		http:    &http.Client{Timeout: defaultTimeout},
	}
}

// NewWith lets tests inject a stub HTTPDoer.
func NewWith(baseURL, apiKey string, doer HTTPDoer) *Client {
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), apiKey: apiKey, http: doer}
}

// Error wraps a non-2xx response from Headscale. Body is capped to
// 4 KiB so a runaway server can't blow up logs.
type Error struct {
	Status int
	Body   string
	Op     string
}

func (e *Error) Error() string {
	return fmt.Sprintf("headscale: %s failed with status %d: %s", e.Op, e.Status, e.Body)
}

// Unauthorized is true when the API key was rejected (401).
func (e *Error) Unauthorized() bool { return e.Status == http.StatusUnauthorized }

// NotFound is true on 404 — node / pre-auth key / user gone.
func (e *Error) NotFound() bool { return e.Status == http.StatusNotFound }

// ---------- core request helper ----------

func (c *Client) do(ctx context.Context, op, method, path string, body, out any) error {
	if c.baseURL == "" {
		return errors.New("headscale: baseURL not configured")
	}
	if c.apiKey == "" {
		return errors.New("headscale: apiKey not configured")
	}

	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("headscale %s: marshal: %w", op, err)
		}
		reader = bytes.NewReader(encoded)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return fmt.Errorf("headscale %s: request: %w", op, err)
	}
	req.Header.Set("Authorization", "Bearer "+c.apiKey)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("headscale %s: do: %w", op, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		bodyBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return &Error{Op: op, Status: resp.StatusCode, Body: string(bodyBytes)}
	}

	if out != nil {
		if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
			return fmt.Errorf("headscale %s: decode: %w", op, err)
		}
	}
	return nil
}

// ---------- PreAuthKey ----------

// CreatePreAuthKey mints a new pre-auth key. The returned PreAuthKey's
// Key field carries the plaintext — it's the only time Headscale will
// surface it, so callers must hand it to the operator immediately.
func (c *Client) CreatePreAuthKey(ctx context.Context, opts CreatePreAuthKeyOpts) (*PreAuthKey, error) {
	expiration := opts.Expiration
	if expiration.IsZero() {
		expiration = time.Now().Add(defaultExpiration)
	}
	body := map[string]any{
		"user":       opts.User,
		"reusable":   opts.Reusable,
		"ephemeral":  opts.Ephemeral,
		"expiration": expiration.UTC().Format(time.RFC3339),
	}
	if len(opts.ACLTags) > 0 {
		body["aclTags"] = opts.ACLTags
	}
	var wire struct {
		PreAuthKey PreAuthKey `json:"preAuthKey"`
	}
	if err := c.do(ctx, "create-preauthkey", http.MethodPost, "/api/v1/preauthkey", body, &wire); err != nil {
		return nil, err
	}
	if wire.PreAuthKey.Key == "" {
		return nil, errors.New("headscale: empty key in CreatePreAuthKey response")
	}
	return &wire.PreAuthKey, nil
}

// ExpirePreAuthKey invalidates a pre-auth key by its server-assigned ID.
// Headscale v0.28 expects the body shape {user, key} where `key` is the
// numeric ID (named "key" for historical reasons in the proto).
func (c *Client) ExpirePreAuthKey(ctx context.Context, user, id string) error {
	body := map[string]any{"user": user, "key": id}
	return c.do(ctx, "expire-preauthkey", http.MethodPost, "/api/v1/preauthkey/expire", body, nil)
}

// ListPreAuthKeys returns every pre-auth key for the given user (omit
// user to list all). The plaintext Key is NEVER returned by the list
// endpoint — only metadata.
func (c *Client) ListPreAuthKeys(ctx context.Context, user string) ([]PreAuthKey, error) {
	u, err := url.Parse("/api/v1/preauthkey")
	if err != nil {
		return nil, err
	}
	q := u.Query()
	if user != "" {
		q.Set("user", user)
	}
	u.RawQuery = q.Encode()
	var wire struct {
		Keys []PreAuthKey `json:"preAuthKeys"`
	}
	if err := c.do(ctx, "list-preauthkeys", http.MethodGet, u.String(), nil, &wire); err != nil {
		return nil, err
	}
	return wire.Keys, nil
}

// ---------- Node ----------

// ListNodes returns every registered node (or every node owned by
// `user` when non-empty). Synapse uses this to surface the tailnet
// membership table in the dashboard.
func (c *Client) ListNodes(ctx context.Context, user string) ([]Node, error) {
	u, err := url.Parse("/api/v1/node")
	if err != nil {
		return nil, err
	}
	q := u.Query()
	if user != "" {
		q.Set("user", user)
	}
	u.RawQuery = q.Encode()
	var wire struct {
		Nodes []Node `json:"nodes"`
	}
	if err := c.do(ctx, "list-nodes", http.MethodGet, u.String(), nil, &wire); err != nil {
		return nil, err
	}
	return wire.Nodes, nil
}

// GetNode fetches a single node by its server-assigned ID.
func (c *Client) GetNode(ctx context.Context, nodeID string) (*Node, error) {
	var wire struct {
		Node Node `json:"node"`
	}
	if err := c.do(ctx, "get-node", http.MethodGet, "/api/v1/node/"+url.PathEscape(nodeID), nil, &wire); err != nil {
		return nil, err
	}
	return &wire.Node, nil
}

// DeleteNode permanently removes a node from the tailnet. The node's
// tailscaled keeps its session keys but loses authorization on next
// reconnect attempt.
func (c *Client) DeleteNode(ctx context.Context, nodeID string) error {
	return c.do(ctx, "delete-node", http.MethodDelete, "/api/v1/node/"+url.PathEscape(nodeID), nil, nil)
}

// ExpireNode forces the node's session to expire immediately. The
// node remains in the database (re-authentication brings it back)
// unlike DeleteNode which removes the row.
func (c *Client) ExpireNode(ctx context.Context, nodeID string) error {
	body := map[string]any{}
	return c.do(ctx, "expire-node", http.MethodPost, "/api/v1/node/"+url.PathEscape(nodeID)+"/expire", body, nil)
}

// ---------- User ----------

// ListUsers returns every Headscale user (namespace). Synapse
// typically has one — "synapse" — created at install time.
func (c *Client) ListUsers(ctx context.Context) ([]User, error) {
	var wire struct {
		Users []User `json:"users"`
	}
	if err := c.do(ctx, "list-users", http.MethodGet, "/api/v1/user", nil, &wire); err != nil {
		return nil, err
	}
	return wire.Users, nil
}

// CreateUser provisions a new Headscale user. Idempotency is the
// caller's responsibility — Headscale 409s on duplicate names.
func (c *Client) CreateUser(ctx context.Context, name string) (*User, error) {
	var wire struct {
		User User `json:"user"`
	}
	if err := c.do(ctx, "create-user", http.MethodPost, "/api/v1/user", map[string]any{"name": name}, &wire); err != nil {
		return nil, err
	}
	return &wire.User, nil
}
