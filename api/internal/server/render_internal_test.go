package server

import (
	"errors"
	"testing"
)

func TestValidateRenderOrigin(t *testing.T) {
	cases := []struct {
		name         string
		app, render  string
		wantRejected bool
	}{
		{"distinct hostnames", "https://app.example.com", "https://render.example.com", false},
		{"distinct hosts same port", "http://localhost:8080", "http://127.0.0.1:8080", false},
		{"same origin", "https://app.example.com", "https://app.example.com", true},
		{"same origin host case", "https://app.example.com", "https://APP.EXAMPLE.COM", true},
		{"same origin scheme case", "https://app.example.com", "HTTPS://app.example.com", true},
		{"same origin default HTTPS port", "https://app.example.com", "https://app.example.com:443", true},
		{"same origin zero-padded port", "https://app.example.com", "https://app.example.com:0443", true},
		{"same origin default HTTP port", "http://app.example.com", "http://app.example.com:80", true},
		{"same origin IDNA hostname", "https://bücher.example", "https://xn--bcher-kva.example", true},
		{"same origin non-transitional IDNA hostname", "https://faß.de", "https://xn--fa-hia.de", true},
		{"same origin equivalent IPv6", "https://[0:0:0:0:0:0:0:1]", "https://[::1]", true},
		{"same host terminal root dot", "https://app.example.com", "https://app.example.com.", true},
		{"distinct underscore hostnames", "https://app_docs.corp.internal", "https://render_docs.corp.internal", false},
		{"same underscore hostname", "https://docs_internal.corp", "https://DOCS_INTERNAL.CORP", true},
		{"ambiguous WHATWG IPv4 hostname", "http://127.1:8080", "http://127.0.0.1:8080", true},
		{"same host different scheme", "http://app.example.com", "https://app.example.com", true},
		{"same host different port", "http://app.example.com:8080", "http://app.example.com:9090", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateRenderOrigin(tc.app, tc.render)
			if got := err != nil; got != tc.wantRejected {
				t.Fatalf("ValidateRenderOrigin(%q, %q) error = %v, want rejected=%v", tc.app, tc.render, err, tc.wantRejected)
			}
		})
	}
}

func TestValidateRenderOriginClassifiesOnlyValidSameHostnameAsOverridable(t *testing.T) {
	equalErr := ValidateRenderOrigin("https://app.example", "https://APP.EXAMPLE:443")
	if !errors.Is(equalErr, ErrUnsafeRenderOrigin) {
		t.Fatalf("same-host origins returned %v, want ErrUnsafeRenderOrigin", equalErr)
	}

	invalidErr := ValidateRenderOrigin("http://127.1:8080", "http://127.0.0.1:8080")
	if invalidErr == nil || errors.Is(invalidErr, ErrUnsafeRenderOrigin) {
		t.Fatalf("ambiguous origin returned %v, want a non-overridable validation error", invalidErr)
	}
}
