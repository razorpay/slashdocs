package postgres_test

import (
	"context"
	"errors"
	"slices"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// The read marks of a service account work as a user's do, and a mark only
// takes the first comment of a thread in its own document.
func TestPostgresCommentReads(t *testing.T) {
	ctx := context.Background()
	store := newStore(t)
	owner := auth.Principal{Type: auth.PrincipalUser, ID: "usr_reads_owner", Email: "reads@example.com", Name: "Reads Owner"}
	doc, ver, err := store.CreateDocument(ctx, owner, "Reads", "", []byte("<html>reads</html>"))
	if err != nil {
		t.Fatal(err)
	}
	sa, err := store.CreateServiceAccount(ctx, owner, "reader-bot")
	if err != nil {
		t.Fatal(err)
	}
	bot := auth.Principal{Type: auth.PrincipalServiceAccount, ID: sa.ID}
	thread, err := store.CreateComment(ctx, doc.ID, ver.ID, "first", repo.Anchor{Quote: "reads"}, owner, nil)
	if err != nil {
		t.Fatal(err)
	}
	unread := func(reader auth.Principal) []string {
		t.Helper()
		ids, err := store.UnreadCommentThreads(ctx, doc.ID, reader)
		if err != nil {
			t.Fatal(err)
		}
		return ids
	}
	if got := unread(owner); len(got) != 0 {
		t.Fatalf("author's unread = %v, want none", got)
	}
	if got := unread(bot); !slices.Equal(got, []string{thread.ID}) {
		t.Fatalf("bot's unread = %v, want the thread", got)
	}
	if err := store.MarkCommentThreadRead(ctx, doc.ID, thread.ID, bot); err != nil {
		t.Fatal(err)
	}
	if got := unread(bot); len(got) != 0 {
		t.Fatalf("bot's unread after mark = %v, want none", got)
	}
	reply, err := store.CreateCommentReply(ctx, doc.ID, thread.ID, "more", owner, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got := unread(bot); !slices.Equal(got, []string{thread.ID}) {
		t.Fatalf("bot's unread after a reply = %v, want the thread once", got)
	}
	for _, tc := range []struct{ docID, threadID string }{
		{doc.ID, reply.ID},
		{"doc_other", thread.ID},
	} {
		if err := store.MarkCommentThreadRead(ctx, tc.docID, tc.threadID, bot); !errors.Is(err, repo.ErrNotFound) {
			t.Fatalf("mark %s in %s = %v, want ErrNotFound", tc.threadID, tc.docID, err)
		}
	}
}
