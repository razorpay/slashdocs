package server_test

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"

	"golang.org/x/oauth2"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/server"
)

const oauthTestSigningMaterial = "test-oauth-session-signing-material"

func TestMeRequiresAuth(t *testing.T) {
	rr := do(t, newTestEnv(t).h, http.MethodGet, "/v1/me", "", nil)
	assertStatus(t, rr, http.StatusUnauthorized)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "unauthorized", "message": "authentication required" }
	}`)
}

func TestLogoutDeletesSessionCookie(t *testing.T) {
	rr := do(t, newTestEnv(t).h, http.MethodPost, "/v1/auth/logout", "", map[string]string{
		"Cookie": "slashdocs_session=test-session",
	})
	assertStatus(t, rr, http.StatusNoContent)
	cookies := rr.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != "slashdocs_session" || cookies[0].Value != "" || cookies[0].MaxAge >= 0 || cookies[0].Path != "/" || !cookies[0].HttpOnly {
		t.Fatalf("logout did not delete the session cookie: %+v", cookies)
	}
}

func TestMeWithUserPrincipal(t *testing.T) {
	rr := do(t, newTestEnv(t).h, http.MethodGet, "/v1/me", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureUser),
	})
	assertStatus(t, rr, http.StatusOK)
	assertJSON(t, rr.Body.Bytes(), `{
	  "principal": { "type": "user", "id": "usr_1" },
	  "user": { "id": "usr_1", "email": "anurag@example.com", "name": "Anurag" }
	}`)
}

func TestMeWithServiceAccountPrincipal(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodGet, "/v1/me", "", map[string]string{
		"X-Test-Principal": "service_account:" + e.sa.ID,
	})
	assertStatus(t, rr, http.StatusOK)
	assertJSON(t, rr.Body.Bytes(), fmt.Sprintf(`{
	  "principal": { "type": "service_account", "id": %q },
	  "service_account": {
	    "id": %q,
	    "name": "fixture",
	    "disabled": false,
	    "owner": { "id": "owner_1", "email": "owner@example.com", "name": "Owner" }
	  }
	}`, e.sa.ID, e.sa.ID))
}

func TestMeWithMissingServiceAccountReturnsInternalError(t *testing.T) {
	rr := do(t, newTestEnv(t).h, http.MethodGet, "/v1/me", "", map[string]string{
		"X-Test-Principal": "service_account:sa_missing",
	})

	assertStatus(t, rr, http.StatusInternalServerError)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "internal", "message": "internal server error" }
	}`)
}

func TestCookieAuthRejectsRenderOriginUnsafeRequest(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", AppOrigin: "https://slashdocs.example.com"})
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", `{
	  "principal": { "type": "anyone" },
	  "role": "viewer"
	}`, map[string]string{
		"Content-Type":     "application/json",
		"Cookie":           "slashdocs_session=test-session",
		"Origin":           "https://slashdocs-render.example.com",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})

	assertStatus(t, rr, http.StatusForbidden)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "forbidden", "message": "csrf check failed" }
	}`)
}

func TestCookieAuthAllowsAppOriginUnsafeRequest(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", AppOrigin: "https://slashdocs.example.com"})
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", `{
	  "principal": { "type": "anyone" },
	  "role": "viewer"
	}`, map[string]string{
		"Content-Type":     "application/json",
		"Cookie":           "slashdocs_session=test-session",
		"Origin":           "https://slashdocs.example.com",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})

	assertStatus(t, rr, http.StatusCreated)
}

func TestCookieAuthAllowsAppRefererUnsafeRequest(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", AppOrigin: "https://slashdocs.example.com"})
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", `{
	  "principal": { "type": "anyone" },
	  "role": "viewer"
	}`, map[string]string{
		"Content-Type":     "application/json",
		"Cookie":           "slashdocs_session=test-session",
		"Referer":          "https://slashdocs.example.com/app/d/" + e.doc.ID,
		"X-Test-Principal": principalHeader(fixtureOwner),
	})

	assertStatus(t, rr, http.StatusCreated)
}

func TestUnsafeRequestWithoutSessionCookieBypassesCSRFGuard(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", AppOrigin: "https://slashdocs.example.com"})
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", `{
	  "principal": { "type": "anyone" },
	  "role": "viewer"
	}`, map[string]string{
		"Content-Type":     "application/json",
		"Origin":           "https://slashdocs-render.example.com",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})

	assertStatus(t, rr, http.StatusCreated)
}

func TestJSONMutationRejectsTextPlain(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", `{
	  "principal": { "type": "anyone" },
	  "role": "viewer"
	}`, map[string]string{
		"Content-Type":     "text/plain",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})

	assertStatus(t, rr, http.StatusUnsupportedMediaType)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "unsupported_media_type", "message": "content-type must be application/json" }
	}`)
}

