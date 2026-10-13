package server_test

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/oauth2"

	"github.com/razorpay/slashdocs/api/internal/auth"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/server"
	"github.com/razorpay/slashdocs/api/internal/testdb"
)

const signedOIDCIssuer = "https://issuer.example"

// signedOIDC is an identity provider for callback tests that signs real ID
// tokens. Its token endpoint records the PKCE verifier it receives; the claims
// it signs are produced by the test for each exchange.
type signedOIDC struct {
	t        *testing.T
	key      *rsa.PrivateKey
	srv      *httptest.Server
	mu       sync.Mutex
	verifier string
	claims   func() map[string]any
}

func newSignedOIDC(t *testing.T) *signedOIDC {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p := &signedOIDC{t: t, key: key}
	p.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		p.mu.Lock()
		p.verifier = r.PostForm.Get("code_verifier")
		claims := p.claims()
		p.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"access_token": "at-1",
			"token_type":   "bearer",
			"id_token":     p.sign(claims),
		})
	}))
	t.Cleanup(p.srv.Close)
	return p
}

func (p *signedOIDC) sign(claims map[string]any) string {
	p.t.Helper()
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: p.key}, (&jose.SignerOptions{}).WithHeader("kid", "k1"))
	if err != nil {
		p.t.Fatal(err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		p.t.Fatal(err)
	}
	jws, err := signer.Sign(payload)
	if err != nil {
		p.t.Fatal(err)
	}
	raw, err := jws.CompactSerialize()
	if err != nil {
		p.t.Fatal(err)
	}
	return raw
}

func (p *signedOIDC) oidc(acceptMissingEmailVerified bool) auth.OIDC {
	return auth.OIDC{
		Issuer: signedOIDCIssuer,
		Config: &oauth2.Config{
			ClientID:     "client-id",
			ClientSecret: "client-secret",
			RedirectURL:  "https://app.example/v1/auth/oidc/callback",
			Endpoint:     oauth2.Endpoint{AuthURL: signedOIDCIssuer + "/auth", TokenURL: p.srv.URL},
		},
		Verifier: oidc.NewVerifier(signedOIDCIssuer, &oidc.StaticKeySet{PublicKeys: []crypto.PublicKey{p.key.Public()}},
			&oidc.Config{ClientID: "client-id"}),
		AcceptMissingEmailVerified: acceptMissingEmailVerified,
	}
}

func baseIDClaims(sub, email, nonce string) map[string]any {
	return map[string]any{
		"iss":            signedOIDCIssuer,
		"aud":            "client-id",
		"sub":            sub,
		"iat":            time.Now().Unix(),
		"exp":            time.Now().Add(time.Hour).Unix(),
		"email":          email,
		"email_verified": true,
		"name":           "Reviewer",
		"nonce":          nonce,
	}
}

type signedLoginEnv struct {
	h      http.Handler
	idp    *signedOIDC
	states *auth.StateStore
	store  *pgrepo.Store
}

func newSignedLoginEnv(t *testing.T, acceptMissingEmailVerified bool) signedLoginEnv {
	t.Helper()
	idp := newSignedOIDC(t)
	states := auth.NewStateStore()
	store := newTestStore(t)
	h := server.New(server.Config{
		Environment:   "test",
		AppOrigin:     "https://app.example",
		SessionSecret: oauthTestSigningMaterial,
		OIDC:          idp.oidc(acceptMissingEmailVerified),
	}, server.WithRepository(store), server.WithStateStore(states)).Handler()
	return signedLoginEnv{h: h, idp: idp, states: states, store: store}
}

// startWebLogin begins a browser login and returns the OAuth state, the
// authorization request query, and the browser-binding cookie header.
func (e signedLoginEnv) startWebLogin(t *testing.T) (string, url.Values, string) {
	t.Helper()
	rr := do(t, e.h, http.MethodGet, "/v1/auth/oidc/start?mode=web&redirect=/documents/doc_1", "", nil)
	assertStatus(t, rr, http.StatusFound)
	loc, err := url.Parse(rr.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	state := loc.Query().Get("state")
	binding := oauthStateCookie(t, rr, state)
	return state, loc.Query(), oauthRequestCookie(binding.Name, binding.Value)
}

func (e signedLoginEnv) callback(t *testing.T, state, cookie string) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, e.h, http.MethodGet, "/v1/auth/oidc/callback?state="+url.QueryEscape(state)+"&code=browser-code", "", map[string]string{"Cookie": cookie})
}

