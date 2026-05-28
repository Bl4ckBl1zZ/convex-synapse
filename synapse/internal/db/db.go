// Package db wraps the Postgres connection pool.
package db

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Connect opens a pgx pool with sane defaults and verifies connectivity.
func Connect(ctx context.Context, dsn string) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		return nil, fmt.Errorf("parse dsn: %w", err)
	}
	// Default pool size is 20 for production. An explicit `pool_max_conns` in
	// the DSN wins (ParseConfig already applied it) — the integration-test
	// harness sets a small value so dozens of parallel per-test pools don't
	// exhaust postgres max_connections.
	if !strings.Contains(dsn, "pool_max_conns") {
		cfg.MaxConns = 20
	}
	// Keep 2 warm connections in production. As with MaxConns, an explicit
	// `pool_min_conns` in the DSN wins (ParseConfig already applied it) — the
	// integration-test harness sets it to 0 so dozens of idle parallel per-test
	// pools don't each pin 2 connections and exhaust postgres.
	if !strings.Contains(dsn, "pool_min_conns") {
		cfg.MinConns = 2
	}
	cfg.MaxConnLifetime = time.Hour
	cfg.MaxConnIdleTime = 30 * time.Minute

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pool: %w", err)
	}

	pingCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := pool.Ping(pingCtx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}

	return pool, nil
}
