// Package dns — Verifier is the background worker that flips
// auto-configured deployment_domains rows from 'pending' to 'active'
// once the A record we minted on the operator's behalf has propagated.
//
// Lifecycle of an auto-configured row, end-to-end:
//
//  1. Operator submits a domain on the dashboard. POST /domains inserts
//     a row at status='pending'.
//  2. Operator clicks "auto-configure" (or it fires automatically on
//     submit, PR #85). The handler calls Cloudflare's API to upsert an
//     A record pointing at SYNAPSE_PUBLIC_IP, then stamps the row
//     auto_configured=true. Status STAYS 'pending'.
//  3. This Verifier wakes up every Interval (~15s), finds rows where
//     auto_configured=true AND status='pending' AND dns_verified_at
//     IS NULL, and resolves the domain. Match → flip to 'active' +
//     audit. Mismatch → leave alone, retry next tick. Older than
//     MaxAge (5min) → flip to 'failed' with a "didn't propagate" hint.
//     The operator can re-verify manually via POST /verify any time.
//
// The verifier makes NO Cloudflare calls and runs no DNS-provider logic —
// it's a DNS-resolution loop. It does NOT rebake containers itself, but
// when a row flips pending→active it fires the optional OnActivated hook
// (see the struct field) so a higher layer can refresh the deployment's
// CONVEX_CLOUD_ORIGIN / CONVEX_SITE_ORIGIN — the same rebake the
// synchronous POST /verify endpoint does. That hook is REQUIRED for
// correctness on role='site' domains: without it an auto-verified site
// domain leaves the container's CONVEX_SITE_ORIGIN stale, and (unlike the
// manual path) there's no operator action that can fix an already-active
// row. The rebake runs in the background, so the sweep itself stays fast
// and never holds the advisory lock across a container recreate.
package dns

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Iann29/synapse/internal/audit"
	synapsedb "github.com/Iann29/synapse/internal/db"
)

// Resolver is the subset of *net.Resolver the verifier uses.
// net.DefaultResolver satisfies it. Tests inject a stub that returns
// canned IPs so the suite doesn't need real-internet DNS.
type Resolver interface {
	LookupIP(ctx context.Context, network, host string) ([]net.IP, error)
}

// Clock is a tiny seam for tests so we don't need time.Sleep to make
// rows look "older than MaxAge". Production passes nil and the
// verifier falls back to time.Now.
type Clock interface {
	Now() time.Time
}

// Verifier scans deployment_domains for auto-configured rows still
// pending DNS propagation and flips them when they land.
type Verifier struct {
	DB     *pgxpool.Pool
	Logger *slog.Logger

	// Resolver is overridable in tests. nil → ExternalResolver.
	Resolver Resolver

	// ExpectedIP is the IPv4 the auto-configure flow points A records
	// at — same anchor SYNAPSE_PUBLIC_IP feeds the manual verify path.
	// Empty disables the verifier (the loop logs once at boot and
	// exits — verification needs an anchor IP).
	ExpectedIP string

	// Interval is the tick period. <= 0 → 15s.
	Interval time.Duration

	// MaxAge is how long we wait for DNS to propagate before flipping
	// a row to 'failed' with last_dns_error="DNS did not propagate
	// within <MaxAge>". <= 0 → 5 minutes.
	MaxAge time.Duration

	// LookupTimeout caps each DNS lookup so a flaky resolver doesn't
	// stall the loop. <= 0 → 5s. Same value the existing
	// verifyDomainDNS in internal/api uses.
	LookupTimeout time.Duration

	// Clock is overridable in tests so MaxAge can fire without a
	// real-time wait. nil → real time.Now().
	Clock Clock

	// OnActivated, when set, is invoked once per row that this loop flips
	// from 'pending' to 'active' (after the flip commits and the audit
	// event is written). The server wires it to the deployments handler's
	// container rebake so a freshly auto-verified custom domain refreshes
	// CONVEX_CLOUD_ORIGIN / CONVEX_SITE_ORIGIN in the running container —
	// the SAME refresh the synchronous POST /verify endpoint performs.
	//
	// Why this matters (and why the loop is no longer "restart-free"): a
	// role='site' domain that lands via this loop would otherwise leave the
	// container's CONVEX_SITE_ORIGIN frozen at provision-time (the cloud
	// URL), which (a) breaks Better Auth's cookie/callback origin and the
	// site-proxy host inside the deployment, and (b) makes `npx convex`'s
	// GET /get_canonical_urls hand the cloud URL back to the CLI, which
	// then writes the wrong NEXT_PUBLIC_CONVEX_SITE_URL. The manual /verify
	// escape hatch can't fix an already-active row (its rebake only fires
	// on the pending→active transition), so this loop must own the rebake.
	// See docs/CONVEX_SITE_ORIGIN.md.
	//
	// Best-effort and non-blocking by contract — the wiring runs the rebake
	// in the background so a ~15s container recreate never stalls the DNS
	// sweep (or holds the advisory lock). nil disables it (single-purpose
	// DNS loop, e.g. in tests that only assert status flips).
	OnActivated func(deploymentID, deploymentName string)
}

