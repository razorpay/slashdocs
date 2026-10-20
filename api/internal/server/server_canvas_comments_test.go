package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/server"
)

func postComment(t *testing.T, e *testEnv, p auth.Principal, anchor string) *httptest.ResponseRecorder {
	t.Helper()
	body := fmt.Sprintf(`{"version_id":%q,"body":"pin","anchor":%s}`, e.ver.ID, anchor)
	return do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", body, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(p),
	})
}

func listComments(t *testing.T, e *testEnv, query string) []map[string]any {
	t.Helper()
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/comments"+query, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, rr, http.StatusOK)
	var out struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Items
}

func findComment(t *testing.T, items []map[string]any, id string) map[string]any {
	t.Helper()
	for _, item := range items {
		if item["id"] == id {
			return item
		}
	}
	t.Fatalf("comment %s not listed", id)
	return nil
}

func TestCreatePointComment(t *testing.T) {
	e := newTestEnv(t)
	rr := postComment(t, e, fixtureCommenter, `{"kind":"point","point":{"target":"t_mob","x":0.123456,"y":0.98765}}`)
	assertStatus(t, rr, http.StatusCreated)
	id := jsonField(t, rr.Body.Bytes(), "id")
	createdAt := jsonField(t, rr.Body.Bytes(), "created_at")
	assertJSON(t, rr.Body.Bytes(), fmt.Sprintf(`{
	  "id": %q,
	  "author": { "type": "user", "id": "commenter_1", "email": "commenter@example.com", "name": "Commenter" },
	  "body": "pin",
	  "mentions": [],
	  "reactions": [],
	  "anchor": {
	    "quote": "", "prefix": "", "suffix": "", "dom_path": "", "start_offset": 0, "end_offset": 0,
	    "kind": "point",
	    "point": { "target": "t_mob", "x": 0.1235, "y": 0.9877 }
	  },
	  "status": "open",
	  "created_at": %q,
	  "created_on_version_id": %q,
	  "current_placement": {
	    "version_id": %q,
	    "status": "attached",
	    "anchor": {
	      "quote": "", "prefix": "", "suffix": "", "dom_path": "", "start_offset": 0, "end_offset": 0,
	      "kind": "point",
	      "point": { "target": "t_mob", "x": 0.1235, "y": 0.9877 }
	    },
	    "matched_text": "",
	    "confidence": 1
	  }
	}`, id, createdAt, e.ver.ID, e.ver.ID))

	// The kind may be omitted: the server sets it.
	rr = postComment(t, e, fixtureCommenter, `{"point":{"target":"","x":0,"y":1}}`)
	assertStatus(t, rr, http.StatusCreated)
	var created struct {
		Anchor struct {
			Kind string `json:"kind"`
		} `json:"anchor"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Anchor.Kind != "point" {
		t.Fatalf("kind = %q, want point", created.Anchor.Kind)
	}
}

func TestPointCommentRequiresFeatureFlag(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", DisableCanvasComments: true})
	rr := postComment(t, e, fixtureCommenter, `{"point":{"target":"t_mob","x":0.5,"y":0.5}}`)
	assertStatus(t, rr, http.StatusBadRequest)
	if !strings.Contains(rr.Body.String(), "point comments are not enabled") {
		t.Fatalf("body = %s", rr.Body.String())
	}
	// Text comments are unaffected.
	assertStatus(t, postComment(t, e, fixtureCommenter, `{"quote":"fixture"}`), http.StatusCreated)
}

func TestPointCommentRejectsInvalidAnchors(t *testing.T) {
	e := newTestEnv(t)
	long := strings.Repeat("a", 129)
	for _, tc := range []struct{ name, anchor string }{
		{"quote with point", `{"quote":"fixture","point":{"target":"t","x":0.5,"y":0.5}}`},
		{"prefix with point", `{"prefix":"p","point":{"target":"t","x":0.5,"y":0.5}}`},
		{"suffix with point", `{"suffix":"s","point":{"target":"t","x":0.5,"y":0.5}}`},
		{"dom path with point", `{"dom_path":"html/body","point":{"target":"t","x":0.5,"y":0.5}}`},
		{"start offset", `{"start_offset":1,"point":{"target":"t","x":0.5,"y":0.5}}`},
		{"end offset", `{"end_offset":1,"point":{"target":"t","x":0.5,"y":0.5}}`},
		{"unknown kind", `{"kind":"region","point":{"target":"t","x":0.5,"y":0.5}}`},
		{"text kind with point", `{"kind":"text","point":{"target":"t","x":0.5,"y":0.5}}`},
		{"kind without point", `{"kind":"point","quote":"fixture"}`},
		{"kind without point or quote", `{"kind":"point"}`},
		{"space in target", `{"point":{"target":"t mob","x":0.5,"y":0.5}}`},
		{"quote in target", `{"point":{"target":"t\"mob","x":0.5,"y":0.5}}`},
		{"slash in target", `{"point":{"target":"a/b","x":0.5,"y":0.5}}`},
		{"unicode target", `{"point":{"target":"té","x":0.5,"y":0.5}}`},
		{"target too long", `{"point":{"target":"` + long + `","x":0.5,"y":0.5}}`},
		{"x below zero", `{"point":{"target":"t","x":-0.01,"y":0.5}}`},
		{"x above one", `{"point":{"target":"t","x":1.01,"y":0.5}}`},
		{"y below zero", `{"point":{"target":"t","x":0.5,"y":-0.01}}`},
		{"y above one", `{"point":{"target":"t","x":0.5,"y":1.01}}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rr := postComment(t, e, fixtureCommenter, tc.anchor)
			assertStatus(t, rr, http.StatusBadRequest)
			if !strings.Contains(rr.Body.String(), "invalid comment") {
				t.Fatalf("body = %s", rr.Body.String())
			}
		})
	}
	// 128 characters is the longest allowed target.
	assertStatus(t, postComment(t, e, fixtureCommenter, `{"point":{"target":"`+strings.Repeat("a", 128)+`","x":0.5,"y":0.5}}`), http.StatusCreated)
	assertStatus(t, postComment(t, e, fixtureCommenter, `{"point":{"target":"a_B.c:d-9","x":0.5,"y":0.5}}`), http.StatusCreated)
}

