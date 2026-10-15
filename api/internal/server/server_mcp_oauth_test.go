package server_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/server"
)

const (
	mcpTestOrigin              = "https://app.example"
	mcpTestRedirectURI         = "https://client.example/callback"
	mcpTestVerifier            = "mcp-test-verifier-with-at-least-forty-three-characters"
	mcpTestMaxClientNameBytes  = 128
	mcpTestMaxRedirectURIBytes = 1024
	mcpTestMaxClientIDBytes    = 2048
)

type mcpOAuthTestEnv struct {
	h          http.Handler
	store      *pgrepo.Store
	stateStore auth.LoginStateStore
	resource   string
	cookie     string
}

func newMCPOAuthTestEnv(t *testing.T) *mcpOAuthTestEnv {
	t.Helper()
	return newMCPOAuthTestEnvConfig(t, nil)
}

// newMCPOAuthTestEnvConfig lets a test adjust the server configuration (e.g.
// DefaultDocPermission) before the handler is built.
func newMCPOAuthTestEnvConfig(t *testing.T, mutate func(*server.Config)) *mcpOAuthTestEnv {
	t.Helper()
	store := newTestStore(t)
	for _, p := range []auth.Principal{fixtureOwner, fixtureUser} {
		if _, err := store.UpsertGoogleUser(context.Background(), p.ID, p.Email, p.Name, "sub-"+p.ID, ""); err != nil {
			t.Fatalf("seed user %s: %v", p.ID, err)
		}
	}
	stateStore := auth.NewPostgresStateStore(store.Pool())
	resource := mcpTestOrigin + "/mcp"
	cfg := server.Config{
		Environment:   "test",
		AppOrigin:     mcpTestOrigin,
		SessionSecret: oauthTestSigningMaterial,
	}
	if mutate != nil {
		mutate(&cfg)
	}
	h := server.New(cfg,
		server.WithRepository(store),
		server.WithAuthenticator(auth.DBAuthenticator{Resolver: store, SessionSecret: oauthTestSigningMaterial}),
		server.WithStateStore(stateStore),
	).Handler()
	session := (auth.SessionCodec{Secret: []byte(oauthTestSigningMaterial)}).Sign(fixtureUser.ID)
	//nolint:gosec // G124: this test-only cookie is injected directly into httptest requests; no network transport is used.
	cookie := (&http.Cookie{Name: "slashdocs_session", Value: session}).String()
	return &mcpOAuthTestEnv{
		h:          h,
		store:      store,
		stateStore: stateStore,
		resource:   resource,
		cookie:     cookie,
	}
}

func TestMCPDiscoveryAndOAuthMetadata(t *testing.T) {
	e := newMCPOAuthTestEnv(t)

	discovery := do(t, e.h, http.MethodGet, "/.well-known/slashdocs.json", "", nil)
	assertStatus(t, discovery, http.StatusOK)
	assertJSON(t, discovery.Body.Bytes(), `{
	  "name": "slashdocs",
	  "api_version": "v1",
	  "auth": { "modes": ["web", "cli", "mcp"] }
	}`)

	for _, path := range []string{
		"/.well-known/oauth-protected-resource",
		"/.well-known/oauth-protected-resource/mcp",
	} {
		t.Run(path, func(t *testing.T) {
			rr := do(t, e.h, http.MethodGet, path, "", nil)
			assertStatus(t, rr, http.StatusOK)
			assertJSON(t, rr.Body.Bytes(), `{
			  "resource": "https://app.example/mcp",
			  "authorization_servers": ["https://app.example"],
			  "bearer_methods_supported": ["header"],
			  "scopes_supported": ["mcp"]
			}`)
		})
	}

	metadata := do(t, e.h, http.MethodGet, "/.well-known/oauth-authorization-server", "", nil)
	assertStatus(t, metadata, http.StatusOK)
	assertJSON(t, metadata.Body.Bytes(), `{
	  "issuer": "https://app.example",
	  "authorization_endpoint": "https://app.example/oauth/authorize",
	  "token_endpoint": "https://app.example/oauth/token",
	  "registration_endpoint": "https://app.example/oauth/register",
	  "response_types_supported": ["code"],
	  "response_modes_supported": ["query"],
	  "grant_types_supported": ["authorization_code", "refresh_token"],
	  "token_endpoint_auth_methods_supported": ["none"],
	  "code_challenge_methods_supported": ["S256"],
	  "scopes_supported": ["mcp"]
	}`)
}