// pendingRow is the slice of deployment_domains a single tick acts
// on. Kept tiny — we only need what's required to (a) decide whether
// to flip to active, (b) decide whether the row has aged out, and
// (c) emit an audit event with enough context.
//
// deadlineAnchor (v1.6.8+) is what we measure "did it propagate in
// time" against. Pre-v1.6.8 we used created_at, which silently
// punished operators who cadastraram a credential days after adding
// the domain — the deadline was already blown the second they hit
// "Auto-configure DNS", flipping the row to 'failed' immediately
// with "did not propagate within 5m0s" even though Cloudflare had
// just acknowledged the upsert. updated_at gets bumped on every
// write to the row (auto_configure, verify, etc), so it tracks
// "time since we last touched it" — exactly the right anchor.
type pendingRow struct {
	id             string
	domain         string
	deploymentID   string
	deploymentName string
	teamID         string
	deadlineAnchor time.Time
}

// defaults applied via accessors so callers can leave fields zero.
func (v *Verifier) interval() time.Duration {
	if v.Interval <= 0 {
		return 15 * time.Second
	}
	return v.Interval
}

func (v *Verifier) maxAge() time.Duration {
	if v.MaxAge <= 0 {
		return 5 * time.Minute
	}
	return v.MaxAge
}

func (v *Verifier) lookupTimeout() time.Duration {
	if v.LookupTimeout <= 0 {
		return 5 * time.Second
	}
	return v.LookupTimeout
}

// resolver returns the configured Resolver, falling back to
// ExternalResolver so production lookups dial 1.1.1.1 directly
// instead of going through the container's possibly-broken
// /etc/resolv.conf. See dns/resolver.go for the rationale.
func (v *Verifier) resolver() Resolver {
	if v.Resolver != nil {
		return v.Resolver
	}
	return ExternalResolver()
}

func (v *Verifier) now() time.Time {
	if v.Clock != nil {
		return v.Clock.Now()
	}
	return time.Now()
}

func (v *Verifier) logger() *slog.Logger {
	if v.Logger != nil {
		return v.Logger
	}
	return slog.Default()
}

// Start blocks until ctx is cancelled, running one Tick per Interval.
// Returns a non-nil error only when the verifier refuses to start
// (e.g. ExpectedIP empty); in-flight tick errors are logged and
// swallowed so a transient DB blip doesn't kill the loop.
//
// Multi-node coordination: each tick is wrapped in
// pg_try_advisory_lock(LockDNSVerifier). With N synapse nodes,
// exactly one runs the sweep per tick; followers observe the lock as
// held and skip silently. Single-node always acquires.
func (v *Verifier) Start(ctx context.Context) error {
	logger := v.logger()
	if v.ExpectedIP == "" {
		logger.Info("dns verifier: SYNAPSE_PUBLIC_IP unset, verifier disabled")
		return nil
	}
	interval := v.interval()
	logger.Info("dns verifier starting",
		"interval", interval,
		"max_age", v.maxAge(),
		"expected_ip", v.ExpectedIP)

	// Run one tick immediately so a fresh server doesn't wait
	// `interval` before reconciling already-pending rows from a
	// previous process.
	v.tickWithLock(ctx)

	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			logger.Info("dns verifier stopping")
			return nil
		case <-t.C:
			v.tickWithLock(ctx)
		}
	}
}