func TestPointCommentNeedsCommenterRole(t *testing.T) {
	e := newTestEnv(t)
	assertStatus(t, postComment(t, e, fixtureViewer, `{"point":{"target":"t","x":0.5,"y":0.5}}`), http.StatusForbidden)
	assertStatus(t, postComment(t, e, fixtureStranger, `{"point":{"target":"t","x":0.5,"y":0.5}}`), http.StatusForbidden)
}

func TestPointCommentListReplyAndResolve(t *testing.T) {
	e := newTestEnv(t)
	rr := postComment(t, e, fixtureCommenter, `{"point":{"target":"t_mob","x":0.25,"y":0.75}}`)
	assertStatus(t, rr, http.StatusCreated)
	id := jsonField(t, rr.Body.Bytes(), "id")
	headers := map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureCommenter)}

	reply := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments/"+id+"/replies", `{"body":"on it"}`, headers)
	assertStatus(t, reply, http.StatusCreated)

	got := findComment(t, listComments(t, e, ""), id)
	anchor, _ := got["anchor"].(map[string]any)
	point, _ := anchor["point"].(map[string]any)
	if anchor["kind"] != "point" || point["target"] != "t_mob" || point["x"] != 0.25 || point["y"] != 0.75 {
		t.Fatalf("listed anchor = %v, want kind point and the saved point", anchor)
	}
	if replies, _ := got["replies"].([]any); len(replies) != 1 {
		t.Fatalf("replies = %v, want the one reply", got["replies"])
	}
	// The pre-existing text comment keeps its text anchor without kind or point.
	text := findComment(t, listComments(t, e, ""), e.cmt.ID)
	textAnchor, _ := text["anchor"].(map[string]any)
	if _, ok := textAnchor["kind"]; ok {
		t.Fatalf("text anchor gained a kind: %v", textAnchor)
	}
	if _, ok := textAnchor["point"]; ok {
		t.Fatalf("text anchor gained a point: %v", textAnchor)
	}

	resolve := do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/comments/"+id, `{"status":"resolved"}`, headers)
	assertStatus(t, resolve, http.StatusOK)
	if st := findComment(t, listComments(t, e, ""), id)["status"]; st != "resolved" {
		t.Fatalf("status = %v, want resolved", st)
	}
}

