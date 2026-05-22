// Package geo resolves an IPv4 address into human-readable location +
// provider metadata. Used by the dashboard's topology panel so the
// operator sees "🇩🇪 Hetzner · Nuremberg" instead of a bare IP.
//
// Two design decisions worth flagging:
//
//  1. In-memory cache only. The set of IPs we ever look up is tiny (one
//     per registered Synapse host — today that's just the local VPS),
//     and the answer doesn't change. Disk persistence would add
//     migration + cleanup with zero operational benefit; we accept
//     re-fetching once per process restart.
//
//  2. Upstream: ipinfo.io free tier (no API key, ~1k req/day per IP).
//     Since we cache, each Synapse instance burns at most one request
//     per process lifetime per IP. If ipinfo goes down or rate-limits,
//     we return Info{IP: ip} with empty fields rather than 500 the
//     caller — the panel renders a graceful "unknown region" state.
//
//  3. Operator override: SYNAPSE_HOST_GEO_OVERRIDE lets an air-gapped
//     install hard-code the values without any outbound call. Format:
//     "country=DE;region=Nuremberg;provider=Hetzner". Empty values are
//     fine — they fall through to the API.
package geo

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Info is the resolved geolocation. JSON-tagged so it can be embedded
// directly in topology responses without a second mapping layer.
type Info struct {
	IP          string `json:"ip"`
	Country     string `json:"country,omitempty"`     // ISO-2 e.g. "DE"
	CountryFlag string `json:"countryFlag,omitempty"` // emoji "🇩🇪"
	City        string `json:"city,omitempty"`
	Region      string `json:"region,omitempty"`
	Provider    string `json:"provider,omitempty"` // "Hetzner", "DigitalOcean", "AWS", ...
	ASN         string `json:"asn,omitempty"`
}

// Resolver looks up Info for an IP. The default implementation
// (DefaultResolver) talks to ipinfo.io; tests inject stubs.
type Resolver interface {
	Lookup(ctx context.Context, ip string) (Info, error)
}

// Cache wraps any Resolver with an in-memory, never-evict cache. Safe
// for concurrent use. Misses (errors from the underlying Resolver) are
// NOT cached so a transient ipinfo outage doesn't poison the slot —
// the next call retries.
type Cache struct {
	inner Resolver
	mu    sync.RWMutex
	hits  map[string]Info
}

func NewCache(inner Resolver) *Cache {
	return &Cache{inner: inner, hits: map[string]Info{}}
}

func (c *Cache) Lookup(ctx context.Context, ip string) (Info, error) {
	if ip == "" {
		return Info{}, nil
	}
	c.mu.RLock()
	if info, ok := c.hits[ip]; ok {
		c.mu.RUnlock()
		return info, nil
	}
	c.mu.RUnlock()

	// Operator override beats any upstream call.
	if override := loadOverride(ip); override != nil {
		c.store(ip, *override)
		return *override, nil
	}

	info, err := c.inner.Lookup(ctx, ip)
	if err != nil {
		return Info{IP: ip}, err
	}
	c.store(ip, info)
	return info, nil
}

func (c *Cache) store(ip string, info Info) {
	c.mu.Lock()
	c.hits[ip] = info
	c.mu.Unlock()
}

// ipinfoResolver hits https://ipinfo.io/<ip>/json. Free tier requires
// no API key for basic geolocation; we never request fields beyond
// what the free tier returns.
type ipinfoResolver struct {
	BaseURL string
	Client  *http.Client
}

// DefaultResolver is the production wiring — 4-second timeout, default
// HTTP client. Wrap with NewCache before use.
var DefaultResolver Resolver = &ipinfoResolver{
	BaseURL: "https://ipinfo.io",
	Client:  &http.Client{Timeout: 4 * time.Second},
}

type ipinfoResp struct {
	IP      string `json:"ip"`
	City    string `json:"city"`
	Region  string `json:"region"`
	Country string `json:"country"`
	Loc     string `json:"loc"`
	Org     string `json:"org"`
}

