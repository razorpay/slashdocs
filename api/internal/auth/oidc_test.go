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
	"net/url"
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
	// tokenForm is the form body of the most recent token request.
	tokenForm url.Values
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
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		if err := r.ParseForm(); err != nil {
			t.Error(err)
		}
		f.tokenForm = r.PostForm
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

	if got := o.AuthCodeURL("st-1", auth.LoginBinding{}); !strings.HasPrefix(got, f.issuer+"/auth?") {
		t.Fatalf("AuthCodeURL = %q, want the discovered auth endpoint %s/auth", got, f.issuer)
	}

	f.idToken = f.signIDToken(t, f.idClaims())
	u, err := o.ExchangeAndVerify(context.Background(), "code-1", auth.LoginBinding{})
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

func TestOIDCExchangeRejectsUnverifiedEmail(t *testing.T) {
	f := newFakeIssuer(t)
	o := newFakeOIDC(t, f, auth.OIDCConfig{})

	claims := f.idClaims()
	claims["email_verified"] = false
	f.idToken = f.signIDToken(t, claims)
	if _, err := o.ExchangeAndVerify(context.Background(), "code-1", auth.LoginBinding{}); err == nil {
		t.Fatal("want an error for an unverified email, got nil")
	}
}

func TestOIDCExchangeRejectsMissingEmail(t *testing.T) {
	f := newFakeIssuer(t)
	o := newFakeOIDC(t, f, auth.OIDCConfig{})

	claims := f.idClaims()
	delete(claims, "email")
	f.idToken = f.signIDToken(t, claims)
	if _, err := o.ExchangeAndVerify(context.Background(), "code-1", auth.LoginBinding{}); err == nil || err.Error() != "missing email claim" {
		t.Fatalf("error = %v, want missing email claim", err)
	}
}

func TestOIDCExchangeReadsOnlyTheExactEmailClaim(t *testing.T) {
	f := newFakeIssuer(t)
	o := newFakeOIDC(t, f, auth.OIDCConfig{})

	claims := f.idClaims()
	delete(claims, "email")
	claims["EMAIL"] = "ceo@acme.com"
	f.idToken = f.signIDToken(t, claims)
	if _, err := o.ExchangeAndVerify(context.Background(), "code-1", auth.LoginBinding{}); err == nil || err.Error() != "missing email claim" {
		t.Fatalf("error = %v, want missing email claim for a differently cased EMAIL", err)
	}
}

func TestOIDCExchangeRejectsMissingSubject(t *testing.T) {
	f := newFakeIssuer(t)
	o := newFakeOIDC(t, f, auth.OIDCConfig{})

	claims := f.idClaims()
	delete(claims, "sub")
	f.idToken = f.signIDToken(t, claims)
	if _, err := o.ExchangeAndVerify(context.Background(), "code-1", auth.LoginBinding{}); err == nil || err.Error() != "missing subject claim" {
		t.Fatalf("error = %v, want missing subject claim", err)
	}
}

func TestOIDCExchangeRejectsEmailWithoutVerificationClaimByDefault(t *testing.T) {
	f := newFakeIssuer(t)
	o := newFakeOIDC(t, f, auth.OIDCConfig{})

	claims := f.idClaims()
	delete(claims, "email_verified")
	f.idToken = f.signIDToken(t, claims)
	if _, err := o.ExchangeAndVerify(context.Background(), "code-1", auth.LoginBinding{}); !errors.Is(err, auth.ErrEmailNotVerified) {
		t.Fatalf("error = %v, want ErrEmailNotVerified for a token that does not assert email_verified", err)
	}
}

