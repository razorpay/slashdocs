package cli

import (
	"bytes"
	"strings"
	"testing"
)

// TestReadPastedCallback covers login from a remote shell (#226): the user
// pastes the callback URL that the browser on another machine fails to open.
func TestReadPastedCallback(t *testing.T) {
	const callback = "http://127.0.0.1:12345/callback"
	for _, tc := range []struct {
		name, input, code, err string
		hints                  int
	}{
		{"code after wrong pastes", "\nnot a url %zz\n" + callback + "?state=other&code=secret\n" + callback + "?state=expected&code=pasted\n", "pasted", "", 2},
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
