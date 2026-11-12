package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

const commentMentionsContentType = "application/vnd.slashdocs.comment-mentions+json"

type commentMentionWire struct {
	Principal auth.Principal `json:"principal"`
	Offset    int64          `json:"offset"`
	Length    int64          `json:"length"`
}

type commentWire struct {
	ID       string               `json:"id"`
	Body     string               `json:"body"`
	Status   string               `json:"status"`
	Mentions []commentMentionWire `json:"mentions"`
	Replies  []commentWire        `json:"replies"`
}

func TestStructuredCommentMentionsAcceptPreRenameMediaType(t *testing.T) {
	e := newTestEnv(t)
	body := "ping @owner@example.com"
	created := createMentionCommentAs(t, e, "application/vnd.aidocs.comment-mentions+json", body, []map[string]any{
		mentionRequest(t, body, "@owner@example.com", map[string]any{"type": "user", "id": fixtureOwner.ID}),
	})
	if len(created.Mentions) != 1 || created.Mentions[0].Principal.ID != fixtureOwner.ID {
		t.Fatalf("mentions = %#v", created.Mentions)
	}
}

func TestStructuredCommentMentionsRoundTripRootReplyAndList(t *testing.T) {
	e := newTestEnv(t)
	body := "🙂 ping @owner@example.com"
	root := createMentionComment(t, e, body, []map[string]any{
		mentionRequest(t, body, "@owner@example.com", map[string]any{
			"type": "user", "id": fixtureOwner.ID, "email": "spoof@example.com", "name": "Spoofed",
		}),
	})
	if len(root.Mentions) != 1 || root.Mentions[0].Offset != 8 || root.Mentions[0].Length != 18 {
		t.Fatalf("root mentions = %#v", root.Mentions)
	}
	if got := root.Mentions[0].Principal; got.ID != fixtureOwner.ID || got.Email != fixtureOwner.Email || got.Name != fixtureOwner.Name {
		t.Fatalf("root canonical principal = %#v", got)
	}

	replyBody := "Ask @fixture."
	replyRequest := map[string]any{
		"body": replyBody,
		"mentions": []map[string]any{
			mentionRequest(t, replyBody, "@fixture", map[string]any{"type": "service_account", "id": e.sa.ID, "name": "spoof-bot"}),
		},
	}
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments/"+root.ID+"/replies", jsonString(t, replyRequest), map[string]string{
		"Content-Type":     commentMentionsContentType,
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusCreated)
	reply := decodeCommentWire(t, rr.Body.Bytes())
	if len(reply.Mentions) != 1 || reply.Mentions[0].Principal.Type != auth.PrincipalServiceAccount || reply.Mentions[0].Principal.ID != e.sa.ID || reply.Mentions[0].Principal.Name != e.sa.Name {
		t.Fatalf("reply mentions = %#v", reply.Mentions)
	}

	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/comments", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusOK)
	var listed struct {
		Items []commentWire `json:"items"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	var foundRoot, foundLegacy bool
	for _, item := range listed.Items {
		switch item.ID {
		case root.ID:
			foundRoot = true
			if len(item.Mentions) != 1 || len(item.Replies) != 1 || len(item.Replies[0].Mentions) != 1 {
				t.Fatalf("listed structured thread = %#v", item)
			}
		case e.cmt.ID:
			foundLegacy = true
			if item.Mentions == nil || len(item.Mentions) != 0 {
				t.Fatalf("ordinary comment mentions = %#v, want []", item.Mentions)
			}
		}
	}
	if !foundRoot || !foundLegacy {
		t.Fatalf("listed roots missing: structured=%v ordinary=%v", foundRoot, foundLegacy)
	}
}

func TestStructuredCommentMediaTypeFailsClosed(t *testing.T) {
	e := newTestEnv(t)
	body := "Ping @owner@example.com"
	payload := map[string]any{
		"version_id": e.ver.ID,
		"body":       body,
		"anchor":     map[string]any{"quote": "fixture"},
		"mentions": []map[string]any{
			mentionRequest(t, body, "@owner@example.com", map[string]any{"type": "user", "id": fixtureOwner.ID}),
		},
	}
	before := commentCount(t, e)
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", jsonString(t, payload), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusUnsupportedMediaType)
	if got := commentCount(t, e); got != before {
		t.Fatalf("application/json structured create wrote comment: before=%d after=%d", before, got)
	}

	replyPayload := map[string]any{
		"body": body,
		"mentions": []map[string]any{
			mentionRequest(t, body, "@owner@example.com", map[string]any{"type": "user", "id": fixtureOwner.ID}),
		},
	}
	rr = do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments/"+e.cmt.ID+"/replies", jsonString(t, replyPayload), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusUnsupportedMediaType)
	if got := commentCount(t, e); got != before {
		t.Fatalf("application/json structured reply wrote comment: before=%d after=%d", before, got)
	}

	// Empty mention lists on create/reply carry no metadata and remain backwards
	// compatible with old application/json clients during a rolling deployment.
	emptyPayload := map[string]any{
		"version_id": e.ver.ID,
		"body":       "plain comment",
		"anchor":     map[string]any{"quote": "fixture"},
		"mentions":   []any{},
	}
	rr = do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", jsonString(t, emptyPayload), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusCreated)
	plain := decodeCommentWire(t, rr.Body.Bytes())
	if plain.Mentions == nil || len(plain.Mentions) != 0 {
		t.Fatalf("plain create mentions = %#v", plain.Mentions)
	}
}

func TestStructuredCommentPatchTriStateAndMediaType(t *testing.T) {
	e := newTestEnv(t)
	body := "Ping @owner@example.com"
	comment := createMentionComment(t, e, body, []map[string]any{
		mentionRequest(t, body, "@owner@example.com", map[string]any{"type": "user", "id": fixtureOwner.ID}),
	})
	path := "/v1/documents/" + e.doc.ID + "/comments/" + comment.ID

	// Old frontends resend the unchanged body on status updates. That must not
	// clear the association.
	rr := do(t, e.h, http.MethodPatch, path, jsonString(t, map[string]any{"body": body, "status": "resolved"}), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusOK)
	comment = decodeCommentWire(t, rr.Body.Bytes())
	if comment.Status != "resolved" || len(comment.Mentions) != 1 {
		t.Fatalf("old-client status patch = %#v", comment)
	}

	// Presence of mentions, even [], is a structured write. Application/json
	// must fail before changing either the comment or its rows.
	rr = do(t, e.h, http.MethodPatch, path, `{"mentions":[]}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusUnsupportedMediaType)
	persisted, err := e.store.GetComment(context.Background(), comment.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(persisted.Mentions) != 1 || persisted.Status != "resolved" {
		t.Fatalf("failed-closed PATCH mutated comment: %#v", persisted)
	}

	rr = do(t, e.h, http.MethodPatch, path, `{"mentions":[]}`, map[string]string{
		"Content-Type":     commentMentionsContentType,
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusOK)
	comment = decodeCommentWire(t, rr.Body.Bytes())
	if comment.Mentions == nil || len(comment.Mentions) != 0 {
		t.Fatalf("explicit vendor clear = %#v", comment.Mentions)
	}

	replacement := map[string]any{"mentions": []map[string]any{
		mentionRequest(t, body, "@owner@example.com", map[string]any{"type": "user", "id": fixtureOwner.ID}),
	}}
	rr = do(t, e.h, http.MethodPatch, path, jsonString(t, replacement), map[string]string{
		"Content-Type":     commentMentionsContentType,
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusOK)
	if got := decodeCommentWire(t, rr.Body.Bytes()); len(got.Mentions) != 1 {
		t.Fatalf("mentions-only replacement = %#v", got)
	}

	changed := "No mention remains"
	rr = do(t, e.h, http.MethodPatch, path, jsonString(t, map[string]any{"body": changed}), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusOK)
	comment = decodeCommentWire(t, rr.Body.Bytes())
	if comment.Body != changed || comment.Mentions == nil || len(comment.Mentions) != 0 {
		t.Fatalf("body-change implicit clear = %#v", comment)
	}
}

func TestStructuredCommentMentionsRejectMalformedAndSpoofedWrites(t *testing.T) {
	e := newTestEnv(t)
	baseCount := commentCount(t, e)
	tests := []struct {
		name     string
		body     string
		mentions []map[string]any
	}{
		{
			name: "surrogate split",
			body: "🙂 @Owner",
			mentions: []map[string]any{{
				"principal": map[string]any{"type": "user", "id": fixtureOwner.ID}, "offset": 1, "length": 1,
			}},
		},
		{
			name: "client identity spoof",
			body: "@Spoofed",
			mentions: []map[string]any{{
				"principal": map[string]any{"type": "user", "id": fixtureOwner.ID, "name": "Spoofed"}, "offset": 0, "length": 8,
			}},
		},
		{
			name: "unknown principal",
			body: "@missing",
			mentions: []map[string]any{{
				"principal": map[string]any{"type": "user", "id": "usr_missing"}, "offset": 0, "length": 8,
			}},
		},
		{
			name: "invalid principal type",
			body: "@everyone",
			mentions: []map[string]any{{
				"principal": map[string]any{"type": "anyone", "id": "all"}, "offset": 0, "length": 9,
			}},
		},
		{
			name: "name prefix spoof",
			body: "@Owner_evil",
			mentions: []map[string]any{{
				"principal": map[string]any{"type": "user", "id": fixtureOwner.ID}, "offset": 0, "length": 6,
			}},
		},
		{
			name: "apostrophe prefix spoof",
			body: "@Owner'evil",
			mentions: []map[string]any{{
				"principal": map[string]any{"type": "user", "id": fixtureOwner.ID}, "offset": 0, "length": 6,
			}},
		},
		{
			name: "email prefix spoof",
			body: "@owner@example.com.evil",
			mentions: []map[string]any{{
				"principal": map[string]any{"type": "user", "id": fixtureOwner.ID}, "offset": 0, "length": 18,
			}},
		},
		{
			name: "fullwidth full stop prefix spoof",
			body: "@Owner．evil",
			mentions: []map[string]any{{
				"principal": map[string]any{"type": "user", "id": fixtureOwner.ID}, "offset": 0, "length": 6,
			}},
		},
		{
			name: "connector punctuation prefix spoof",
			body: "@Owner‿evil",
			mentions: []map[string]any{{
				"principal": map[string]any{"type": "user", "id": fixtureOwner.ID}, "offset": 0, "length": 6,
			}},
		},
		{
			name: "punctuation run before text",
			body: "@Owner…!evil",
			mentions: []map[string]any{{
				"principal": map[string]any{"type": "user", "id": fixtureOwner.ID}, "offset": 0, "length": 6,
			}},
		},
		{
			name: "punctuation run before symbol",
			body: "@Owner…”$",
			mentions: []map[string]any{{
				"principal": map[string]any{"type": "user", "id": fixtureOwner.ID}, "offset": 0, "length": 6,
			}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			payload := map[string]any{
				"version_id": e.ver.ID,
				"body":       tc.body,
				"anchor":     map[string]any{"quote": "fixture"},
				"mentions":   tc.mentions,
			}
			rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", jsonString(t, payload), map[string]string{
				"Content-Type":     commentMentionsContentType,
				"X-Test-Principal": principalHeader(fixtureCommenter),
			})
			assertStatus(t, rr, http.StatusBadRequest)
		})
	}
	if got := commentCount(t, e); got != baseCount {
		t.Fatalf("invalid writes persisted comments: before=%d after=%d", baseCount, got)
	}
}

