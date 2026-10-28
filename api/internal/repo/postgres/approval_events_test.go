package postgres_test

import (
	"context"
	"testing"

	"github.com/jackc/pgx/v5"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/testdb"
)

// Events past their retention are dropped by the next change to approvals, so
// the log does not grow without bound.
func TestApprovalEventsPastRetentionArePruned(t *testing.T) {
	ctx := context.Background()
	url := testdb.New(t)
	store, err := pgrepo.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(store.Close)

	owner := auth.Principal{Type: auth.PrincipalUser, ID: "usr_events_owner", Email: "events-owner@example.com", Name: "Owner"}
	reviewer := auth.Principal{Type: auth.PrincipalUser, ID: "usr_events_reviewer", Email: "events-reviewer@example.com", Name: "Reviewer"}
	if _, err := store.UpsertGoogleUser(ctx, reviewer.ID, reviewer.Email, reviewer.Name, "sub-"+reviewer.ID, ""); err != nil {
		t.Fatal(err)
	}
	doc, _, err := store.CreateDocument(ctx, owner, "Events doc", []byte("<html>v1</html>"))
	if err != nil {
		t.Fatal(err)
	}

	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect for backdating: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close(ctx) })
	for _, age := range []string{"91 days", "10 days"} {
		if _, err := conn.Exec(ctx, `INSERT INTO approval_events(document_id, event_type, created_at) VALUES($1, 'approved', now() - $2::interval)`, doc.ID, age); err != nil {
			t.Fatalf("seed %s old event: %v", age, err)
		}
	}

	if _, err := store.CreateApprovalRequest(ctx, doc.ID, reviewer, owner); err != nil {
		t.Fatal(err)
	}

	events, err := store.ListApprovalEvents(ctx, 0, 10)
	if err != nil {
		t.Fatal(err)
	}
	// The 91-day-old event is gone; the 10-day-old one and the new one remain.
	if len(events) != 2 || events[0].EventType != repo.ApprovalEventApproved || events[1].EventType != repo.ApprovalEventRequested {
		t.Fatalf("events = %+v, want the recent approved event and the new requested one", events)
	}
}