func hasSessionCookie(rr *httptest.ResponseRecorder) bool {
	for _, c := range rr.Result().Cookies() {
		if c.Name == "slashdocs_session" && c.Value != "" && c.MaxAge >= 0 {
			return true
		}
	}
	return false
}

func TestOAuthStartBindsNonceAndPKCEToTheStoredState(t *testing.T) {
	e := newSignedLoginEnv(t, false)
	state, q, _ := e.startWebLogin(t)

	if q.Get("nonce") == "" || q.Get("code_challenge") == "" || q.Get("code_challenge_method") != "S256" {
		t.Fatalf("authorization request is missing nonce or S256 PKCE: %v", q)
	}
	if q.Has("code_verifier") {
		t.Fatal("the PKCE verifier leaked into the browser redirect")
	}
	st, ok, err := e.states.TakeState(context.Background(), state)
	if err != nil || !ok {
		t.Fatalf("stored state missing: ok=%t err=%v", ok, err)
	}
	if st.Nonce != q.Get("nonce") {
		t.Fatalf("stored nonce %q does not match the one sent to the IdP %q", st.Nonce, q.Get("nonce"))
	}
	if !auth.VerifyPKCES256(st.PKCEVerifier, q.Get("code_challenge")) {
		t.Fatal("stored PKCE verifier does not match the challenge sent to the IdP")
	}
}

func TestOAuthCallbackWithMatchingNonceAndVerifierSignsIn(t *testing.T) {
	e := newSignedLoginEnv(t, false)
	state, q, cookie := e.startWebLogin(t)
	e.idp.claims = func() map[string]any { return baseIDClaims("sub-1", "reviewer@acme.com", q.Get("nonce")) }

	rr := e.callback(t, state, cookie)

	assertStatus(t, rr, http.StatusFound)
	if loc := rr.Header().Get("Location"); loc != "/documents/doc_1" {
		t.Fatalf("redirect = %q, want /documents/doc_1", loc)
	}
	if !hasSessionCookie(rr) {
		t.Fatal("successful login did not set a session cookie")
	}
	if !auth.VerifyPKCES256(e.idp.verifier, q.Get("code_challenge")) {
		t.Fatalf("token exchange sent verifier %q, which does not match the authorization challenge", e.idp.verifier)
	}
}

func TestOAuthCallbackRejectsIDTokenWithWrongNonce(t *testing.T) {
	for _, tc := range []struct {
		name  string
		nonce func(sent string) any
	}{
		{name: "different nonce", nonce: func(string) any { return "replayed-nonce" }},
		{name: "missing nonce", nonce: func(string) any { return nil }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := newSignedLoginEnv(t, false)
			state, q, cookie := e.startWebLogin(t)
			e.idp.claims = func() map[string]any {
				c := baseIDClaims("sub-1", "reviewer@acme.com", "")
				if n := tc.nonce(q.Get("nonce")); n != nil {
					c["nonce"] = n
				} else {
					delete(c, "nonce")
				}
				return c
			}

			rr := e.callback(t, state, cookie)

			assertStatus(t, rr, http.StatusUnauthorized)
			if hasSessionCookie(rr) {
				t.Fatal("login with a mismatched nonce set a session cookie")
			}
		})
	}
}