func TestStructuredCommentMentionsAcceptTerminalPunctuation(t *testing.T) {
	e := newTestEnv(t)
	for _, tc := range []struct {
		body  string
		label string
	}{
		{body: "@Owner.", label: "@Owner"},
		{body: "@owner@example.com,", label: "@owner@example.com"},
		{body: "@Owner…” next", label: "@Owner"},
	} {
		root := createMentionComment(t, e, tc.body, []map[string]any{
			mentionRequest(t, tc.body, tc.label, map[string]any{"type": "user", "id": fixtureOwner.ID}),
		})
		if len(root.Mentions) != 1 {
			t.Fatalf("terminal punctuation body %q mentions = %#v", tc.body, root.Mentions)
		}
	}
}

func TestStructuredCommentMentionSnapshotSurvivesRename(t *testing.T) {
	e := newTestEnv(t)
	body := "Hello @Anurag"
	comment := createMentionComment(t, e, body, []map[string]any{
		mentionRequest(t, body, "@Anurag", map[string]any{"type": "user", "id": fixtureUser.ID}),
	})
	renamed, err := e.store.UpsertGoogleUser(context.Background(), fixtureUser.ID, "renamed@example.com", "Renamed User", "sub-"+fixtureUser.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	shiftedBody := "Prefix " + body
	patch := map[string]any{
		"body": shiftedBody,
		"mentions": []map[string]any{
			mentionRequest(t, shiftedBody, "@Anurag", map[string]any{"type": "user", "id": fixtureUser.ID}),
		},
	}
	path := "/v1/documents/" + e.doc.ID + "/comments/" + comment.ID
	rr := do(t, e.h, http.MethodPatch, path, jsonString(t, patch), map[string]string{
		"Content-Type":     commentMentionsContentType,
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusOK)
	shifted := decodeCommentWire(t, rr.Body.Bytes())
	if len(shifted.Mentions) != 1 || shifted.Mentions[0].Principal.Name != renamed.Name {
		t.Fatalf("shifted renamed mention = %#v", shifted.Mentions)
	}

	stalePayload := map[string]any{
		"version_id": e.ver.ID,
		"body":       "@Anurag",
		"anchor":     map[string]any{"quote": "fixture"},
		"mentions": []map[string]any{
			mentionRequest(t, "@Anurag", "@Anurag", map[string]any{"type": "user", "id": fixtureUser.ID, "name": "Anurag"}),
		},
	}
	rr = do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", jsonString(t, stalePayload), map[string]string{
		"Content-Type":     commentMentionsContentType,
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusBadRequest)
}

func TestStructuredCommentMentionLimit(t *testing.T) {
	e := newTestEnv(t)
	label := "@" + fixtureOwner.Email
	makePayload := func(count int) map[string]any {
		parts := make([]string, count)
		mentions := make([]map[string]any, 0, count)
		var offset int64
		for i := 0; i < count; i++ {
			parts[i] = label
			mentions = append(mentions, map[string]any{
				"principal": map[string]any{"type": "user", "id": fixtureOwner.ID},
				"offset":    offset,
				"length":    len(label),
			})
			offset += int64(len(label) + 1)
		}
		return map[string]any{
			"version_id": e.ver.ID,
			"body":       strings.Join(parts, " "),
			"anchor":     map[string]any{"quote": "fixture"},
			"mentions":   mentions,
		}
	}

	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", jsonString(t, makePayload(repo.MaxCommentMentions)), map[string]string{
		"Content-Type":     commentMentionsContentType,
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusCreated)
	if got := decodeCommentWire(t, rr.Body.Bytes()); len(got.Mentions) != repo.MaxCommentMentions {
		t.Fatalf("50 mention response count = %d", len(got.Mentions))
	}

	rr = do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", jsonString(t, makePayload(repo.MaxCommentMentions+1)), map[string]string{
		"Content-Type":     commentMentionsContentType,
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusBadRequest)
}