// tickWithLock acquires the verifier's advisory lock and runs one
// sweep. Returns silently when another node holds the lock.
func (v *Verifier) tickWithLock(ctx context.Context) {
	logger := v.logger()
	acquired, err := synapsedb.WithTryAdvisoryLock(ctx, v.DB, synapsedb.LockDNSVerifier,
		func(ctx context.Context) error {
			v.Tick(ctx)
			return nil
		})
	if err != nil {
		logger.Warn("dns verifier: advisory-lock acquire failed", "err", err)
		return
	}
	if !acquired {
		logger.Debug("dns verifier: another node holds the sweep lock; skipping tick")
	}
}

// Tick runs a single sweep. Exposed (vs unexported `tick`) so tests
// can drive the loop deterministically without spinning up Start +
// time.NewTicker. Errors are logged, never returned — same
// philosophy as health.Worker.sweep.
func (v *Verifier) Tick(ctx context.Context) {
	logger := v.logger()
	rows, err := v.loadPending(ctx)
	if err != nil {
		logger.Error("dns verifier: load pending rows", "err", err)
		return
	}
	if len(rows) == 0 {
		// No work this tick — early exit so an idle cluster doesn't
		// pay for resolver round-trips it doesn't need.
		return
	}

	maxAge := v.maxAge()
	now := v.now()
	for _, row := range rows {
		// Aged-out path: if a row has been sitting pending past
		// MaxAge since the last write (auto_configure, verify, etc.),
		// give up and surface a "didn't propagate" hint so the
		// operator knows to investigate (forgot to set the IP,
		// Cloudflare proxied the record, registrar didn't apply NS,
		// etc.). Manual /verify can still re-run any time, which
		// bumps updated_at and resets this deadline naturally.
		if now.Sub(row.deadlineAnchor) > maxAge {
			v.markFailed(ctx, row, "DNS did not propagate within "+maxAge.String())
			continue
		}
		// Otherwise: try to resolve the domain. Match → flip active
		// + audit. Anything else → leave the row alone, surface the
		// error string on last_dns_error so the dashboard renders a
		// "still propagating" state.
		v.checkAndFlip(ctx, row)
	}
}