func TestOAuthCallbackRejectsTokenThatDoesNotAssertEmailVerified(t *testing.T) {
	e := newSignedLoginEnv(t, false)
	state, q, cookie := e.startWebLogin(t)
	e.idp.claims = func() map[string]any {
		c := baseIDClaims("sub-1", "ceo@acme.com", q.Get("nonce"))
		delete(c, "email_verified")
		return c
	}

	rr := e.callback(t, state, cookie)

	assertStatus(t, rr, http.StatusForbidden)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "email_not_verified", "message": "your identity provider did not confirm that this email address is verified" }
	}`)
	if hasSessionCookie(rr) {
		t.Fatal("unverified email set a session cookie")
	}
	if _, err := e.store.UserByEmail(context.Background(), "ceo@acme.com"); err == nil {
		t.Fatal("an unverified email must not create or claim a user")
	}
}

func TestOAuthCallbackRejectsExplicitlyUnverifiedEmail(t *testing.T) {
	for _, acceptMissing := range []bool{false, true} {
		t.Run(map[bool]string{false: "default", true: "with opt-in"}[acceptMissing], func(t *testing.T) {
			e := newSignedLoginEnv(t, acceptMissing)
			state, q, cookie := e.startWebLogin(t)
			e.idp.claims = func() map[string]any {
				c := baseIDClaims("sub-1", "reviewer@acme.com", q.Get("nonce"))
				c["email_verified"] = false
				return c
			}

			rr := e.callback(t, state, cookie)

			assertStatus(t, rr, http.StatusForbidden)
			assertJSON(t, rr.Body.Bytes(), `{
			  "error": { "code": "email_not_verified", "message": "your identity provider did not confirm that this email address is verified" }
			}`)
		})
	}
}

func TestOAuthCallbackAcceptsMissingEmailVerifiedWhenOperatorOptsIn(t *testing.T) {
	e := newSignedLoginEnv(t, true)
	state, q, cookie := e.startWebLogin(t)
	e.idp.claims = func() map[string]any {
		c := baseIDClaims("sub-1", "reviewer@acme.com", q.Get("nonce"))
		delete(c, "email_verified")
		return c
	}

	rr := e.callback(t, state, cookie)

	assertStatus(t, rr, http.StatusFound)
	if !hasSessionCookie(rr) {
		t.Fatal("opt-in login did not set a session cookie")
	}
}

func TestOAuthCallbackEmailLinkedToAnotherIdentityIsForbiddenNotInternal(t *testing.T) {
	e := newSignedLoginEnv(t, false)
	if _, err := e.store.UpsertGoogleUser(context.Background(), "usr_existing", "taken@acme.com", "Existing", "existing-sub", ""); err != nil {
		t.Fatal(err)
	}
	state, q, cookie := e.startWebLogin(t)
	e.idp.claims = func() map[string]any { return baseIDClaims("different-sub", "taken@acme.com", q.Get("nonce")) }

	rr := e.callback(t, state, cookie)

	assertStatus(t, rr, http.StatusForbidden)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "email_in_use", "message": "this email address is already linked to a different sign-in account" }
	}`)
	if hasSessionCookie(rr) {
		t.Fatal("conflicting identity set a session cookie")
	}
	got, err := e.store.UserByEmail(context.Background(), "taken@acme.com")
	if err != nil || got.ID != "usr_existing" {
		t.Fatalf("existing user changed: %+v err=%v", got, err)
	}
}

