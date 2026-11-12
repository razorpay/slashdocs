package postgres_test

import (
	"context"
	"errors"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

// TestUpsertGoogleUserReportsAnEmailIdentityConflict covers a sign-in after
// SLASHDOCS_OIDC_ISSUER_URL changes: the same verified email arrives with a
// new identity key while the stored user still holds the previous one.
func TestUpsertGoogleUserReportsAnEmailIdentityConflict(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	if _, err := store.UpsertGoogleUser(ctx, "usr_old_issuer", "person@example.com", "Person", "oidc_sha256_old", ""); err != nil {
		t.Fatal(err)
	}

	_, err := store.UpsertGoogleUser(ctx, "usr_new_issuer", "person@example.com", "Person", "oidc_sha256_new", "")
	var conflict *repo.EmailIdentityConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("new identity key for a known email = %v, want *repo.EmailIdentityConflictError", err)
	}
	want := repo.EmailIdentityConflictError{Email: "person@example.com", ExistingIdentity: "oidc_sha256_old", IncomingIdentity: "oidc_sha256_new"}
	if *conflict != want {
		t.Fatalf("conflict = %+v, want %+v", *conflict, want)
	}
}

func TestRelinkUserIdentityKeepsTheUser(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	if _, err := store.UpsertGoogleUser(ctx, "usr_old_issuer", "person@example.com", "Person", "oidc_sha256_old", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpsertGoogleUser(ctx, "usr_other", "other@example.com", "Other", "oidc_sha256_other", ""); err != nil {
		t.Fatal(err)
	}

	if err := store.RelinkUserIdentity(ctx, "oidc_sha256_old", "oidc_sha256_new"); err != nil {
		t.Fatal(err)
	}
	p, err := store.UpsertGoogleUser(ctx, "usr_new_issuer", "person@example.com", "Person Renamed", "oidc_sha256_new", "")
	if err != nil || p.ID != "usr_old_issuer" || p.Name != "Person Renamed" {
		t.Fatalf("sign-in with the relinked key = %+v, %v; want the original user", p, err)
	}

	for _, tc := range []struct{ name, from, to string }{
		{"unknown key", "oidc_sha256_old", "oidc_sha256_newer"},
		{"key already in use", "oidc_sha256_new", "oidc_sha256_other"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := store.RelinkUserIdentity(ctx, tc.from, tc.to); !errors.Is(err, repo.ErrNotFound) {
				t.Fatalf("relink = %v, want repo.ErrNotFound", err)
			}
		})
	}
}
