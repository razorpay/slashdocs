package cli

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestLoginCallbackHandler covers the browser path of the CLI login: only
// /callback reports a result, and only a matching state with a code succeeds.
func TestLoginCallbackHandler(t *testing.T) {
	for _, tc := range []struct {
		name, target, code, err string
		status                  int
	}{
		{"wrong state", "/callback?state=other&code=secret", "", "unexpected state", http.StatusBadRequest},
		{"provider error", "/callback?state=expected&error=access_denied", "", "login failed: access_denied", http.StatusBadRequest},
		{"no code", "/callback?state=expected", "", "authorization code", http.StatusBadRequest},
		{"code", "/callback?state=expected&code=granted", "granted", "", http.StatusOK},
		{"not the callback", "/favicon.ico", "", "", http.StatusOK},
	} {
		t.Run(tc.name, func(t *testing.T) {
			results := make(chan callbackResult, 1)
			rec := httptest.NewRecorder()
			loginCallbackHandler("expected", results).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, tc.target, nil))

			if failed := strings.Contains(rec.Body.String(), "Login failed"); rec.Code != tc.status || failed != (tc.status != http.StatusOK) {
				t.Fatalf("status = %d with failure page %t, want %d", rec.Code, failed, tc.status)
			}
			if !strings.HasPrefix(tc.target, "/callback") {
				if len(results) != 0 {
					t.Fatalf("%s sent a login result", tc.target)
				}
				return
			}
			res := <-results
			if res.code != tc.code || (res.err == nil) != (tc.err == "") || (res.err != nil && !strings.Contains(res.err.Error(), tc.err)) {
				t.Fatalf("result = %+v, want code %q and error %q", res, tc.code, tc.err)
			}
		})
	}
}

// TestReadPastedCallback covers login from a remote shell (#226): the user
// pastes the callback URL that the browser on another machine fails to open.
func TestReadPastedCallback(t *testing.T) {
	const callback = "http://127.0.0.1:12345/callback"
	for _, tc := range []struct {
		name, input, code, err string
		hints                  int
	}{
		{"code after wrong pastes", "\nnot a url %zz\n" + callback + "?state=other&code=secret\n" + callback + "?state=expected&code=pasted\n", "pasted", "", 2},
		{"code after the login URL", "https://docs.example.com/v1/auth/google/start?mode=cli&state=expected\n" + callback + "?state=expected&code=pasted\n", "pasted", "", 1},
		{"provider error", callback + "?state=expected&error=access_denied\n", "", "login failed: access_denied", 0},
		{"no code", callback + "?state=expected\n", "", "authorization code", 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			results := make(chan callbackResult, 1)
			var errOut bytes.Buffer
			readPastedCallback(strings.NewReader(tc.input), &errOut, "expected", results)

			res := <-results
			if res.code != tc.code || (res.err == nil) != (tc.err == "") || (res.err != nil && !strings.Contains(res.err.Error(), tc.err)) {
				t.Fatalf("result = %+v, want code %q and error %q", res, tc.code, tc.err)
			}
			if hints := strings.Count(errOut.String(), "\n"); hints != tc.hints || strings.Contains(errOut.String(), "secret") {
				t.Fatalf("diagnostics = %q, want %d hints that do not echo the input", errOut.String(), tc.hints)
			}
		})
	}
}
