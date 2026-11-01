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
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
	"golang.org/x/oauth2"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/server"
)

const identityTestIssuer = "https://sso.example"

// TestOIDCCallbackRelinksUsersAfterIssuerChange covers #203: an existing user
// whose generic OIDC identity key came from another issuer URL keeps their
// account, while a user linked to a Google identity is not taken over.
func TestOIDCCallbackRelinksUsersAfterIssuerChange(t *testing.T) {
	for _, tc := range []struct {
		name, existingIdentity string
		wantStatus             int
	}{
		{"generic OIDC identity", "oidc_sha256_before_issuer_change", http.StatusFound},
		{"Google identity", "google-sub-1", http.StatusConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := newTestStore(t)
			if _, err := store.UpsertGoogleUser(context.Background(), "usr_existing", "reviewer@acme.com", "Reviewer", tc.existingIdentity, ""); err != nil {
				t.Fatal(err)
			}
			h := server.New(server.Config{
				Environment:   "test",
				AppOrigin:     "https://app.example",
				SessionSecret: oauthTestSigningMaterial,
				OIDC:          identityTestOIDC(t),
			}, server.WithRepository(store), server.WithStateStore(auth.NewStateStore())).Handler()

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
				if got := sessionUserID(t, rr); got != "usr_existing" {
					t.Fatalf("signed in as %q, want the existing user", got)
				}
			}
		})
	}
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

// identityTestOIDC returns an OIDC client whose token endpoint issues an ID
// token for reviewer@acme.com, signed by a key its verifier trusts.
func identityTestOIDC(t *testing.T) auth.OIDC {
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
		"iss":            identityTestIssuer,
		"aud":            "client-id",
		"sub":            "sub-1",
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
		Issuer:   identityTestIssuer,
		Verifier: oidc.NewVerifier(identityTestIssuer, &oidc.StaticKeySet{PublicKeys: []crypto.PublicKey{key.Public()}}, &oidc.Config{ClientID: "client-id"}),
		Config: &oauth2.Config{
			ClientID: "client-id",
			Endpoint: oauth2.Endpoint{AuthURL: identityTestIssuer + "/auth", TokenURL: tokenServer.URL},
		},
	}
}
