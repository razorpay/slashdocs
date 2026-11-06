package auth_test

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
	"golang.org/x/oauth2"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

type countingRoundTripper struct {
	requests int
}

func (t *countingRoundTripper) RoundTrip(*http.Request) (*http.Response, error) {
	t.requests++
	return nil, errors.New("unexpected network request")
}

// fakeIssuer is an in-process OIDC provider: discovery, JWKS, and a token
// endpoint that returns whatever ID token the test signs. Setting issuer to
// something other than the httptest URL simulates a split-horizon setup where
// the discovery document names a public issuer the server cannot reach.
type fakeIssuer struct {
	srv     *httptest.Server
	key     *rsa.PrivateKey
	issuer  string
	idToken string
}

func newFakeIssuer(t *testing.T) *fakeIssuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeIssuer{key: key}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
			"issuer":                                f.issuer,
			"authorization_endpoint":                f.issuer + "/auth",
			"token_endpoint":                        f.issuer + "/token",
			"jwks_uri":                              f.issuer + "/keys",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/keys", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{
			Key: key.Public(), KeyID: "test-key", Algorithm: "RS256", Use: "sig",
		}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(t, w, map[string]any{
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

func writeJSON(t *testing.T, w http.ResponseWriter, v any) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		t.Error(err)
	}
}

