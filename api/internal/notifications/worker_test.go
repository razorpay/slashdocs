package notifications

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/testdb"
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
	store.SetNotificationsEnabled(true)
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
	if _, err := store.CreateGrant(ctx, "document", doc.ID, author, repo.RoleCommenter, owner); err != nil {
		t.Fatal(err)
	}
	sender := &recordingSender{}
	w := Worker{Store: store, Sender: sender, AppOrigin: "https://slashdocs.example.com"}
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

	if got := sender.messages[0]; got.DocumentTitle != "Private" || got.Highlight != "Review" || got.Body != "@Owner" || got.Actor != author.Name || got.Reply {
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
	if got := sender.messages[len(sender.messages)-1]; got.Highlight != "Review" || got.Body != "Reply" || got.Actor != author.Name || !got.Reply {
		t.Fatalf("reply must include root highlight and reply body: %+v", got)
	}

	// The author of the parent comment subscribes to replies, even when they
	// are not the document owner. A document mute clears that reply too.
	reply, err = store.CreateCommentReply(ctx, doc.ID, c.ID, "Owner reply", owner, nil)
	if err != nil {
		t.Fatal(err)
	}
	resetGate()
	if err := w.DeliverNext(ctx); err != nil {
		t.Fatal(err)
	}
	if sender.emails[len(sender.emails)-1] != author.Email || sender.reasons[len(sender.reasons)-1] != "reply" || !strings.Contains(sender.links[len(sender.links)-1], reply.ID) {
		t.Fatal("parent comment author did not receive the reply notification")
	}
	if _, err := store.CreateCommentReply(ctx, doc.ID, c.ID, "@Author", owner, []repo.CommentMention{mention(author, "@Author")}); err != nil {
		t.Fatal(err)
	}
	resetGate()
	if err := w.DeliverNext(ctx); err != nil {
		t.Fatal(err)
	}
	if sender.emails[len(sender.emails)-1] != author.Email || sender.reasons[len(sender.reasons)-1] != "mention" {
		t.Fatal("mention subscription must replace the duplicate reply subscription")
	}
	if _, err := store.CreateCommentReply(ctx, doc.ID, c.ID, "Muted owner reply", owner, nil); err != nil {
		t.Fatal(err)
	}
	if count() != 1 {
		t.Fatal("reply notification was not queued")
	}
	if _, err := store.SetNotificationPreferences(ctx, author, doc.ID, false); err != nil {
		t.Fatal(err)
	}
	if count() != 0 {
		t.Fatal("document mute must discard queued reply notifications")
	}
}

