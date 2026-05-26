package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
)

// TokenPrefix is what every Synapse-issued personal access token starts with
// — analogous to how GitHub tokens start with "ghp_". Helps secret-scanners
// catch leaks and helps users identify what a token is for.
const TokenPrefix = "syn_"

// AgentTokenPrefix marks long-lived synapse-agent tokens (feat/cell-control-
// plane, Bloco 6). It deliberately starts with TokenPrefix so leak scanners
// still match; the longer prefix just makes it human-identifiable. Agent
// tokens are stored in host_agents.token_hash (never access_tokens), so they
// can NOT authenticate a user even if presented to a user-scoped route —
// the access_tokens lookup simply misses.
const AgentTokenPrefix = "syn_agent_"

// ServiceTokenPrefix marks Cell-to-Cell service tokens (feat/cell-control-
// plane, Bloco 7). Like AgentTokenPrefix it starts with TokenPrefix (scanner
// match) but is stored only in service_tokens.token_hash — it can't
// authenticate a user or an agent.
const ServiceTokenPrefix = "syn_svc_"

// GenerateToken returns a fresh random token (with the personal-access-token
// prefix) and the hash that should be stored in the database. The plain token
// is returned to the caller only once — at issuance.
func GenerateToken() (plain, hash string, err error) {
	return GenerateTokenWithPrefix(TokenPrefix)
}

// GenerateTokenWithPrefix is GenerateToken with a caller-chosen prefix. Used
// for agent tokens (AgentTokenPrefix); the entropy + hashing are identical.
func GenerateTokenWithPrefix(prefix string) (plain, hash string, err error) {
	buf := make([]byte, 32) // 256 bits of entropy
	if _, err := rand.Read(buf); err != nil {
		return "", "", err
	}
	plain = prefix + base64.RawURLEncoding.EncodeToString(buf)
	hash = HashToken(plain)
	return plain, hash, nil
}

// HashToken returns the SHA-256 hex digest of a plain token. We use SHA-256
// (not bcrypt) because tokens are uniformly random with 256 bits of entropy —
// brute-forcing the hash is impossible regardless of the function's speed,
// and SHA-256 lets us look the token up by hash via a unique-index probe.
func HashToken(plain string) string {
	sum := sha256.Sum256([]byte(plain))
	return hex.EncodeToString(sum[:])
}
