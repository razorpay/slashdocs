package server_test

import (
	"net/http"
	"testing"
	"testing/fstest"

	"github.com/razorpay/slashdocs/api/internal/server"
)

// A CDN in front of the server must not keep a response that depends on who
// asks: it would serve one user's account or documents to the next caller.
func TestResponsesForbidSharedCachingByDefault(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test"},
		server.WithFrontend(fstest.MapFS{
			"index.html":        {Data: []byte(testShell)},
			"assets/app-abc.js": {Data: []byte("console.log(1)")},
		}))

	for _, tc := range []struct {
		name, path string
		principal  bool
		want       string
	}{
		{"signed-in account", "/v1/me", true, "private, no-store"},
		{"rejected account request", "/v1/me", false, "private, no-store"},
		{"document list", "/v1/documents", true, "private, no-store"},
		{"app shell", "/app/documents", false, "private, no-store"},
		// Handlers that know better keep their own policy.
		{"document page", "/app/d/" + e.doc.ID, true, "private, no-cache"},
		{"fingerprinted asset", "/assets/app-abc.js", false, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			headers := map[string]string{}
			if tc.principal {
				headers["X-Test-Principal"] = principalHeader(fixtureOwner)
			}
			rr := do(t, e.h, http.MethodGet, tc.path, "", headers)
			if got := rr.Header().Get("Cache-Control"); got != tc.want {
				t.Errorf("GET %s (status %d): Cache-Control = %q, want %q", tc.path, rr.Code, got, tc.want)
			}
		})
	}
}