// loadPending returns rows the verifier should consider this tick.
// We deliberately scope to auto_configured=true so the manual flow
// (operator-managed A records) keeps owning its own propagation
// timing — they may want to leave a row pending for hours while
// they wait on a registrar TTL.
//
// Joins to deployments + teams pull the audit-context fields in one
// round-trip; teams.id is derived via projects.team_id.
func (v *Verifier) loadPending(ctx context.Context) ([]pendingRow, error) {
	rs, err := v.DB.Query(ctx, `
		SELECT dd.id, dd.domain, d.id, d.name, p.team_id, dd.updated_at
		  FROM deployment_domains dd
		  JOIN deployments d ON d.id = dd.deployment_id
		  JOIN projects p ON p.id = d.project_id
		 WHERE dd.auto_configured = true
		   AND dd.status = 'pending'
		   AND dd.dns_verified_at IS NULL
		 ORDER BY dd.created_at ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rs.Close()

	var out []pendingRow
	for rs.Next() {
		var r pendingRow
		if err := rs.Scan(&r.id, &r.domain, &r.deploymentID, &r.deploymentName, &r.teamID, &r.deadlineAnchor); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rs.Err()
}

// checkAndFlip resolves one domain and flips the row when it matches
// ExpectedIP. Mismatch → update last_dns_error so the dashboard
// renders something actionable, but leave status='pending' so the
// next tick retries. Resolver errors are treated like a mismatch
// (same surface — operator only cares "is it active yet?").
func (v *Verifier) checkAndFlip(ctx context.Context, row pendingRow) {
	logger := v.logger()
	lookupCtx, cancel := context.WithTimeout(ctx, v.lookupTimeout())
	defer cancel()

	ips, err := v.resolver().LookupIP(lookupCtx, "ip4", row.domain)
	if err != nil {
		// Pending stays pending. last_dns_error gets the hint so the
		// dashboard can surface "DNS lookup failed: NXDOMAIN" instead
		// of a stale "" state. We also DON'T audit the failure —
		// per the brief, audits would just spam.
		v.recordPendingError(ctx, row.id, "lookup failed: "+err.Error())
		logger.Debug("dns verifier: lookup error",
			"domain", row.domain, "err", err)
		return
	}
	for _, ip := range ips {
		if ip.String() == v.ExpectedIP {
			v.flipToActive(ctx, row)
			return
		}
	}
	// No match yet. Build a "got X, expected Y" hint for the row.
	got := make([]byte, 0, 32)
	for i, ip := range ips {
		if i > 0 {
			got = append(got, ',', ' ')
		}
		got = append(got, ip.String()...)
	}
	hint := "expected " + v.ExpectedIP + ", got " + string(got)
	if len(ips) == 0 {
		hint = "no A records returned"
	}
	v.recordPendingError(ctx, row.id, hint)
}

// flipToActive runs the UPDATE that promotes the row + emits the
// audit event. Both writes are best-effort — a transient DB blip
// just means the next tick retries (the WHERE clause re-checks
// status='pending' so we never double-flip).
func (v *Verifier) flipToActive(ctx context.Context, row pendingRow) {
	logger := v.logger()
	tag, err := v.DB.Exec(ctx, `
		UPDATE deployment_domains
		   SET status = 'active',
		       dns_verified_at = now(),
		       last_dns_error = NULL,
		       updated_at = now()
		 WHERE id = $1
		   AND status = 'pending'
	`, row.id)
	if err != nil {
		logger.Error("dns verifier: flip to active",
			"domain", row.domain, "err", err)
		return
	}
	if tag.RowsAffected() == 0 {
		// Lost the race to the manual /verify endpoint or another
		// node that grabbed the lock between our SELECT and UPDATE.
		// Either way the row is no longer pending — drop the audit.
		return
	}

	if err := audit.Record(ctx, v.DB, audit.Options{
		TeamID:     row.teamID,
		Action:     audit.ActionVerifyDomain,
		TargetType: audit.TargetDomain,
		TargetID:   row.id,
		Metadata: map[string]any{
			"deploymentId":   row.deploymentID,
			"deploymentName": row.deploymentName,
			"domain":         row.domain,
			"status":         "active",
			"source":         "verifier", // distinguishes from manual /verify
		},
	}); err != nil && !errors.Is(err, context.Canceled) {
		// audit.Record already logged at WARN — we just don't want to
		// surface here.
	}

	logger.Info("dns verifier: domain active",
		"domain", row.domain,
		"deployment_id", row.deploymentID,
		"deployment_name", row.deploymentName)

	// Rebake the deployment's container so the just-activated domain takes
	// effect in CONVEX_CLOUD_ORIGIN / CONVEX_SITE_ORIGIN. Fired only on a
	// real flip (RowsAffected > 0 above), so exactly one node triggers it.
	// The hook is non-blocking by contract (see the struct doc).
	if v.OnActivated != nil {
		v.OnActivated(row.deploymentID, row.deploymentName)
	}
}

// markFailed flips an aged-out row to 'failed' with a "didn't
// propagate" hint. We DON'T audit this transition — the operator
// sees the status in the UI and can re-verify any time.
func (v *Verifier) markFailed(ctx context.Context, row pendingRow, reason string) {
	logger := v.logger()
	tag, err := v.DB.Exec(ctx, `
		UPDATE deployment_domains
		   SET status = 'failed',
		       last_dns_error = $2,
		       updated_at = now()
		 WHERE id = $1
		   AND status = 'pending'
	`, row.id, reason)
	if err != nil {
		logger.Error("dns verifier: flip to failed",
			"domain", row.domain, "err", err)
		return
	}
	if tag.RowsAffected() == 0 {
		return
	}
	logger.Warn("dns verifier: domain failed propagation deadline",
		"domain", row.domain,
		"deployment_id", row.deploymentID,
		"deployment_name", row.deploymentName,
		"reason", reason)
}

// recordPendingError stamps last_dns_error on a still-pending row so
// the dashboard can render "still propagating: <reason>" without a
// status flip. Best-effort — silent on error.
func (v *Verifier) recordPendingError(ctx context.Context, id, reason string) {
	if reason == "" {
		return
	}
	if len(reason) > 1024 {
		reason = reason[:1024]
	}
	_, _ = v.DB.Exec(ctx, `
		UPDATE deployment_domains
		   SET last_dns_error = $2,
		       updated_at = now()
		 WHERE id = $1
		   AND status = 'pending'
	`, id, reason)
}