func TestOAuthCLICodeDoesNotCarryTheOIDCBinding(t *testing.T) {
	e := newSignedLoginEnv(t, false)
	verifier := "cli-verifier-0123456789-0123456789-0123456789"
	challenge := pkceChallenge(verifier)
	rr := do(t, e.h, http.MethodGet, "/v1/auth/oidc/start?mode=cli&state=cli-state&cli_redirect=http://127.0.0.1:32123/callback&code_challenge="+challenge, "", nil)
	assertStatus(t, rr, http.StatusFound)
	loc, err := url.Parse(rr.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	e.idp.claims = func() map[string]any { return baseIDClaims("sub-1", "reviewer@acme.com", loc.Query().Get("nonce")) }

	cb := do(t, e.h, http.MethodGet, "/v1/auth/oidc/callback?state=cli-state&code=cli-code", "", nil)

	assertStatus(t, cb, http.StatusFound)
	back, err := url.Parse(cb.Header().Get("Location"))
	if err != nil {
		t.Fatal(err)
	}
	code := back.Query().Get("code")
	st, ok, err := e.states.TakeCode(context.Background(), code)
	if err != nil || !ok {
		t.Fatalf("CLI code missing: ok=%t err=%v", ok, err)
	}
	if st.Nonce != "" || st.PKCEVerifier != "" {
		t.Fatalf("CLI code state kept the spent OIDC binding: %+v", st)
	}
}

func TestOAuthCallbackEmailChangedOntoAnotherUsersAddressIsForbidden(t *testing.T) {
	e := newSignedLoginEnv(t, false)
	ctx := context.Background()
	if _, err := e.store.UpsertGoogleUser(ctx, "usr_a", "a@acme.com", "A", "sub-a", ""); err != nil {
		t.Fatal(err)
	}
	// sub-b signs in first with its own address, so the row exists.
	state, q, cookie := e.startWebLogin(t)
	e.idp.claims = func() map[string]any { return baseIDClaims("sub-b", "b@acme.com", q.Get("nonce")) }
	assertStatus(t, e.callback(t, state, cookie), http.StatusFound)

	// The provider now reports sub-b with A's address: the upsert's UPDATE
	// branch hits the unique email constraint.
	state, q, cookie = e.startWebLogin(t)
	e.idp.claims = func() map[string]any { return baseIDClaims("sub-b", "a@acme.com", q.Get("nonce")) }
	rr := e.callback(t, state, cookie)

	assertStatus(t, rr, http.StatusForbidden)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "email_in_use", "message": "this email address is already linked to a different sign-in account" }
	}`)
	got, err := e.store.UserByEmail(ctx, "a@acme.com")
	if err != nil || got.ID != "usr_a" {
		t.Fatalf("A's account changed: %+v err=%v", got, err)
	}
}

// TestOAuthCallbackFinishesLoginStartedByAnOlderInstance drives the real
// rolling-deploy path: a login state persisted in Postgres by a server that
// predates the nonce and PKCE binding must still complete on this server.
func TestOAuthCallbackFinishesLoginStartedByAnOlderInstance(t *testing.T) {
	ctx := context.Background()
	dbURL := testdb.New(t)
	store, err := pgrepo.Connect(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	// Exactly what an older instance wrote: no Nonce, no PKCEVerifier, and no
	// WebBindingRequired.
	legacy := `{"Mode":"web","Redirect":"/documents/doc_1","CLIRedirect":"","CodeChallenge":"","ExpiresAt":"` +
		time.Now().Add(5*time.Minute).UTC().Format(time.RFC3339Nano) + `","GoogleUser":{"Sub":"","Email":"","Name":"","PictureURL":""},"UserID":""}`
	if _, err := pool.Exec(ctx, `INSERT INTO oauth_states(id, kind, state_json, expires_at) VALUES ($1, 'state', $2::jsonb, $3)`,
		"legacy-state", legacy, time.Now().Add(5*time.Minute)); err != nil {
		t.Fatal(err)
	}

	idp := newSignedOIDC(t)
	idp.claims = func() map[string]any {
		c := baseIDClaims("sub-1", "reviewer@acme.com", "")
		delete(c, "nonce")
		return c
	}
	h := server.New(server.Config{
		Environment:   "test",
		AppOrigin:     "https://app.example",
		SessionSecret: oauthTestSigningMaterial,
		OIDC:          idp.oidc(false),
	}, server.WithRepository(store), server.WithStateStore(auth.NewPostgresStateStore(pool))).Handler()

	rr := do(t, h, http.MethodGet, "/v1/auth/oidc/callback?state=legacy-state&code=legacy-code", "", nil)

	assertStatus(t, rr, http.StatusFound)
	if !hasSessionCookie(rr) {
		t.Fatal("legacy login did not sign in")
	}
	if idp.verifier != "" {
		t.Fatalf("a legacy state has no verifier, but %q was sent", idp.verifier)
	}
}

func TestOAuthCallbackEmailChangedOntoAPlaceholderIsForbiddenNotInternal(t *testing.T) {
	e := newSignedLoginEnv(t, false)
	ctx := context.Background()
	state, q, cookie := e.startWebLogin(t)
	e.idp.claims = func() map[string]any { return baseIDClaims("sub-b", "b@acme.com", q.Get("nonce")) }
	assertStatus(t, e.callback(t, state, cookie), http.StatusFound)
	// A pending ownership transfer created a placeholder row for a@acme.com.
	if _, err := e.store.EnsureUserByEmail(ctx, "a@acme.com"); err != nil {
		t.Fatal(err)
	}

	// The upsert now matches sub-b's row and the placeholder; whichever unique
	// constraint fires, the answer is the same 403.
	state, q, cookie = e.startWebLogin(t)
	e.idp.claims = func() map[string]any { return baseIDClaims("sub-b", "a@acme.com", q.Get("nonce")) }
	rr := e.callback(t, state, cookie)

	assertStatus(t, rr, http.StatusForbidden)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "email_in_use", "message": "this email address is already linked to a different sign-in account" }
	}`)
}
