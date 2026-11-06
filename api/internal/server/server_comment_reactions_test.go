package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

func reactionPath(docID, commentID, emoji string) string {
	return "/v1/documents/" + docID + "/comments/" + commentID + "/reactions/" + emoji
}

func reactTo(t *testing.T, e *testEnv, method, docID, commentID, emoji string, p auth.Principal) {
	t.Helper()
	rr := do(t, e.h, method, reactionPath(docID, commentID, emoji), "", map[string]string{
		"X-Test-Principal": principalHeader(p),
	})
	assertStatus(t, rr, http.StatusNoContent)
}

// reactionsOf returns the reaction groups the given principal sees on the
// fixture's root comment, in the order the API reports them.
func reactionsOf(t *testing.T, e *testEnv, p auth.Principal) []map[string]any {
	t.Helper()
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/comments", "", map[string]string{
		"X-Test-Principal": principalHeader(p),
	})
	assertStatus(t, rr, http.StatusOK)
	var out struct {
		Items []struct {
			Reactions []map[string]any `json:"reactions"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad comments response: %v", err)
	}
	if len(out.Items) == 0 {
		t.Fatalf("no comments returned")
	}
	return out.Items[0].Reactions
}

func TestReactToCommentIsIdempotent(t *testing.T) {
	e := newTestEnv(t)
	for i := 0; i < 2; i++ {
		reactTo(t, e, http.MethodPut, e.doc.ID, e.cmt.ID, "+1", fixtureCommenter)
	}

	got := reactionsOf(t, e, fixtureCommenter)
	if len(got) != 1 || got[0]["emoji"] != "+1" || got[0]["count"] != float64(1) || got[0]["reacted"] != true {
		t.Fatalf("reactions after double PUT = %#v, want a single +1 with count 1 and reacted true", got)
	}

	// Removing is likewise idempotent: the second delete finds nothing to do.
	for i := 0; i < 2; i++ {
		reactTo(t, e, http.MethodDelete, e.doc.ID, e.cmt.ID, "+1", fixtureCommenter)
	}
	if got := reactionsOf(t, e, fixtureCommenter); len(got) != 0 {
		t.Fatalf("reactions after delete = %#v, want none", got)
	}
}

// Each viewer must see the shared count but only their own "reacted" flag.
func TestReactionCountsAreViewerScoped(t *testing.T) {
	e := newTestEnv(t)
	for _, p := range []auth.Principal{fixtureCommenter, fixtureEditor} {
		reactTo(t, e, http.MethodPut, e.doc.ID, e.cmt.ID, "+1", p)
	}

	for _, p := range []auth.Principal{fixtureCommenter, fixtureEditor} {
		got := reactionsOf(t, e, p)
		if len(got) != 1 || got[0]["count"] != float64(2) || got[0]["reacted"] != true {
			t.Fatalf("reactions for %s = %#v, want count 2 and reacted true", p.ID, got)
		}
	}

	got := reactionsOf(t, e, fixtureViewer)
	if len(got) != 1 || got[0]["count"] != float64(2) || got[0]["reacted"] != false {
		t.Fatalf("reactions for a principal who did not react = %#v, want count 2 and reacted false", got)
	}
}

// Groups must keep first-reaction order across requests. Aggregating by
// ranging a Go map would make this flake instead of failing outright.
func TestReactionOrderIsStableAcrossRequests(t *testing.T) {
	e := newTestEnv(t)
	for _, emoji := range []string{"eyes", "rocket", "+1"} {
		reactTo(t, e, http.MethodPut, e.doc.ID, e.cmt.ID, emoji, fixtureCommenter)
	}

	var first string
	for i := 0; i < 5; i++ {
		order := make([]string, 0, 3)
		for _, r := range reactionsOf(t, e, fixtureCommenter) {
			emoji, _ := r["emoji"].(string)
			order = append(order, emoji)
		}
		joined := strings.Join(order, ",")
		if i == 0 {
			first = joined
			continue
		}
		if joined != first {
			t.Fatalf("reaction order changed between identical requests: %q then %q", first, joined)
		}
	}
	if first != "eyes,rocket,+1" {
		t.Fatalf("reaction order = %q, want first-reaction order \"eyes,rocket,+1\"", first)
	}
}

func TestReactionOnReply(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments/"+e.cmt.ID+"/replies", `{"body":"reply body"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusCreated)
	replyID := jsonField(t, rr.Body.Bytes(), "id")

	reactTo(t, e, http.MethodPut, e.doc.ID, replyID, "heart", fixtureCommenter)

	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/comments", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusOK)
	var out struct {
		Items []struct {
			Replies []struct {
				Reactions []map[string]any `json:"reactions"`
			} `json:"replies"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad comments response: %v", err)
	}
	if len(out.Items) != 1 || len(out.Items[0].Replies) != 1 {
		t.Fatalf("want one root comment with one reply, got %#v", out.Items)
	}
	got := out.Items[0].Replies[0].Reactions
	if len(got) != 1 || got[0]["emoji"] != "heart" || got[0]["count"] != float64(1) {
		t.Fatalf("reply reactions = %#v, want a single heart", got)
	}
}

// Every advertised slug must survive both the handler allowlist and the
// column CHECK; a slug added to one but not the other fails here rather than
// at runtime.
func TestEveryAllowedReactionSlugIsAccepted(t *testing.T) {
	e := newTestEnv(t)
	slugs := []string{"+1", "-1", "laugh", "hooray", "confused", "heart", "rocket", "eyes", "plus"}
	for _, emoji := range slugs {
		reactTo(t, e, http.MethodPut, e.doc.ID, e.cmt.ID, emoji, fixtureCommenter)
	}

	got := reactionsOf(t, e, fixtureCommenter)
	if len(got) != len(slugs) {
		t.Fatalf("reaction groups = %d, want %d: %#v", len(got), len(slugs), got)
	}
	for i, emoji := range slugs {
		if got[i]["emoji"] != emoji || got[i]["count"] != float64(1) {
			t.Fatalf("group %d = %#v, want emoji %q with count 1", i, got[i], emoji)
		}
	}
}

func TestReactionRejectsUnknownEmoji(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPut, reactionPath(e.doc.ID, e.cmt.ID, "pineapple"), "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})

	assertStatus(t, rr, http.StatusBadRequest)
}

func TestViewerCannotReact(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPut, reactionPath(e.doc.ID, e.cmt.ID, "+1"), "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureViewer),
	})

	assertStatus(t, rr, http.StatusForbidden)
}

// Creating a document requires no role, so an attacker owns any document they
// create. Authorizing only the document named in the URL would let them write
// a reaction onto a comment in a document they cannot read -- which is also
// how a revoked grant would be bypassed by anyone still holding a comment id.
func TestReactionRejectsCommentFromAnotherDocument(t *testing.T) {
	e := newTestEnv(t)
	attackerDoc, _ := e.createDocument("Attacker", "<html>attacker</html>", fixtureAttacker)

	for _, method := range []string{http.MethodPut, http.MethodDelete} {
		rr := do(t, e.h, method, reactionPath(attackerDoc, e.cmt.ID, "+1"), "", map[string]string{
			"X-Test-Principal": principalHeader(fixtureAttacker),
		})
		assertStatus(t, rr, http.StatusNotFound)
	}

	if got := reactionsOf(t, e, fixtureCommenter); len(got) != 0 {
		t.Fatalf("comment in another document gained reactions = %#v, want none", got)
	}
}

func TestReactionRejectsUnknownComment(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPut, reactionPath(e.doc.ID, "cmt_missing", "+1"), "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})

	assertStatus(t, rr, http.StatusNotFound)
}

func TestDeletingCommentRemovesReactions(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", fmt.Sprintf(`{
	  "version_id": %q, "body": "temporary", "anchor": { "quote": "fixture" }
	}`, e.ver.ID), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusCreated)
	commentID := jsonField(t, rr.Body.Bytes(), "id")

	reactTo(t, e, http.MethodPut, e.doc.ID, commentID, "rocket", fixtureCommenter)

	rr = do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/comments/"+commentID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusNoContent)

	var count int
	if err := e.store.Pool().QueryRow(context.Background(),
		"SELECT count(*) FROM comment_reactions WHERE comment_id = $1", commentID).Scan(&count); err != nil {
		t.Fatalf("count reactions: %v", err)
	}
	if count != 0 {
		t.Fatalf("reaction rows after comment delete = %d, want 0 via ON DELETE CASCADE", count)
	}
}

func TestReactionIdentitiesIncludeUsersAndServiceAccounts(t *testing.T) {
	e := newTestEnv(t)
	// Deliberately share an ID across principal types to catch incorrect joins.
	human := auth.Principal{Type: auth.PrincipalUser, ID: e.sa.ID, Name: "Reviewer", Email: "reviewer@example.com"}
	bot := auth.Principal{Type: auth.PrincipalServiceAccount, ID: e.sa.ID, Name: e.sa.Name}
	nameless := fixtureCommenter
	nameless.Name = ""
	e.seedUser(human)
	e.seedUser(nameless)
	for _, p := range []auth.Principal{human, bot} {
		if _, err := e.store.CreateGrant(context.Background(), "document", e.doc.ID, p, repo.RoleCommenter, fixtureOwner); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range []auth.Principal{human, bot, nameless} {
		reactTo(t, e, http.MethodPut, e.doc.ID, e.cmt.ID, "heart", p)
	}
	for _, viewer := range []auth.Principal{fixtureViewer, bot} {
		groups := reactionsOf(t, e, viewer)
		if len(groups) != 1 || groups[0]["count"] != float64(3) || groups[0]["reacted"] != (viewer.Type == auth.PrincipalServiceAccount) {
			t.Fatalf("unexpected reaction group: %#v", groups)
		}
		raw, err := json.Marshal(groups[0]["reactors"])
		if err != nil {
			t.Fatal(err)
		}
		var reactors []auth.Principal
		if err := json.Unmarshal(raw, &reactors); err != nil {
			t.Fatal(err)
		}
		if len(reactors) != 3 {
			t.Fatalf("reactor count = %d, want 3", len(reactors))
		}
		byID := map[string]auth.Principal{}
		for _, p := range reactors {
			byID[string(p.Type)+":"+p.ID] = p
		}
		for _, want := range []auth.Principal{human, bot, nameless} {
			got := byID[string(want.Type)+":"+want.ID]
			if got.ID != want.ID || got.Name != want.Name || got.Email != want.Email {
				t.Fatalf("reactor profile = %#v, want %#v", got, want)
			}
		}
	}
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/comments", "", map[string]string{"X-Test-Principal": principalHeader(fixtureStranger)})
	assertStatus(t, rr, http.StatusForbidden)
	if strings.Contains(rr.Body.String(), "reactors") {
		t.Fatal("reactor identities exposed without document access")
	}
}