func TestCommentActorFallbacks(t *testing.T) {
	tests := []struct {
		name   string
		author auth.Principal
		want   string
	}{
		{name: "name", author: auth.Principal{Name: "Asha", Email: "asha@example.com", ID: "usr_asha"}, want: "Asha"},
		{name: "email", author: auth.Principal{Email: "asha@example.com", ID: "usr_asha"}, want: "asha@example.com"},
		{name: "id", author: auth.Principal{ID: "usr_asha"}, want: "usr_asha"},
		{name: "anonymous", author: auth.Principal{}, want: "Someone"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := commentActor(tt.author); got != tt.want {
				t.Fatalf("commentActor() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestDocumentAccessNotifications(t *testing.T) {
	ctx := context.Background()
	store, err := pgrepo.Connect(ctx, testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	store.SetNotificationsEnabled(true)

	owner, err := store.UpsertGoogleUser(ctx, "access-owner", "access-owner@example.com", "Owner", "access-owner-sub", "")
	if err != nil {
		t.Fatal(err)
	}
	direct, err := store.UpsertGoogleUser(ctx, "access-direct", "access-direct@example.com", "Direct", "access-direct-sub", "")
	if err != nil {
		t.Fatal(err)
	}
	opened, err := store.UpsertGoogleUser(ctx, "access-opened", "access-opened@example.com", "Opened", "access-opened-sub", "")
	if err != nil {
		t.Fatal(err)
	}
	unopened, err := store.UpsertGoogleUser(ctx, "access-unopened", "access-unopened@example.com", "Unopened", "access-unopened-sub", "")
	if err != nil {
		t.Fatal(err)
	}
	doc, _, err := store.CreateDocument(ctx, owner, "Access review", []byte("<p>Review</p>"))
	if err != nil {
		t.Fatal(err)
	}
	sender := &recordingSender{}
	w := Worker{Store: store, Sender: sender, AppOrigin: "https://slashdocs.example.com"}
	count := func() int {
		t.Helper()
		var n int
		if err := store.Pool().QueryRow(ctx, "SELECT count(*) FROM document_access_notification_outbox").Scan(&n); err != nil {
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
	deliver := func() Message {
		t.Helper()
		resetGate()
		before := len(sender.messages)
		if err := w.DeliverNextDocumentAccess(ctx); err != nil {
			t.Fatal(err)
		}
		if len(sender.messages) != before+1 {
			t.Fatalf("delivered messages=%d, want %d", len(sender.messages), before+1)
		}
		return sender.messages[len(sender.messages)-1]
	}

	grant, err := store.CreateGrant(ctx, "document", doc.ID, direct, repo.RoleViewer, owner)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateGrant(ctx, doc.ID, grant.ID, repo.RoleEditor, owner); err != nil {
		t.Fatal(err)
	}
	if count() != 1 {
		t.Fatal("rapid direct access changes must coalesce")
	}
	got := deliver()
	if got.Reason != "access_shared" || got.Role != repo.RoleEditor || got.PreviousRole != repo.RoleNone || !got.DirectAccess || sender.emails[len(sender.emails)-1] != direct.Email {
		t.Fatalf("wrong direct share notification: %+v", got)
	}
	if err := store.DeleteGrant(ctx, doc.ID, grant.ID, owner); err != nil {
		t.Fatal(err)
	}
	got = deliver()
	if got.Reason != "access_removed" || got.PreviousRole != repo.RoleEditor || got.Role != repo.RoleNone || !got.DirectAccess {
		t.Fatalf("wrong direct removal notification: %+v", got)
	}

	anyoneGrant, err := store.CreateGrant(ctx, "document", doc.ID, auth.Principal{Type: auth.PrincipalAnyone}, repo.RoleViewer, owner)
	if err != nil {
		t.Fatal(err)
	}
	if count() != 0 {
		t.Fatal("org-wide share must not notify users who have not opened the document")
	}
	grant, err = store.CreateGrant(ctx, "document", doc.ID, direct, repo.RoleViewer, owner)
	if err != nil {
		t.Fatal(err)
	}
	got = deliver()
	if got.Reason != "access_shared" || !got.DirectAccess {
		t.Fatalf("direct share must notify even when org-wide access is equivalent: %+v", got)
	}

	if err := store.RecordDocumentOpened(ctx, doc.ID, opened); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateGrant(ctx, doc.ID, anyoneGrant.ID, repo.RoleCommenter, owner); err != nil {
		t.Fatal(err)
	}
	if count() != 1 {
		t.Fatalf("org-wide update queued %d notifications, want one for the prior opener", count())
	}
	got = deliver()
	if got.Reason != "access_updated" || got.PreviousRole != repo.RoleViewer || got.Role != repo.RoleCommenter || got.DirectAccess || sender.emails[len(sender.emails)-1] != opened.Email {
		t.Fatalf("wrong prior-opener notification: %+v", got)
	}
	for _, email := range sender.emails {
		if email == unopened.Email {
			t.Fatal("org-wide access change notified a user who never opened the document")
		}
	}

	if _, err := store.UpdateGrant(ctx, doc.ID, grant.ID, repo.RoleEditor, owner); err != nil {
		t.Fatal(err)
	}
	if count() != 1 {
		t.Fatal("direct role update must be queued")
	}
	got = deliver()
	if got.Reason != "access_updated" || got.PreviousRole != repo.RoleViewer || got.Role != repo.RoleEditor || !got.DirectAccess {
		t.Fatalf("wrong direct access update notification: %+v", got)
	}
	if _, err := store.UpdateGrant(ctx, doc.ID, grant.ID, repo.RoleCommenter, owner); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetNotificationPreferences(ctx, direct, doc.ID, false); err != nil {
		t.Fatal(err)
	}
	if count() != 0 {
		t.Fatal("document mute must discard queued access notifications")
	}
}

func TestDocumentAccessRequestNotification(t *testing.T) {
	ctx := context.Background()
	store, err := pgrepo.Connect(ctx, testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	store.SetNotificationsEnabled(true)
	owner, err := store.UpsertGoogleUser(ctx, "request-owner", "request-owner@example.com", "Owner", "request-owner-sub", "")
	if err != nil {
		t.Fatal(err)
	}
	requester, err := store.UpsertGoogleUser(ctx, "request-reader", "reader@example.com", "Reader", "request-reader-sub", "")
	if err != nil {
		t.Fatal(err)
	}
	doc, _, err := store.CreateDocument(ctx, owner, "Request review", []byte("<p>Private</p>"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.RequestDocumentAccess(ctx, requester, doc.ID); err != nil {
		t.Fatal(err)
	}
	var queued int
	if err := store.Pool().QueryRow(ctx, "SELECT count(*) FROM document_access_request_notification_outbox").Scan(&queued); err != nil || queued != 1 {
		t.Fatalf("queued=%d err=%v, want one owner notification", queued, err)
	}
	sender := &recordingSender{}
	w := Worker{Store: store, Sender: sender, AppOrigin: "https://slashdocs.example.com"}
	if err := w.DeliverNextDocumentAccessRequest(ctx); err != nil {
		t.Fatal(err)
	}
	if len(sender.messages) != 1 || sender.emails[0] != owner.Email || sender.messages[0].Reason != "access_requested" ||
		sender.messages[0].Requester != "Reader (reader@example.com)" || sender.messages[0].DocumentTitle != doc.Title {
		t.Fatalf("wrong access request notification: emails=%v messages=%+v", sender.emails, sender.messages)
	}
	if err := store.RequestDocumentAccess(ctx, requester, doc.ID); err != nil {
		t.Fatal(err)
	}
	if err := store.Pool().QueryRow(ctx, "SELECT count(*) FROM document_access_request_notification_outbox").Scan(&queued); err != nil || queued != 0 {
		t.Fatalf("repeat request queued=%d err=%v, want 24-hour coalescing", queued, err)
	}
}
