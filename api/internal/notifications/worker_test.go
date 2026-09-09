package notifications

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/aidocs/api/internal/auth"
	"github.com/razorpay/aidocs/api/internal/repo"
	pgrepo "github.com/razorpay/aidocs/api/internal/repo/postgres"
	"github.com/razorpay/aidocs/api/internal/testdb"
)

type recordingSender struct {
	emails   []string
	reasons  []string
	links    []string
	messages []Message
	err      error
}

func (s *recordingSender) Send(_ context.Context, email string, message Message) error {
	s.emails = append(s.emails, email)
	s.reasons = append(s.reasons, message.Reason)
	s.links = append(s.links, message.Link)
	s.messages = append(s.messages, message)
	return s.err
}

func TestOutboxDeliveryPreferencesAndAccess(t *testing.T) {
	ctx := context.Background()
	store, err := pgrepo.Connect(ctx, testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	store.SetCommentNotificationsEnabled(true)
	owner, err := store.UpsertGoogleUser(ctx, "owner", "owner@example.com", "Owner", "owner-sub", "")
	if err != nil {
		t.Fatal(err)
	}
	author, err := store.UpsertGoogleUser(ctx, "author", "author@example.com", "Author", "author-sub", "")
	if err != nil {
		t.Fatal(err)
	}
	stranger, err := store.UpsertGoogleUser(ctx, "stranger", "stranger@example.com", "Stranger", "stranger-sub", "")
	if err != nil {
		t.Fatal(err)
	}
	doc, v, err := store.CreateDocument(ctx, owner, "Private", []byte("<p>Review</p>"))
	if err != nil {
		t.Fatal(err)
	}
	sender := &recordingSender{}
	w := Worker{Store: store, Sender: sender, AppOrigin: "https://aidocs.example.com"}
	create := func(body string, mentions []repo.CommentMention) repo.Comment {
		t.Helper()
		c, err := store.CreateComment(ctx, doc.ID, v.ID, body, repo.Anchor{Quote: "Review"}, author, mentions)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	count := func() int {
		t.Helper()
		var n int
		if err := store.Pool().QueryRow(ctx, "SELECT count(*) FROM comment_notification_outbox").Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	resetGate := func() {
		t.Helper()
		if _, err := store.Pool().Exec(ctx, "UPDATE users SET next_notification_at=now()"); err != nil {
			t.Fatal(err)
		}
	}
	mention := func(p auth.Principal, label string) repo.CommentMention {
		return repo.CommentMention{Principal: p, OffsetUTF16: 0, LengthUTF16: int64(len(label))}
	}
	c := create("@Owner", []repo.CommentMention{mention(owner, "@Owner")})
	if count() != 1 {
		t.Fatal("owner and mention must produce one entry")
	}
	if err := w.DeliverNext(ctx); err != nil {
		t.Fatal(err)
	}
	if count() != 0 || len(sender.emails) != 1 || sender.reasons[0] != "mention" || !strings.Contains(sender.links[0], c.ID) {
		t.Fatal("delivery must delete its entry and link to the comment")
	}

	if got := sender.messages[0]; got.DocumentTitle != "Private" || got.Highlight != "Review" || got.Body != "@Owner" || got.Reply {
		t.Fatalf("wrong comment context: %+v", got)
	}

	emptyMentions := []repo.CommentMention{}
	if _, err := store.UpdateComment(ctx, c.ID, repo.CommentUpdate{Mentions: &emptyMentions}); err != nil {
		t.Fatal(err)
	}
	if count() != 0 {
		t.Fatal("removing a mention must not queue a notification")
	}
	ownerMention := []repo.CommentMention{mention(owner, "@Owner")}
	if _, err := store.UpdateComment(ctx, c.ID, repo.CommentUpdate{Mentions: &ownerMention}); err != nil {
		t.Fatal(err)
	}
	if count() != 1 {
		t.Fatal("adding a mention while editing must queue a notification")
	}
	resetGate()
	if err := w.DeliverNext(ctx); err != nil {
		t.Fatal(err)
	}
	if count() != 0 || sender.reasons[len(sender.reasons)-1] != "mention" {
		t.Fatal("edited mention notification was not delivered")
	}
	if _, err := store.UpdateComment(ctx, c.ID, repo.CommentUpdate{Mentions: &ownerMention}); err != nil {
		t.Fatal(err)
	}
	if count() != 0 {
		t.Fatal("preserving an existing mention must not notify again")
	}

	create("@Author", []repo.CommentMention{mention(author, "@Author")})
	if count() != 1 {
		t.Fatal("author must not receive their own mention")
	}
	if _, err := store.SetNotificationPreferences(ctx, owner, doc.ID, false); err != nil {
		t.Fatal(err)
	}
	if count() != 0 {
		t.Fatal("mute must discard queued messages")
	}
	create("Muted", nil)
	if count() != 0 {
		t.Fatal("muted activity must not be queued")
	}
	if _, err := store.SetNotificationPreferences(ctx, owner, "", false); err != nil {
		t.Fatal(err)
	}
	prefs, err := store.SetNotificationPreferences(ctx, owner, doc.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if !prefs.Enabled || prefs.EffectiveEnabled {
		t.Fatal("global disable must override document enable")
	}
	create("Globally disabled", nil)
	if count() != 0 {
		t.Fatal("global disable must prevent queueing")
	}
	if _, err := store.SetNotificationPreferences(ctx, owner, "", true); err != nil {
		t.Fatal(err)
	}

	deliveredBefore := len(sender.emails)
	create("@Stranger", []repo.CommentMention{mention(stranger, "@Stranger")})
	resetGate()
	for i := 0; i < 2; i++ {
		if err := w.DeliverNext(ctx); err != nil {
			t.Fatal(err)
		}
	}
	if count() != 0 || len(sender.emails) != deliveredBefore+1 || sender.emails[len(sender.emails)-1] != owner.Email {
		t.Fatal("mention must not disclose a private document to a stranger")
	}

	resetGate()
	create("Retry", nil)
	sender.err = &DeliveryError{Code: "rate_limited", RetryAfter: time.Minute}
	if err := w.DeliverNext(ctx); err != nil {
		t.Fatal(err)
	}
	if count() != 1 {
		t.Fatal("temporary failure must retain the entry")
	}
	if claimed, err := store.ClaimCommentNotification(ctx); err != nil || claimed != nil {
		t.Fatal("retry must honor Retry-After")
	}
	if _, err := store.Pool().Exec(ctx, "UPDATE comment_notification_outbox SET available_at=now()"); err != nil {
		t.Fatal(err)
	}
	resetGate()
	sender.err = nil
	if err := w.DeliverNext(ctx); err != nil {
		t.Fatal(err)
	}
	if count() != 0 {
		t.Fatal("successful retry must delete entry")
	}

	// Two workers cannot claim the same live lease. A stale acknowledgement
	// cannot delete a row reclaimed after a crashed worker's lease expires.
	create("Lease", nil)
	first, err := store.ClaimCommentNotification(ctx)
	if err != nil || first == nil {
		t.Fatal(err)
	}
	second, err := store.ClaimCommentNotification(ctx)
	if err != nil || second != nil {
		t.Fatal("live lease claimed twice")
	}
	if _, err := store.Pool().Exec(ctx, "UPDATE comment_notification_outbox SET available_at=now()"); err != nil {
		t.Fatal(err)
	}
	second, err = store.ClaimCommentNotification(ctx)
	if err != nil || second == nil {
		t.Fatal(err)
	}
	if err := store.FinishCommentNotification(ctx, *first, 0); err != nil {
		t.Fatal(err)
	}
	if count() != 1 {
		t.Fatal("stale ack deleted newer claim")
	}
	if err := store.FinishCommentNotification(ctx, *second, 0); err != nil {
		t.Fatal(err)
	}

	// The owner is notified for replies, including comments from agents.
	reply, err := store.CreateCommentReply(ctx, doc.ID, c.ID, "Reply", author, nil)
	if err != nil {
		t.Fatal(err)
	}
	resetGate()
	if err := w.DeliverNext(ctx); err != nil {
		t.Fatal(err)
	}
	if count() != 0 || !strings.Contains(sender.links[len(sender.links)-1], reply.ID) {
		t.Fatal("reply notification missing")
	}
	if got := sender.messages[len(sender.messages)-1]; got.Highlight != "Review" || got.Body != "Reply" || !got.Reply {
		t.Fatalf("reply must include root highlight and reply body: %+v", got)
	}
}
