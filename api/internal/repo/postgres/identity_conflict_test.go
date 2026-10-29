package postgres_test

import (
	"context"
	"errors"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

// TestUpsertGoogleUserReportsAnEmailIdentityConflict covers the lockout after
// SLASHDOCS_OIDC_ISSUER_URL changes: the same verified email arrives with a
// new identity key while the stored row still holds the previous one.
func TestUpsertGoogleUserReportsAnEmailIdentityConflict(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)

	if _, err := store.UpsertGoogleUser(ctx, "usr_old_issuer", "person@example.com", "Person", "oidc_sha256_old_issuer", ""); err != nil {
		t.Fatalf("seed existing identity: %v", err)
	}

	_, err := store.UpsertGoogleUser(ctx, "usr_new_issuer", "person@example.com", "Person", "oidc_sha256_new_issuer", "")
	if !errors.Is(err, repo.ErrEmailIdentityConflict) {
		t.Fatalf("new identity key for a known email = %v, want repo.ErrEmailIdentityConflict", err)
	}
	var conflict *repo.EmailIdentityConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("error %T does not carry the conflict details", err)
	}
	if conflict.Email != "person@example.com" ||
		conflict.ExistingExternalSubject != "oidc_sha256_old_issuer" ||
		conflict.IncomingExternalSubject != "oidc_sha256_new_issuer" {
		t.Fatalf("conflict details = %+v", conflict)
	}

	// The stored identity key keeps updating the same row as before.
	if _, err := store.UpsertGoogleUser(ctx, "usr_old_issuer", "person@example.com", "Person Renamed", "oidc_sha256_old_issuer", ""); err != nil {
		t.Fatalf("repeat sign-in with the stored identity key: %v", err)
	}
}
