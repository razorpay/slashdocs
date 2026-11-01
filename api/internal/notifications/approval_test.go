package notifications

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/testdb"
)

func TestApprovalNotifications(t *testing.T) {
	ctx := context.Background()
	store, err := pgrepo.Connect(ctx, testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	store.SetNotificationsEnabled(true)
	owner, err := store.UpsertGoogleUser(ctx, "approval-owner", "approval-owner@example.com", "Owner", "approval-owner-sub", "")
	if err != nil {
		t.Fatal(err)
	}
	approver, err := store.UpsertGoogleUser(ctx, "approval-reviewer", "reviewer@example.com", "Reviewer", "approval-reviewer-sub", "")
	if err != nil {
		t.Fatal(err)
	}
	doc, v, err := store.CreateDocument(ctx, owner, "Launch plan", []byte("<p>Plan</p>"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateGrant(ctx, "document", doc.ID, approver, repo.RoleViewer, owner); err != nil {
		t.Fatal(err)
	}
	sender := &recordingSender{}
	w := Worker{Store: store, Sender: sender, AppOrigin: "https://slashdocs.example.com"}
	deliver := func() {
		t.Helper()
		if _, err := store.Pool().Exec(ctx, "UPDATE users SET next_notification_at=now()"); err != nil {
			t.Fatal(err)
		}
		if err := w.DeliverNextApproval(ctx); err != nil {
			t.Fatal(err)
		}
	}
	queued := func() int {
		t.Helper()
		var n int
		if err := store.Pool().QueryRow(ctx, "SELECT count(*) FROM approval_notification_outbox").Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	request, err := store.CreateApprovalRequest(ctx, doc.ID, approver, owner)
	if err != nil {
		t.Fatal(err)
	}
	deliver()
	if len(sender.messages) != 1 || sender.emails[0] != approver.Email || sender.reasons[0] != "approval_requested" ||
		sender.messages[0].Actor != "Owner" || sender.links[0] != "https://slashdocs.example.com/app/d/"+doc.ID+"?approvals=1" {
		t.Fatalf("request notification: emails=%v messages=%+v", sender.emails, sender.messages)
	}

	if _, _, err := store.CreateOrUpdateApproval(ctx, doc.ID, v.ID, repo.DecisionRejected, "needs a rollback plan", approver); err != nil {
		t.Fatal(err)
	}
	deliver()
	if len(sender.messages) != 2 || sender.emails[1] != owner.Email || sender.reasons[1] != "approval_rejected" ||
		sender.messages[1].Actor != "Reviewer" || sender.messages[1].Body != "needs a rollback plan" {
		t.Fatalf("decision notification: emails=%v messages=%+v", sender.emails, sender.messages)
	}

	// A decision revoked before delivery, or an approver removed before their
	// request is delivered, sends nothing.
	approval, _, err := store.CreateOrUpdateApproval(ctx, doc.ID, v.ID, repo.DecisionApproved, "", approver)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteApproval(ctx, doc.ID, approval.ID, approver); err != nil {
		t.Fatal(err)
	}
	deliver()
	if err := store.DeleteApprovalRequest(ctx, doc.ID, request.ID); err != nil {
		t.Fatal(err)
	}
	again, err := store.CreateApprovalRequest(ctx, doc.ID, approver, owner)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteApprovalRequest(ctx, doc.ID, again.ID); err != nil {
		t.Fatal(err)
	}
	deliver()
	if len(sender.messages) != 2 || queued() != 0 {
		t.Fatalf("stale notifications were sent: messages=%+v queued=%d", sender.messages, queued())
	}
}

func TestSlackApprovalMessageContent(t *testing.T) {
	for _, tc := range []struct {
		reason, actor string
		want          []string
	}{
		{"approval_requested", "Owner", []string{"Owner asked you to approve a document", "Review document"}},
		{"approval_approved", "Reviewer", []string{"Reviewer approved your document", "View approvals", "needs a rollback plan"}},
		{"approval_rejected", "Reviewer", []string{"Reviewer rejected your document", "View approvals", "needs a rollback plan"}},
	} {
		message := Message{
			Reason: tc.reason, Actor: tc.actor, DocumentTitle: "Launch <plan>", Body: "needs a rollback plan",
			Link: "https://slashdocs.example.com/app/d/doc_1?approvals=1",
		}
		payload := slackMessage("D1", message)
		encoded, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		for _, want := range append(tc.want, message.Link) {
			if !strings.Contains(string(encoded), want) {
				t.Errorf("%s notification missing %q", tc.reason, want)
			}
		}
		if fallback, ok := payload["text"].(string); !ok || !strings.Contains(fallback, message.DocumentTitle) {
			t.Errorf("%s notification must keep the literal document title", tc.reason)
		}
		if payload["parse"] != "none" || payload["mrkdwn"] != false || payload["link_names"] != false {
			t.Errorf("%s notification content must remain literal", tc.reason)
		}
	}
}