func TestPointCommentPlacementFollowsTargetAcrossVersions(t *testing.T) {
	e := newTestEnv(t)
	mk := func(target string) string {
		anchor := `{"point":{"target":"` + target + `","x":0.5,"y":0.5}}`
		rr := postComment(t, e, fixtureCommenter, anchor)
		assertStatus(t, rr, http.StatusCreated)
		return jsonField(t, rr.Body.Bytes(), "id")
	}
	withTarget := mk("t_mob")
	singleQuoted := mk("t_web")
	gone := mk("t_gone")
	board := mk("")

	v2, err := e.store.CreateVersion(context.Background(), e.doc.ID, e.ver.ID, "canvas",
		[]byte(`<html><body><div data-slashdocs-target="t_mob"></div><div data-slashdocs-target='t_web'></div></body></html>`), fixtureOwner)
	if err != nil {
		t.Fatal(err)
	}

	placement := func(items []map[string]any, id string) map[string]any {
		p, _ := findComment(t, items, id)["current_placement"].(map[string]any)
		return p
	}
	// With no version filter, placement is judged against the current version.
	items := listComments(t, e, "")
	if v2.ID == e.ver.ID {
		t.Fatal("second version reused the first version id")
	}
	for id, want := range map[string]string{withTarget: "attached", singleQuoted: "attached", gone: "orphaned", board: "attached"} {
		if got := placement(items, id)["status"]; got != want {
			t.Errorf("v2 placement of %s = %v, want %s", id, got, want)
		}
	}
	if conf := placement(items, gone)["confidence"]; conf != float64(0) {
		t.Errorf("orphaned confidence = %v, want 0", conf)
	}

	// Judged against the version they were created on, every point is attached.
	for _, id := range []string{withTarget, gone, board} {
		if got := placement(listComments(t, e, "?version_id="+e.ver.ID), id)["status"]; got != "attached" {
			t.Errorf("v1 placement of %s = %v, want attached", id, got)
		}
	}
}

