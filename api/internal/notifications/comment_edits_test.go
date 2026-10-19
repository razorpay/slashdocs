package notifications

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/testdb"
)

func TestEveryCommentEditKeepsItsOwnNotification(t *testing.T) {
	for _, reply := range []bool{false, true} {
		t.Run(fmt.Sprintf("reply=%v", reply), func(t *testing.T) {
			ctx := context.Background()
			store, err := pgrepo.Connect(ctx, testdb.New(t))
			if err != nil {
				t.Fatal(err)
			}
			defer store.Close()
			user := func(id string) auth.Principal {
				t.Helper()
				p, err := store.UpsertGoogleUser(ctx, id, id+"@example.com", id, id+"-sub", "")
				if err != nil {
					t.Fatal(err)
				}
				return p
			}
			owner, author, parent, mentioned := user("owner"), user("author"), user("parent"), user("mentioned")
			doc, version, err := store.CreateDocument(ctx, owner, "Review", []byte("<p>Highlight</p>"))
			if err != nil {
				t.Fatal(err)
			}
			for _, p := range []auth.Principal{author, parent, mentioned} {
				if _, err := store.CreateGrant(ctx, "document", doc.ID, p, repo.RoleCommenter, owner); err != nil {
					t.Fatal(err)
				}
			}
			root, err := store.CreateComment(ctx, doc.ID, version.ID, "Parent", repo.Anchor{Quote: "Highlight"}, parent, nil)
			if err != nil {
				t.Fatal(err)
			}
			store.SetNotificationsEnabled(true)
			mentions := []repo.CommentMention{{Principal: mentioned, OffsetUTF16: 0, LengthUTF16: 10}}
			var comment repo.Comment
			if reply {
				comment, err = store.CreateCommentReply(ctx, doc.ID, root.ID, "@mentioned text to remove", author, mentions)
			} else {
				comment, err = store.CreateComment(ctx, doc.ID, version.ID, "@mentioned text to remove", repo.Anchor{Quote: "Highlight"}, author, mentions)
			}
			if err != nil {
				t.Fatal(err)
			}
			if comment.EditedAt != "" {
				t.Fatal("new comments must not be marked edited")
			}
			claimed, err := store.ClaimCommentNotification(ctx)
			if err != nil || claimed == nil {
				t.Fatalf("claim: %v, %v", claimed, err)
			}
			for _, body := range []string{"@mentioned another text to remove", "@mentioned corrected text"} {
				comment, err = store.UpdateComment(ctx, comment.ID, repo.CommentUpdate{Body: &body, Mentions: &mentions})
				if err != nil {
					t.Fatal(err)
				}
				if comment.EditedAt == "" {
					t.Fatal("edit timestamp missing")
				}
			}
			editTime := comment.EditedAt
			// Identical saves and status changes must neither notify nor change the edit marker.
			comment, err = store.UpdateComment(ctx, comment.ID, repo.CommentUpdate{Body: &comment.Body, Mentions: &mentions, Status: "resolved"})
			if err != nil || comment.EditedAt != editTime {
				t.Fatalf("no-op changed edit marker: %+v, %v", comment, err)
			}
			sender := &recordingSender{}
			worker := Worker{Store: store, Sender: sender, AppOrigin: "https://slashdocs.example.com"}
			if _, err := worker.deliver(ctx, *claimed); err != nil {
				t.Fatal(err)
			}
			if err := store.FinishCommentNotification(ctx, *claimed, 0); err != nil {
				t.Fatal(err)
			}
			recipients := 2
			if reply {
				recipients = 3
			}
			for i := 1; i < recipients*3; i++ {
				if _, err := store.Pool().Exec(ctx, "UPDATE users SET next_notification_at=now()"); err != nil {
					t.Fatal(err)
				}
				if err := worker.DeliverNext(ctx); err != nil {
					t.Fatal(err)
				}
			}
			if len(sender.messages) != recipients*3 {
				t.Fatalf("got %d messages, want %d", len(sender.messages), recipients*3)
			}
			reasons := map[string]int{}
			for _, message := range sender.messages {
				reasons[message.Reason]++
				if message.Body != "@mentioned corrected text" {
					t.Fatalf("pending notification sent removed text: %q", message.Body)
				}
				if message.Highlight != "Highlight" || message.Reply != reply || message.Actor != author.Name {
					t.Fatalf("lost context: %+v", message)
				}
			}
			for _, reason := range []string{"owner", "mention"} {
				if reasons[reason] != 1 || reasons["edited_"+reason] != 2 {
					t.Fatalf("notification events were lost or combined: %v", reasons)
				}
			}
			if reply && (reasons["reply"] != 1 || reasons["edited_reply"] != 2) {
				t.Fatalf("reply notification events were lost or combined: %v", reasons)
			}
			if next, err := store.ClaimCommentNotification(ctx); err != nil || next != nil {
				t.Fatalf("unexpected notification: %+v, %v", next, err)
			}
			listed, err := store.ListComments(ctx, doc.ID, "", "")
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, c := range listed {
				if c.ID == comment.ID {
					found = c.EditedAt == editTime
				}
			}
			if !found {
				t.Fatal("list did not preserve edited timestamp")
			}
		})
	}
}