func TestMCPDynamicClientRegistrationValidatesRedirectURIs(t *testing.T) {
	e := newMCPOAuthTestEnv(t)

	for _, redirectURI := range []string{
		"https://client.example/callback",
		"http://localhost:3210/callback",
		"http://127.0.0.1:3210/callback",
		"http://[::1]:3210/callback",
		// Private-use app schemes (RFC 8252 §7.1) used by native MCP clients.
		"cursor://anysphere.cursor-retrieval/oauth/user-slashdocs/callback",
		"vscode://ms-vscode.remote-server/oauth/callback",
		"claude://oauth/callback",
	} {
		t.Run("allows "+redirectURI, func(t *testing.T) {
			rr := registerMCPClient(t, e, "Conformance client", []string{redirectURI})
			assertStatus(t, rr, http.StatusCreated)
			if got := jsonField(t, rr.Body.Bytes(), "client_id"); !strings.HasPrefix(got, "slashdocs_mcp_client_") {
				t.Fatalf("client_id = %q, want signed slashdocs MCP client id", got)
			}
			if got := rr.Header().Get("Cache-Control"); got != "no-store" {
				t.Fatalf("Cache-Control = %q, want no-store", got)
			}
		})
	}

	invalid := []struct {
		name         string
		redirectURIs []string
	}{
		{"empty", nil},
		{"relative", []string{"/callback"}},
		{"external http", []string{"http://client.example/callback"}},
		{"credentials", []string{"https://user:pass@client.example/callback"}},
		{"fragment", []string{"https://client.example/callback#fragment"}},
		{"unsupported scheme", []string{"javascript:alert(1)"}},
		{"hierarchical javascript", []string{"javascript://client.example/callback"}},
		{"data scheme", []string{"data://client.example/callback"}},
		{"file scheme", []string{"file:///etc/passwd"}},
		{"opaque private scheme", []string{"cursor:opaque-form"}},
		{"private scheme with fragment", []string{"cursor://client/callback#fragment"}},
		{"non-loopback IP", []string{"http://192.0.2.1/callback"}},
		{"overlong URI", []string{paddedMCPRedirectURI(mcpTestMaxRedirectURIBytes + 1)}},
		{"too many", []string{
			"https://client.example/0", "https://client.example/1", "https://client.example/2",
			"https://client.example/3", "https://client.example/4", "https://client.example/5",
			"https://client.example/6", "https://client.example/7", "https://client.example/8",
			"https://client.example/9", "https://client.example/10",
		}},
	}
	for _, tc := range invalid {
		t.Run("rejects "+tc.name, func(t *testing.T) {
			rr := registerMCPClient(t, e, "Bad client", tc.redirectURIs)
			assertStatus(t, rr, http.StatusBadRequest)
			if got := jsonField(t, rr.Body.Bytes(), "error"); got != "invalid_client_metadata" {
				t.Fatalf("error = %q, want invalid_client_metadata", got)
			}
			if strings.Contains(rr.Body.String(), "client_id") {
				t.Fatalf("invalid registration returned a client id: %s", rr.Body.String())
			}
		})
	}

	t.Run("rejects confidential clients", func(t *testing.T) {
		body := `{"client_name":"bad","redirect_uris":["https://client.example/callback"],"token_endpoint_auth_method":"client_secret_basic"}`
		rr := do(t, e.h, http.MethodPost, "/oauth/register", body, map[string]string{"Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusBadRequest)
		if got := jsonField(t, rr.Body.Bytes(), "error"); got != "invalid_client_metadata" {
			t.Fatalf("error = %q, want invalid_client_metadata", got)
		}
	})

	// Conformant MCP clients (mcp2cli, VS Code) register authorization_code
	// alongside refresh_token; the registration must be accepted even though
	// the server never issues refresh tokens.
	t.Run("allows co-registered refresh_token grant", func(t *testing.T) {
		body := `{"client_name":"mcp2cli","redirect_uris":["http://localhost:4100/callback"],"token_endpoint_auth_method":"none","grant_types":["authorization_code","refresh_token"],"response_types":["code"]}`
		rr := do(t, e.h, http.MethodPost, "/oauth/register", body, map[string]string{"Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusCreated)
		if got := jsonField(t, rr.Body.Bytes(), "client_id"); !strings.HasPrefix(got, "slashdocs_mcp_client_") {
			t.Fatalf("client_id = %q, want signed client id", got)
		}
	})

	t.Run("rejects unsupported grant without authorization_code", func(t *testing.T) {
		body := `{"client_name":"bad","redirect_uris":["https://client.example/callback"],"token_endpoint_auth_method":"none","grant_types":["client_credentials"]}`
		rr := do(t, e.h, http.MethodPost, "/oauth/register", body, map[string]string{"Content-Type": "application/json"})
		assertStatus(t, rr, http.StatusBadRequest)
		if got := jsonField(t, rr.Body.Bytes(), "error"); got != "invalid_client_metadata" {
			t.Fatalf("error = %q, want invalid_client_metadata", got)
		}
	})

	t.Run("rejects overlong client name", func(t *testing.T) {
		rr := registerMCPClient(t, e, strings.Repeat("n", mcpTestMaxClientNameBytes+1), []string{mcpTestRedirectURI})
		assertOAuthError(t, rr, http.StatusBadRequest, "invalid_client_metadata")
		if !strings.Contains(rr.Body.String(), "128 bytes") {
			t.Fatalf("overlong client name error is not actionable: %s", rr.Body.String())
		}
	})

	t.Run("rejects metadata whose signed client id is too large", func(t *testing.T) {
		redirects := []string{
			paddedMCPRedirectURI(mcpTestMaxRedirectURIBytes),
			paddedMCPRedirectURI(mcpTestMaxRedirectURIBytes - 1),
			paddedMCPRedirectURI(mcpTestMaxRedirectURIBytes - 2),
		}
		rr := registerMCPClient(t, e, strings.Repeat("n", mcpTestMaxClientNameBytes), redirects)
		assertOAuthError(t, rr, http.StatusBadRequest, "invalid_client_metadata")
		if !strings.Contains(rr.Body.String(), "oversized client_id") {
			t.Fatalf("oversized signed client id error is not actionable: %s", rr.Body.String())
		}
	})
}

func TestMCPNearBoundClientRegistrationReachesConsent(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	redirectURI := paddedMCPRedirectURI(mcpTestMaxRedirectURIBytes)
	clientID := registeredMCPClientID(t, e, "N", []string{redirectURI})
	if len(clientID) > mcpTestMaxClientIDBytes || len(clientID) < mcpTestMaxClientIDBytes-128 {
		t.Fatalf("near-bound client_id length = %d, want within 128 bytes of limit %d", len(clientID), mcpTestMaxClientIDBytes)
	}

	values := mcpAuthorizeValues(e, clientID, redirectURI, mcpTestVerifier, "near-bound")
	consent := do(t, e.h, http.MethodGet, "/oauth/authorize?"+values.Encode(), "", map[string]string{
		"Accept": "text/html", "Cookie": e.cookie,
	})
	assertStatus(t, consent, http.StatusOK)
	if !strings.Contains(consent.Body.String(), "Connect N?") || !strings.Contains(consent.Body.String(), "near-bound") {
		t.Fatalf("near-bound registration did not reach intact consent: %s", consent.Body.String())
	}
}

func TestMCPAuthorizeRequiresBrowserSessionAndExplicitConsent(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	clientID := registeredMCPClientID(t, e, "Review agent", []string{mcpTestRedirectURI})
	values := mcpAuthorizeValues(e, clientID, mcpTestRedirectURI, mcpTestVerifier, "state-123")
	path := "/oauth/authorize?" + values.Encode()

	unauthenticated := do(t, e.h, http.MethodGet, path, "", map[string]string{"Accept": "text/html"})
	assertStatus(t, unauthenticated, http.StatusFound)
	if location := unauthenticated.Header().Get("Location"); !strings.HasPrefix(location, "/v1/auth/google/start?mode=web") {
		t.Fatalf("unauthenticated authorize Location = %q, want web login", location)
	}

	consent := do(t, e.h, http.MethodGet, path, "", map[string]string{"Accept": "text/html", "Cookie": e.cookie})
	assertStatus(t, consent, http.StatusOK)
	for _, want := range []string{"Connect Review agent?", "Access goes to <strong>client.example</strong>", "The client name is self-reported and is not verified.", fixtureUser.Name, `name="decision" value="deny"`, `name="decision" value="approve"`} {
		if !strings.Contains(consent.Body.String(), want) {
			t.Errorf("consent page missing %q: %s", want, consent.Body.String())
		}
	}
	if got := consent.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("consent Cache-Control = %q, want no-store", got)
	}
	if got := consent.Header().Get("Content-Security-Policy"); !strings.Contains(got, "frame-ancestors 'none'") || strings.Contains(got, "form-action") {
		// Browsers check form-action on every redirect after the POST, and
		// client callbacks redirect again (www.cursor.com to cursor.com).
		t.Fatalf("consent Content-Security-Policy = %q, want frame-ancestors and no form-action", got)
	}
	if got := consent.Header().Get("X-Frame-Options"); got != "DENY" {
		t.Fatalf("consent X-Frame-Options = %q, want DENY", got)
	}
	if got := consent.Header().Get("Referrer-Policy"); got != "same-origin" {
		t.Fatalf("consent Referrer-Policy = %q, want same-origin", got)
	}

	deniedValues := cloneValues(values)
	deniedValues.Set("decision", "deny")
	denied := postMCPAuthorize(t, e, deniedValues, mcpTestOrigin)
	assertStatus(t, denied, http.StatusFound)
	deniedURL := mustParseURL(t, denied.Header().Get("Location"))
	if deniedURL.Scheme+"://"+deniedURL.Host+deniedURL.Path != mcpTestRedirectURI ||
		deniedURL.Query().Get("error") != "access_denied" || deniedURL.Query().Get("state") != "state-123" ||
		deniedURL.Query().Get("code") != "" {
		t.Fatalf("deny redirect = %q, want bound access_denied and state", deniedURL.String())
	}

	hostile := cloneValues(values)
	hostile.Set("decision", "approve")
	csrf := postMCPAuthorize(t, e, hostile, "https://attacker.example")
	assertStatus(t, csrf, http.StatusForbidden)

	unregistered := cloneValues(values)
	unregistered.Set("redirect_uri", "https://attacker.example/callback")
	invalid := postMCPAuthorize(t, e, unregistered, mcpTestOrigin)
	assertStatus(t, invalid, http.StatusBadRequest)
	if location := invalid.Header().Get("Location"); location != "" {
		t.Fatalf("invalid redirect URI was followed: %q", location)
	}
}

// Native clients such as Cursor register private-use scheme callbacks
// (RFC 8252 §7.1); the whole flow must work end to end for them.
func TestMCPOAuthFlowCompletesWithPrivateUseSchemeRedirect(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	redirectURI := "cursor://anysphere.cursor-retrieval/oauth/user-slashdocs/callback"
	clientID := registeredMCPClientID(t, e, "Cursor", []string{redirectURI})

	values := mcpAuthorizeValues(e, clientID, redirectURI, mcpTestVerifier, "cursor-state")
	consent := do(t, e.h, http.MethodGet, "/oauth/authorize?"+values.Encode(), "", map[string]string{"Accept": "text/html", "Cookie": e.cookie})
	assertStatus(t, consent, http.StatusOK)
	if !strings.Contains(consent.Body.String(), "Access goes to <strong>cursor://anysphere.cursor-retrieval</strong>") {
		t.Fatal("consent did not show the private-use redirect target")
	}

	code := approveMCPAuthorization(t, e, clientID, redirectURI, mcpTestVerifier, "cursor-state")
	exchanged := postMCPToken(t, e, mcpTokenValues(e, code, clientID, redirectURI, mcpTestVerifier))
	assertStatus(t, exchanged, http.StatusOK)
	if got := jsonField(t, exchanged.Body.Bytes(), "access_token"); !strings.HasPrefix(got, auth.MCPAccessTokenPrefix) {
		t.Fatalf("access_token = %q, want %q prefix", got, auth.MCPAccessTokenPrefix)
	}
}

func TestMCPOAuthFlowAcceptsPreRenameClientRegistration(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	signed := strings.TrimPrefix(registeredMCPClientID(t, e, "Claude", []string{mcpTestRedirectURI}), "slashdocs_mcp_client_")
	clientID := "aidocs_mcp_client_" + signed

	code := approveMCPAuthorization(t, e, clientID, mcpTestRedirectURI, mcpTestVerifier, "legacy-state")
	exchanged := postMCPToken(t, e, mcpTokenValues(e, code, clientID, mcpTestRedirectURI, mcpTestVerifier))
	assertStatus(t, exchanged, http.StatusOK)
}

// Native clients bind an ephemeral loopback port at request time, so a
// client_id cached across runs carries a stale port. RFC 8252 §7.3 requires
// the authorization server to accept any port on a loopback IP redirect, and
// the full flow must complete on the fresh port.
func TestMCPOAuthFlowAcceptsDifferentLoopbackPortThanRegistered(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	clientID := registeredMCPClientID(t, e, "mcp2cli", []string{"http://127.0.0.1:51726/callback"})
	liveRedirect := "http://127.0.0.1:49812/callback" // fresh ephemeral port

	values := mcpAuthorizeValues(e, clientID, liveRedirect, mcpTestVerifier, "loopback-state")
	consent := do(t, e.h, http.MethodGet, "/oauth/authorize?"+values.Encode(), "", map[string]string{"Accept": "text/html", "Cookie": e.cookie})
	assertStatus(t, consent, http.StatusOK)
	if !strings.Contains(consent.Body.String(), "Access goes to <strong>http://127.0.0.1:49812</strong>") {
		t.Fatal("consent did not show the live loopback redirect target")
	}

	code := approveMCPAuthorization(t, e, clientID, liveRedirect, mcpTestVerifier, "loopback-state")
	exchanged := postMCPToken(t, e, mcpTokenValues(e, code, clientID, liveRedirect, mcpTestVerifier))
	assertStatus(t, exchanged, http.StatusOK)
	if got := jsonField(t, exchanged.Body.Bytes(), "access_token"); !strings.HasPrefix(got, auth.MCPAccessTokenPrefix) {
		t.Fatalf("access_token = %q, want %q prefix", got, auth.MCPAccessTokenPrefix)
	}
}

// A non-loopback redirect must still match the registration exactly; the
// loopback port exemption must not leak into https callbacks.
func TestMCPAuthorizeRejectsHTTPSRedirectPortMismatch(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	clientID := registeredMCPClientID(t, e, "web", []string{"https://client.example:8443/callback"})
	values := mcpAuthorizeValues(e, clientID, "https://client.example:9443/callback", mcpTestVerifier, "s")
	rr := do(t, e.h, http.MethodGet, "/oauth/authorize?"+values.Encode(), "", map[string]string{"Accept": "text/html", "Cookie": e.cookie})
	assertStatus(t, rr, http.StatusBadRequest)
	if location := rr.Header().Get("Location"); location != "" {
		t.Fatalf("mismatched https redirect was followed: %q", location)
	}
}

func TestMCPOAuthCodeExchangeIsBoundAndOneTime(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	clientID := registeredMCPClientID(t, e, "Bound client", []string{mcpTestRedirectURI, "https://client.example/second"})

	code := approveMCPAuthorization(t, e, clientID, mcpTestRedirectURI, mcpTestVerifier, "first")
	form := mcpTokenValues(e, code, clientID, mcpTestRedirectURI, mcpTestVerifier)
	exchanged := postMCPToken(t, e, form)
	assertStatus(t, exchanged, http.StatusOK)
	accessToken := jsonField(t, exchanged.Body.Bytes(), "access_token")
	if !strings.HasPrefix(accessToken, auth.MCPAccessTokenPrefix) {
		t.Fatalf("access_token = %q, want %q prefix", accessToken, auth.MCPAccessTokenPrefix)
	}
	if got := exchanged.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("token Cache-Control = %q, want no-store", got)
	}
	if got := exchanged.Header().Get("Pragma"); got != "no-cache" {
		t.Fatalf("token Pragma = %q, want no-cache", got)
	}

	replay := postMCPToken(t, e, form)
	assertOAuthError(t, replay, http.StatusBadRequest, "invalid_grant")

	otherClient := registeredMCPClientID(t, e, "Other client", []string{mcpTestRedirectURI})
	cases := []struct {
		name   string
		mutate func(url.Values)
	}{
		{"PKCE verifier", func(v url.Values) { v.Set("code_verifier", strings.Repeat("x", 48)) }},
		{"client", func(v url.Values) { v.Set("client_id", otherClient) }},
		{"redirect URI", func(v url.Values) { v.Set("redirect_uri", "https://client.example/second") }},
		{"resource", func(v url.Values) { v.Set("resource", mcpTestOrigin+"/other") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			freshCode := approveMCPAuthorization(t, e, clientID, mcpTestRedirectURI, mcpTestVerifier, tc.name)
			bad := mcpTokenValues(e, freshCode, clientID, mcpTestRedirectURI, mcpTestVerifier)
			tc.mutate(bad)
			assertOAuthError(t, postMCPToken(t, e, bad), http.StatusBadRequest, "invalid_grant")

			// Any exchange attempt consumes the authorization code, including a
			// mismatched one, so an intercepted code cannot later be replayed.
			good := mcpTokenValues(e, freshCode, clientID, mcpTestRedirectURI, mcpTestVerifier)
			assertOAuthError(t, postMCPToken(t, e, good), http.StatusBadRequest, "invalid_grant")
		})
	}
}

// The authorization_code exchange must issue a rotating refresh token so MCP
// clients can renew the short-lived access token without re-prompting the
// user every hour (the bug reported for the SlashDocs MCP server: signed in
// at 2:05 PM, asked to re-auth by 3:07 PM, while the CLI stays signed in).
func TestMCPRefreshTokenGrantRotatesAndIsBound(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	clientID := registeredMCPClientID(t, e, "Refresh client", []string{mcpTestRedirectURI})

	code := approveMCPAuthorization(t, e, clientID, mcpTestRedirectURI, mcpTestVerifier, "refresh-flow")
	exchanged := postMCPToken(t, e, mcpTokenValues(e, code, clientID, mcpTestRedirectURI, mcpTestVerifier))
	assertStatus(t, exchanged, http.StatusOK)
	refreshToken := jsonField(t, exchanged.Body.Bytes(), "refresh_token")
	if !strings.HasPrefix(refreshToken, "slashdocs_mcp_refresh_") {
		t.Fatalf("refresh_token = %q, want slashdocs_mcp_refresh_ prefix", refreshToken)
	}

	renewed := postMCPToken(t, e, mcpRefreshTokenValues(e, refreshToken, clientID))
	assertStatus(t, renewed, http.StatusOK)
	if got := renewed.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("refresh Cache-Control = %q, want no-store", got)
	}
	newAccess := jsonField(t, renewed.Body.Bytes(), "access_token")
	if !strings.HasPrefix(newAccess, auth.MCPAccessTokenPrefix) {
		t.Fatalf("refreshed access_token = %q, want %q prefix", newAccess, auth.MCPAccessTokenPrefix)
	}
	// Access tokens are deterministic over (sub, aud, exp) with second
	// granularity, so same-second renewals can repeat bytes; the refresh token
	// below must still rotate because it carries fresh random material.
	newRefresh := jsonField(t, renewed.Body.Bytes(), "refresh_token")
	if newRefresh == "" || newRefresh == refreshToken {
		t.Fatalf("refresh_token was not rotated: %q", newRefresh)
	}

	// The refreshed access token must authenticate against the MCP resource.
	authenticator := auth.MCPAuthenticator{
		Users:         e.store,
		ServiceTokens: auth.DBAuthenticator{Resolver: e.store, SessionSecret: oauthTestSigningMaterial},
		SessionSecret: oauthTestSigningMaterial,
		Resource:      e.resource,
	}
	if got := authenticateMCP(t, authenticator, newAccess, ""); got.ID != fixtureUser.ID {
		t.Fatalf("refreshed token principal = %#v, want user %s", got, fixtureUser.ID)
	}

	// Reuse of a rotated-out token must be rejected AND revoke the whole
	// family (OAuth 2.1 §4.14.2): after the replay below, the latest token in
	// the chain must be dead too, so a thief who redeemed a stolen token
	// cannot keep a live descendant chain once reuse is detected.
	assertOAuthError(t, postMCPToken(t, e, mcpRefreshTokenValues(e, refreshToken, clientID)),
		http.StatusBadRequest, "invalid_grant")
	assertOAuthError(t, postMCPToken(t, e, mcpRefreshTokenValues(e, newRefresh, clientID)),
		http.StatusBadRequest, "invalid_grant")

	// Binding: a different client cannot redeem a fresh chain's token, and
	// the attempt revokes the family so the stolen token is dead afterwards.
	code2 := approveMCPAuthorization(t, e, clientID, mcpTestRedirectURI, mcpTestVerifier, "second-chain")
	exchanged2 := postMCPToken(t, e, mcpTokenValues(e, code2, clientID, mcpTestRedirectURI, mcpTestVerifier))
	assertStatus(t, exchanged2, http.StatusOK)
	secondRefresh := jsonField(t, exchanged2.Body.Bytes(), "refresh_token")
	otherClient := registeredMCPClientID(t, e, "Other client", []string{mcpTestRedirectURI})
	assertOAuthError(t, postMCPToken(t, e, mcpRefreshTokenValues(e, secondRefresh, otherClient)),
		http.StatusBadRequest, "invalid_grant")
	assertOAuthError(t, postMCPToken(t, e, mcpRefreshTokenValues(e, secondRefresh, clientID)),
		http.StatusBadRequest, "invalid_grant")
}

func TestMCPRefreshTokenGrantValidatesRequests(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	clientID := registeredMCPClientID(t, e, "Validation client", []string{mcpTestRedirectURI})

	t.Run("missing refresh_token", func(t *testing.T) {
		values := mcpRefreshTokenValues(e, "", clientID)
		values.Del("refresh_token")
		assertOAuthError(t, postMCPToken(t, e, values), http.StatusBadRequest, "invalid_request")
	})

	t.Run("unknown refresh token", func(t *testing.T) {
		values := mcpRefreshTokenValues(e, "slashdocs_mcp_refresh_forged", clientID)
		assertOAuthError(t, postMCPToken(t, e, values), http.StatusBadRequest, "invalid_grant")
	})

	t.Run("mismatched resource", func(t *testing.T) {
		code := approveMCPAuthorization(t, e, clientID, mcpTestRedirectURI, mcpTestVerifier, "resource-check")
		exchanged := postMCPToken(t, e, mcpTokenValues(e, code, clientID, mcpTestRedirectURI, mcpTestVerifier))
		assertStatus(t, exchanged, http.StatusOK)
		refreshToken := jsonField(t, exchanged.Body.Bytes(), "refresh_token")

		values := mcpRefreshTokenValues(e, refreshToken, clientID)
		values.Set("resource", mcpTestOrigin+"/other")
		assertOAuthError(t, postMCPToken(t, e, values), http.StatusBadRequest, "invalid_grant")
	})

	t.Run("login states cannot be replayed as refresh tokens", func(t *testing.T) {
		// A state row that is not a real refresh-token grant (wrong mode) must
		// never redeem as a refresh token, even when stored under the exact id
		// the token endpoint would look up for this token value.
		token := "slashdocs_mcp_refresh_imposter-family.imposter-secret" //nolint:gosec // G101: fabricated test token, not a credential.
		if err := e.stateStore.PutState(context.Background(), "mcp_refresh_family:imposter-family", auth.LoginState{
			Mode: "web", UserID: fixtureUser.ID, OAuthClientID: clientID,
			OAuthResource: e.resource, OAuthRefreshTokenHash: auth.HashToken(token),
			ExpiresAt: time.Now().Add(time.Hour),
		}); err != nil {
			t.Fatal(err)
		}
		values := mcpRefreshTokenValues(e, token, clientID)
		assertOAuthError(t, postMCPToken(t, e, values), http.StatusBadRequest, "invalid_grant")
	})

	t.Run("chains of deleted users cannot be renewed", func(t *testing.T) {
		// Offboarded accounts must not keep a renewable credential factory: a
		// refresh row whose user no longer resolves is consumed, not renewed.
		token := "slashdocs_mcp_refresh_ghost-family.ghost-secret" //nolint:gosec // G101: fabricated test token, not a credential.
		if err := e.stateStore.PutState(context.Background(), "mcp_refresh_family:ghost-family", auth.LoginState{
			Mode: "mcp_refresh", UserID: "usr_deleted", OAuthClientID: clientID,
			OAuthResource: e.resource, OAuthScope: "mcp",
			OAuthRefreshTokenHash: auth.HashToken(token),
			OAuthChainExpiresAt:   time.Now().Add(time.Hour),
			ExpiresAt:             time.Now().Add(time.Hour),
		}); err != nil {
			t.Fatal(err)
		}
		values := mcpRefreshTokenValues(e, token, clientID)
		assertOAuthError(t, postMCPToken(t, e, values), http.StatusBadRequest, "invalid_grant")
	})

	t.Run("chain expiry caps the sliding window", func(t *testing.T) {
		// One consent must not grant perpetual access: a refresh inside the
		// final stretch of the chain issues a token that cannot outlive the
		// chain deadline, enforced by the stored row's expiry.
		code := approveMCPAuthorization(t, e, clientID, mcpTestRedirectURI, mcpTestVerifier, "chain-cap")
		exchanged := postMCPToken(t, e, mcpTokenValues(e, code, clientID, mcpTestRedirectURI, mcpTestVerifier))
		assertStatus(t, exchanged, http.StatusOK)
		refreshToken := jsonField(t, exchanged.Body.Bytes(), "refresh_token")

		// Rewrite the live row as if the chain deadline had already passed;
		// the renewal attempt must fail instead of extending the session.
		familyID, _, found := strings.Cut(strings.TrimPrefix(refreshToken, "slashdocs_mcp_refresh_"), ".")
		if !found {
			t.Fatalf("refresh token %q has no family separator", refreshToken)
		}
		if err := e.stateStore.PutState(context.Background(), "mcp_refresh_family:"+familyID, auth.LoginState{
			Mode: "mcp_refresh", UserID: fixtureUser.ID, OAuthClientID: clientID,
			OAuthResource: e.resource, OAuthScope: "mcp",
			OAuthRefreshTokenHash: auth.HashToken(refreshToken),
			OAuthChainExpiresAt:   time.Now().Add(-time.Minute),
			ExpiresAt:             time.Now().Add(-time.Minute),
		}); err != nil {
			t.Fatal(err)
		}
		assertOAuthError(t, postMCPToken(t, e, mcpRefreshTokenValues(e, refreshToken, clientID)),
			http.StatusBadRequest, "invalid_grant")
	})
}

func TestMCPAndCLIAuthCodesCannotCrossProtocols(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	clientID := registeredMCPClientID(t, e, "Protocol-bound client", []string{mcpTestRedirectURI})

	mcpCode := approveMCPAuthorization(t, e, clientID, mcpTestRedirectURI, mcpTestVerifier, "mcp-to-cli")
	cliBody, err := json.Marshal(map[string]string{
		"code": mcpCode, "code_verifier": mcpTestVerifier, "name": "must-not-work",
	})
	if err != nil {
		t.Fatal(err)
	}
	mcpAsCLI := do(t, e.h, http.MethodPost, "/v1/auth/cli/exchange", string(cliBody), map[string]string{"Content-Type": "application/json"})
	assertStatus(t, mcpAsCLI, http.StatusUnauthorized)

	cliCode := "cli-code-cannot-be-mcp"
	if err := e.stateStore.PutCode(context.Background(), cliCode, auth.LoginState{
		Mode: "cli", CodeChallenge: pkceChallenge(mcpTestVerifier), UserID: fixtureUser.ID,
	}); err != nil {
		t.Fatalf("store CLI code: %v", err)
	}
	cliAsMCP := postMCPToken(t, e, mcpTokenValues(e, cliCode, clientID, mcpTestRedirectURI, mcpTestVerifier))
	assertOAuthError(t, cliAsMCP, http.StatusBadRequest, "invalid_grant")
}

func TestMCPAuthenticatorRequiresAudienceBoundBearerTokens(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	serviceAuthenticator := auth.DBAuthenticator{Resolver: e.store, SessionSecret: oauthTestSigningMaterial}
	authenticator := auth.MCPAuthenticator{
		Users: e.store, ServiceTokens: serviceAuthenticator,
		SessionSecret: oauthTestSigningMaterial, Resource: e.resource,
	}

	valid := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)
	principal := authenticateMCP(t, authenticator, valid, "")
	if principal.Type != fixtureUser.Type || principal.ID != fixtureUser.ID || principal.Email != fixtureUser.Email {
		t.Fatalf("MCP principal = %#v, want %#v", *principal, fixtureUser)
	}

	invalidTokens := []struct {
		name  string
		token string
	}{
		{"expired", auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, -time.Second)},
		{"wrong audience", auth.NewMCPAccessToken(fixtureUser.ID, mcpTestOrigin+"/other", oauthTestSigningMaterial, time.Minute)},
		{"wrong signing key", auth.NewMCPAccessToken(fixtureUser.ID, e.resource, "different-signing-material", time.Minute)},
		{"missing user", auth.NewMCPAccessToken("missing-user", e.resource, oauthTestSigningMaterial, time.Minute)},
		{"tampered", valid + "x"},
	}
	for _, tc := range invalidTokens {
		t.Run(tc.name, func(t *testing.T) {
			assertMCPUnauthorized(t, authenticator, tc.token, "")
		})
	}

	t.Run("browser cookie is never MCP authentication", func(t *testing.T) {
		assertMCPUnauthorized(t, authenticator, "", e.cookie)
	})

	t.Run("CLI credential is never MCP authentication", func(t *testing.T) {
		cliToken, cliHash, err := auth.NewBearerToken("slashdocs_cli_")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.store.CreateCLICredential(context.Background(), fixtureUser.ID, "test", cliHash); err != nil {
			t.Fatalf("create CLI credential: %v", err)
		}
		assertMCPUnauthorized(t, authenticator, cliToken, "")
	})

	t.Run("service-account keys work until disabled or revoked", func(t *testing.T) {
		sa, err := e.store.CreateServiceAccount(context.Background(), fixtureOwner, "mcp-bot")
		if err != nil {
			t.Fatalf("create service account: %v", err)
		}
		token, hash, err := auth.NewBearerToken(auth.ServiceAccountPrefix)
		if err != nil {
			t.Fatal(err)
		}
		keyID, err := e.store.CreateServiceAccountKey(context.Background(), sa.ID, "mcp", hash)
		if err != nil {
			t.Fatalf("create service-account key: %v", err)
		}
		got := authenticateMCP(t, authenticator, token, "")
		if got.Type != auth.PrincipalServiceAccount || got.ID != sa.ID {
			t.Fatalf("service-account principal = %#v, want id %s", got, sa.ID)
		}

		disabled := true
		if _, err := e.store.UpdateServiceAccount(context.Background(), sa.ID, "", &disabled); err != nil {
			t.Fatalf("disable service account: %v", err)
		}
		assertMCPUnauthorized(t, authenticator, token, "")

		disabled = false
		if _, err := e.store.UpdateServiceAccount(context.Background(), sa.ID, "", &disabled); err != nil {
			t.Fatalf("enable service account: %v", err)
		}
		if err := e.store.RevokeServiceAccountKey(context.Background(), sa.ID, keyID); err != nil {
			t.Fatalf("revoke service-account key: %v", err)
		}
		assertMCPUnauthorized(t, authenticator, token, "")
	})

	t.Run("service-account keys issued before the rename still work", func(t *testing.T) {
		sa, err := e.store.CreateServiceAccount(context.Background(), fixtureOwner, "legacy-mcp-bot")
		if err != nil {
			t.Fatalf("create service account: %v", err)
		}
		token, hash, err := auth.NewBearerToken("aidocs_sa_")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.store.CreateServiceAccountKey(context.Background(), sa.ID, "legacy", hash); err != nil {
			t.Fatalf("create service-account key: %v", err)
		}
		if got := authenticateMCP(t, authenticator, token, ""); got.ID != sa.ID {
			t.Fatalf("legacy service-account principal = %#v, want id %s", got, sa.ID)
		}
	})
}