func TestLegacyCommentMarkersAreRejected(t *testing.T) {
	e := newTestEnv(t)
	const marker = "\u2063"
	body := "Hello " + marker + "@owner@example.com" + marker
	root := createMentionComment(t, e, "Root comment", nil)

	for _, tc := range []struct {
		name, method, path string
		payload            map[string]any
	}{
		{
			name:   "create",
			method: http.MethodPost,
			path:   "/v1/documents/" + e.doc.ID + "/comments",
			payload: map[string]any{
				"version_id": e.ver.ID,
				"body":       body,
				"anchor":     map[string]any{"quote": "fixture"},
			},
		},
		{
			name:    "reply",
			method:  http.MethodPost,
			path:    "/v1/documents/" + e.doc.ID + "/comments/" + root.ID + "/replies",
			payload: map[string]any{"body": body},
		},
		{
			name:    "patch",
			method:  http.MethodPatch,
			path:    "/v1/documents/" + e.doc.ID + "/comments/" + root.ID,
			payload: map[string]any{"body": body},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rr := do(t, e.h, tc.method, tc.path, jsonString(t, tc.payload), map[string]string{
				"Content-Type":     "application/json",
				"X-Test-Principal": principalHeader(fixtureCommenter),
			})
			assertStatus(t, rr, http.StatusBadRequest)
			if !strings.Contains(rr.Body.String(), "reload the client") {
				t.Fatalf("legacy marker error = %s", rr.Body.String())
			}
		})
	}
}

