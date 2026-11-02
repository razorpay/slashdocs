package server_test

import (
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
	"golang.org/x/oauth2"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/server"
)

const identityTestIssuer = "https://sso.example"

// TestOIDCCallbackRelinksUsersAfterIssuerChange covers #203: a user keeps
// their account after SLASHDOCS_OIDC_ISSUER_URL changes, when the earlier
// issuer is listed and the subject is the same. Another subject with the same
// email, such as a recreated IdP account, does not take the account over.
func TestOIDCCallbackRelinksUsersAfterIssuerChange(t *testing.T) {
	const previousIssuer = "https://old-sso.example"
	for _, tc := range []struct {
		name                string
		seedIssuer, seedSub string
		previousIssuers     []string
		wantStatus          int
	}{
		{"same subject under a previous issuer", previousIssuer, "sub-1", []string{previousIssuer}, http.StatusFound},
		{"same subject under an unlisted issuer", previousIssuer, "sub-1", nil, http.StatusConflict},
		{"another subject under a previous issuer", previousIssuer, "sub-0", []string{previousIssuer}, http.StatusConflict},
		{"another subject under the same issuer", identityTestIssuer, "sub-0", []string{previousIssuer}, http.StatusConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := newTestStore(t)
			seed := oidcWebSignIn(t, identityTestHandler(t, store, identityTestOIDC(t, tc.seedIssuer, tc.seedSub), nil))
			assertStatus(t, seed, http.StatusFound)
			existingUserID := sessionUserID(t, seed)
			h := identityTestHandler(t, store, identityTestOIDC(t, identityTestIssuer, "sub-1"), tc.previousIssuers)

			for range 2 {
				rr := oidcWebSignIn(t, h)
				assertStatus(t, rr, tc.wantStatus)
				if tc.wantStatus == http.StatusConflict {
					assertJSON(t, rr.Body.Bytes(), `{
					  "error": {
					    "code": "conflict",
					    "message": "this email is already linked to another sign-in identity; see docs/self-hosting.md#generic-oidc-providers"
					  }
					}`)
					continue
				}
				if got := sessionUserID(t, rr); got != existingUserID {
					t.Fatalf("signed in as %q, want the existing user %q", got, existingUserID)
				}
			}
		})
	}
}

func identityTestHandler(t *testing.T, store repo.Repository, provider auth.OIDC, previousIssuers []string) http.Handler {
	t.Helper()
	return server.New(server.Config{
		Environment:         "test",
		AppOrigin:           "https://app.example",
		SessionSecret:       oauthTestSigningMaterial,
		OIDC:                provider,
		PreviousOIDCIssuers: previousIssuers,
	}, server.WithRepository(store), server.WithStateStore(auth.NewStateStore())).Handler()
}

func oidcWebSignIn(t *testing.T, h http.Handler) *httptest.ResponseRecorder {
	t.Helper()
	start := do(t, h, http.MethodGet, "/v1/auth/oidc/start?mode=web&redirect=/", "", nil)
	assertStatus(t, start, http.StatusFound)
	state := oauthRedirectState(t, start)
	binding := oauthStateCookie(t, start, state)
	return do(t, h, http.MethodGet, "/v1/auth/oidc/callback?state="+url.QueryEscape(state)+"&code=code-1", "", map[string]string{
		"Cookie": oauthRequestCookie(binding.Name, binding.Value),
	})
}

func sessionUserID(t *testing.T, rr *httptest.ResponseRecorder) string {
	t.Helper()
	for _, cookie := range rr.Result().Cookies() {
		if cookie.Name == "slashdocs_session" {
			id, _ := (auth.SessionCodec{Secret: []byte(oauthTestSigningMaterial)}).VerifySession(cookie.Value)
			return id
		}
	}
	t.Fatal("callback did not set a session cookie")
	return ""
}

// identityTestOIDC returns an OIDC client of issuer whose token endpoint
// issues an ID token of subject for reviewer@acme.com, signed by a key its
// verifier trusts.
func identityTestOIDC(t *testing.T, issuer, subject string) auth.OIDC {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key}, nil)
	if err != nil {
		t.Fatal(err)
	}
	claims, err := json.Marshal(map[string]any{
		"iss":            issuer,
		"aud":            "client-id",
		"sub":            subject,
		"exp":            time.Now().Add(time.Hour).Unix(),
		"email":          "reviewer@acme.com",
		"email_verified": true,
	})
	if err != nil {
		t.Fatal(err)
	}
	jws, err := signer.Sign(claims)
	if err != nil {
		t.Fatal(err)
	}
	idToken, err := jws.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	tokenServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "at-1", "token_type": "bearer", "id_token": idToken})
	}))
	t.Cleanup(tokenServer.Close)
	return auth.OIDC{
		Issuer:   issuer,
		Verifier: oidc.NewVerifier(issuer, &oidc.StaticKeySet{PublicKeys: []crypto.PublicKey{key.Public()}}, &oidc.Config{ClientID: "client-id"}),
		Config: &oauth2.Config{
			ClientID: "client-id",
			Endpoint: oauth2.Endpoint{AuthURL: issuer + "/auth", TokenURL: tokenServer.URL},
		},
	}
}
