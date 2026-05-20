package config

import (
	"testing"
	"time"
)

func TestLoadReadsBaseConfig(t *testing.T) {
	t.Setenv("SYNAPSE_JWT_SECRET", "test-secret-test-secret-test-secret-test-secret")
	t.Setenv("SYNAPSE_DB_URL", "postgres://synapse:synapse@localhost:5432/synapse?sslmode=disable")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(cfg.JWTSecret) == 0 {
		t.Errorf("JWTSecret: empty")
	}
	if cfg.DBURL == "" {
		t.Errorf("DBURL: empty")
	}
}

// The default access TTL is load-bearing for the dashboard UX: a session
// that expires inside a typical work session forces operators to /login
// repeatedly. We bumped from 15m to 24h alongside the dashboard's silent
// refresh-on-401 retry; this test pins the default so a stray edit can't
// regress to the old hostile value.
func TestLoadDefaultsAccessTTLToOneDay(t *testing.T) {
	t.Setenv("SYNAPSE_JWT_SECRET", "test-secret-test-secret-test-secret-test-secret")
	t.Setenv("SYNAPSE_DB_URL", "postgres://synapse:synapse@localhost:5432/synapse?sslmode=disable")
	t.Setenv("SYNAPSE_JWT_ACCESS_TTL", "")  // explicit empty → use default
	t.Setenv("SYNAPSE_JWT_REFRESH_TTL", "") // ditto

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.JWTAccessTTL != 24*time.Hour {
		t.Errorf("JWTAccessTTL: got %v, want 24h", cfg.JWTAccessTTL)
	}
	if cfg.JWTRefreshTTL != 720*time.Hour {
		t.Errorf("JWTRefreshTTL: got %v, want 720h", cfg.JWTRefreshTTL)
	}
}

// Operators who want a stricter TTL for compliance can still set their
// own value via env — verify the override path is intact.
func TestLoadHonoursAccessTTLOverride(t *testing.T) {
	t.Setenv("SYNAPSE_JWT_SECRET", "test-secret-test-secret-test-secret-test-secret")
	t.Setenv("SYNAPSE_DB_URL", "postgres://synapse:synapse@localhost:5432/synapse?sslmode=disable")
	t.Setenv("SYNAPSE_JWT_ACCESS_TTL", "30m")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.JWTAccessTTL != 30*time.Minute {
		t.Errorf("JWTAccessTTL: got %v, want 30m", cfg.JWTAccessTTL)
	}
}