func TestOIDCExchangeEmailVerificationEvidence(t *testing.T) {
	for _, tc := range []struct {
		name          string
		claims        map[string]any // overrides; a nil value deletes the claim
		acceptMissing bool
		wantVerified  bool
	}{
		{name: "email_verified true", claims: map[string]any{"email_verified": true}, wantVerified: true},
		{name: "email_verified false", claims: map[string]any{"email_verified": false}},
		{name: "email_verified false even with opt-in", claims: map[string]any{"email_verified": false}, acceptMissing: true},
		{name: "email_verified string true (Cognito style)", claims: map[string]any{"email_verified": "true"}, wantVerified: true},
		{name: "email_verified string false", claims: map[string]any{"email_verified": "false"}},
		{name: "email_verified number 1 is not a boolean", claims: map[string]any{"email_verified": 1}},
		{name: "email_verified null with opt-in counts as missing", claims: map[string]any{"email_verified": nil}, acceptMissing: true, wantVerified: true},
		{name: "missing claim with opt-in", claims: map[string]any{"email_verified": nil}, acceptMissing: true, wantVerified: true},
		{name: "Entra xms_edov true", claims: map[string]any{"email_verified": nil, "xms_edov": true}, wantVerified: true},
		{name: "Entra xms_edov string 1", claims: map[string]any{"email_verified": nil, "xms_edov": "1"}, wantVerified: true},
		{name: "Entra xms_edov string true", claims: map[string]any{"email_verified": nil, "xms_edov": "true"}, wantVerified: true},
		{name: "Entra xms_edov false", claims: map[string]any{"email_verified": nil, "xms_edov": false}},
		{name: "Entra xms_edov false even with opt-in", claims: map[string]any{"email_verified": nil, "xms_edov": false}, acceptMissing: true},
		{name: "Entra xms_edov string 0", claims: map[string]any{"email_verified": nil, "xms_edov": "0"}},
		{name: "Entra xms_edov unrecognised value", claims: map[string]any{"email_verified": nil, "xms_edov": "yes"}},
		{name: "email_verified false wins over xms_edov true", claims: map[string]any{"email_verified": false, "xms_edov": true}},
		{name: "differently cased claim cannot override", claims: map[string]any{"email_verified": false, "Email_Verified": true}},
		{name: "differently cased claim does not count", claims: map[string]any{"email_verified": nil, "Email_Verified": true}},
		{name: "upper-case xms_edov does not count", claims: map[string]any{"email_verified": nil, "XMS_EDOV": true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeIssuer(t)
			o := newFakeOIDC(t, f, auth.OIDCConfig{AcceptMissingEmailVerified: tc.acceptMissing})
			claims := f.idClaims()
			for k, v := range tc.claims {
				if v == nil {
					delete(claims, k)
				} else {
					claims[k] = v
				}
			}
			f.idToken = f.signIDToken(t, claims)
			_, err := o.ExchangeAndVerify(context.Background(), "code-1", auth.LoginBinding{})
			if tc.wantVerified && err != nil {
				t.Fatalf("error = %v, want the email accepted as verified", err)
			}
			if !tc.wantVerified && !errors.Is(err, auth.ErrEmailNotVerified) {
				t.Fatalf("error = %v, want ErrEmailNotVerified", err)
			}
		})
	}
}

func TestNewLoginBindingIsFreshAndWellFormed(t *testing.T) {
	a, err := auth.NewLoginBinding()
	if err != nil {
		t.Fatal(err)
	}
	b, err := auth.NewLoginBinding()
	if err != nil {
		t.Fatal(err)
	}
	if a.Nonce == "" || a.PKCEVerifier == "" || a.Nonce == b.Nonce || a.PKCEVerifier == b.PKCEVerifier || a.Nonce == a.PKCEVerifier {
		t.Fatalf("bindings are not fresh, distinct values: %+v %+v", a, b)
	}
	// RFC 7636 section 4.1: 43 to 128 unreserved characters.
	if n := len(a.PKCEVerifier); n < 43 || n > 128 {
		t.Fatalf("PKCE verifier length = %d, want 43..128", n)
	}
}

func TestOIDCAuthCodeURLCarriesNonceAndS256Challenge(t *testing.T) {
	f := newFakeIssuer(t)
	o := newFakeOIDC(t, f, auth.OIDCConfig{})
	b, err := auth.NewLoginBinding()
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(o.AuthCodeURL("st-1", b))
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if q.Get("nonce") != b.Nonce {
		t.Fatalf("nonce = %q, want %q", q.Get("nonce"), b.Nonce)
	}
	if q.Get("code_challenge_method") != "S256" {
		t.Fatalf("code_challenge_method = %q, want S256", q.Get("code_challenge_method"))
	}
	if !auth.VerifyPKCES256(b.PKCEVerifier, q.Get("code_challenge")) {
		t.Fatalf("code_challenge %q is not the S256 of the binding verifier", q.Get("code_challenge"))
	}
	if q.Get("code_verifier") != "" {
		t.Fatal("the PKCE verifier must never appear in the browser redirect")
	}
}