func registerMCPClient(t *testing.T, e *mcpOAuthTestEnv, name string, redirectURIs []string) *httptest.ResponseRecorder {
	t.Helper()
	payload := map[string]any{
		"client_name": name, "redirect_uris": redirectURIs,
		"token_endpoint_auth_method": "none",
		"grant_types":                []string{"authorization_code"}, "response_types": []string{"code"},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return do(t, e.h, http.MethodPost, "/oauth/register", string(body), map[string]string{"Content-Type": "application/json"})
}

func registeredMCPClientID(t *testing.T, e *mcpOAuthTestEnv, name string, redirectURIs []string) string {
	t.Helper()
	rr := registerMCPClient(t, e, name, redirectURIs)
	assertStatus(t, rr, http.StatusCreated)
	return jsonField(t, rr.Body.Bytes(), "client_id")
}

func mcpAuthorizeValues(e *mcpOAuthTestEnv, clientID, redirectURI, verifier, state string) url.Values {
	return url.Values{
		"client_id":             {clientID},
		"redirect_uri":          {redirectURI},
		"response_type":         {"code"},
		"code_challenge":        {pkceChallenge(verifier)},
		"code_challenge_method": {"S256"},
		"resource":              {e.resource},
		"scope":                 {"mcp"},
		"state":                 {state},
	}
}

func postMCPAuthorize(t *testing.T, e *mcpOAuthTestEnv, values url.Values, origin string) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, e.h, http.MethodPost, "/oauth/authorize", values.Encode(), map[string]string{
		"Content-Type": "application/x-www-form-urlencoded", "Cookie": e.cookie, "Origin": origin,
	})
}