func (r *ipinfoResolver) Lookup(ctx context.Context, ip string) (Info, error) {
	base := r.BaseURL
	if base == "" {
		base = "https://ipinfo.io"
	}
	client := r.Client
	if client == nil {
		client = http.DefaultClient
	}
	url := strings.TrimRight(base, "/") + "/" + ip + "/json"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Info{IP: ip}, err
	}
	req.Header.Set("Accept", "application/json")
	res, err := client.Do(req)
	if err != nil {
		return Info{IP: ip}, fmt.Errorf("ipinfo fetch: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return Info{IP: ip}, fmt.Errorf("ipinfo HTTP %d", res.StatusCode)
	}
	var p ipinfoResp
	if err := json.NewDecoder(res.Body).Decode(&p); err != nil {
		return Info{IP: ip}, fmt.Errorf("decode ipinfo: %w", err)
	}
	return Info{
		IP:          firstNonEmpty(p.IP, ip),
		Country:     p.Country,
		CountryFlag: flagEmoji(p.Country),
		City:        p.City,
		Region:      p.Region,
		Provider:    providerFromOrg(p.Org),
		ASN:         asnFromOrg(p.Org),
	}, nil
}

// flagEmoji maps a 2-letter ISO country code to the regional-indicator
// pair that renders as the country flag. Returns "" for empty/invalid
// input so the caller can safely concatenate.
func flagEmoji(country string) string {
	c := strings.ToUpper(strings.TrimSpace(country))
	if len(c) != 2 {
		return ""
	}
	const base rune = 0x1F1E6 // regional indicator A
	var b strings.Builder
	for _, r := range c {
		if r < 'A' || r > 'Z' {
			return ""
		}
		b.WriteRune(base + (r - 'A'))
	}
	return b.String()
}

// providerFromOrg extracts a short cloud-provider label from ipinfo's
// `org` string. Examples:
//
//	"AS24940 Hetzner Online GmbH"      → "Hetzner"
//	"AS14061 DigitalOcean, LLC"        → "DigitalOcean"
//	"AS16509 Amazon.com, Inc."          → "AWS"
//	"AS15169 Google LLC"                → "Google Cloud"
//	"AS8075 Microsoft Corporation"      → "Azure"
//
// Anything we don't recognise falls through to the org name with the
// ASN prefix stripped, so an unusual provider still renders cleanly.
var asnPrefix = regexp.MustCompile(`^AS\d+\s+`)

func providerFromOrg(org string) string {
	o := strings.TrimSpace(asnPrefix.ReplaceAllString(org, ""))
	low := strings.ToLower(o)
	switch {
	case strings.Contains(low, "hetzner"):
		return "Hetzner"
	case strings.Contains(low, "digitalocean"):
		return "DigitalOcean"
	case strings.Contains(low, "amazon"):
		return "AWS"
	case strings.Contains(low, "google"):
		return "Google Cloud"
	case strings.Contains(low, "microsoft"):
		return "Azure"
	case strings.Contains(low, "ovh"):
		return "OVH"
	case strings.Contains(low, "vultr"):
		return "Vultr"
	case strings.Contains(low, "linode") || strings.Contains(low, "akamai"):
		return "Linode"
	case strings.Contains(low, "oracle"):
		return "Oracle Cloud"
	case strings.Contains(low, "cloudflare"):
		return "Cloudflare"
	case strings.Contains(low, "fastly"):
		return "Fastly"
	}
	return o
}

// asnFromOrg pulls the AS number prefix out of an ipinfo org string.
// "AS24940 Hetzner Online GmbH" → "AS24940". Returns "" when the
// prefix is missing.
var asnRe = regexp.MustCompile(`^AS\d+`)

func asnFromOrg(org string) string {
	return asnRe.FindString(strings.TrimSpace(org))
}

// loadOverride checks SYNAPSE_HOST_GEO_OVERRIDE for a hardcoded answer.
// Format: "country=DE;region=Nuremberg;provider=Hetzner;city=Nuremberg".
// Unknown keys are ignored. Empty env var returns nil → fall through to
// the upstream API. Always overrides for ALL IPs (single-VPS today is
// the only operational mode; future multi-VPS will key by IP).
func loadOverride(ip string) *Info {
	raw := strings.TrimSpace(os.Getenv("SYNAPSE_HOST_GEO_OVERRIDE"))
	if raw == "" {
		return nil
	}
	info := Info{IP: ip}
	for _, part := range strings.Split(raw, ";") {
		kv := strings.SplitN(strings.TrimSpace(part), "=", 2)
		if len(kv) != 2 {
			continue
		}
		k := strings.ToLower(strings.TrimSpace(kv[0]))
		v := strings.TrimSpace(kv[1])
		switch k {
		case "country":
			info.Country = strings.ToUpper(v)
			info.CountryFlag = flagEmoji(v)
		case "region":
			info.Region = v
		case "city":
			info.City = v
		case "provider":
			info.Provider = v
		}
	}
	return &info
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