func TestOAuthStartRejectsExternalWebRedirect(t *testing.T) {
	rr := do(t, newOAuthTestServer(t), http.MethodGet, "/v1/auth/google/start?mode=web&redirect=https://evil.example/callback", "", nil)

	assertStatus(t, rr, http.StatusBadRequest)
}

func TestOAuthStartRejectsUnknownMode(t *testing.T) {
	for _, tc := range []struct {
		name, redirect string
	}{
		{"safe redirect", "/documents/doc_1"},
		{"external redirect", "https://evil.example/callback"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rr := do(t, newOAuthTestServer(t), http.MethodGet, "/v1/auth/google/start?mode=evil&redirect="+tc.redirect, "", nil)

			assertStatus(t, rr, http.StatusBadRequest)
			assertJSON(t, rr.Body.Bytes(), `{
			  "error": { "code": "bad_request", "message": "invalid oauth mode" }
			}`)
			if location := rr.Header().Get("Location"); location != "" {
				t.Fatalf("unknown mode redirected to %q", location)
			}
		})
	}
}

func TestOAuthStartGeneratesBrowserBoundWebState(t *testing.T) {
	for _, tc := range []struct {
		name, appOrigin string
		wantSecure      bool
	}{
		{"HTTPS deployment", "https://app.example", true},
		{"local HTTP development", "http://localhost:8080", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rr := do(t, newOAuthTestServerForOrigin(t, tc.appOrigin), http.MethodGet, "/v1/auth/oidc/start?mode=web&state=attacker-fixed&redirect=/documents/doc_1", "", nil)

			assertStatus(t, rr, http.StatusFound)
			state := oauthRedirectState(t, rr)
			if state == "" || state == "attacker-fixed" {
				t.Fatalf("web OAuth state = %q, want a fresh server-generated value", state)
			}
			cookie := oauthStateCookie(t, rr, state)
			if !cookie.HttpOnly || cookie.Secure != tc.wantSecure || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/" || cookie.MaxAge <= 0 || cookie.Domain != "" {
				t.Fatalf("web OAuth state cookie has unsafe attributes: %#v", cookie)
			}
			if hasHostPrefix := strings.HasPrefix(cookie.Name, "__Host-"); hasHostPrefix != tc.wantSecure {
				t.Fatalf("web OAuth state cookie name = %q, __Host- prefix = %t, want %t", cookie.Name, hasHostPrefix, tc.wantSecure)
			}
		})
	}
}

func TestOAuthStartPreservesCallerStateForPKCEBoundCLIFlow(t *testing.T) {
	rr := do(t, newOAuthTestServer(t), http.MethodGet, "/v1/auth/oidc/start?mode=cli&state=cli-state&cli_redirect=http://127.0.0.1:32123/callback&code_challenge=challenge", "", nil)

	assertStatus(t, rr, http.StatusFound)
	if state := oauthRedirectState(t, rr); state != "cli-state" {
		t.Fatalf("CLI OAuth state = %q, want caller state", state)
	}
	for _, cookie := range rr.Result().Cookies() {
		if isOAuthStateCookieName(cookie.Name) {
			t.Fatalf("CLI flow unexpectedly set a browser-binding cookie: %#v", cookie)
		}
	}
}

