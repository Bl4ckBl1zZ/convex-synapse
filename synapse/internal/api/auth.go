package api

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/audit"
	"github.com/Iann29/synapse/internal/auth"
	synapsedb "github.com/Iann29/synapse/internal/db"
	"github.com/Iann29/synapse/internal/email"
	"github.com/Iann29/synapse/internal/models"
)

// AuthHandler exposes registration, login, session refresh, and the
// self-service password-reset flow (v1.25+).
type AuthHandler struct {
	DB  *pgxpool.Pool
	JWT *auth.JWTIssuer
	// Email is the .env-fallback Sender; resolveEmailSender (DB
	// email_settings wins) picks the active one at send time. Reset emails
	// ride the same Resend config as invites.
	Email email.Sender
	// Crypto decrypts the DB-stored Resend key (same SecretBox the email
	// settings handler uses). nil → .env fallback only.
	Crypto SecretEnvelope
	// PublicURL builds the emailed /reset-password link. Empty → the
	// forgot endpoint still answers 200 but mints nothing (no way to
	// deliver a working link).
	PublicURL string
}

func (h *AuthHandler) Routes() chi.Router {
	r := chi.NewRouter()
	r.Post("/register", h.register)
	r.Post("/login", h.login)
	r.Post("/refresh", h.refresh)
	r.Post("/forgot_password", h.forgotPassword)
	r.Post("/reset_password", h.resetPassword)
	return r
}

type registerReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	Name     string `json:"name"`
}

type tokenPair struct {
	AccessToken  string      `json:"accessToken"`
	RefreshToken string      `json:"refreshToken"`
	TokenType    string      `json:"tokenType"`
	ExpiresIn    int         `json:"expiresIn"` // seconds
	User         models.User `json:"user"`
}

