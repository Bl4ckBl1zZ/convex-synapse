// Package hostssh loads and decrypts per-host SSH private keys from
// the hosts table. Phase 3B's sshprov client uses this to obtain the
// signer for connecting back to a remote VPS.
//
// SECURITY: the decrypted key is held in memory ONLY for the lifetime
// of the SSH dial + handshake. Never logged. Never persisted to disk.
// The fingerprint (sha256 of the pubkey) is fine to log + return
// publicly.
package hostssh

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/crypto"
)

// ErrNoKey is returned when a host row has no encrypted private key
// (legacy host pre-Remote-Hosts, or the self-host).
var ErrNoKey = errors.New("hostssh: no SSH private key stored for this host")

// ErrCryptoDisabled is returned when SYNAPSE_STORAGE_KEY isn't
// configured and we can't decrypt anything.
var ErrCryptoDisabled = errors.New("hostssh: crypto.SecretBox not configured (set SYNAPSE_STORAGE_KEY)")

// LoadPrivKey fetches the ciphertext from hosts.ssh_privkey_encrypted +
// returns the plaintext PEM-encoded private key bytes. Caller is
// responsible for zeroing the buffer when done (Go GC doesn't zero;
// best-effort overwrite is good enough for v1).
func LoadPrivKey(ctx context.Context, db *pgxpool.Pool, secrets *crypto.SecretBox, hostID string) ([]byte, error) {
	if secrets == nil {
		return nil, ErrCryptoDisabled
	}
	var ciphertext []byte
	err := db.QueryRow(ctx,
		`SELECT ssh_privkey_encrypted FROM hosts WHERE id = $1`,
		hostID,
	).Scan(&ciphertext)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return nil, fmt.Errorf("hostssh: host %s: %w", hostID, ErrNoKey)
		}
		return nil, fmt.Errorf("hostssh: load: %w", err)
	}
	if len(ciphertext) == 0 {
		return nil, ErrNoKey
	}
	plaintext, err := secrets.Decrypt(ciphertext)
	if err != nil {
		return nil, fmt.Errorf("hostssh: decrypt: %w", err)
	}
	return plaintext, nil
}

// Fingerprint returns the sha256 fingerprint of an ed25519 pubkey in
// OpenSSH 'SHA256:base64' form. Used by the persist path + dashboard
// display. Mirrors what `ssh-keygen -lf <key.pub>` outputs.
//
// Input is the OpenSSH single-line pubkey ("ssh-ed25519 AAAA... comment").
// We strip the wrapper, base64-decode the wire-format key bytes, and
// hash those — NOT the textual form — so the fingerprint stays stable
// across comment edits.
func Fingerprint(pubkeyBytes []byte) (string, error) {
	parts := strings.Fields(string(pubkeyBytes))
	if len(parts) < 2 {
		return "", errors.New("hostssh: malformed pubkey — expected 'type base64'")
	}
	raw, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return "", fmt.Errorf("hostssh: pubkey base64: %w", err)
	}
	sum := sha256.Sum256(raw)
	return "SHA256:" + strings.TrimRight(base64.StdEncoding.EncodeToString(sum[:]), "="), nil
}
