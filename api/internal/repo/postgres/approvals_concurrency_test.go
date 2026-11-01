package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// TestPostgresDecisionWaitsForAConcurrentPush queues a version push and then a
// decision behind a row lock on the document, so the decision starts while the
// push is in flight. The decision must see the pushed version: it is refused
// when the content changed or when the approver made the push.
func TestPostgresDecisionWaitsForAConcurrentPush(t *testing.T) {
	ctx := context.Background()
	owner := auth.Principal{Type: auth.PrincipalUser, ID: "usr_race_owner", Email: "race-owner@example.com"}
	approver := auth.Principal{Type: auth.PrincipalUser, ID: "usr_race_approver", Email: "race-approver@example.com"}
	for _, tc := range []struct {
		name   string
		pusher auth.Principal
		want   error
	}{
		{"changed content", owner, repo.ErrVersionConflict},
		{"approver pushed", approver, repo.ErrApproverIsAuthor},
	} {
		t.Run(tc.name, func(t *testing.T) {
			store := newStore(t)
			doc, ver, err := store.CreateDocument(ctx, owner, "Race", []byte("<html>v1</html>"))
			if err != nil {
				t.Fatal(err)
			}
			if _, err := store.CreateApprovalRequest(ctx, doc.ID, approver, owner); err != nil {
				t.Fatal(err)
			}

			blocker, err := store.Pool().Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = blocker.Rollback(ctx) }()
			if _, err := blocker.Exec(ctx, `SELECT 1 FROM documents WHERE id=$1 FOR UPDATE`, doc.ID); err != nil {
				t.Fatal(err)
			}
			waitCtx, cancelWait := context.WithTimeout(ctx, 5*time.Second)
			defer cancelWait()

			pushed := make(chan error, 1)
			go func() {
				_, err := store.CreateVersion(ctx, doc.ID, ver.ID, "", []byte("<html>v2</html>"), tc.pusher)
				pushed <- err
			}()
			if err := waitForLockWaiters(waitCtx, store.Pool(), 1); err != nil {
				t.Fatalf("the push did not wait: %v", err)
			}
			decided := make(chan error, 1)
			go func() {
				_, _, err := store.CreateOrUpdateApproval(ctx, doc.ID, ver.ID, repo.DecisionApproved, "", approver)
				decided <- err
			}()
			if err := waitForLockWaiters(waitCtx, store.Pool(), 2); err != nil {
				t.Fatalf("the decision did not wait: %v", err)
			}
			if err := blocker.Commit(ctx); err != nil {
				t.Fatal(err)
			}

			if err := <-pushed; err != nil {
				t.Fatalf("push: %v", err)
			}
			if err := <-decided; !errors.Is(err, tc.want) {
				t.Fatalf("decision err = %v, want %v", err, tc.want)
			}
		})
	}
}

func TestPostgresPushRemovesTheApproverWhoMadeIt(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	owner := auth.Principal{Type: auth.PrincipalUser, ID: "usr_author_owner", Email: "author-owner@example.com"}
	editor := auth.Principal{Type: auth.PrincipalUser, ID: "usr_author_editor", Email: "author-editor@example.com"}
	doc, ver, err := store.CreateDocument(ctx, owner, "Author", []byte("<html>v1</html>"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateApprovalRequest(ctx, doc.ID, editor, owner); err != nil {
		t.Fatal(err)
	}
	if _, _, err := store.CreateOrUpdateApproval(ctx, doc.ID, ver.ID, repo.DecisionApproved, "", editor); err != nil {
		t.Fatal(err)
	}

	if _, err := store.CreateVersion(ctx, doc.ID, ver.ID, "", []byte("<html>v1</html>"), editor); err != nil {
		t.Fatal(err)
	}

	requests, err := store.ListApprovalRequests(ctx, doc.ID)
	if err != nil || len(requests) != 0 {
		t.Fatalf("approvers = %+v, %v; want none", requests, err)
	}
	decisions, err := store.ListApprovals(ctx, doc.ID, ver.SHA256)
	if err != nil || len(decisions) != 0 {
		t.Fatalf("decisions = %+v, %v; want none", decisions, err)
	}
	if _, err := store.CreateApprovalRequest(ctx, doc.ID, editor, owner); !errors.Is(err, repo.ErrApproverIsAuthor) {
		t.Fatalf("assigning the author again: err = %v, want ErrApproverIsAuthor", err)
	}
}
