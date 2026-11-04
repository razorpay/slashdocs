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
	"github.com/razorpay/slashdocs/api/internal/repo"
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
	rr := postComment(t, e, fixtureCommenter, `{"quote":"fixture","prefix":"","suffix":"","point":{"target":"chart","path":"0.2","label":"Revenue chart","x":0.123456,"y":0.98765}}`)
	assertStatus(t, rr, http.StatusCreated)
	id := jsonField(t, rr.Body.Bytes(), "id")
	createdAt := jsonField(t, rr.Body.Bytes(), "created_at")
	anchor := `{
	  "quote": "fixture", "prefix": "", "suffix": "", "dom_path": "", "start_offset": 0, "end_offset": 0,
	  "point": { "target": "chart", "path": "0.2", "label": "Revenue chart", "x": 0.1235, "y": 0.9877 }
	}`
	assertJSON(t, rr.Body.Bytes(), fmt.Sprintf(`{
	  "id": %q,
	  "author": { "type": "user", "id": "commenter_1", "email": "commenter@example.com", "name": "Commenter" },
	  "body": "pin",
	  "mentions": [],
	  "reactions": [],
	  "selected_text": "fixture",
	  "anchor": %s,
	  "status": "open",
	  "created_at": %q,
	  "created_on_version_id": %q,
	  "current_placement": {
	    "version_id": %q,
	    "status": "attached",
	    "anchor": %s,
	    "matched_text": "fixture",
	    "confidence": 1
	  }
	}`, id, anchor, createdAt, e.ver.ID, e.ver.ID, anchor))

	// An element with no text and no name has only its path.
	assertStatus(t, postComment(t, e, fixtureCommenter, `{"point":{"path":"3","x":0,"y":1}}`), http.StatusCreated)
}