func TestOAuthCallbackRejectsUnknownModeBeforeTokenExchange(t *testing.T) {
	var tokenCalls atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		tokenCalls.Add(1)
		http.Error(w, "token exchange must not run", http.StatusInternalServerError)
	}))
	t.Cleanup(tokenServer.Close)

	states := auth.NewStateStore()
	if err := states.PutState(context.Background(), "poisoned-state", auth.LoginState{
		Mode:     "unknown",
		Redirect: "https://evil.example/callback",
	}); err != nil {
		t.Fatal(err)
	}
	h := server.New(server.Config{
		Environment:   "test",
		AppOrigin:     "https://app.example",
		SessionSecret: oauthTestSigningMaterial,
		OIDC: auth.OIDC{
			Issuer: "https://issuer.example",
			Config: &oauth2.Config{
				ClientID: "client-id",
				Endpoint: oauth2.Endpoint{TokenURL: tokenServer.URL},
			},
		},
	}, server.WithRepository(newTestStore(t)), server.WithStateStore(states)).Handler()

	rr := do(t, h, http.MethodGet, "/v1/auth/oidc/callback?state=poisoned-state&code=must-not-exchange", "", nil)

	assertStatus(t, rr, http.StatusBadRequest)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "bad_request", "message": "invalid oauth state" }
	}`)
	if got := tokenCalls.Load(); got != 0 {
		t.Fatalf("invalid callback state made %d token exchange requests", got)
	}
}

func TestOAuthCallbackRequiresOriginatingWebStateCookieBeforeTokenExchange(t *testing.T) {
	var tokenCalls atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		tokenCalls.Add(1)
		http.Error(w, "expected test exchange failure", http.StatusInternalServerError)
	}))
	t.Cleanup(tokenServer.Close)

	h := oauthExchangeTestServer(t, tokenServer.URL, auth.NewStateStore())
	start := do(t, h, http.MethodGet, "/v1/auth/oidc/start?mode=web&redirect=/documents/doc_1", "", nil)
	assertStatus(t, start, http.StatusFound)
	state := oauthRedirectState(t, start)

	withoutCookie := do(t, h, http.MethodGet, "/v1/auth/oidc/callback?state="+url.QueryEscape(state)+"&code=attacker-code", "", nil)
	assertStatus(t, withoutCookie, http.StatusBadRequest)
	if got := tokenCalls.Load(); got != 0 {
		t.Fatalf("callback without its originating cookie made %d token requests", got)
	}

	start = do(t, h, http.MethodGet, "/v1/auth/oidc/start?mode=web&redirect=/documents/doc_1", "", nil)
	assertStatus(t, start, http.StatusFound)
	state = oauthRedirectState(t, start)
	binding := oauthStateCookie(t, start, state)
	withForgedCookie := do(t, h, http.MethodGet, "/v1/auth/oidc/callback?state="+url.QueryEscape(state)+"&code=attacker-code", "", map[string]string{
		"Cookie": oauthRequestCookie(binding.Name, state),
	})
	assertStatus(t, withForgedCookie, http.StatusBadRequest)
	if got := tokenCalls.Load(); got != 0 {
		t.Fatalf("callback with a forged browser cookie made %d token requests", got)
	}

	replaySource := do(t, h, http.MethodGet, "/v1/auth/oidc/start?mode=web&redirect=/documents/doc_1", "", nil)
	assertStatus(t, replaySource, http.StatusFound)
	replaySourceState := oauthRedirectState(t, replaySource)
	replaySourceBinding := oauthStateCookie(t, replaySource, replaySourceState)
	start = do(t, h, http.MethodGet, "/v1/auth/oidc/start?mode=web&redirect=/documents/doc_1", "", nil)
	assertStatus(t, start, http.StatusFound)
	state = oauthRedirectState(t, start)
	binding = oauthStateCookie(t, start, state)
	withReplayedBinding := do(t, h, http.MethodGet, "/v1/auth/oidc/callback?state="+url.QueryEscape(state)+"&code=attacker-code", "", map[string]string{
		"Cookie": oauthRequestCookie(binding.Name, replaySourceBinding.Value),
	})
	assertStatus(t, withReplayedBinding, http.StatusBadRequest)
	if got := tokenCalls.Load(); got != 0 {
		t.Fatalf("callback with another flow's signed binding made %d token requests", got)
	}

	start = do(t, h, http.MethodGet, "/v1/auth/oidc/start?mode=web&redirect=/documents/doc_1", "", nil)
	assertStatus(t, start, http.StatusFound)
	state = oauthRedirectState(t, start)
	binding = oauthStateCookie(t, start, state)
	withCookie := do(t, h, http.MethodGet, "/v1/auth/oidc/callback?state="+url.QueryEscape(state)+"&code=browser-code", "", map[string]string{
		"Cookie": oauthRequestCookie(binding.Name, binding.Value),
	})
	assertStatus(t, withCookie, http.StatusUnauthorized)
	if got := tokenCalls.Load(); got == 0 {
		t.Fatal("callback with its originating cookie did not reach token exchange")
	}
	var cleared bool
	for _, cookie := range withCookie.Result().Cookies() {
		if cookie.Name == binding.Name && cookie.MaxAge < 0 {
			cleared = true
		}
	}
	if !cleared {
		t.Fatal("callback did not clear its one-time web OAuth state cookie")
	}
}

func TestOAuthCallbackAllowsLegacyWebStateDuringRollingDeployment(t *testing.T) {
	var tokenCalls atomic.Int32
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		tokenCalls.Add(1)
		http.Error(w, "expected test exchange failure", http.StatusInternalServerError)
	}))
	t.Cleanup(tokenServer.Close)

	states := auth.NewStateStore()
	if err := states.PutState(context.Background(), "legacy-web-state", auth.LoginState{
		Mode:     "web",
		Redirect: "/documents/doc_1",
		// WebBindingRequired is deliberately absent, matching a state written
		// by an older instance before browser binding was deployed.
	}); err != nil {
		t.Fatal(err)
	}
	h := oauthExchangeTestServer(t, tokenServer.URL, states)

	rr := do(t, h, http.MethodGet, "/v1/auth/oidc/callback?state=legacy-web-state&code=legacy-code", "", nil)

	assertStatus(t, rr, http.StatusUnauthorized)
	if got := tokenCalls.Load(); got == 0 {
		t.Fatal("legacy callback did not reach token exchange")
	}
}

func oauthExchangeTestServer(t *testing.T, tokenURL string, states auth.LoginStateStore) http.Handler {
	t.Helper()
	return server.New(server.Config{
		Environment:   "test",
		AppOrigin:     "https://app.example",
		SessionSecret: oauthTestSigningMaterial,
		OIDC: auth.OIDC{
			Issuer: "https://issuer.example",
			Config: &oauth2.Config{
				ClientID: "client-id",
				Endpoint: oauth2.Endpoint{
					AuthURL:  "https://issuer.example/auth",
					TokenURL: tokenURL,
				},
			},
		},
	}, server.WithRepository(newTestStore(t)), server.WithStateStore(states)).Handler()
}

func oauthRedirectState(t *testing.T, rr *httptest.ResponseRecorder) string {
	t.Helper()
	location, err := url.Parse(rr.Header().Get("Location"))
	if err != nil {
		t.Fatalf("parse OAuth redirect: %v", err)
	}
	return location.Query().Get("state")
}

func oauthStateCookie(t *testing.T, rr *httptest.ResponseRecorder, state string) *http.Cookie {
	t.Helper()
	for _, cookie := range rr.Result().Cookies() {
		if !isOAuthStateCookieName(cookie.Name) {
			continue
		}
		if cookie.Value == state {
			t.Fatalf("web OAuth state cookie exposes the raw state: %#v", cookie)
		}
		boundState, ok := (auth.SessionCodec{Secret: []byte(oauthTestSigningMaterial)}).VerifyAudience(cookie.Value, "oauth-state")
		if ok && boundState == state {
			return cookie
		}
	}
	t.Fatalf("response did not set a web OAuth state cookie for %q", state)
	return nil
}

func isOAuthStateCookieName(name string) bool {
	return strings.HasPrefix(name, "__Host-slashdocs_oauth_state_") || strings.HasPrefix(name, "slashdocs_oauth_state_")
}

func oauthRequestCookie(name, value string) string {
	// OAuth state names and values are generated from URL-safe hashes/tokens.
	return name + "=" + value
}

func TestOAuthStartRejectsBackslashNormalizedWebRedirect(t *testing.T) {
	rr := do(t, newOAuthTestServer(t), http.MethodGet, "/v1/auth/google/start?mode=web&redirect=/%5C%5Cevil.com", "", nil)

	assertStatus(t, rr, http.StatusBadRequest)
}

func TestOAuthStartAllowsOnlyRootRelativeWebRedirect(t *testing.T) {
	rr := do(t, newOAuthTestServer(t), http.MethodGet, "/v1/auth/google/start?mode=web&redirect=/documents/doc_1", "", nil)

	assertStatus(t, rr, http.StatusFound)
}

func TestOAuthStartAddsGoogleHostedDomainForSingleDomainOrg(t *testing.T) {
	h := newOIDCTestServer(t, auth.GoogleIssuer, server.DeploymentOrg, []string{"acme.com"})
	rr := do(t, h, http.MethodGet, "/v1/auth/google/start?mode=web&redirect=/documents/doc_1", "", nil)

	assertStatus(t, rr, http.StatusFound)
	if loc := rr.Header().Get("Location"); !strings.Contains(loc, "hd=acme.com") {
		t.Fatalf("Location = %q, want hd=acme.com login hint", loc)
	}
}

func TestOAuthStartOmitsHostedDomainForNonGoogleIssuer(t *testing.T) {
	h := newOIDCTestServer(t, "https://sso.example", server.DeploymentOrg, []string{"acme.com"})
	rr := do(t, h, http.MethodGet, "/v1/auth/oidc/start?mode=web&redirect=/documents/doc_1", "", nil)

	assertStatus(t, rr, http.StatusFound)
	if loc := rr.Header().Get("Location"); strings.Contains(loc, "hd=") {
		t.Fatalf("Location = %q, want no hd parameter for a non-Google issuer", loc)
	}
}
