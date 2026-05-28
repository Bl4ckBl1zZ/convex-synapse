// Package headscale is a small HTTP client for Headscale's REST API
// (which is a gRPC-Gateway over a protobuf surface; we hit the JSON
// transport). Synapse uses it to mint Tailscale pre-auth keys for
// hosts added via install-agent.sh, list / expire / delete tailnet
// nodes from the dashboard, and probe whether a host's last-seen
// agent matches an expected key.
//
// Auth: every call carries `Authorization: Bearer <api-key>`. The key
// is minted ONCE via `headscale apikeys create` in the container at
// install time (installer/install/headscale.sh) and persisted to .env
// as SYNAPSE_HEADSCALE_API_KEY.
//
// Tested against Headscale v0.28.0. Endpoints are stable since 0.22
// (only the PreAuthKey CLI shape changed; the HTTP API is unchanged).
package headscale

import "time"

// User is a Headscale namespace owner. Synapse uses a single user
// named 'synapse' for every pre-auth key it mints; tag-based ACLs
// (Phase 3) handle multi-tenancy concerns separately.
//
// NOTE: Headscale serialises uint64 IDs as JSON strings (gRPC-Gateway
// default for 64-bit numbers, to keep precision through JS clients).
// We mirror that as Go strings — operators never do arithmetic on
// these and string round-trips losslessly.
type User struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"createdAt"`
}

// PreAuthKey is a single-use (or reusable) token a Tailscale client
// presents to `tailscale up --auth-key=...`. Synapse mints these on
// demand when an operator clicks "New host" in the dashboard.
type PreAuthKey struct {
	User       User      `json:"user"`
	ID         string    `json:"id"`
	Key        string    `json:"key"`
	Reusable   bool      `json:"reusable"`
	Ephemeral  bool      `json:"ephemeral"`
	Used       bool      `json:"used"`
	Expiration time.Time `json:"expiration"`
	CreatedAt  time.Time `json:"createdAt"`
	ACLTags    []string  `json:"aclTags,omitempty"`
}

// Node is a registered tailnet member — the VPS the operator
// install-agent.sh'd onto. Synapse reads `IPAddresses[0]` to get the
// tailnet IP it should SSH to for remote provisioning.
type Node struct {
	ID             string    `json:"id"`
	MachineKey     string    `json:"machineKey"`
	NodeKey        string    `json:"nodeKey"`
	DiscoKey       string    `json:"discoKey"`
	IPAddresses    []string  `json:"ipAddresses"`
	Name           string    `json:"name"`
	GivenName      string    `json:"givenName"`
	User           User      `json:"user"`
	LastSeen       time.Time `json:"lastSeen"`
	Expiry         time.Time `json:"expiry"`
	Online         bool      `json:"online"`
	CreatedAt      time.Time `json:"createdAt"`
	RegisterMethod string    `json:"registerMethod"`
	Tags           []string  `json:"forcedTags,omitempty"`
}

// CreatePreAuthKeyOpts captures the inputs Synapse uses when minting
// a pre-auth key for a new host adoption. Defaults: single-use, NOT
// ephemeral, 1h expiration.
type CreatePreAuthKeyOpts struct {
	User       string    // username (e.g. "synapse")
	Reusable   bool      // false = single-use (recommended)
	Ephemeral  bool      // false = node persists across reconnects
	Expiration time.Time // RFC3339; zero → 1h from now (set by Client)
	ACLTags    []string  // optional tags applied at registration
}