func (h *AuthHandler) register(w http.ResponseWriter, r *http.Request) {
	var req registerReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	req.Email = strings.TrimSpace(req.Email)
	if req.Email == "" || !strings.Contains(req.Email, "@") {
		writeError(w, http.StatusBadRequest, "invalid_email", "A valid email is required")
		return
	}
	if len(req.Password) < 8 {
		writeError(w, http.StatusBadRequest, "weak_password", "Password must be at least 8 characters")
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		logErr("hash password", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to hash password")
		return
	}

	var u models.User
	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		logErr("begin register", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to create user")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// Serialise first-user promotion. Without the transaction-scoped lock,
	// two simultaneous first-run registrations could both observe an empty
	// users table and both become instance admins.
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtext('synapse:first_instance_admin'))`); err != nil {
		logErr("lock first instance admin", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to create user")
		return
	}

	err = tx.QueryRow(r.Context(), `
		INSERT INTO users (email, password_hash, name, is_instance_admin)
		VALUES ($1, $2, $3, NOT EXISTS (SELECT 1 FROM users))
		RETURNING id, email, name, is_instance_admin, created_at, updated_at
	`, req.Email, hash, req.Name).Scan(&u.ID, &u.Email, &u.Name, &u.IsInstanceAdmin, &u.CreatedAt, &u.UpdatedAt)
	if err != nil {
		// Detect duplicate-email collisions by SQLSTATE + constraint name
		// rather than by string-matching the message text — Postgres minor
		// versions can rephrase errors, the protocol fields are stable.
		if synapsedb.IsUniqueViolationOn(err, "users_email_key") {
			writeError(w, http.StatusConflict, "email_taken", "An account with that email already exists")
			return
		}
		logErr("create user", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to create user")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		logErr("commit create user", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to create user")
		return
	}

	h.respondTokenPair(w, http.StatusCreated, u)
}

type loginReq struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

func (h *AuthHandler) login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	var u models.User
	err := h.DB.QueryRow(r.Context(), `
		SELECT id, email, name, password_hash, is_instance_admin, created_at, updated_at
		  FROM users WHERE email = $1
	`, req.Email).Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.IsInstanceAdmin, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "Email or password is incorrect")
		return
	}
	if err != nil {
		logErr("lookup user", err)
		writeError(w, http.StatusInternalServerError, "internal", "Login failed")
		return
	}

	if !auth.VerifyPassword(u.PasswordHash, req.Password) {
		writeError(w, http.StatusUnauthorized, "invalid_credentials", "Email or password is incorrect")
		return
	}

	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    u.ID,
		Action:     audit.ActionLogin,
		TargetType: audit.TargetUser,
		TargetID:   u.ID,
	})
	h.respondTokenPair(w, http.StatusOK, u)
}

type refreshReq struct {
	RefreshToken string `json:"refreshToken"`
}

func (h *AuthHandler) refresh(w http.ResponseWriter, r *http.Request) {
	var req refreshReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}

	claims, err := h.JWT.Verify(req.RefreshToken)
	if err != nil || claims.Kind != "refresh" {
		writeError(w, http.StatusUnauthorized, "invalid_refresh", "Refresh token is invalid or expired")
		return
	}

	var u models.User
	var passwordChangedAt *time.Time
	err = h.DB.QueryRow(r.Context(), `
		SELECT id, email, name, is_instance_admin, created_at, updated_at, password_changed_at
		  FROM users WHERE id = $1
	`, claims.UserID).Scan(&u.ID, &u.Email, &u.Name, &u.IsInstanceAdmin, &u.CreatedAt, &u.UpdatedAt, &passwordChangedAt)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "user_not_found", "User no longer exists")
		return
	}

	// Refresh JWTs are stateless, so a password reset can't delete them —
	// instead, refuse tokens issued before the last password change. The
	// change timestamp is truncated DOWN to whole seconds because iat has
	// second precision: a session started in the same second as the reset
	// survives (≤1s window), which is the right trade — the alternative
	// wrongly locks out the login the user performs right after resetting.
	if passwordChangedAt != nil && claims.IssuedAt != nil &&
		claims.IssuedAt.Time.Before(passwordChangedAt.Truncate(time.Second)) {
		writeError(w, http.StatusUnauthorized, "invalid_refresh", "Refresh token is invalid or expired")
		return
	}

	h.respondTokenPair(w, http.StatusOK, u)
}

// ---------- password reset (v1.25+) ----------

const (
	// resetTokenTTL bounds how long an emailed reset link works.
	resetTokenTTL = time.Hour
	// maxActiveResetTokens caps outstanding (unused, unexpired) tokens per
	// account — basic anti-abuse so an attacker can't fill someone's inbox
	// by hammering forgot_password. Once at the cap the endpoint still
	// answers 200 (no oracle) but mints nothing.
	maxActiveResetTokens = 3
)

type forgotPasswordReq struct {
	Email string `json:"email"`
}

// forgotPassword always answers 200 {ok:true} with an identical body —
// whether the account exists, email is configured, or the cap was hit.
// Anything else is a user-enumeration oracle. The actual email send is
// detached so Resend latency can't leak the difference either.
func (h *AuthHandler) forgotPassword(w http.ResponseWriter, r *http.Request) {
	var req forgotPasswordReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	reqEmail := strings.TrimSpace(req.Email)
	respond := func() { writeJSON(w, http.StatusOK, map[string]any{"ok": true}) }
	if reqEmail == "" || !strings.Contains(reqEmail, "@") {
		// Malformed input can't be an oracle — but it's also never a real
		// account; answer the same 200 and skip the lookup.
		respond()
		return
	}

	var userID string
	err := h.DB.QueryRow(r.Context(),
		`SELECT id FROM users WHERE email = $1`, reqEmail,
	).Scan(&userID)
	if err != nil {
		if !errors.Is(err, pgx.ErrNoRows) {
			logErr("forgot_password lookup", err)
		}
		respond()
		return
	}

	// Without a working sender AND a public URL there is no way to deliver
	// a usable link — don't mint undeliverable tokens.
	sender := resolveEmailSender(r.Context(), h.DB, h.Crypto, h.Email)
	if sender == nil || !sender.Enabled() || h.PublicURL == "" {
		respond()
		return
	}

	var active int
	if err := h.DB.QueryRow(r.Context(), `
		SELECT count(*) FROM password_reset_tokens
		 WHERE user_id = $1 AND used_at IS NULL AND expires_at > now()
	`, userID).Scan(&active); err != nil {
		logErr("forgot_password count active", err)
		respond()
		return
	}
	if active >= maxActiveResetTokens {
		respond()
		return
	}

	plain, hash, err := auth.GenerateTokenWithPrefix("syn_reset_")
	if err != nil {
		logErr("forgot_password generate token", err)
		respond()
		return
	}
	if _, err := h.DB.Exec(r.Context(), `
		INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
		VALUES ($1, $2, $3)
	`, userID, hash, time.Now().Add(resetTokenTTL)); err != nil {
		logErr("forgot_password insert token", err)
		respond()
		return
	}

	resetURL := strings.TrimRight(h.PublicURL, "/") + "/reset-password?token=" + url.QueryEscape(plain)
	msg := buildPasswordResetEmail(reqEmail, resetURL)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := sender.Send(ctx, msg); err != nil {
			logErr("send password reset email", err)
		}
	}()
	respond()
}

type resetPasswordReq struct {
	Token       string `json:"token"`
	NewPassword string `json:"newPassword"`
}

func (h *AuthHandler) resetPassword(w http.ResponseWriter, r *http.Request) {
	var req resetPasswordReq
	if err := readJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "bad_request", err.Error())
		return
	}
	// Password policy first (mirrors register) — and BEFORE consuming the
	// token, so a too-short password leaves the link usable for a retry.
	if len(req.NewPassword) < 8 {
		writeError(w, http.StatusBadRequest, "weak_password", "Password must be at least 8 characters")
		return
	}
	tokenHash := auth.HashToken(strings.TrimSpace(req.Token))

	newHash, err := auth.HashPassword(req.NewPassword)
	if err != nil {
		logErr("hash new password", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to reset password")
		return
	}

	tx, err := h.DB.Begin(r.Context())
	if err != nil {
		logErr("begin reset_password", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to reset password")
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()

	// FOR UPDATE serialises concurrent resets with the same token: the
	// loser blocks here, then re-evaluates the predicate post-commit and
	// sees used_at set → invalid_token, never a double consume.
	var tokenID, userID string
	err = tx.QueryRow(r.Context(), `
		SELECT id, user_id FROM password_reset_tokens
		 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
		 FOR UPDATE
	`, tokenHash).Scan(&tokenID, &userID)
	if errors.Is(err, pgx.ErrNoRows) {
		writeError(w, http.StatusBadRequest, "invalid_token", "Reset link is invalid or expired — request a new one")
		return
	}
	if err != nil {
		logErr("lookup reset token", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to reset password")
		return
	}

	if _, err := tx.Exec(r.Context(), `
		UPDATE users SET password_hash = $1, password_changed_at = now(), updated_at = now()
		 WHERE id = $2
	`, newHash, userID); err != nil {
		logErr("update password", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to reset password")
		return
	}
	// Consume this token; kill the user's other outstanding links too —
	// once one reset lands, older inbox emails must stop working.
	if _, err := tx.Exec(r.Context(),
		`UPDATE password_reset_tokens SET used_at = now() WHERE id = $1`, tokenID); err != nil {
		logErr("mark reset token used", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to reset password")
		return
	}
	if _, err := tx.Exec(r.Context(),
		`DELETE FROM password_reset_tokens WHERE user_id = $1 AND used_at IS NULL`, userID); err != nil {
		logErr("delete sibling reset tokens", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to reset password")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		logErr("commit reset_password", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to reset password")
		return
	}

	_ = audit.Record(r.Context(), h.DB, audit.Options{
		ActorID:    userID,
		Action:     audit.ActionPasswordReset,
		TargetType: audit.TargetUser,
		TargetID:   userID,
	})
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h *AuthHandler) respondTokenPair(w http.ResponseWriter, status int, u models.User) {
	access, err := h.JWT.IssueAccess(u.ID, u.Email)
	if err != nil {
		logErr("issue access", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to issue token")
		return
	}
	refresh, err := h.JWT.IssueRefresh(u.ID, u.Email)
	if err != nil {
		logErr("issue refresh", err)
		writeError(w, http.StatusInternalServerError, "internal", "Failed to issue token")
		return
	}

	writeJSON(w, status, tokenPair{
		AccessToken:  access,
		RefreshToken: refresh,
		TokenType:    "Bearer",
		ExpiresIn:    int(h.JWT.AccessTTL() / time.Second),
		User:         u,
	})
}