func TestCommentNotificationRetryReadsLatestText(t *testing.T) {
	ctx := context.Background()
	store, err := pgrepo.Connect(ctx, testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	owner, err := store.UpsertGoogleUser(ctx, "owner", "owner@example.com", "Owner", "owner-sub", "")
	if err != nil {
		t.Fatal(err)
	}
	author, err := store.UpsertGoogleUser(ctx, "author", "author@example.com", "Author", "author-sub", "")
	if err != nil {
		t.Fatal(err)
	}
	doc, version, err := store.CreateDocument(ctx, owner, "Review", []byte("<p>Review</p>"))
	if err != nil {
		t.Fatal(err)
	}
	store.SetNotificationsEnabled(true)
	comment, err := store.CreateComment(ctx, doc.ID, version.ID, "Text removed before retry", repo.Anchor{}, author, nil)
	if err != nil {
		t.Fatal(err)
	}
	sender := &recordingSender{err: &DeliveryError{Code: "rate_limited", RetryAfter: time.Minute}}
	worker := Worker{Store: store, Sender: sender, AppOrigin: "https://slashdocs.example.com"}
	if err := worker.DeliverNext(ctx); err != nil {
		t.Fatal(err)
	}
	if len(sender.messages) != 1 || sender.messages[0].Body != comment.Body {
		t.Fatal("expected the original delivery attempt to fail and be queued for retry")
	}
	corrected := "Corrected text"
	if _, err := store.UpdateComment(ctx, comment.ID, repo.CommentUpdate{Body: &corrected}); err != nil {
		t.Fatal(err)
	}
	sender.err = nil
	if _, err := store.Pool().Exec(ctx, "UPDATE comment_notification_outbox SET available_at=now()"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err := store.Pool().Exec(ctx, "UPDATE users SET next_notification_at=now()"); err != nil {
			t.Fatal(err)
		}
		if err := worker.DeliverNext(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if len(sender.messages) != 3 {
		t.Fatalf("expected failed attempt, retry, and edit notification; got %d attempts", len(sender.messages))
	}
	for _, message := range sender.messages[1:] {
		if message.Body != corrected {
			t.Fatalf("retry or edit notification sent removed text: %q", message.Body)
		}
	}
	if sender.messages[1].Reason != "owner" || sender.messages[2].Reason != "edited_owner" {
		t.Fatalf("original and edit events were not kept separate: %v", sender.reasons)
	}
	if next, err := store.ClaimCommentNotification(ctx); err != nil || next != nil {
		t.Fatalf("unexpected pending notification: %+v, %v", next, err)
	}
}