func approveMCPAuthorization(t *testing.T, e *mcpOAuthTestEnv, clientID, redirectURI, verifier, state string) string {
	t.Helper()
	values := mcpAuthorizeValues(e, clientID, redirectURI, verifier, state)
	values.Set("decision", "approve")
	rr := postMCPAuthorize(t, e, values, mcpTestOrigin)
	assertStatus(t, rr, http.StatusFound)
	redirect := mustParseURL(t, rr.Header().Get("Location"))
	if got := redirect.Query().Get("state"); got != state {
		t.Fatalf("authorize state = %q, want %q", got, state)
	}
	code := redirect.Query().Get("code")
	if code == "" {
		t.Fatalf("authorization redirect has no code: %s", redirect)
	}
	return code
}

func mcpTokenValues(e *mcpOAuthTestEnv, code, clientID, redirectURI, verifier string) url.Values {
	return url.Values{
		"grant_type":    {"authorization_code"},
		"code":          {code},
		"code_verifier": {verifier},
		"client_id":     {clientID},
		"redirect_uri":  {redirectURI},
		"resource":      {e.resource},
	}
}

func mcpRefreshTokenValues(e *mcpOAuthTestEnv, refreshToken, clientID string) url.Values {
	return url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
		"client_id":     {clientID},
		"resource":      {e.resource},
	}
}

