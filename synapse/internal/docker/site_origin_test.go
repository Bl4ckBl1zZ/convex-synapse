package docker

import "testing"

// The backend mounts HTTP actions under /http on the cloud port (3210) and
// re-exposes them at natural paths via the site proxy (3211). When no site URL
// is configured — host-port mode, pre-site deployments, adopted backends —
// CONVEX_SITE_ORIGIN must name the /http prefix rather than the bare cloud
// origin, or everything that derives a URL from CONVEX_SITE_URL inside the
// container (Better Auth's JWKS endpoint above all) resolves to a 404.

func TestSiteOriginFallback_AppendsHTTPPrefix(t *testing.T) {
	cases := []struct {
		name  string
		given string
		want  string
	}{
		{
			name:  "host-port loopback",
			given: "http://127.0.0.1:42001",
			want:  "http://127.0.0.1:42001/http",
		},
		{
			name:  "public host-anchored origin",
			given: "https://convex.example.test:8443",
			want:  "https://convex.example.test:8443/http",
		},
		{
			name:  "trailing slash is not doubled",
			given: "http://127.0.0.1:42001/",
			want:  "http://127.0.0.1:42001/http",
		},
		{
			name:  "already prefixed is left alone",
			given: "http://127.0.0.1:42001/http",
			want:  "http://127.0.0.1:42001/http",
		},
		{
			name:  "empty origin stays empty",
			given: "",
			want:  "",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := SiteOriginFallback(tc.given); got != tc.want {
				t.Errorf("SiteOriginFallback(%q) = %q, want %q", tc.given, got, tc.want)
			}
		})
	}
}
