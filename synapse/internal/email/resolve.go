package email

import (
	"context"
	"log/slog"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Decrypter is the subset of crypto.SecretBox that ResolveSender needs to
// read the DB-stored Resend key. Declared here (not borrowed from api's
// SecretEnvelope) so non-api callers — the alert Notifier — don't have to
// import the api package for an interface.
type Decrypter interface {
	DecryptString(ciphertext []byte) (string, error)
}

// ResolveSender returns the active Sender: the DB-configured Resend
// settings if present (decrypted), else the fallback. Read at send-time so
// a dashboard change takes effect without a restart. Any failure (no
// crypto, no row, decrypt error) degrades to the fallback — transactional
// email is best-effort everywhere, never blocked by a config hiccup.
//
// Shared by the invite path (api.resolveEmailSender delegates here) and
// the deployment-down alert Notifier.
func ResolveSender(ctx context.Context, db *pgxpool.Pool, dec Decrypter, fallback Sender) Sender {
	if dec == nil {
		return fallback
	}
	var (
		keyEnc []byte
		from   string
	)
	err := db.QueryRow(ctx,
		`SELECT api_key_encrypted, from_address FROM email_settings WHERE id = true`,
	).Scan(&keyEnc, &from)
	if err != nil {
		return fallback // no row (or transient error) → .env fallback
	}
	key, derr := dec.DecryptString(keyEnc)
	if derr != nil {
		slog.Error("email: decrypt resend key", "err", derr)
		return fallback
	}
	return New(key, from)
}