func createMentionComment(t *testing.T, e *testEnv, body string, mentions []map[string]any) commentWire {
	t.Helper()
	return createMentionCommentAs(t, e, commentMentionsContentType, body, mentions)
}

func createMentionCommentAs(t *testing.T, e *testEnv, contentType, body string, mentions []map[string]any) commentWire {
	t.Helper()
	payload := map[string]any{
		"version_id": e.ver.ID,
		"body":       body,
		"anchor":     map[string]any{"quote": "fixture"},
		"mentions":   mentions,
	}
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", jsonString(t, payload), map[string]string{
		"Content-Type":     contentType,
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusCreated)
	return decodeCommentWire(t, rr.Body.Bytes())
}

func mentionRequest(t *testing.T, body, label string, principal map[string]any) map[string]any {
	t.Helper()
	byteOffset := strings.Index(body, label)
	if byteOffset < 0 {
		t.Fatalf("label %q not found in %q", label, body)
	}
	return map[string]any{
		"principal": principal,
		"offset":    utf16WireUnits(body[:byteOffset]),
		"length":    utf16WireUnits(label),
	}
}

func utf16WireUnits(value string) int64 {
	var units int64
	for _, r := range value {
		units += int64(utf16.RuneLen(r))
	}
	return units
}

func jsonString(t *testing.T, value any) string {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func decodeCommentWire(t *testing.T, body []byte) commentWire {
	t.Helper()
	var comment commentWire
	if err := json.Unmarshal(body, &comment); err != nil {
		t.Fatalf("decode comment response: %v; body=%s", err, body)
	}
	if comment.ID == "" {
		t.Fatalf("comment response missing id: %s", body)
	}
	return comment
}

func commentCount(t *testing.T, e *testEnv) int {
	t.Helper()
	comments, err := e.store.ListComments(context.Background(), e.doc.ID, "", "")
	if err != nil {
		t.Fatal(err)
	}
	return len(comments)
}