func postMCPToken(t *testing.T, e *mcpOAuthTestEnv, values url.Values) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, e.h, http.MethodPost, "/oauth/token", values.Encode(), map[string]string{
		"Content-Type": "application/x-www-form-urlencoded",
	})
}

func assertOAuthError(t *testing.T, rr *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	assertStatus(t, rr, status)
	if got := jsonField(t, rr.Body.Bytes(), "error"); got != code {
		t.Fatalf("OAuth error = %q, want %q; body=%s", got, code, rr.Body.String())
	}
}

func authenticateMCP(t *testing.T, authenticator auth.MCPAuthenticator, token, cookie string) *auth.Principal {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, mcpTestOrigin+"/mcp", nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	principal, err := authenticator.Authenticate(req)
	if err != nil {
		t.Fatalf("authenticate MCP token: %v", err)
	}
	return principal
}

func assertMCPUnauthorized(t *testing.T, authenticator auth.MCPAuthenticator, token, cookie string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, mcpTestOrigin+"/mcp", nil)
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if cookie != "" {
		req.Header.Set("Cookie", cookie)
	}
	if _, err := authenticator.Authenticate(req); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("Authenticate() error = %v, want ErrUnauthorized", err)
	}
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func cloneValues(values url.Values) url.Values {
	clone := make(url.Values, len(values))
	for key, value := range values {
		clone[key] = append([]string(nil), value...)
	}
	return clone
}

func mustParseURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse URL %q: %v", raw, err)
	}
	return u
}

func paddedMCPRedirectURI(size int) string {
	const prefix = "https://client.example/callback/"
	if size <= len(prefix) {
		return prefix[:size]
	}
	return prefix + strings.Repeat("x", size-len(prefix))
}
