package server_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

// approvalEvents returns the events written so far, oldest first.
func approvalEvents(t *testing.T, e *testEnv) []repo.ApprovalEvent {
	t.Helper()
	events, err := e.store.ListApprovalEvents(context.Background(), 0, 100)
	if err != nil {
		t.Fatalf("list approval events: %v", err)
	}
	return events
}

// approvalEventTypes is the types of the events written for one document, in
// order, as one string.
func approvalEventTypes(t *testing.T, e *testEnv, docID string) string {
	t.Helper()
	var types []string
	for _, ev := range approvalEvents(t, e) {
		if ev.DocumentID == docID {
			types = append(types, ev.EventType)
		}
	}
	return strings.Join(types, ",")
}

func TestApprovalEventsRecordEachChange(t *testing.T) {
	e := newTestEnv(t)
	requestID := mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)
	// Changing the decision replaces it and is an event of its own.
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "changes_requested", fixtureViewer), http.StatusOK)

	decisionID := listApprovals(t, e, e.doc.ID, "", fixtureViewer).Items[0].ID
	rr := do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/approvals/"+decisionID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, rr, http.StatusNoContent)

	// A new version of a document with approvers resets or carries their approvals.
	pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, false, fixtureEditor)

	rr = do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/approvers/"+requestID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, rr, http.StatusNoContent)

	want := "requested,approved,rejected,revoked,version_created,removed"
	if got := approvalEventTypes(t, e, e.doc.ID); got != want {
		t.Fatalf("events = %s, want %s", got, want)
	}
}

func TestApprovalEventsSkipDocumentsWithoutApprovers(t *testing.T) {
	e := newTestEnv(t)
	// Nobody is asked to approve, so a new version has no approval state to reset.
	pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, false, fixtureEditor)

	if got := approvalEventTypes(t, e, e.doc.ID); got != "" {
		t.Fatalf("events = %q, want none", got)
	}
}

func TestRefusedApprovalChangesWriteNoEvent(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)

	// Already an approver: refused, and the event rolled back with it.
	rr := assignApprover(t, e, e.doc.ID, `{"principal": {"type": "user", "email": "viewer@example.com"}}`, fixtureOwner)
	assertStatus(t, rr, http.StatusConflict)
	// Not an assigned approver.
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureCommenter), http.StatusForbidden)
	// A version that is no longer the latest.
	pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, false, fixtureEditor)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusConflict)

	if got, want := approvalEventTypes(t, e, e.doc.ID), "requested,version_created"; got != want {
		t.Fatalf("events = %s, want %s", got, want)
	}
}

func TestApprovalEventsPageByCursor(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "changes_requested", fixtureViewer), http.StatusOK)

	ctx := context.Background()
	first, err := e.store.ListApprovalEvents(ctx, 0, 2)
	if err != nil || len(first) != 2 {
		t.Fatalf("first page = %+v, %v; want 2 events", first, err)
	}
	rest, err := e.store.ListApprovalEvents(ctx, first[1].ID, 10)
	if err != nil || len(rest) != 1 {
		t.Fatalf("after cursor = %+v, %v; want the one event left", rest, err)
	}
	if first[0].ID >= first[1].ID || first[1].ID >= rest[0].ID {
		t.Fatalf("ids = %d, %d, %d; want increasing", first[0].ID, first[1].ID, rest[0].ID)
	}
	for _, ev := range append(first, rest...) {
		if ev.DocumentID != e.doc.ID || ev.CreatedAt == "" {
			t.Fatalf("event = %+v, want the document id and a creation time", ev)
		}
	}
	if rest[0].EventType != repo.ApprovalEventRejected {
		t.Fatalf("last event = %s, want %s", rest[0].EventType, repo.ApprovalEventRejected)
	}
}