func TestPointCommentConfigFlag(t *testing.T) {
	cfg := func(e *testEnv) bool {
		rr := do(t, e.h, http.MethodGet, "/v1/config", "", nil)
		assertStatus(t, rr, http.StatusOK)
		var out struct {
			Enabled bool `json:"canvas_comments_enabled"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		return out.Enabled
	}
	if !cfg(newTestEnv(t)) {
		t.Fatal("canvas_comments_enabled = false on a default server, want true")
	}
	if cfg(newConfiguredTestEnv(t, server.Config{Environment: "test", DisableCanvasComments: true})) {
		t.Fatal("canvas_comments_enabled = true with DisableCanvasComments, want false")
	}
}

func TestPresenceDropsPointAnchorFields(t *testing.T) {
	e := newTestEnv(t)
	ts := httptest.NewServer(e.h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	reader, _ := openLiveStream(ctx, t, ts, e.doc.ID, "?session=viewer-session", fixtureViewer)

	body := `{"session":"editor-session","version":"` + e.ver.ID + `","anchor":{"quote":"fixture","kind":"point","point":{"target":"t_mob","x":0.5,"y":0.5}}}`
	assertStatus(t, do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/presence", body, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureEditor),
	}), http.StatusNoContent)

	data := presenceOf(t, readLiveEvent(t, reader))
	anchor, _ := data["anchor"].(map[string]any)
	if anchor == nil || anchor["quote"] != "fixture" {
		t.Fatalf("presence anchor = %v, want the text part kept", data["anchor"])
	}
	if _, ok := anchor["kind"]; ok {
		t.Fatalf("presence anchor kept kind: %v", anchor)
	}
	if _, ok := anchor["point"]; ok {
		t.Fatalf("presence anchor kept point: %v", anchor)
	}
}

func TestMCPCreatePointComment(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	token := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)
	created := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "create_document", map[string]any{
		"title": "MCP canvas", "html": `<html><body><div data-slashdocs-target="t_mob"></div></body></html>`,
	}), "current_version_id"))
	docID := requiredMCPString(t, created, "id")
	versionID := requiredMCPString(t, created, "current_version_id")

	pinned := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "create_point_comment", map[string]any{
		"document_id": docID, "version_id": versionID, "body": "Move this", "target": "t_mob", "x": 0.4, "y": 0.2,
	}), "Move this"))
	anchor, _ := pinned["anchor"].(map[string]any)
	point, _ := anchor["point"].(map[string]any)
	if anchor["kind"] != "point" || point["target"] != "t_mob" || point["x"] != 0.4 || point["y"] != 0.2 {
		t.Fatalf("anchor = %v, want a point on t_mob at 0.4,0.2", anchor)
	}

	// An omitted target pins on the board; zero is a valid fraction.
	board := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "create_point_comment", map[string]any{
		"document_id": docID, "version_id": versionID, "body": "Board note", "x": 0, "y": 0,
	}), "Board note"))
	boardPoint, _ := board["anchor"].(map[string]any)["point"].(map[string]any)
	if boardPoint["target"] != "" {
		t.Fatalf("board point = %v, want an empty target", boardPoint)
	}

	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "list_comments", map[string]any{"document_id": docID}), "t_mob")
	assertMCPToolError(t, callMCPToolHTTP(t, e, token, "create_point_comment", map[string]any{
		"document_id": docID, "version_id": versionID, "body": "Off the board", "target": "t_mob", "x": 1.5, "y": 0.2,
	}), "invalid comment")
	assertMCPToolError(t, callMCPToolHTTP(t, e, token, "create_point_comment", map[string]any{
		"document_id": docID, "version_id": versionID, "body": "No y", "x": 0.5,
	}), "y")
}

func TestMovePointComment(t *testing.T) {
	e := newTestEnv(t)
	rr := postComment(t, e, fixtureCommenter, `{"point":{"target":"t_mob","x":0.25,"y":0.75}}`)
	assertStatus(t, rr, http.StatusCreated)
	id := jsonField(t, rr.Body.Bytes(), "id")
	path := "/v1/documents/" + e.doc.ID + "/comments/" + id
	as := func(p auth.Principal) map[string]string {
		return map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(p)}
	}

	move := do(t, e.h, http.MethodPatch, path, `{"anchor":{"point":{"target":"t_otp","x":0.123456,"y":0.5}}}`, as(fixtureCommenter))
	assertStatus(t, move, http.StatusOK)
	anchor, _ := findComment(t, listComments(t, e, ""), id)["anchor"].(map[string]any)
	point, _ := anchor["point"].(map[string]any)
	if anchor["kind"] != "point" || point["target"] != "t_otp" || point["x"] != 0.1235 || point["y"] != 0.5 {
		t.Fatalf("moved anchor = %v, want t_otp at 0.1235, 0.5", anchor)
	}

	// A move to the board, with no target, is a move too.
	assertStatus(t, do(t, e.h, http.MethodPatch, path, `{"anchor":{"point":{"target":"","x":0.5,"y":0.5}}}`, as(fixtureCommenter)), http.StatusOK)

	for _, tc := range []struct {
		name, body string
		p          auth.Principal
		want       int
	}{
		{"text anchor", `{"anchor":{"quote":"hello"}}`, fixtureCommenter, http.StatusBadRequest},
		{"point out of range", `{"anchor":{"point":{"target":"t_mob","x":1.5,"y":0}}}`, fixtureCommenter, http.StatusBadRequest},
		{"bad target", `{"anchor":{"point":{"target":"has space","x":0,"y":0}}}`, fixtureCommenter, http.StatusBadRequest},
		{"someone else's pin", `{"anchor":{"point":{"target":"t_mob","x":0,"y":0}}}`, fixtureViewer, http.StatusForbidden},
	} {
		t.Run(tc.name, func(t *testing.T) {
			assertStatus(t, do(t, e.h, http.MethodPatch, path, tc.body, as(tc.p)), tc.want)
		})
	}
}

func TestTextCommentCannotMove(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/comments/"+e.cmt.ID,
		`{"anchor":{"point":{"target":"t_mob","x":0.5,"y":0.5}}}`,
		map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureOwner)})
	assertStatus(t, rr, http.StatusBadRequest)
}

func TestMovePointCommentNeedsFeatureFlag(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", DisableCanvasComments: true})
	move := do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/comments/"+e.cmt.ID,
		`{"anchor":{"point":{"target":"t_mob","x":0.5,"y":0.5}}}`,
		map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureOwner)})
	assertStatus(t, move, http.StatusBadRequest)
	if !strings.Contains(move.Body.String(), "point comments are not enabled") {
		t.Fatalf("body = %s", move.Body.String())
	}
}

func TestCommentBodyMustHaveText(t *testing.T) {
	e := newTestEnv(t)
	headers := map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureCommenter)}
	blank := fmt.Sprintf(`{"version_id":%q,"body":"  \n\t ","anchor":{"point":{"target":"t_mob","x":0.5,"y":0.5}}}`, e.ver.ID)
	assertStatus(t, do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", blank, headers), http.StatusBadRequest)

	rr := postComment(t, e, fixtureCommenter, `{"point":{"target":"t_mob","x":0.5,"y":0.5}}`)
	assertStatus(t, rr, http.StatusCreated)
	id := jsonField(t, rr.Body.Bytes(), "id")
	assertStatus(t, do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments/"+id+"/replies", `{"body":"   "}`, headers), http.StatusBadRequest)
	assertStatus(t, do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/comments/"+id, `{"body":" \n "}`, headers), http.StatusBadRequest)
	// A status change with the legacy empty body still works.
	assertStatus(t, do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/comments/"+id, `{"body":"","status":"resolved"}`, headers), http.StatusOK)
}

func TestCommentBodyLengthLimit(t *testing.T) {
	e := newTestEnv(t)
	headers := map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureCommenter)}
	post := func(body string) *httptest.ResponseRecorder {
		in := fmt.Sprintf(`{"version_id":%q,"body":%q,"anchor":{"point":{"target":"t_mob","x":0.5,"y":0.5}}}`, e.ver.ID, body)
		return do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", in, headers)
	}
	// Characters, not bytes: 20000 two-byte runes fit.
	assertStatus(t, post(strings.Repeat("é", 20000)), http.StatusCreated)
	assertStatus(t, post(strings.Repeat("a", 20001)), http.StatusBadRequest)
}

func TestListCommentsStatusAll(t *testing.T) {
	e := newTestEnv(t)
	rr := postComment(t, e, fixtureCommenter, `{"point":{"target":"t_mob","x":0.5,"y":0.5}}`)
	assertStatus(t, rr, http.StatusCreated)
	id := jsonField(t, rr.Body.Bytes(), "id")
	headers := map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureCommenter)}
	assertStatus(t, do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/comments/"+id, `{"status":"resolved"}`, headers), http.StatusOK)
	all := listComments(t, e, "?status=all")
	if len(all) != len(listComments(t, e, "")) || len(all) < 2 {
		t.Fatalf("status=all listed %d comments, want every comment", len(all))
	}
	findComment(t, all, id)
}
