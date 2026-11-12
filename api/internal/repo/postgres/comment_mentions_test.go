package postgres_test

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
)

type mentionFixture struct {
	store *pgrepo.Store
	owner auth.Principal
	user  auth.Principal
	sa    repo.ServiceAccount
	doc   repo.Document
	ver   repo.Version
}

func newMentionFixture(t *testing.T) *mentionFixture {
	t.Helper()
	ctx := context.Background()
	store := newStore(t)
	owner := auth.Principal{Type: auth.PrincipalUser, ID: "usr_mention_owner", Email: "mention-owner@example.com", Name: "Mention Owner"}
	doc, ver, err := store.CreateDocument(ctx, owner, "Mention test", []byte("<html>mentions</html>"))
	if err != nil {
		t.Fatal(err)
	}
	user, err := store.UpsertGoogleUser(ctx, "usr_mentioned", "mention@example.com", "Mentioned User", "sub-mentioned", "https://example.com/avatar.png")
	if err != nil {
		t.Fatal(err)
	}
	sa, err := store.CreateServiceAccount(ctx, owner, "review-bot")
	if err != nil {
		t.Fatal(err)
	}
	return &mentionFixture{store: store, owner: owner, user: user, sa: sa, doc: doc, ver: ver}
}

func TestPostgresCommentMentionRootReplyAndCanonicalPrincipals(t *testing.T) {
	f := newMentionFixture(t)
	ctx := context.Background()
	disabled := true
	if _, err := f.store.UpdateServiceAccount(ctx, f.sa.ID, "", &disabled); err != nil {
		t.Fatal(err)
	}

	body := "🙂 ping @mention@example.com and @review-bot"
	userMention := mentionAt(t, body, "@mention@example.com", auth.Principal{Type: auth.PrincipalUser, ID: f.user.ID, Email: "spoof@example.com", Name: "Spoof"})
	saMention := mentionAt(t, body, "@review-bot", auth.Principal{Type: auth.PrincipalServiceAccount, ID: f.sa.ID, Name: "spoof-bot"})
	created, err := f.store.CreateComment(ctx, f.doc.ID, f.ver.ID, body, repo.Anchor{Quote: "mentions"}, f.owner, []repo.CommentMention{saMention, userMention})
	if err != nil {
		t.Fatal(err)
	}
	if len(created.Mentions) != 2 || created.Mentions[0].OffsetUTF16 != 8 {
		t.Fatalf("created mentions = %#v", created.Mentions)
	}
	if got := created.Mentions[0].Principal; got.ID != f.user.ID || got.Email != f.user.Email || got.Name != f.user.Name || got.PictureURL != f.user.PictureURL {
		t.Fatalf("canonical user = %#v, want %#v", got, f.user)
	}
	if got := created.Mentions[1].Principal; got.Type != auth.PrincipalServiceAccount || got.ID != f.sa.ID || got.Name != f.sa.Name || got.Email != "" {
		t.Fatalf("canonical service account = %#v", got)
	}

	got, err := f.store.GetComment(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Mentions == nil || !reflect.DeepEqual(got.Mentions, created.Mentions) {
		t.Fatalf("GetComment mentions = %#v, want %#v", got.Mentions, created.Mentions)
	}
	listed, err := f.store.ListComments(ctx, f.doc.ID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].Mentions == nil || !reflect.DeepEqual(listed[0].Mentions, created.Mentions) {
		t.Fatalf("ListComments = %#v", listed)
	}

	replyBody := "Thanks @review-bot."
	reply, err := f.store.CreateCommentReply(ctx, f.doc.ID, created.ID, replyBody, f.owner, []repo.CommentMention{mentionAt(t, replyBody, "@review-bot", auth.Principal{Type: auth.PrincipalServiceAccount, ID: f.sa.ID})})
	if err != nil {
		t.Fatal(err)
	}
	if len(reply.Mentions) != 1 || reply.Mentions[0].Principal.Name != f.sa.Name {
		t.Fatalf("reply mentions = %#v", reply.Mentions)
	}
	role, err := f.store.RoleForDocument(ctx, f.user, f.doc.ID)
	if err != nil || role != repo.RoleNone {
		t.Fatalf("mention unexpectedly granted role %q, err=%v", role, err)
	}
}

func TestPostgresCommentMentionWritesRollbackAtomically(t *testing.T) {
	f := newMentionFixture(t)
	ctx := context.Background()

	before, err := f.store.ListComments(ctx, f.doc.ID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	badBody := "@mention@example.com and @missing"
	_, err = f.store.CreateComment(ctx, f.doc.ID, f.ver.ID, badBody, repo.Anchor{Quote: "mentions"}, f.owner, []repo.CommentMention{
		mentionAt(t, badBody, "@mention@example.com", auth.Principal{Type: auth.PrincipalUser, ID: f.user.ID}),
		mentionAt(t, badBody, "@missing", auth.Principal{Type: auth.PrincipalUser, ID: "usr_missing"}),
	})
	if !errors.Is(err, repo.ErrInvalidCommentMention) {
		t.Fatalf("invalid root error = %v", err)
	}
	after, err := f.store.ListComments(ctx, f.doc.ID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("invalid root inserted a comment: before=%d after=%d", len(before), len(after))
	}

	root, err := f.store.CreateComment(ctx, f.doc.ID, f.ver.ID, "@mention@example.com", repo.Anchor{Quote: "mentions"}, f.owner, []repo.CommentMention{
		mentionAt(t, "@mention@example.com", "@mention@example.com", auth.Principal{Type: auth.PrincipalUser, ID: f.user.ID}),
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = f.store.CreateCommentReply(ctx, f.doc.ID, root.ID, "@missing", f.owner, []repo.CommentMention{
		mentionAt(t, "@missing", "@missing", auth.Principal{Type: auth.PrincipalUser, ID: "usr_missing"}),
	})
	if !errors.Is(err, repo.ErrInvalidCommentMention) {
		t.Fatalf("invalid reply error = %v", err)
	}
	thread, err := f.store.ListComments(ctx, f.doc.ID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, comment := range thread {
		if comment.ParentCommentID == root.ID {
			t.Fatalf("invalid reply persisted: %#v", comment)
		}
	}

	changed := "changed @missing"
	badMention := mentionAt(t, changed, "@missing", auth.Principal{Type: auth.PrincipalUser, ID: "usr_missing"})
	_, err = f.store.UpdateComment(ctx, root.ID, repo.CommentUpdate{Body: &changed, Mentions: &[]repo.CommentMention{badMention}})
	if !errors.Is(err, repo.ErrInvalidCommentMention) {
		t.Fatalf("invalid update error = %v", err)
	}
	unchanged, err := f.store.GetComment(ctx, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	if unchanged.Body != root.Body || !reflect.DeepEqual(unchanged.Mentions, root.Mentions) {
		t.Fatalf("invalid update was not atomic: %#v", unchanged)
	}
}

func TestPostgresCommentMentionPatchTriState(t *testing.T) {
	f := newMentionFixture(t)
	ctx := context.Background()
	body := "Please ask @mention@example.com"
	mention := mentionAt(t, body, "@mention@example.com", auth.Principal{Type: auth.PrincipalUser, ID: f.user.ID})
	comment, err := f.store.CreateComment(ctx, f.doc.ID, f.ver.ID, body, repo.Anchor{Quote: "mentions"}, f.owner, []repo.CommentMention{mention})
	if err != nil {
		t.Fatal(err)
	}

	comment, err = f.store.UpdateComment(ctx, comment.ID, repo.CommentUpdate{Status: "resolved"})
	if err != nil || len(comment.Mentions) != 1 {
		t.Fatalf("status-only update = %#v, %v", comment, err)
	}
	sameBody := body
	comment, err = f.store.UpdateComment(ctx, comment.ID, repo.CommentUpdate{Body: &sameBody})
	if err != nil || len(comment.Mentions) != 1 {
		t.Fatalf("same-body update = %#v, %v", comment, err)
	}

	empty := []repo.CommentMention{}
	comment, err = f.store.UpdateComment(ctx, comment.ID, repo.CommentUpdate{Mentions: &empty})
	if err != nil || comment.Mentions == nil || len(comment.Mentions) != 0 {
		t.Fatalf("explicit clear = %#v, %v", comment.Mentions, err)
	}
	replacement := []repo.CommentMention{mention}
	comment, err = f.store.UpdateComment(ctx, comment.ID, repo.CommentUpdate{Mentions: &replacement})
	if err != nil || len(comment.Mentions) != 1 {
		t.Fatalf("mentions-only replacement = %#v, %v", comment.Mentions, err)
	}

	changedBody := "No structured mention remains"
	comment, err = f.store.UpdateComment(ctx, comment.ID, repo.CommentUpdate{Body: &changedBody})
	if err != nil || comment.Body != changedBody || comment.Mentions == nil || len(comment.Mentions) != 0 {
		t.Fatalf("changed-body implicit clear = %#v, %v", comment, err)
	}
}

func TestPostgresCommentMentionLabelSnapshotsSurviveRenameWithoutAllowingSpoofing(t *testing.T) {
	f := newMentionFixture(t)
	ctx := context.Background()
	oldUser, err := f.store.UpsertGoogleUser(ctx, "usr_rename", "old@example.com", "Old Name", "sub-rename", "")
	if err != nil {
		t.Fatal(err)
	}
	oldBody := "Hello @Old Name"
	oldMention := mentionAt(t, oldBody, "@Old Name", auth.Principal{Type: auth.PrincipalUser, ID: oldUser.ID, Email: "forged@example.com", Name: "Forged"})
	comment, err := f.store.CreateComment(ctx, f.doc.ID, f.ver.ID, oldBody, repo.Anchor{Quote: "mentions"}, f.owner, []repo.CommentMention{oldMention})
	if err != nil {
		t.Fatal(err)
	}

	renamed, err := f.store.UpsertGoogleUser(ctx, oldUser.ID, "new@example.com", "New Name", "sub-rename", "")
	if err != nil {
		t.Fatal(err)
	}
	shiftedBody := "Prefix " + oldBody
	shiftedMention := mentionAt(t, shiftedBody, "@Old Name", auth.Principal{Type: auth.PrincipalUser, ID: oldUser.ID, Name: "Old Name"})
	comment, err = f.store.UpdateComment(ctx, comment.ID, repo.CommentUpdate{Body: &shiftedBody, Mentions: &[]repo.CommentMention{shiftedMention}})
	if err != nil {
		t.Fatalf("shifted historical association rejected after rename: %v", err)
	}
	if len(comment.Mentions) != 1 || comment.Mentions[0].Principal.Name != renamed.Name || comment.Mentions[0].LabelText != "@Old Name" {
		t.Fatalf("renamed mention = %#v", comment.Mentions)
	}

	_, err = f.store.CreateComment(ctx, f.doc.ID, f.ver.ID, "@Old Name", repo.Anchor{Quote: "mentions"}, f.owner, []repo.CommentMention{
		mentionAt(t, "@Old Name", "@Old Name", auth.Principal{Type: auth.PrincipalUser, ID: oldUser.ID, Name: "Old Name"}),
	})
	if !errors.Is(err, repo.ErrInvalidCommentMention) {
		t.Fatalf("fresh stale label error = %v", err)
	}
	_, err = f.store.CreateComment(ctx, f.doc.ID, f.ver.ID, "@Spoofed", repo.Anchor{Quote: "mentions"}, f.owner, []repo.CommentMention{
		mentionAt(t, "@Spoofed", "@Spoofed", auth.Principal{Type: auth.PrincipalUser, ID: oldUser.ID, Email: "spoof@example.com", Name: "Spoofed"}),
	})
	if !errors.Is(err, repo.ErrInvalidCommentMention) {
		t.Fatalf("client identity spoof error = %v", err)
	}

	duplicatedBody := "Prefix @Old Name and @Old Name"
	first := mentionAt(t, duplicatedBody, "@Old Name", auth.Principal{Type: auth.PrincipalUser, ID: oldUser.ID})
	second := mentionAtFrom(t, duplicatedBody, "@Old Name", strings.Index(duplicatedBody, "@Old Name")+1, auth.Principal{Type: auth.PrincipalUser, ID: oldUser.ID})
	_, err = f.store.UpdateComment(ctx, comment.ID, repo.CommentUpdate{Body: &duplicatedBody, Mentions: &[]repo.CommentMention{first, second}})
	if !errors.Is(err, repo.ErrInvalidCommentMention) {
		t.Fatalf("duplicated stale association error = %v", err)
	}
	stillShifted, err := f.store.GetComment(ctx, comment.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stillShifted.Body != shiftedBody || len(stillShifted.Mentions) != 1 {
		t.Fatalf("failed stale duplication changed comment: %#v", stillShifted)
	}
}

func TestPostgresCommentMentionLimit(t *testing.T) {
	f := newMentionFixture(t)
	ctx := context.Background()
	body, fifty := repeatedStoreMentions(f.user, repo.MaxCommentMentions)
	comment, err := f.store.CreateComment(ctx, f.doc.ID, f.ver.ID, body, repo.Anchor{Quote: "mentions"}, f.owner, fifty)
	if err != nil || len(comment.Mentions) != repo.MaxCommentMentions {
		t.Fatalf("50 mentions = %d, %v", len(comment.Mentions), err)
	}

	missing := auth.Principal{Type: auth.PrincipalUser, ID: "usr_missing_cap"}
	body, fiftyOne := repeatedStoreMentions(missing, repo.MaxCommentMentions+1)
	_, err = f.store.CreateComment(ctx, f.doc.ID, f.ver.ID, body, repo.Anchor{Quote: "mentions"}, f.owner, fiftyOne)
	if !errors.Is(err, repo.ErrInvalidCommentMention) || !strings.Contains(err.Error(), "too many mentions") {
		t.Fatalf("51 mentions error = %v, want count rejection before lookup", err)
	}
}

func TestPostgresCommentBodiesNormalizeLegacyMarkers(t *testing.T) {
	f := newMentionFixture(t)
	ctx := context.Background()
	const marker = "\u2063"
	comment, err := f.store.CreateComment(ctx, f.doc.ID, f.ver.ID, "Hello "+marker+"@mention@example.com"+marker, repo.Anchor{Quote: "mentions"}, f.owner, nil)
	if err != nil {
		t.Fatal(err)
	}
	if comment.Body != "Hello @mention@example.com" || strings.Contains(comment.Body, marker) {
		t.Fatalf("created body = %q", comment.Body)
	}
	persisted, err := f.store.GetComment(ctx, comment.ID)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Body != comment.Body {
		t.Fatalf("persisted body = %q, response = %q", persisted.Body, comment.Body)
	}

	reply, err := f.store.CreateCommentReply(ctx, f.doc.ID, comment.ID, marker+"@review-bot"+marker, f.owner, nil)
	if err != nil {
		t.Fatal(err)
	}
	if reply.Body != "@review-bot" {
		t.Fatalf("reply body = %q", reply.Body)
	}
	updatedBody := "Changed " + marker + "@mention@example.com" + marker
	updated, err := f.store.UpdateComment(ctx, comment.ID, repo.CommentUpdate{Body: &updatedBody})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Body != "Changed @mention@example.com" || strings.Contains(updated.Body, marker) {
		t.Fatalf("updated body = %q", updated.Body)
	}

	markerOnly := marker
	if _, err := f.store.UpdateComment(ctx, comment.ID, repo.CommentUpdate{Body: &markerOnly}); !errors.Is(err, repo.ErrInvalidCommentBody) {
		t.Fatalf("marker-only update error = %v", err)
	}
}

func mentionAt(t *testing.T, body, label string, principal auth.Principal) repo.CommentMention {
	t.Helper()
	return mentionAtFrom(t, body, label, 0, principal)
}

func mentionAtFrom(t *testing.T, body, label string, from int, principal auth.Principal) repo.CommentMention {
	t.Helper()
	relative := strings.Index(body[from:], label)
	if relative < 0 {
		t.Fatalf("label %q not found in %q after byte %d", label, body, from)
	}
	byteOffset := from + relative
	return repo.CommentMention{
		Principal:   principal,
		OffsetUTF16: utf16Units(body[:byteOffset]),
		LengthUTF16: utf16Units(label),
	}
}

func utf16Units(value string) int64 {
	var units int64
	for _, r := range value {
		units += int64(utf16.RuneLen(r))
	}
	return units
}

func repeatedStoreMentions(principal auth.Principal, count int) (string, []repo.CommentMention) {
	labelValue := principal.Email
	if labelValue == "" {
		labelValue = principal.ID
	}
	label := "@" + labelValue
	var body strings.Builder
	mentions := make([]repo.CommentMention, 0, count)
	var offset int64
	for i := 0; i < count; i++ {
		if i > 0 {
			body.WriteByte(' ')
			offset++
		}
		body.WriteString(label)
		mentions = append(mentions, repo.CommentMention{Principal: principal, OffsetUTF16: offset, LengthUTF16: int64(len(label))})
		offset += int64(len(label))
	}
	return body.String(), mentions
}