func (f *fakeIssuer) signIDToken(t *testing.T, claims map[string]any) string {
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

func (f *fakeIssuer) idClaims() map[string]any {
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

func newFakeOIDC(t *testing.T, f *fakeIssuer, cfg auth.OIDCConfig) auth.OIDC {
	t.Helper()
	cfg.ClientID = "client-id"
	cfg.ClientSecret = "client-secret"
	cfg.RedirectURL = "https://app.example/v1/auth/oidc/callback"
	if cfg.IssuerURL == "" {
		cfg.IssuerURL = f.issuer
	}
	o, err := auth.NewOIDC(context.Background(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	return o
}

func TestOIDCExchangeAndVerify(t *testing.T) {
	f := newFakeIssuer(t)
	o := newFakeOIDC(t, f, auth.OIDCConfig{})

	if got := o.AuthCodeURL("st-1"); !strings.HasPrefix(got, f.issuer+"/auth?") {
		t.Fatalf("AuthCodeURL = %q, want the discovered auth endpoint %s/auth", got, f.issuer)
	}

	f.idToken = f.signIDToken(t, f.idClaims())
	u, err := o.ExchangeAndVerify(context.Background(), "code-1")
	if err != nil {
		t.Fatal(err)
	}
	want := auth.OIDCUser{Sub: "sub-1", Email: "reviewer@acme.com", Name: "Reviewer", PictureURL: "https://img.example/p.png"}
	if u != want {
		t.Fatalf("user = %+v, want %+v", u, want)
	}
}

func TestNewOIDCGoogleDoesNotDiscoverAtStartup(t *testing.T) {
	t.Parallel()

	transport := &countingRoundTripper{}
	ctx := oidc.ClientContext(context.Background(), &http.Client{Transport: transport})
	got, err := auth.NewOIDC(ctx, auth.OIDCConfig{
		IssuerURL:    auth.GoogleIssuer,
		ClientID:     "client-id",
		ClientSecret: "client-secret",
		RedirectURL:  "https://app.example/v1/auth/google/callback",
	})
	if err != nil {
		t.Fatalf("construct Google OIDC: %v", err)
	}
	if transport.requests != 0 {
		t.Fatalf("Google OIDC construction made %d network requests, want none", transport.requests)
	}
	if got.Issuer != auth.GoogleIssuer {
		t.Fatalf("issuer = %q, want %q", got.Issuer, auth.GoogleIssuer)
	}
	//nolint:gosec // G101: these are public OAuth protocol endpoints, not credentials.
	wantEndpoint := oauth2.Endpoint{
		AuthURL:       "https://accounts.google.com/o/oauth2/auth",
		TokenURL:      "https://oauth2.googleapis.com/token",
		DeviceAuthURL: "https://oauth2.googleapis.com/device/code",
		AuthStyle:     oauth2.AuthStyleInParams,
	}
	if got.Config.Endpoint != wantEndpoint {
		t.Fatalf("endpoint = %+v, want historical Google endpoint %+v", got.Config.Endpoint, wantEndpoint)
	}
	if got.Verifier == nil {
		t.Fatal("Google OIDC verifier is nil")
	}
}

func TestGoogleVerifierAcceptsOnlyDocumentedIssuerForms(t *testing.T) {
	f := newFakeIssuer(t)
	verifier := oidc.NewVerifier(auth.GoogleIssuer, &oidc.StaticKeySet{
		PublicKeys: []crypto.PublicKey{f.key.Public()},
	}, &oidc.Config{ClientID: "client-id"})

	for _, tc := range []struct {
		name, issuer string
		wantError    bool
	}{
		{name: "canonical HTTPS issuer", issuer: auth.GoogleIssuer},
		{name: "legacy schemeless issuer", issuer: "accounts.google.com"},
		{name: "foreign issuer", issuer: "https://attacker.example", wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			claims := f.idClaims()
			claims["iss"] = tc.issuer
			_, err := verifier.Verify(context.Background(), f.signIDToken(t, claims))
			if gotError := err != nil; gotError != tc.wantError {
				t.Fatalf("Verify issuer %q error = %v, want error = %t", tc.issuer, err, tc.wantError)
			}
		})
	}
}

func TestOIDCExchangeEmailVerification(t *testing.T) {
	f := newFakeIssuer(t)
	o := newFakeOIDC(t, f, auth.OIDCConfig{})

	for _, tc := range []struct {
		name       string
		claims     map[string]any // nil value deletes the claim
		wantReject bool
	}{
		{name: "email_verified true", claims: map[string]any{"email_verified": true}},
		{name: "email_verified string true", claims: map[string]any{"email_verified": "true"}},
		{name: "email_verified false", claims: map[string]any{"email_verified": false}, wantReject: true},
		{name: "email_verified false wins over xms_edov", claims: map[string]any{"email_verified": false, "xms_edov": true}, wantReject: true},
		{name: "no claim", claims: map[string]any{"email_verified": nil}, wantReject: true},
		{name: "Entra xms_edov true", claims: map[string]any{"email_verified": nil, "xms_edov": true}},
		{name: "Entra xms_edov 1", claims: map[string]any{"email_verified": nil, "xms_edov": "1"}},
		{name: "Entra xms_edov false", claims: map[string]any{"email_verified": nil, "xms_edov": false}, wantReject: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			claims := f.idClaims()
			for k, v := range tc.claims {
				if v == nil {
					delete(claims, k)
				} else {
					claims[k] = v
				}
			}
			f.idToken = f.signIDToken(t, claims)
			_, err := o.ExchangeAndVerify(context.Background(), "code-1")
			if gotReject := err != nil; gotReject != tc.wantReject {
				t.Fatalf("error = %v, want reject = %t", err, tc.wantReject)
			}
		})
	}
}

func TestOIDCExchangeRejectsMissingEmail(t *testing.T) {
	f := newFakeIssuer(t)
	o := newFakeOIDC(t, f, auth.OIDCConfig{})

	claims := f.idClaims()
	delete(claims, "email")
	f.idToken = f.signIDToken(t, claims)
	if _, err := o.ExchangeAndVerify(context.Background(), "code-1"); err == nil || err.Error() != "missing email claim" {
		t.Fatalf("error = %v, want missing email claim", err)
	}
}

func TestOIDCExchangeRejectsMissingSubject(t *testing.T) {
	f := newFakeIssuer(t)
	o := newFakeOIDC(t, f, auth.OIDCConfig{})

	claims := f.idClaims()
	delete(claims, "sub")
	f.idToken = f.signIDToken(t, claims)
	if _, err := o.ExchangeAndVerify(context.Background(), "code-1"); err == nil || err.Error() != "missing subject claim" {
		t.Fatalf("error = %v, want missing subject claim", err)
	}
}

func TestOIDCExchangeRejectsWrongAudience(t *testing.T) {
	f := newFakeIssuer(t)
	o := newFakeOIDC(t, f, auth.OIDCConfig{})

	claims := f.idClaims()
	claims["aud"] = "someone-else"
	f.idToken = f.signIDToken(t, claims)
	if _, err := o.ExchangeAndVerify(context.Background(), "code-1"); err == nil {
		t.Fatal("want an audience verification error, got nil")
	}
}

func TestOIDCSplitHorizonIssuer(t *testing.T) {
	const publicIssuer = "https://sso.public.example"
	f := newFakeIssuer(t)
	// Discovery (served over the internal httptest URL) names the public
	// issuer and public endpoints, as an IdP behind docker-compose would.
	f.issuer = publicIssuer
	o := newFakeOIDC(t, f, auth.OIDCConfig{IssuerURL: publicIssuer, InternalIssuerURL: f.srv.URL})

	// Browsers must be sent to the public auth endpoint...
	if got := o.AuthCodeURL("st-1"); !strings.HasPrefix(got, publicIssuer+"/auth?") {
		t.Fatalf("AuthCodeURL = %q, want the public auth endpoint", got)
	}
	// ...while the token exchange and JWKS fetch reach the internal host, and
	// the token's public `iss` claim still verifies.
	f.idToken = f.signIDToken(t, f.idClaims())
	u, err := o.ExchangeAndVerify(context.Background(), "code-1")
	if err != nil {
		t.Fatal(err)
	}
	if u.Sub != "sub-1" || u.Email != "reviewer@acme.com" {
		t.Fatalf("user = %+v", u)
	}
}
