package postgres_test

import (
	"context"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

func TestGoogleGroupRoleMergesWithDirectAndAnyoneUsingHighestPrecedence(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	owner := auth.Principal{Type: auth.PrincipalUser, ID: "group_owner", Email: "group-owner@example.com"}
	member := auth.Principal{Type: auth.PrincipalUser, ID: "group_member", Email: "group-member@example.com", GoogleGroupIDs: []string{"groups/platform"}}
	if _, err := store.UpsertGoogleUser(ctx, owner.ID, owner.Email, "Owner", "sub-owner", ""); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpsertGoogleUser(ctx, member.ID, member.Email, "Member", "sub-member", ""); err != nil {
		t.Fatal(err)
	}
	doc, _, err := store.CreateDocument(ctx, owner, "Role precedence", []byte("<html></html>"))
	if err != nil {
		t.Fatal(err)
	}
	group := auth.Principal{Type: auth.PrincipalGoogleGroup, ID: "groups/platform", Email: "platform@example.com"}
	if err := store.UpsertGoogleGroup(ctx, repo.GoogleGroup{ID: group.ID, CustomerID: "C123", Email: group.Email, Name: "Platform", LastVerifiedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateGrant(ctx, "document", doc.ID, group, repo.RoleViewer, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateGrant(ctx, "document", doc.ID, member, repo.RoleCommenter, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateGrant(ctx, "document", doc.ID, auth.Principal{Type: auth.PrincipalAnyone}, repo.RoleEditor, owner); err != nil {
		t.Fatal(err)
	}
	if role, err := store.RoleForDocument(ctx, member, doc.ID); err != nil || role != repo.RoleEditor {
		t.Fatalf("merged role=%q err=%v, want editor", role, err)
	}
}
