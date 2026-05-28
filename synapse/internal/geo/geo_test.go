package geo

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestFlagEmoji(t *testing.T) {
	cases := map[string]string{
		"DE":  "🇩🇪",
		"US":  "🇺🇸",
		"BR":  "🇧🇷",
		"SG":  "🇸🇬",
		"":    "",
		"D":   "",
		"DEU": "",
		"d1":  "",
	}
	for in, want := range cases {
		if got := flagEmoji(in); got != want {
			t.Errorf("flagEmoji(%q): got %q want %q", in, got, want)
		}
	}
}

func TestProviderFromOrg(t *testing.T) {
	cases := map[string]string{
		"AS24940 Hetzner Online GmbH":             "Hetzner",
		"AS14061 DigitalOcean, LLC":               "DigitalOcean",
		"AS16509 Amazon.com, Inc.":                "AWS",
		"AS15169 Google LLC":                      "Google Cloud",
		"AS8075 Microsoft Corporation":            "Azure",
		"AS16276 OVH SAS":                         "OVH",
		"AS20473 Vultr Holdings, LLC":             "Vultr",
		"AS63949 Akamai Connected Cloud":          "Linode",
		"AS31898 Oracle Corporation":              "Oracle Cloud",
		"AS13335 Cloudflare, Inc.":                "Cloudflare",
		"AS54113 Fastly":                          "Fastly",
		"AS47583 Hostinger International Limited": "Hostinger",
		"AS12876 Scaleway S.A.S.":                 "Scaleway",
		"AS51167 Contabo GmbH":                    "Contabo",
		"AS60781 Leaseweb Netherlands B.V.":       "Leaseweb",
		"AS8560 IONOS SE":                         "IONOS",
		// Unknown providers fall through with the ASN stripped.
		"AS99999 Tiny Cloud Co.": "Tiny Cloud Co.",
		// Empty org returns empty string.
		"": "",
	}
	for in, want := range cases {
		if got := providerFromOrg(in); got != want {
			t.Errorf("providerFromOrg(%q): got %q want %q", in, got, want)
		}
	}
}

func TestASNFromOrg(t *testing.T) {
	if got := asnFromOrg("AS24940 Hetzner Online GmbH"); got != "AS24940" {
		t.Errorf("got %q", got)
	}
	if got := asnFromOrg("Hetzner (no ASN)"); got != "" {
		t.Errorf("expected empty, got %q", got)
	}
}

func TestCache_CachesHits(t *testing.T) {
	var hits int64
	fake := &fakeResolver{
		fn: func(ip string) (Info, error) {
			atomic.AddInt64(&hits, 1)
			return Info{IP: ip, Country: "DE", CountryFlag: "🇩🇪", Provider: "Hetzner"}, nil
		},
	}
	c := NewCache(fake)
	for i := 0; i < 5; i++ {
		info, err := c.Lookup(context.Background(), "72.60.3.159")
		if err != nil {
			t.Fatalf("iter %d: %v", i, err)
		}
		if info.Country != "DE" {
			t.Errorf("iter %d: wrong country %q", i, info.Country)
		}
	}
	if got := atomic.LoadInt64(&hits); got != 1 {
		t.Errorf("upstream calls: got %d want 1 (cache should have hit on later calls)", got)
	}
}

func TestCache_DoesNotCacheErrors(t *testing.T) {
	var calls int64
	fake := &fakeResolver{
		fn: func(ip string) (Info, error) {
			n := atomic.AddInt64(&calls, 1)
			if n == 1 {
				return Info{}, errors.New("transient")
			}
			return Info{IP: ip, Country: "DE"}, nil
		},
	}
	c := NewCache(fake)
	if _, err := c.Lookup(context.Background(), "x"); err == nil {
		t.Errorf("expected error on first call")
	}
	// Second call must retry — the previous error wasn't cached.
	info, err := c.Lookup(context.Background(), "x")
	if err != nil {
		t.Errorf("unexpected error on retry: %v", err)
	}
	if info.Country != "DE" {
		t.Errorf("retry: country %q", info.Country)
	}
	if got := atomic.LoadInt64(&calls); got != 2 {
		t.Errorf("expected exactly 2 upstream calls, got %d", got)
	}
}

func TestCache_EmptyIPNoOp(t *testing.T) {
	c := NewCache(&fakeResolver{fn: func(ip string) (Info, error) {
		t.Fatal("upstream must not be called for empty ip")
		return Info{}, nil
	}})
	if _, err := c.Lookup(context.Background(), ""); err != nil {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestIPInfoResolver_HappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/72.60.3.159/json" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		fmt.Fprintln(w, `{"ip":"72.60.3.159","city":"Nuremberg","region":"Bavaria","country":"DE","loc":"49.4521,11.0767","org":"AS24940 Hetzner Online GmbH","postal":"90402","timezone":"Europe/Berlin"}`)
	}))
	defer srv.Close()
	r := &ipinfoResolver{BaseURL: srv.URL}
	info, err := r.Lookup(context.Background(), "72.60.3.159")
	if err != nil {
		t.Fatal(err)
	}
	if info.Country != "DE" || info.CountryFlag != "🇩🇪" {
		t.Errorf("country mismatch: %+v", info)
	}
	if info.Provider != "Hetzner" {
		t.Errorf("provider: got %q want Hetzner", info.Provider)
	}
	if info.City != "Nuremberg" {
		t.Errorf("city: %q", info.City)
	}
	if info.ASN != "AS24940" {
		t.Errorf("asn: %q", info.ASN)
	}
}

func TestIPInfoResolver_503ReturnsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))
	defer srv.Close()
	r := &ipinfoResolver{BaseURL: srv.URL}
	info, err := r.Lookup(context.Background(), "8.8.8.8")
	if err == nil {
		t.Fatalf("expected error, got %+v", info)
	}
	// Caller can still render the IP even when upstream fails.
	if info.IP != "8.8.8.8" {
		t.Errorf("expected IP preserved on error, got %q", info.IP)
	}
}

type fakeResolver struct {
	fn func(string) (Info, error)
}

func (f *fakeResolver) Lookup(_ context.Context, ip string) (Info, error) {
	return f.fn(ip)
}
