package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestParsePastedLoginCallback(t *testing.T) {
	const redirect = "http://127.0.0.1:12345/callback"
	for _, tt := range []struct {
		name, input, code string
	}{
		{"valid", redirect + "?code=auth%2Bcode&state=expected", "auth+code"},
		{"whitespace", " \t" + redirect + "?state=expected&code=auth-code\r\n", "auth-code"},
		{"wrong state", redirect + "?code=secret&state=other", ""},
		{"missing state", redirect + "?code=secret", ""},
		{"duplicate state", redirect + "?code=secret&state=expected&state=other", ""},
		{"missing code", redirect + "?state=expected", ""},
		{"empty code", redirect + "?state=expected&code=", ""},
		{"duplicate code", redirect + "?state=expected&code=secret&code=other", ""},
		{"provider error", redirect + "?state=expected&error=secret", ""},
		{"code and error", redirect + "?state=expected&code=secret&error=denied", ""},
		{"wrong port", "http://127.0.0.1:54321/callback?state=expected&code=secret", ""},
		{"wrong host", "http://example.com:12345/callback?state=expected&code=secret", ""},
		{"wrong scheme", "https://127.0.0.1:12345/callback?state=expected&code=secret", ""},
		{"wrong path", "http://127.0.0.1:12345/other?state=expected&code=secret", ""},
		{"relative", "/callback?state=expected&code=secret", ""},
		{"userinfo", "http://secret@127.0.0.1:12345/callback?state=expected&code=secret", ""},
		{"fragment", redirect + "?state=expected&code=secret#fragment", ""},
		{"malformed URL", "http://[secret", ""},
		{"malformed query", redirect + "?state=expected&code=%secret", ""},
		{"semicolon query", redirect + "?state=expected&code=secret;other", ""},
	} {
		t.Run(tt.name, func(t *testing.T) {
			res := parsePastedLoginCallback(tt.input, redirect, "expected")
			if res.code != tt.code || (res.err == nil) != (tt.code != "") {
				t.Fatalf("result = %+v, want code %q", res, tt.code)
			}
			if res.err != nil && strings.Contains(res.err.Error(), "secret") {
				t.Fatal("error exposed callback contents")
			}
		})
	}
}

func TestWaitForLoginCallbackPasteRetries(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	var diagnostics bytes.Buffer
	input := "\nhttp://127.0.0.1:12345/callback?state=wrong&code=secret\nhttp://127.0.0.1:12345/callback?state=expected&code=valid\n"
	code, err := waitForLoginCallback(ctx, strings.NewReader(input), &diagnostics, "http://127.0.0.1:12345/callback", "expected", nil, nil)
	if err != nil || code != "valid" {
		t.Fatalf("code = %q, error = %v", code, err)
	}
	if !strings.Contains(diagnostics.String(), "unexpected state") || strings.Contains(diagnostics.String(), "secret") {
		t.Fatalf("diagnostics = %q", diagnostics.String())
	}
}

