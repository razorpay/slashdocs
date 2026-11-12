package auth_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

type resolver struct {
	p auth.Principal
	h string
}

func (r resolver) ResolveBearerToken(ctx context.Context, h string) (auth.Principal, error) {
	if h == r.h {
		return r.p, nil
	}
	return auth.Principal{}, auth.ErrUnauthorized
}
func (r resolver) ResolveUser(ctx context.Context, id string) (auth.Principal, error) {
	if id == r.p.ID {
		return r.p, nil
	}
	return auth.Principal{}, auth.ErrUnauthorized
}

func TestDBAuthenticatorBearerToken(t *testing.T) {
	tok, hash, err := auth.NewBearerToken("slashdocs_cli_")
	if err != nil {
		t.Fatal(err)
	}
	a := auth.DBAuthenticator{Resolver: resolver{p: auth.Principal{Type: auth.PrincipalUser, ID: "usr_1"}, h: hash}}
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	p, err := a.Authenticate(req)
	if err != nil {
		t.Fatal(err)
	}
	if p.ID != "usr_1" {
		t.Fatalf("principal=%+v", p)
	}
}

// erringResolver fails every lookup with a fixed error, standing in for either
// an unknown credential (ErrNotFound) or an infrastructure failure.
type erringResolver struct{ err error }

func (r erringResolver) ResolveBearerToken(ctx context.Context, h string) (auth.Principal, error) {
	return auth.Principal{}, r.err
}
func (r erringResolver) ResolveUser(ctx context.Context, id string) (auth.Principal, error) {
	return auth.Principal{}, r.err
}

func TestDBAuthenticatorUnknownBearerTokenIsUnauthorized(t *testing.T) {
	a := auth.DBAuthenticator{Resolver: erringResolver{err: auth.ErrNotFound}}
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer nope")
	if _, err := a.Authenticate(req); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
}

func TestDBAuthenticatorPropagatesResolverFailures(t *testing.T) {
	dbDown := errors.New("db down")
	a := auth.DBAuthenticator{Resolver: erringResolver{err: dbDown}, SessionSecret: "s"}

	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer tok")
	if _, err := a.Authenticate(req); !errors.Is(err, dbDown) {
		t.Fatalf("bearer path: err = %v, want the resolver failure", err)
	}

	req = httptest.NewRequest("GET", "/", nil)
	req.AddCookie(&http.Cookie{
		Name:     "slashdocs_session",
		Value:    (auth.SessionCodec{Secret: []byte("s")}).Sign("usr_1"),
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	if _, err := a.Authenticate(req); !errors.Is(err, dbDown) {
		t.Fatalf("session path: err = %v, want the resolver failure", err)
	}
}

func TestDBAuthenticatorNoCredentials(t *testing.T) {
	a := auth.DBAuthenticator{Resolver: erringResolver{err: auth.ErrNotFound}, SessionSecret: "s"}
	if _, err := a.Authenticate(httptest.NewRequest("GET", "/", nil)); !errors.Is(err, auth.ErrUnauthorized) {
		t.Fatalf("err = %v, want ErrUnauthorized", err)
	}
}

func TestSessionTokenCarriesExpiryMetadata(t *testing.T) {
	tok := (auth.SessionCodec{Secret: []byte("test-secret")}).Sign("render:ver_1")
	parts := strings.Split(tok, ".")
	if len(parts) < 3 {
		t.Fatalf("signed token has %d parts, want payload with expiry plus signature", len(parts))
	}
}

func TestDBAuthenticatorSignedSession(t *testing.T) {
	secret := "test-secret"
	cookie := (auth.SessionCodec{Secret: []byte(secret)}).Sign("usr_1")
	a := auth.DBAuthenticator{Resolver: resolver{p: auth.Principal{Type: auth.PrincipalUser, ID: "usr_1"}}, SessionSecret: secret}
	req := httptest.NewRequest("GET", "/", nil)
	req.AddCookie(&http.Cookie{
		Name:     "slashdocs_session",
		Value:    cookie,
		Secure:   true,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
	})
	p, err := a.Authenticate(req)
	if err != nil {
		t.Fatal(err)
	}
	if p.ID != "usr_1" {
		t.Fatalf("principal=%+v", p)
	}
}
