package server_test

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/server"
)

// fakeOIDCIssuer is an in-process OpenID provider for the sign-in callback
// tests: discovery, JWKS, and a token endpoint that returns whatever ID token
// the test signed.
type fakeOIDCIssuer struct {
	srv     *httptest.Server
	key     *rsa.PrivateKey
	issuer  string
	idToken string
}

func newFakeOIDCIssuer(t *testing.T) *fakeOIDCIssuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeOIDCIssuer{key: key}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		writeFakeOIDCJSON(t, w, map[string]any{
			"issuer":                                f.issuer,
			"authorization_endpoint":                f.issuer + "/auth",
			"token_endpoint":                        f.issuer + "/token",
			"jwks_uri":                              f.issuer + "/keys",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/keys", func(w http.ResponseWriter, _ *http.Request) {
		writeFakeOIDCJSON(t, w, jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{
			Key: key.Public(), KeyID: "test-key", Algorithm: "RS256", Use: "sig",
		}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, _ *http.Request) {
		writeFakeOIDCJSON(t, w, map[string]any{
			"access_token": "at-1",
			"token_type":   "bearer",
			"id_token":     f.idToken,
		})
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	f.issuer = f.srv.URL
	return f
}

func writeFakeOIDCJSON(t *testing.T, w http.ResponseWriter, v any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		t.Error(err)
	}
}

func (f *fakeOIDCIssuer) signIDToken(t *testing.T, claims map[string]any) string {
	t.Helper()
	signer, err := jose.NewSigner(
		jose.SigningKey{Algorithm: jose.RS256, Key: f.key},
		(&jose.SignerOptions{}).WithHeader("kid", "test-key"),
	)
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	jws, err := signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := jws.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func (f *fakeOIDCIssuer) idClaims() map[string]any {
	return map[string]any{
		"iss":            f.issuer,
		"aud":            "client-id",
		"sub":            "sub-1",
		"iat":            time.Now().Unix(),
		"exp":            time.Now().Add(time.Hour).Unix(),
		"email":          "reviewer@acme.com",
		"email_verified": true,
		"name":           "Reviewer",
		"picture":        "https://img.example/p.png",
	}
}

func newOIDCCallbackServer(t *testing.T, issuer *fakeOIDCIssuer, store *postgres.Store) http.Handler {
	t.Helper()
	o, err := auth.NewOIDC(context.Background(), auth.OIDCConfig{
		IssuerURL:    issuer.issuer,
		ClientID:     "client-id",
		ClientSecret: "client-secret",
		RedirectURL:  "https://app.example/v1/auth/oidc/callback",
	})
	if err != nil {
		t.Fatalf("build OIDC client: %v", err)
	}
	return server.New(server.Config{
		Environment:   "test",
		AppOrigin:     "https://app.example",
		SessionSecret: oauthTestSigningMaterial,
		OIDC:          o,
	}, server.WithRepository(store), server.WithStateStore(auth.NewStateStore())).Handler()
}

// TestOIDCCallbackRejectsAnEmailLinkedToAnotherIdentity covers the generic
// OIDC lockout after SLASHDOCS_OIDC_ISSUER_URL changes: the sign-in must name
// the cause with a 409 instead of an opaque 500.
func TestOIDCCallbackRejectsAnEmailLinkedToAnotherIdentity(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	if _, err := store.UpsertGoogleUser(ctx, "usr_before_issuer_change", "reviewer@acme.com", "Reviewer", "oidc_sha256_before", ""); err != nil {
		t.Fatalf("seed the account created before the issuer change: %v", err)
	}
	issuer := newFakeOIDCIssuer(t)
	issuer.idToken = issuer.signIDToken(t, issuer.idClaims())
	h := newOIDCCallbackServer(t, issuer, store)

	start := do(t, h, http.MethodGet, "/v1/auth/oidc/start?mode=web&redirect=/documents/doc_1", "", nil)
	assertStatus(t, start, http.StatusFound)
	state := oauthRedirectState(t, start)
	binding := oauthStateCookie(t, start, state)

	rr := do(t, h, http.MethodGet, "/v1/auth/oidc/callback?state="+url.QueryEscape(state)+"&code=code-1", "", map[string]string{
		"Cookie": oauthRequestCookie(binding.Name, binding.Value),
	})
	assertStatus(t, rr, http.StatusConflict)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": {
	    "code": "conflict",
	    "message": "this email is already linked to another sign-in identity; keep the OIDC issuer unchanged for the life of the database (see docs/self-hosting.md#generic-oidc-providers)"
	  }
	}`)
}

// TestOIDCCallbackAdoptsAnUnlinkedUserByVerifiedEmail guards the documented
// relink escape hatch: an existing row without an identity key is adopted by
// the next sign-in with the same verified email.
func TestOIDCCallbackAdoptsAnUnlinkedUserByVerifiedEmail(t *testing.T) {
	ctx := context.Background()
	store := newTestStore(t)
	if _, err := store.EnsureUserByEmail(ctx, "reviewer@acme.com"); err != nil {
		t.Fatalf("seed unlinked user: %v", err)
	}
	issuer := newFakeOIDCIssuer(t)
	issuer.idToken = issuer.signIDToken(t, issuer.idClaims())
	h := newOIDCCallbackServer(t, issuer, store)

	start := do(t, h, http.MethodGet, "/v1/auth/oidc/start?mode=web&redirect=/documents/doc_1", "", nil)
	assertStatus(t, start, http.StatusFound)
	state := oauthRedirectState(t, start)
	binding := oauthStateCookie(t, start, state)

	rr := do(t, h, http.MethodGet, "/v1/auth/oidc/callback?state="+url.QueryEscape(state)+"&code=code-1", "", map[string]string{
		"Cookie": oauthRequestCookie(binding.Name, binding.Value),
	})
	assertStatus(t, rr, http.StatusFound)
	if loc := rr.Header().Get("Location"); loc != "/documents/doc_1" {
		t.Fatalf("callback redirect = %q, want the requested document", loc)
	}
}