func TestWaitForLoginCallbackBrowser(t *testing.T) {
	for _, input := range []string{"eof", "blocked", "invalid"} {
		t.Run(input, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			var in io.Reader = strings.NewReader("")
			switch input {
			case "blocked":
				r, w := io.Pipe()
				defer func() { _ = r.Close() }()
				defer func() { _ = w.Close() }()
				in = r
			case "invalid":
				in = strings.NewReader("invalid URL\n")
			}
			results := make(chan callbackResult, 1)
			requestDone := make(chan error, 1)
			server := httptest.NewServer(loginCallbackHandler("expected", results))
			defer server.Close()
			go func() {
				resp, err := http.Get(server.URL + "/callback?state=expected&code=browser-code")
				if err == nil {
					_, err = io.Copy(io.Discard, resp.Body)
					_ = resp.Body.Close()
					if resp.StatusCode != http.StatusOK {
						err = errors.New("callback failed")
					}
				}
				requestDone <- err
			}()
			code, err := waitForLoginCallback(ctx, in, io.Discard, "http://127.0.0.1:12345/callback", "expected", results, nil)
			if err != nil || code != "browser-code" {
				t.Fatalf("code = %q, error = %v", code, err)
			}
			if err := <-requestDone; err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestWaitForLoginCallbackFailures(t *testing.T) {
	for _, kind := range []string{"cancel", "timeout", "listener", "callback"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			results := make(chan callbackResult, 1)
			serveErrors := make(chan error, 1)
			wantErr := errors.New("test failure")
			switch kind {
			case "cancel":
				cancel()
				wantErr = context.Canceled
			case "timeout":
				var timeoutCancel context.CancelFunc
				ctx, timeoutCancel = context.WithDeadline(ctx, time.Now().Add(-time.Second))
				defer timeoutCancel()
			case "listener":
				serveErrors <- wantErr
			case "callback":
				results <- callbackResult{err: wantErr}
			}
			r, w := io.Pipe()
			defer func() { _ = r.Close() }()
			defer func() { _ = w.Close() }()
			code, err := waitForLoginCallback(ctx, r, io.Discard, "http://127.0.0.1:12345/callback", "expected", results, serveErrors)
			if code != "" || err == nil {
				t.Fatalf("code = %q, error = %v", code, err)
			}
			if kind == "timeout" {
				if !strings.Contains(err.Error(), "timed out waiting") {
					t.Fatalf("error = %v", err)
				}
			} else if !errors.Is(err, wantErr) {
				t.Fatalf("error = %v, want %v", err, wantErr)
			}
		})
	}
}

// loginTestReader defers creating input until the command has printed its URL.
// This simulates pasting a callback for the random state and port of that login.
type loginTestReader struct {
	makeInput func() io.Reader
	reader    io.Reader
}

func (r *loginTestReader) Read(p []byte) (int, error) {
	if r.reader == nil {
		r.reader = r.makeInput()
	}
	return r.reader.Read(p)
}

func TestLoginCommandPastedCallback(t *testing.T) {
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
	t.Setenv("SLASHDOCS_NO_KEYCHAIN", "1")
	// An empty PATH makes a mistakenly attempted browser launch harmless.
	// --no-browser must work without SLASHDOCS_NO_BROWSER being set.
	t.Setenv("PATH", t.TempDir())
	t.Setenv("SLASHDOCS_NO_BROWSER", "")
	t.Setenv("AIDOCS_NO_BROWSER", "")
	var out, diagnostics bytes.Buffer
	loginParams := make(chan url.Values, 1)
	exchanged := make(chan struct{}, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/v1/auth/cli/exchange" {
			http.NotFound(w, r)
			return
		}
		var body struct {
			Code     string `json:"code"`
			Verifier string `json:"code_verifier"`
			Name     string `json:"name"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			http.Error(w, "bad request", http.StatusBadRequest)
			return
		}
		params := <-loginParams
		if body.Code != "pasted-code" || body.Name != "remote-vm" || body.Verifier == "" || pkceChallenge(body.Verifier) != params.Get("code_challenge") {
			t.Errorf("exchange did not preserve the code, credential name and PKCE verifier")
			http.Error(w, "bad exchange", http.StatusBadRequest)
			return
		}
		exchanged <- struct{}{}
		writeTestJSON(t, w, map[string]any{"id": "cred_test", "token": "test-token"})
	}))
	defer server.Close()
	cmd := loginCmd(&globals{}, &out)
	cmd.SetErr(&diagnostics)
	cmd.SetIn(&loginTestReader{makeInput: func() io.Reader {
		loginURL := strings.TrimPrefix(strings.SplitN(out.String(), "\n", 2)[0], "Open this URL to log in: ")
		u, err := url.Parse(loginURL)
		if err != nil {
			t.Error(err)
			return strings.NewReader("")
		}
		params := u.Query()
		loginParams <- params
		callback := params.Get("cli_redirect")
		return strings.NewReader(callback + "?state=wrong&code=secret\n" + callback + "?state=" + url.QueryEscape(params.Get("state")) + "&code=pasted-code\n")
	}})
	cmd.SetArgs([]string{server.URL, "--no-browser", "--name", "remote-vm"})
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := cmd.ExecuteContext(ctx); err != nil {
		t.Fatal(err)
	}
	cfg, err := loadConfig()
	if err != nil {
		t.Fatal(err)
	}
	cx := cfg.Contexts[cfg.ActiveContext]
	if len(exchanged) != 1 || cx == nil || cx.Server != server.URL || credentialToken(cfg.ActiveContext, cx.Credential) != "test-token" {
		t.Fatalf("login did not exchange and save the credential: %+v", cfg)
	}
	if !strings.Contains(out.String(), "paste the full") || !strings.Contains(out.String(), "Logged in to") {
		t.Fatalf("missing instructions or confirmation: %s", out.String())
	}
}

func TestLoginCallbackHandler(t *testing.T) {
	for _, tt := range []struct {
		name, path, code, errText string
		status                    int
	}{
		{"success", "/callback?state=expected&code=browser-code", "browser-code", "", http.StatusOK},
		{"wrong state", "/callback?state=other&code=secret", "", "unexpected state", http.StatusBadRequest},
		{"missing state", "/callback?code=secret", "", "unexpected state", http.StatusBadRequest},
		{"provider error", "/callback?state=expected&error=access_denied", "", "access_denied", http.StatusBadRequest},
		{"missing code", "/callback?state=expected", "", "authorization code", http.StatusBadRequest},
		{"favicon", "/favicon.ico", "", "", http.StatusOK},
	} {
		t.Run(tt.name, func(t *testing.T) {
			results := make(chan callbackResult, 1)
			handler := loginCallbackHandler("expected", results)
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, tt.path, nil))
			if w.Code != tt.status || !strings.Contains(w.Header().Get("Content-Type"), "text/html") {
				t.Fatalf("callback status = %d, headers = %v", w.Code, w.Header())
			}
			select {
			case res := <-results:
				if tt.name == "favicon" {
					t.Fatal("favicon completed the login")
				}
				if res.code != tt.code || (res.err == nil) != (tt.errText == "") {
					t.Fatalf("result = %+v", res)
				}
				if res.err != nil && !strings.Contains(res.err.Error(), tt.errText) {
					t.Fatalf("error = %v, want %q", res.err, tt.errText)
				}
			default:
				if tt.name != "favicon" {
					t.Fatal("callback did not deliver a result")
				}
			}
		})
	}
}
