package server_test

import (
	"net/http"
	"strings"
	"testing"
	"time"
)

// chapterRoute is one of the routes that name a chapter.
type chapterRoute struct {
	name   string
	method string
	path   func(doc string) string
	body   func(t *testing.T, doc, ver string) string
}

var chapterRoutes = []chapterRoute{
	{"position", http.MethodPut, func(string) string { return "/position" },
		func(t *testing.T, doc, ver string) string { return positionBody(t, position(doc, ver, "", time.Now())) }},
	{"open", http.MethodPost, func(doc string) string { return "/chapters/" + doc + "/open" },
		func(_ *testing.T, _, ver string) string { return `{"version_id":"` + ver + `"}` }},
	{"progress", http.MethodPost, func(doc string) string { return "/chapters/" + doc + "/progress" },
		func(_ *testing.T, _, ver string) string {
			return `{"progression":1,"reached_end":true,"version_id":"` + ver + `"}`
		}},
	{"done", http.MethodPut, func(doc string) string { return "/chapters/" + doc + "/done" },
		func(*testing.T, string, string) string { return `{"done":true}` }},
	{"seen", http.MethodPost, func(doc string) string { return "/chapters/" + doc + "/seen" },
		func(_ *testing.T, _, ver string) string { return `{"version_id":"` + ver + `"}` }},
	{"changes", http.MethodGet, func(doc string) string { return "/chapters/" + doc + "/changes" },
		func(*testing.T, string, string) string { return "" }},
}

// Every route that names a chapter answers 404, with nothing about the
// document in the body, for a chapter the reader cannot open, for a document
// the reader can open in another folder, and for a document of the book's
// folder that the outline does not place (R24).
func TestChapterRoutesAnswerNotFoundOutsideTheReadersBook(t *testing.T) {
	f := newReadingFixture(t)
	// The viewer owns a document in no folder.
	other, otherVer := f.e.createDocument("Viewer diary", readingV1, fixtureViewer)
	// A document in the book's folder that the outline does not place.
	loose, looseVer := f.e.createDocument("Loose notes", readingV1, fixtureOwner)
	bkMoveIn(t, f.e, f.folderID, loose, f.owner)
	f.grant(t, loose, fixtureViewer)
	rr := do(t, f.e.h, http.MethodGet, "/v1/documents/"+loose, "", bkHeaders(f.viewer))
	assertStatus(t, rr, http.StatusOK)

	cases := []struct{ name, doc, ver, title string }{
		{"hidden chapter", f.ch3, f.ch3v1, "Secrets"},
		{"document in another folder", other, otherVer, "Viewer diary"},
		{"document not in the outline", loose, looseVer, "Loose notes"},
	}
	for _, r := range chapterRoutes {
		for _, tc := range cases {
			t.Run(r.name+"/"+tc.name, func(t *testing.T) {
				body := f.expect(t, r.method, r.path(tc.doc), r.body(t, tc.doc, tc.ver), f.viewer, http.StatusNotFound)
				if strings.Contains(string(body), tc.title) || strings.Contains(string(body), tc.doc) {
					t.Fatalf("404 leaks the document: %s", body)
				}
			})
		}
	}
	// Nothing was written for any of them.
	s := f.state(t, f.viewer)
	if len(s.Positions) != 0 {
		t.Fatalf("positions = %+v, want none", s.Positions)
	}
}