func TestPointCommentRejectsInvalidAnchors(t *testing.T) {
	e := newTestEnv(t)
	for _, tc := range []struct{ name, anchor string }{
		{"no quote and no point", `{"prefix":"p"}`},
		{"no target and no path", `{"quote":"fixture","point":{"x":0.5,"y":0.5}}`},
		{"space in target", `{"point":{"target":"t mob","x":0.5,"y":0.5}}`},
		{"quote in target", `{"point":{"target":"t\"mob","x":0.5,"y":0.5}}`},
		{"slash in target", `{"point":{"target":"a/b","x":0.5,"y":0.5}}`},
		{"target too long", `{"point":{"target":"` + strings.Repeat("a", 129) + `","x":0.5,"y":0.5}}`},
		{"bad path", `{"point":{"path":"0..1","x":0.5,"y":0.5}}`},
		{"deep path", `{"point":{"path":"0` + strings.Repeat(".0", 64) + `","x":0.5,"y":0.5}}`},
		{"label too long", `{"point":{"target":"t","label":"` + strings.Repeat("a", 129) + `","x":0.5,"y":0.5}}`},
		{"label with a control character", `{"point":{"target":"t","label":"a\u0007","x":0.5,"y":0.5}}`},
		{"x far left", `{"point":{"target":"t","x":-1000.01,"y":0.5}}`},
		{"x far right", `{"point":{"target":"t","x":1000.01,"y":0.5}}`},
		{"y far above", `{"point":{"target":"t","x":0.5,"y":-1000.01}}`},
		{"y far below", `{"point":{"target":"t","x":0.5,"y":1000.01}}`},
		{"page spot without viewport", `{"point":{"target":"t","x":0.5,"y":0.5,"page_x":10,"page_y":20}}`},
		{"viewport without page spot", `{"point":{"target":"t","x":0.5,"y":0.5,"viewport_w":1200}}`},
		{"zero viewport", `{"point":{"target":"t","x":0.5,"y":0.5,"page_x":10,"page_y":20,"viewport_w":0}}`},
		{"page spot above the page", `{"point":{"target":"t","x":0.5,"y":0.5,"page_x":10,"page_y":-1,"viewport_w":1200}}`},
		{"page spot past the bound", `{"point":{"target":"t","x":0.5,"y":0.5,"page_x":10000001,"page_y":20,"viewport_w":1200}}`},
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
	// A spot beside its element, as in a margin, keeps its place.
	assertStatus(t, postComment(t, e, fixtureCommenter, `{"point":{"target":"t","x":-0.4,"y":1.5}}`), http.StatusCreated)
}

func TestPointCommentKeepsItsPageSpot(t *testing.T) {
	e := newTestEnv(t)
	rr := postComment(t, e, fixtureCommenter, `{"point":{"target":"t_mob","x":-0.25,"y":1.5,"page_x":120.5,"page_y":0,"viewport_w":1280}}`)
	assertStatus(t, rr, http.StatusCreated)
	point, _ := findComment(t, listComments(t, e, ""), jsonField(t, rr.Body.Bytes(), "id"))["anchor"].(map[string]any)["point"].(map[string]any)
	if point["x"] != -0.25 || point["y"] != 1.5 || point["page_x"] != 120.5 || point["page_y"] != float64(0) || point["viewport_w"] != float64(1280) {
		t.Fatalf("point = %v, want its fractions and page spot", point)
	}
	// A page spot alone puts the point on the body.
	body := postComment(t, e, fixtureCommenter, `{"point":{"label":"Fixture","x":0.1,"y":0.2,"page_x":40,"page_y":300,"viewport_w":1280}}`)
	assertStatus(t, body, http.StatusCreated)
	point, _ = findComment(t, listComments(t, e, ""), jsonField(t, body.Body.Bytes(), "id"))["anchor"].(map[string]any)["point"].(map[string]any)
	if _, named := point["path"]; named || point["target"] != nil || point["label"] != "Fixture" {
		t.Fatalf("body point = %v, want no target and no path", point)
	}
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

	assertStatus(t, do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments/"+id+"/replies", `{"body":"on it"}`, headers), http.StatusCreated)

	got := findComment(t, listComments(t, e, ""), id)
	point, _ := got["anchor"].(map[string]any)["point"].(map[string]any)
	if point["target"] != "t_mob" || point["x"] != 0.25 || point["y"] != 0.75 {
		t.Fatalf("listed point = %v, want the saved point", point)
	}
	if replies, _ := got["replies"].([]any); len(replies) != 1 {
		t.Fatalf("replies = %v, want the one reply", got["replies"])
	}
	// The text comment keeps its text anchor without a point.
	if _, ok := findComment(t, listComments(t, e, ""), e.cmt.ID)["anchor"].(map[string]any)["point"]; ok {
		t.Fatal("text anchor gained a point")
	}

	assertStatus(t, do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/comments/"+id, `{"status":"resolved"}`, headers), http.StatusOK)
	if st := findComment(t, listComments(t, e, ""), id)["status"]; st != "resolved" {
		t.Fatalf("status = %v, want resolved", st)
	}
}

func TestPointCommentPlacementAcrossVersions(t *testing.T) {
	e := newTestEnv(t)
	mk := func(anchor string) string {
		rr := postComment(t, e, fixtureCommenter, anchor)
		assertStatus(t, rr, http.StatusCreated)
		return jsonField(t, rr.Body.Bytes(), "id")
	}
	byTarget := mk(`{"point":{"target":"t_mob","x":0.5,"y":0.5}}`)
	byID := mk(`{"point":{"target":"chart","x":0.5,"y":0.5}}`)
	gone := mk(`{"point":{"target":"t_gone","x":0.5,"y":0.5}}`)
	byQuote := mk(`{"quote":"Revenue","point":{"target":"t_gone","x":0.5,"y":0.5}}`)
	quoteGone := mk(`{"quote":"fixture","point":{"path":"0","x":0.5,"y":0.5}}`)
	byPath := mk(`{"point":{"path":"0","x":0.5,"y":0.5}}`)
	// An attribute that only ends in "id" names no element.
	notAnID := mk(`{"point":{"target":"t_data","x":0.5,"y":0.5}}`)
	// A gone element with a page spot shows there, marked as moved.
	moved := mk(`{"point":{"target":"t_gone","x":0.5,"y":0.5,"page_x":40,"page_y":300,"viewport_w":1280}}`)
	onBody := mk(`{"point":{"x":-0.1,"y":0.5,"page_x":40,"page_y":300,"viewport_w":1280}}`)

	if _, err := e.store.CreateVersion(context.Background(), e.doc.ID, e.ver.ID, "", "points",
		[]byte(`<html><body><div data-slashdocs-target='t_mob'></div><svg id="chart"></svg><p data-id="t_data">Revenue</p></body></html>`), fixtureOwner); err != nil {
		t.Fatal(err)
	}

	placement := func(items []map[string]any, id string) map[string]any {
		p, _ := findComment(t, items, id)["current_placement"].(map[string]any)
		return p
	}
	// With no version filter, placement is judged against the current version.
	items := listComments(t, e, "")
	for id, want := range map[string]string{
		byTarget: "attached", byID: "attached", gone: "orphaned", byQuote: "attached",
		quoteGone: "orphaned", byPath: "attached", notAnID: "orphaned", moved: "moved", onBody: "attached",
	} {
		if got := placement(items, id)["status"]; got != want {
			t.Errorf("v2 placement of %s = %v, want %s", id, got, want)
		}
	}

	// Judged against the version they were created on, every point is attached.
	for _, id := range []string{gone, quoteGone, notAnID, moved} {
		if got := placement(listComments(t, e, "?version_id="+e.ver.ID), id)["status"]; got != "attached" {
			t.Errorf("v1 placement of %s = %v, want attached", id, got)
		}
	}
}

func TestPresenceDropsPointAnchorFields(t *testing.T) {
	e := newTestEnv(t)
	ts := httptest.NewServer(e.h)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	reader, _ := openLiveStream(ctx, t, ts, e.doc.ID, "?session=viewer-session", fixtureViewer)

	body := `{"session":"editor-session","version":"` + e.ver.ID + `","anchor":{"quote":"fixture","point":{"target":"t_mob","x":0.5,"y":0.5}}}`
	assertStatus(t, do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/presence", body, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureEditor),
	}), http.StatusNoContent)

	anchor, _ := presenceOf(t, readLiveEvent(t, reader))["anchor"].(map[string]any)
	if anchor == nil || anchor["quote"] != "fixture" {
		t.Fatalf("presence anchor = %v, want the text part kept", anchor)
	}
	if _, ok := anchor["point"]; ok {
		t.Fatalf("presence anchor kept its point: %v", anchor)
	}
}

func TestMCPCreatePointComment(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	token := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)
	created := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "create_document", map[string]any{
		"title": "MCP points", "html": `<html><body><svg id="chart"></svg></body></html>`,
	}), "current_version_id"))
	docID := requiredMCPString(t, created, "id")
	versionID := requiredMCPString(t, created, "current_version_id")

	pinned := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "create_point_comment", map[string]any{
		"document_id": docID, "version_id": versionID, "body": "Label this axis", "target": "chart", "label": "Revenue chart", "x": 0, "y": 0.2,
	}), "Label this axis"))
	point, _ := pinned["anchor"].(map[string]any)["point"].(map[string]any)
	if point["target"] != "chart" || point["label"] != "Revenue chart" || point["x"] != float64(0) || point["y"] != 0.2 {
		t.Fatalf("point = %v, want chart at 0,0.2", point)
	}

	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "list_comments", map[string]any{"document_id": docID}), "Revenue chart")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "create_point_comment", map[string]any{
		"document_id": docID, "version_id": versionID, "body": "Beside the element", "target": "chart", "x": 1.5, "y": 0.2,
	}), "Beside the element")
	assertMCPToolError(t, callMCPToolHTTP(t, e, token, "create_point_comment", map[string]any{
		"document_id": docID, "version_id": versionID, "body": "Far off the element", "target": "chart", "x": 1001, "y": 0.2,
	}), "invalid comment")
	assertMCPToolError(t, callMCPToolHTTP(t, e, token, "create_point_comment", map[string]any{
		"document_id": docID, "version_id": versionID, "body": "No target", "x": 0.5, "y": 0.5,
	}), "target")
	assertMCPToolError(t, callMCPToolHTTP(t, e, token, "create_point_comment", map[string]any{
		"document_id": docID, "version_id": versionID, "body": "No y", "target": "chart", "x": 0.5,
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

	move := do(t, e.h, http.MethodPatch, path, `{"anchor":{"quote":"fixture","point":{"path":"0","x":0.123456,"y":0.5}}}`, as(fixtureCommenter))
	assertStatus(t, move, http.StatusOK)
	got := findComment(t, listComments(t, e, ""), id)
	point, _ := got["anchor"].(map[string]any)["point"].(map[string]any)
	if point["path"] != "0" || point["x"] != 0.1235 || point["y"] != 0.5 || got["selected_text"] != "fixture" {
		t.Fatalf("moved comment = %v, want path 0 at 0.1235, 0.5 with the new quote", got)
	}
	// fixtureUser may comment, but this point is not theirs.
	if _, err := e.store.CreateGrant(context.Background(), "document", e.doc.ID, fixtureUser, repo.RoleCommenter, fixtureOwner); err != nil {
		t.Fatalf("grant: %v", err)
	}
	// An editor moves anyone's point.
	assertStatus(t, do(t, e.h, http.MethodPatch, path, `{"anchor":{"point":{"target":"t_otp","x":0.5,"y":0.5}}}`, as(fixtureEditor)), http.StatusOK)

	for _, tc := range []struct {
		name, body string
		p          auth.Principal
		want       int
	}{
		{"text anchor", `{"anchor":{"quote":"hello"}}`, fixtureCommenter, http.StatusBadRequest},
		{"point out of range", `{"anchor":{"point":{"target":"t_mob","x":1001,"y":0}}}`, fixtureCommenter, http.StatusBadRequest},
		{"bad target", `{"anchor":{"point":{"target":"has space","x":0,"y":0}}}`, fixtureCommenter, http.StatusBadRequest},
		{"no element", `{"anchor":{"point":{"x":0,"y":0}}}`, fixtureCommenter, http.StatusBadRequest},
		{"a viewer", `{"anchor":{"point":{"target":"t_mob","x":0,"y":0}}}`, fixtureViewer, http.StatusForbidden},
		{"another commenter", `{"anchor":{"point":{"target":"t_mob","x":0,"y":0}}}`, fixtureUser, http.StatusForbidden},
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

func TestCommentBodyMustHaveText(t *testing.T) {
	e := newTestEnv(t)
	headers := map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureCommenter)}
	blank := fmt.Sprintf(`{"version_id":%q,"body":"  \n\t ","anchor":{"quote":"fixture"}}`, e.ver.ID)
	assertStatus(t, do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", blank, headers), http.StatusBadRequest)

	id := e.cmt.ID
	assertStatus(t, do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments/"+id+"/replies", `{"body":"   "}`, headers), http.StatusBadRequest)
	assertStatus(t, do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/comments/"+id, `{"body":" \n "}`, headers), http.StatusBadRequest)
	// A status change with the legacy empty body still works.
	assertStatus(t, do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/comments/"+id, `{"body":"","status":"resolved"}`, headers), http.StatusOK)
}

func TestCommentBodyLengthLimit(t *testing.T) {
	e := newTestEnv(t)
	headers := map[string]string{"Content-Type": "application/json", "X-Test-Principal": principalHeader(fixtureCommenter)}
	post := func(body string) *httptest.ResponseRecorder {
		in := fmt.Sprintf(`{"version_id":%q,"body":%q,"anchor":{"quote":"fixture"}}`, e.ver.ID, body)
		return do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/comments", in, headers)
	}
	// Characters, not bytes: 20000 two-byte runes fit.
	assertStatus(t, post(strings.Repeat("é", 20000)), http.StatusCreated)
	rr := post(strings.Repeat("a", 20001))
	assertStatus(t, rr, http.StatusBadRequest)
	if !strings.Contains(rr.Body.String(), "at most 20000 characters") {
		t.Fatalf("body = %s", rr.Body.String())
	}
}