func TestOIDCAuthCodeURLLegacyBindingAddsNothing(t *testing.T) {
	f := newFakeIssuer(t)
	o := newFakeOIDC(t, f, auth.OIDCConfig{})
	u, err := url.Parse(o.AuthCodeURL("st-1", auth.LoginBinding{}))
	if err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"nonce", "code_challenge", "code_challenge_method"} {
		if u.Query().Has(k) {
			t.Fatalf("zero binding added %q to the authorization URL", k)
		}
	}
}

func TestOIDCExchangeSendsPKCEVerifierAndChecksNonce(t *testing.T) {
	b := auth.LoginBinding{Nonce: "nonce-1", PKCEVerifier: "verifier-0123456789-0123456789-0123456789-abc"}
	for _, tc := range []struct {
		name      string
		nonce     any // nil deletes the claim
		wantError bool
	}{
		{name: "matching nonce", nonce: "nonce-1"},
		{name: "different nonce", nonce: "nonce-2", wantError: true},
		{name: "missing nonce", nonce: nil, wantError: true},
		{name: "empty nonce", nonce: "", wantError: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFakeIssuer(t)
			o := newFakeOIDC(t, f, auth.OIDCConfig{})
			claims := f.idClaims()
			if tc.nonce != nil {
				claims["nonce"] = tc.nonce
			}
			f.idToken = f.signIDToken(t, claims)
			_, err := o.ExchangeAndVerify(context.Background(), "code-1", b)
			if gotError := err != nil; gotError != tc.wantError {
				t.Fatalf("error = %v, want error = %t", err, tc.wantError)
			}
			if got := f.tokenForm.Get("code_verifier"); got != b.PKCEVerifier {
				t.Fatalf("token request code_verifier = %q, want the binding verifier", got)
			}
		})
	}
}

func TestOIDCExchangeLegacyBindingSkipsNonceAndVerifier(t *testing.T) {
	f := newFakeIssuer(t)
	o := newFakeOIDC(t, f, auth.OIDCConfig{})
	claims := f.idClaims()
	claims["nonce"] = "whatever"
	f.idToken = f.signIDToken(t, claims)
	if _, err := o.ExchangeAndVerify(context.Background(), "code-1", auth.LoginBinding{}); err != nil {
		t.Fatalf("legacy state from an older instance must still log in: %v", err)
	}
	if f.tokenForm.Has("code_verifier") {
		t.Fatal("legacy state has no verifier; none must be sent")
	}
}

func TestOIDCExchangeRejectsWrongAudience(t *testing.T) {
	f := newFakeIssuer(t)
	o := newFakeOIDC(t, f, auth.OIDCConfig{})

	claims := f.idClaims()
	claims["aud"] = "someone-else"
	f.idToken = f.signIDToken(t, claims)
	if _, err := o.ExchangeAndVerify(context.Background(), "code-1", auth.LoginBinding{}); err == nil {
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
	if got := o.AuthCodeURL("st-1", auth.LoginBinding{}); !strings.HasPrefix(got, publicIssuer+"/auth?") {
		t.Fatalf("AuthCodeURL = %q, want the public auth endpoint", got)
	}
	// ...while the token exchange and JWKS fetch reach the internal host, and
	// the token's public `iss` claim still verifies.
	f.idToken = f.signIDToken(t, f.idClaims())
	u, err := o.ExchangeAndVerify(context.Background(), "code-1", auth.LoginBinding{})
	if err != nil {
		t.Fatal(err)
	}
	if u.Sub != "sub-1" || u.Email != "reviewer@acme.com" {
		t.Fatalf("user = %+v", u)
	}
}
