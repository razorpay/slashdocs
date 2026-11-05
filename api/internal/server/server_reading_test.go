package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/server"
)

const (
	readingV1 = `<html><body><h1>Costs</h1><h2 id="intro">Intro</h2><p>Hello reader, this is the start.</p>` +
		`<h2 id="cost">Cost</h2><p>It costs ₹10 a month.</p></body></html>`
	readingV2 = `<html><body><h1>Costs</h1><h2 id="intro">Intro</h2><p>Hello reader, this is the start.</p>` +
		`<h2 id="cost">Cost</h2><p>It costs ₹12 a month.</p></body></html>`
	readingDevice      = "device_laptop_1"
	readingOtherDevice = "device_phone_22"
)

// readingFixture makes a book of three chapters owned by fixtureOwner. The
// viewer can open chapters one and two but not three.
type readingFixture struct {
	e                     *testEnv
	owner, viewer, bookID string
	folderID              string
	ch1, ch2, ch3         string
	ch1v1, ch2v1, ch3v1   string
}

func newReadingFixture(t *testing.T) *readingFixture {
	t.Helper()
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", BooksEnabled: true})
	f := &readingFixture{e: e, owner: principalHeader(fixtureOwner), viewer: principalHeader(fixtureViewer)}
	f.folderID = createFolder(t, e, `{"title":"Guide"}`, f.owner)
	mk := func(title string) (string, string) {
		id, ver := e.createDocument(title, readingV1, fixtureOwner)
		bkMoveIn(t, e, f.folderID, id, f.owner)
		return id, ver
	}
	f.ch1, f.ch1v1 = mk("01 · Costs")
	f.ch2, f.ch2v1 = mk("02 · Plans")
	f.ch3, f.ch3v1 = mk("03 · Secrets")
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+f.folderID+"/book", `{}`, bkHeaders(f.owner))
	assertStatus(t, rr, http.StatusCreated)
	f.bookID = bkString(t, rr.Body.Bytes(), "book_id")
	f.grant(t, f.ch1, fixtureViewer)
	f.grant(t, f.ch2, fixtureViewer)
	return f
}

func (f *readingFixture) grant(t *testing.T, docID string, p auth.Principal) {
	t.Helper()
	if _, err := f.e.store.CreateGrant(context.Background(), "document", docID, p, repo.RoleViewer, fixtureOwner); err != nil {
		t.Fatalf("grant: %v", err)
	}
}

// publish saves a new version of a chapter as the owner.
func (f *readingFixture) publish(t *testing.T, docID, base, summary, html string) string {
	t.Helper()
	v, err := f.e.store.CreateVersion(context.Background(), docID, base, summary, []byte(html), fixtureOwner)
	if err != nil {
		t.Fatalf("CreateVersion: %v", err)
	}
	return v.ID
}

func (f *readingFixture) path(p string) string { return "/v1/books/" + f.bookID + p }

func (f *readingFixture) do(t *testing.T, method, p, body, principal string) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, f.e.h, method, f.path(p), body, bkHeaders(principal))
}

func (f *readingFixture) expect(t *testing.T, method, p, body, principal string, want int) []byte {
	t.Helper()
	rr := do(t, f.e.h, method, f.path(p), body, bkHeaders(principal))
	assertStatus(t, rr, want)
	return rr.Body.Bytes()
}

func positionBody(t *testing.T, fields map[string]any) string {
	t.Helper()
	b, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func position(doc, ver, section string, ts time.Time) map[string]any {
	return map[string]any{
		"device_id":   readingDevice,
		"document_id": doc,
		"version_id":  ver,
		"section_id":  section,
		"anchor":      map[string]any{"quote": "It costs", "prefix": "", "suffix": " a month", "start_offset": 0, "end_offset": 8},
		"progression": 0.4,
		"client_ts":   ts.UTC().Format(time.RFC3339Nano),
	}
}

type readingState struct {
	Positions []struct {
		DeviceID    string         `json:"device_id"`
		DocumentID  string         `json:"document_id"`
		VersionID   string         `json:"version_id"`
		SectionID   string         `json:"section_id"`
		Anchor      map[string]any `json:"anchor"`
		Progression float64        `json:"progression"`
		ClientTS    string         `json:"client_ts"`
	} `json:"positions"`
	Chapters map[string]struct {
		State               string  `json:"state"`
		Updated             bool    `json:"updated"`
		SeenVersionID       string  `json:"seen_version_id"`
		FurthestProgression float64 `json:"furthest_progression"`
	} `json:"chapters"`
	Progress struct {
		Chapter int     `json:"chapter"`
		Of      int     `json:"of"`
		Share   float64 `json:"share"`
	} `json:"progress"`
}

func (f *readingFixture) state(t *testing.T, principal string) readingState {
	t.Helper()
	body := f.expect(t, http.MethodGet, "/state", "", principal, http.StatusOK)
	var s readingState
	if err := json.Unmarshal(body, &s); err != nil {
		t.Fatalf("bad state JSON: %v; %s", err, body)
	}
	if s.Positions == nil || s.Chapters == nil {
		t.Fatalf("state must hold positions and chapters: %s", body)
	}
	return s
}

func errorCode(t *testing.T, body []byte) string {
	t.Helper()
	return bkString(t, body, "error.code")
}

func (f *readingFixture) open(t *testing.T, doc, ver, principal string) {
	t.Helper()
	f.expect(t, http.MethodPost, "/chapters/"+doc+"/open", `{"version_id":"`+ver+`"}`, principal, http.StatusNoContent)
}

func TestPositionWithUnknownSectionIsKeptWithoutSection(t *testing.T) {
	f := newReadingFixture(t)
	now := time.Now()
	f.expect(t, http.MethodPut, "/position", positionBody(t, position(f.ch1, f.ch1v1, "nope", now)), f.viewer, http.StatusNoContent)
	s := f.state(t, f.viewer)
	if len(s.Positions) != 1 {
		t.Fatalf("positions = %+v, want 1", s.Positions)
	}
	p := s.Positions[0]
	if p.SectionID != "" || p.DocumentID != f.ch1 || p.VersionID != f.ch1v1 || p.DeviceID != readingDevice {
		t.Fatalf("position = %+v, want ch1 v1 with no section", p)
	}
	if p.Anchor["quote"] != "It costs" || p.Progression < 0.39 || p.Progression > 0.41 {
		t.Fatalf("quote and progression must survive: %+v", p)
	}

	// A known heading id is kept.
	f.expect(t, http.MethodPut, "/position", positionBody(t, position(f.ch1, f.ch1v1, "cost", now.Add(time.Second))), f.viewer, http.StatusNoContent)
	if s := f.state(t, f.viewer); s.Positions[0].SectionID != "cost" {
		t.Fatalf("section_id = %q, want cost", s.Positions[0].SectionID)
	}

	// A chapter the reader cannot open is not found, never forbidden.
	rr := f.expect(t, http.MethodPut, "/position", positionBody(t, position(f.ch3, f.ch3v1, "", now.Add(2*time.Second))), f.viewer, http.StatusNotFound)
	if strings.Contains(string(rr), "Secrets") {
		t.Fatalf("404 leaks the chapter: %s", rr)
	}
}

func TestPositionValidation(t *testing.T) {
	f := newReadingFixture(t)
	now := time.Now()
	anchorOf := func(m map[string]any) map[string]any {
		a, ok := m["anchor"].(map[string]any)
		if !ok {
			t.Fatalf("anchor = %T, want object", m["anchor"])
		}
		return a
	}
	bad := map[string]func(map[string]any){
		"short device":      func(m map[string]any) { m["device_id"] = "abc" },
		"device charset":    func(m map[string]any) { m["device_id"] = "device id with spaces" },
		"long quote":        func(m map[string]any) { anchorOf(m)["quote"] = strings.Repeat("₹", 513) },
		"long prefix":       func(m map[string]any) { anchorOf(m)["prefix"] = strings.Repeat("a", 65) },
		"long suffix":       func(m map[string]any) { anchorOf(m)["suffix"] = strings.Repeat("a", 65) },
		"bad offsets":       func(m map[string]any) { anchorOf(m)["end_offset"] = -1 },
		"future timestamp":  func(m map[string]any) { m["client_ts"] = now.Add(10 * time.Minute).UTC().Format(time.RFC3339) },
		"missing timestamp": func(m map[string]any) { delete(m, "client_ts") },
		"missing version":   func(m map[string]any) { m["version_id"] = "" },
		"foreign version":   func(m map[string]any) { m["version_id"] = f.ch2v1 },
		"unknown version":   func(m map[string]any) { m["version_id"] = "ver_missing" },
	}
	for name, mutate := range bad {
		t.Run(name, func(t *testing.T) {
			m := position(f.ch1, f.ch1v1, "", now)
			mutate(m)
			body := f.expect(t, http.MethodPut, "/position", positionBody(t, m), f.viewer, http.StatusBadRequest)
			if got := errorCode(t, body); got != "invalid_position" {
				t.Fatalf("error.code = %q, want invalid_position", got)
			}
		})
	}

	// A timestamp a little in the future (clock skew) is fine, and
	// progression is clamped to [0,1].
	m := position(f.ch1, f.ch1v1, "", now.Add(2*time.Minute))
	m["progression"] = 1.7
	f.expect(t, http.MethodPut, "/position", positionBody(t, m), f.viewer, http.StatusNoContent)
	if s := f.state(t, f.viewer); s.Positions[0].Progression != 1 {
		t.Fatalf("progression = %v, want clamped to 1", s.Positions[0].Progression)
	}
	m = position(f.ch1, f.ch1v1, "", now.Add(3*time.Minute))
	m["progression"] = -3
	f.expect(t, http.MethodPut, "/position", positionBody(t, m), f.viewer, http.StatusNoContent)
	if s := f.state(t, f.viewer); s.Positions[0].Progression != 0 {
		t.Fatalf("progression = %v, want clamped to 0", s.Positions[0].Progression)
	}
}

func TestStalePositionIgnored(t *testing.T) {
	f := newReadingFixture(t)
	t2 := time.Now().Add(-time.Minute)
	t1 := t2.Add(-time.Minute)
	rr := f.do(t, http.MethodPut, "/position", positionBody(t, position(f.ch2, f.ch2v1, "intro", t2)), f.viewer)
	if rr.Code != http.StatusNoContent || rr.Header().Get("X-Position-Stale") != "" {
		t.Fatalf("first write: status %d stale %q", rr.Code, rr.Header().Get("X-Position-Stale"))
	}
	rr = f.do(t, http.MethodPut, "/position", positionBody(t, position(f.ch1, f.ch1v1, "cost", t1)), f.viewer)
	if rr.Code != http.StatusNoContent || rr.Header().Get("X-Position-Stale") != "1" {
		t.Fatalf("stale write: status %d stale %q, want 204 and X-Position-Stale: 1", rr.Code, rr.Header().Get("X-Position-Stale"))
	}
	s := f.state(t, f.viewer)
	if len(s.Positions) != 1 || s.Positions[0].DocumentID != f.ch2 || s.Positions[0].SectionID != "intro" {
		t.Fatalf("positions = %+v, want the T2 position on ch2", s.Positions)
	}
	got, err := time.Parse(time.RFC3339Nano, s.Positions[0].ClientTS)
	if err != nil || !got.Equal(t2.Truncate(time.Microsecond)) {
		t.Fatalf("client_ts = %q, want %s", s.Positions[0].ClientTS, t2)
	}

	// Another device keeps its own position; the newest one comes first.
	m := position(f.ch1, f.ch1v1, "", t2.Add(30*time.Second))
	m["device_id"] = readingOtherDevice
	f.expect(t, http.MethodPut, "/position", positionBody(t, m), f.viewer, http.StatusNoContent)
	s = f.state(t, f.viewer)
	if len(s.Positions) != 2 || s.Positions[0].DeviceID != readingOtherDevice || s.Positions[1].DeviceID != readingDevice {
		t.Fatalf("positions = %+v, want the phone first, then the laptop", s.Positions)
	}
}

func TestUpdatedSinceReadAndChanges(t *testing.T) {
	f := newReadingFixture(t)
	f.open(t, f.ch1, f.ch1v1, f.viewer)
	s := f.state(t, f.viewer)
	if c := s.Chapters[f.ch1]; c.State != "reading" || c.Updated || c.SeenVersionID != f.ch1v1 {
		t.Fatalf("after open: %+v", c)
	}
	if c := s.Chapters[f.ch2]; c.State != "not_started" || c.Updated {
		t.Fatalf("unopened chapter: %+v", c)
	}

	v2 := f.publish(t, f.ch1, f.ch1v1, "Recomputed ₹ costs", readingV2)
	s = f.state(t, f.viewer)
	if !s.Chapters[f.ch1].Updated {
		t.Fatalf("a new version of an opened chapter must be updated: %+v", s.Chapters[f.ch1])
	}

	body := f.expect(t, http.MethodGet, "/chapters/"+f.ch1+"/changes", "", f.viewer, http.StatusOK)
	var ch struct {
		SinceVersionID string `json:"since_version_id"`
		Versions       []struct {
			ID            string `json:"id"`
			Number        int    `json:"number"`
			ChangeSummary string `json:"change_summary"`
			CreatedAt     string `json:"created_at"`
		} `json:"versions"`
		ChangedSections []struct {
			ID      string `json:"id"`
			Title   string `json:"title"`
			Removed bool   `json:"removed"`
		} `json:"changed_sections"`
	}
	if err := json.Unmarshal(body, &ch); err != nil {
		t.Fatalf("bad changes JSON: %v; %s", err, body)
	}
	if ch.SinceVersionID != f.ch1v1 {
		t.Fatalf("since_version_id = %q, want %q", ch.SinceVersionID, f.ch1v1)
	}
	if len(ch.Versions) != 1 || ch.Versions[0].ID != v2 || ch.Versions[0].Number != 2 ||
		ch.Versions[0].ChangeSummary != "Recomputed ₹ costs" || ch.Versions[0].CreatedAt == "" {
		t.Fatalf("versions = %+v, want only v2 with its note: %s", ch.Versions, body)
	}
	if len(ch.ChangedSections) != 1 || ch.ChangedSections[0].ID != "cost" || ch.ChangedSections[0].Title != "Cost" || ch.ChangedSections[0].Removed {
		t.Fatalf("changed_sections = %+v, want [cost]: %s", ch.ChangedSections, body)
	}

	// Reaching the end of the new version clears the update.
	f.expect(t, http.MethodPost, "/chapters/"+f.ch1+"/progress", `{"progression":1,"reached_end":true,"version_id":"`+v2+`"}`, f.viewer, http.StatusNoContent)
	s = f.state(t, f.viewer)
	if c := s.Chapters[f.ch1]; c.Updated || c.State != "read" || c.SeenVersionID != v2 || c.FurthestProgression != 1 {
		t.Fatalf("after reaching the end: %+v", c)
	}
	body = f.expect(t, http.MethodGet, "/chapters/"+f.ch1+"/changes", "", f.viewer, http.StatusOK)
	if bkLen(t, body, "versions") != 0 || bkLen(t, body, "changed_sections") != 0 {
		t.Fatalf("nothing changed since the seen version: %s", body)
	}

	// A hidden chapter has no changes to show.
	f.expect(t, http.MethodGet, "/chapters/"+f.ch3+"/changes", "", f.viewer, http.StatusNotFound)
}

func TestOpeningAloneDoesNotClearUpdated(t *testing.T) {
	f := newReadingFixture(t)
	f.open(t, f.ch1, f.ch1v1, f.viewer)
	v2 := f.publish(t, f.ch1, f.ch1v1, "Second", readingV2)
	f.open(t, f.ch1, v2, f.viewer)
	s := f.state(t, f.viewer)
	if c := s.Chapters[f.ch1]; !c.Updated || c.SeenVersionID != f.ch1v1 {
		t.Fatalf("reopening must not clear updated: %+v", c)
	}
	// Dismissing the chip (seen without a body) clears it.
	f.expect(t, http.MethodPost, "/chapters/"+f.ch1+"/seen", "", f.viewer, http.StatusNoContent)
	if c := f.state(t, f.viewer).Chapters[f.ch1]; c.Updated || c.SeenVersionID != v2 {
		t.Fatalf("after seen: %+v", c)
	}
}

func TestFinishingOldVersionKeepsNewUpdate(t *testing.T) {
	f := newReadingFixture(t)
	f.open(t, f.ch1, f.ch1v1, f.viewer)
	v2 := f.publish(t, f.ch1, f.ch1v1, "Second", readingV2)
	// The reader finishes v1, which is still on their screen.
	f.expect(t, http.MethodPost, "/chapters/"+f.ch1+"/progress", `{"progression":1,"reached_end":true,"version_id":"`+f.ch1v1+`"}`, f.viewer, http.StatusNoContent)
	if c := f.state(t, f.viewer).Chapters[f.ch1]; !c.Updated || c.SeenVersionID != f.ch1v1 || c.State != "read" {
		t.Fatalf("finishing v1 must keep v2 updated: %+v", c)
	}
	// Seeing v2 and then v1 again never moves seen backwards.
	f.expect(t, http.MethodPost, "/chapters/"+f.ch1+"/seen", `{"version_id":"`+v2+`"}`, f.viewer, http.StatusNoContent)
	f.expect(t, http.MethodPost, "/chapters/"+f.ch1+"/seen", `{"version_id":"`+f.ch1v1+`"}`, f.viewer, http.StatusNoContent)
	if c := f.state(t, f.viewer).Chapters[f.ch1]; c.Updated || c.SeenVersionID != v2 {
		t.Fatalf("seen moved backwards: %+v", c)
	}
}

// Reaching the end must name the version read: defaulting to the current
// version would clear an update the reader has not seen (A7).
func TestReachedEndRequiresVersionID(t *testing.T) {
	f := newReadingFixture(t)
	f.open(t, f.ch1, f.ch1v1, f.viewer)
	f.publish(t, f.ch1, f.ch1v1, "Second", readingV2)
	body := f.expect(t, http.MethodPost, "/chapters/"+f.ch1+"/progress", `{"progression":1,"reached_end":true}`, f.viewer, http.StatusBadRequest)
	if got := errorCode(t, body); got != "invalid_request" {
		t.Fatalf("error.code = %q, want invalid_request", got)
	}
	if c := f.state(t, f.viewer).Chapters[f.ch1]; !c.Updated || c.SeenVersionID != f.ch1v1 || c.State != "reading" {
		t.Fatalf("reached_end without version_id changed the chapter: %+v", c)
	}
	// Progress without reached_end needs no version.
	f.expect(t, http.MethodPost, "/chapters/"+f.ch1+"/progress", `{"progression":0.5}`, f.viewer, http.StatusNoContent)
}

func TestChapterRoutesRejectVersionOfAnotherDocument(t *testing.T) {
	f := newReadingFixture(t)
	f.open(t, f.ch1, f.ch1v1, f.viewer)
	v2 := f.publish(t, f.ch2, f.ch2v1, "Second", readingV2)
	f.open(t, f.ch2, f.ch2v1, f.viewer)
	// v2 of chapter two has a higher number than ch1's seen version, so the
	// SQL guard alone would let it through.
	for _, r := range []struct{ path, body string }{
		{"/chapters/" + f.ch1 + "/seen", `{"version_id":"` + v2 + `"}`},
		{"/chapters/" + f.ch1 + "/progress", `{"progression":1,"reached_end":true,"version_id":"` + v2 + `"}`},
		{"/chapters/" + f.ch1 + "/open", `{"version_id":"` + v2 + `"}`},
		{"/chapters/" + f.ch1 + "/seen", `{"version_id":"ver_missing"}`},
	} {
		body := f.expect(t, http.MethodPost, r.path, r.body, f.viewer, http.StatusBadRequest)
		if got := errorCode(t, body); got != "invalid_request" {
			t.Fatalf("%s: error.code = %q, want invalid_request", r.path, got)
		}
	}
	if c := f.state(t, f.viewer).Chapters[f.ch1]; c.SeenVersionID != f.ch1v1 || c.State != "reading" {
		t.Fatalf("a foreign version changed ch1: %+v", c)
	}
}

func TestSeenAllAndDone(t *testing.T) {
	f := newReadingFixture(t)
	f.open(t, f.ch1, f.ch1v1, f.viewer)
	f.open(t, f.ch2, f.ch2v1, f.viewer)
	v2a := f.publish(t, f.ch1, f.ch1v1, "a", readingV2)
	v2b := f.publish(t, f.ch2, f.ch2v1, "b", readingV2)
	s := f.state(t, f.viewer)
	if !s.Chapters[f.ch1].Updated || !s.Chapters[f.ch2].Updated {
		t.Fatalf("both chapters should be updated: %+v", s.Chapters)
	}
	f.expect(t, http.MethodPost, "/seen", "", f.viewer, http.StatusNoContent)
	s = f.state(t, f.viewer)
	if c := s.Chapters[f.ch1]; c.Updated || c.SeenVersionID != v2a {
		t.Fatalf("ch1 after mark all seen: %+v", c)
	}
	if c := s.Chapters[f.ch2]; c.Updated || c.SeenVersionID != v2b {
		t.Fatalf("ch2 after mark all seen: %+v", c)
	}
	if c, ok := s.Chapters[f.ch3]; ok {
		t.Fatalf("state leaks the hidden chapter: %+v", c)
	}

	done := func(doc string, v bool) {
		f.expect(t, http.MethodPut, "/chapters/"+doc+"/done", fmt.Sprintf(`{"done":%t}`, v), f.viewer, http.StatusNoContent)
	}
	done(f.ch1, true)
	if c := f.state(t, f.viewer).Chapters[f.ch1]; c.State != "done" {
		t.Fatalf("state = %q, want done", c.State)
	}
	done(f.ch1, false)
	if c := f.state(t, f.viewer).Chapters[f.ch1]; c.State != "reading" {
		t.Fatalf("undone without reaching the end: state = %q, want reading", c.State)
	}
	f.expect(t, http.MethodPost, "/chapters/"+f.ch2+"/progress", `{"progression":1,"reached_end":true,"version_id":"`+v2b+`"}`, f.viewer, http.StatusNoContent)
	done(f.ch2, true)
	done(f.ch2, false)
	if c := f.state(t, f.viewer).Chapters[f.ch2]; c.State != "read" {
		t.Fatalf("undone after reaching the end: state = %q, want read", c.State)
	}
	f.expect(t, http.MethodPut, "/chapters/"+f.ch3+"/done", `{"done":true}`, f.viewer, http.StatusNotFound)
}

func TestStateProgressCountsChaptersTheReaderCanOpen(t *testing.T) {
	f := newReadingFixture(t)
	// The stranger can open chapters one and three, not two.
	f.grant(t, f.ch1, fixtureStranger)
	f.grant(t, f.ch3, fixtureStranger)
	stranger := principalHeader(fixtureStranger)
	s := f.state(t, stranger)
	if s.Progress.Of != 2 || s.Progress.Chapter != 0 || s.Progress.Share != 0 {
		t.Fatalf("fresh progress = %+v, want 0 of 2", s.Progress)
	}
	f.open(t, f.ch1, f.ch1v1, stranger)
	f.expect(t, http.MethodPost, "/chapters/"+f.ch1+"/progress", `{"progression":1,"reached_end":true,"version_id":"`+f.ch1v1+`"}`, stranger, http.StatusNoContent)
	f.open(t, f.ch3, f.ch3v1, stranger)
	f.expect(t, http.MethodPut, "/position", positionBody(t, position(f.ch3, f.ch3v1, "", time.Now())), stranger, http.StatusNoContent)
	s = f.state(t, stranger)
	if s.Progress.Chapter != 2 || s.Progress.Of != 2 {
		t.Fatalf("progress = %+v, want chapter 2 of 2", s.Progress)
	}
	// Both chapters have the same words: one read is half the book.
	if s.Progress.Share < 0.49 || s.Progress.Share > 0.51 {
		t.Fatalf("share = %v, want 0.5", s.Progress.Share)
	}
	if _, ok := s.Chapters[f.ch2]; ok {
		t.Fatalf("state leaks the hidden chapter: %+v", s.Chapters)
	}
}

func TestStateIsPrivate(t *testing.T) {
	f := newReadingFixture(t)
	f.open(t, f.ch1, f.ch1v1, f.viewer)
	f.expect(t, http.MethodPut, "/position", positionBody(t, position(f.ch1, f.ch1v1, "cost", time.Now())), f.viewer, http.StatusNoContent)
	s := f.state(t, f.owner)
	if len(s.Positions) != 0 {
		t.Fatalf("owner sees the viewer's positions: %+v", s.Positions)
	}
	if c := s.Chapters[f.ch1]; c.State != "not_started" || c.SeenVersionID != "" {
		t.Fatalf("owner sees the viewer's chapter state: %+v", c)
	}
	// Someone who can open nothing gets not found.
	f.expect(t, http.MethodGet, "/state", "", principalHeader(fixtureAttacker), http.StatusNotFound)
}

func TestServiceAccountGetsUsersOnly(t *testing.T) {
	f := newReadingFixture(t)
	sa := "service_account:" + f.e.sa.ID
	ch := "/chapters/" + f.ch1
	for _, r := range []struct{ method, path, body string }{
		{http.MethodGet, "/state", ""},
		{http.MethodPut, "/position", positionBody(t, position(f.ch1, f.ch1v1, "", time.Now()))},
		{http.MethodPost, ch + "/open", `{"version_id":"` + f.ch1v1 + `"}`},
		{http.MethodPost, ch + "/progress", `{"progression":0.5}`},
		{http.MethodPut, ch + "/done", `{"done":true}`},
		{http.MethodPost, ch + "/seen", ""},
		{http.MethodPost, "/seen", ""},
		{http.MethodGet, ch + "/changes", ""},
	} {
		body := f.expect(t, r.method, r.path, r.body, sa, http.StatusForbidden)
		if got := errorCode(t, body); got != "reading_state_users_only" {
			t.Fatalf("%s %s: error.code = %q, want reading_state_users_only", r.method, r.path, got)
		}
	}
}

// accessCounter counts the access checks and folder scans a request makes.
type accessCounter struct {
	repo.Repository
	roleForDocument, listFolderDocuments int
}

func (r *accessCounter) RoleForDocument(ctx context.Context, p auth.Principal, id string) (repo.Role, error) {
	r.roleForDocument++
	return r.Repository.RoleForDocument(ctx, p, id)
}

func (r *accessCounter) ListFolderDocuments(ctx context.Context, p auth.Principal, folderID string) ([]repo.Document, error) {
	r.listFolderDocuments++
	return r.Repository.ListFolderDocuments(ctx, p, folderID)
}

func TestChapterRoutesDoNotScanTheBook(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", BooksEnabled: true})
	ctx := context.Background()
	owner := principalHeader(fixtureOwner)
	folderID := createFolder(t, e, `{"title":"Long book"}`, owner)
	var docs []repo.Document
	for i := 1; i <= 30; i++ {
		d, _, err := e.store.CreateDocument(ctx, fixtureOwner, fmt.Sprintf("%02d · Chapter", i), []byte(readingV1))
		if err != nil {
			t.Fatalf("CreateDocument: %v", err)
		}
		if _, err := e.store.MoveDocumentToFolder(ctx, fixtureOwner, folderID, d.ID); err != nil {
			t.Fatalf("MoveDocumentToFolder: %v", err)
		}
		// Chapter grants, not a folder grant: a book scan would check each.
		if _, err := e.store.CreateGrant(ctx, "document", d.ID, fixtureViewer, repo.RoleViewer, fixtureOwner); err != nil {
			t.Fatalf("grant: %v", err)
		}
		docs = append(docs, d)
	}
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/book", `{}`, bkHeaders(owner))
	assertStatus(t, rr, http.StatusCreated)
	bookID := bkString(t, rr.Body.Bytes(), "book_id")

	counter := &accessCounter{Repository: e.store}
	h := server.New(server.Config{Environment: "test", BooksEnabled: true},
		server.WithRepository(counter), server.WithAuthenticator(testPrincipalAuth{})).Handler()
	d := docs[14]
	rr = do(t, h, http.MethodPut, "/v1/books/"+bookID+"/position",
		positionBody(t, position(d.ID, d.CurrentVersionID, "cost", time.Now())), bkHeaders(principalHeader(fixtureViewer)))
	assertStatus(t, rr, http.StatusNoContent)
	if counter.roleForDocument != 1 || counter.listFolderDocuments != 0 {
		t.Fatalf("PUT /position made %d RoleForDocument and %d ListFolderDocuments calls, want 1 and 0",
			counter.roleForDocument, counter.listFolderDocuments)
	}
	for _, r := range []struct{ method, path, body string }{
		{http.MethodPost, "/open", `{"version_id":"` + d.CurrentVersionID + `"}`},
		{http.MethodPost, "/progress", `{"progression":0.5}`},
		{http.MethodPut, "/done", `{"done":true}`},
		{http.MethodPost, "/seen", ""},
		{http.MethodGet, "/changes", ""},
	} {
		counter.roleForDocument, counter.listFolderDocuments = 0, 0
		rr = do(t, h, r.method, "/v1/books/"+bookID+"/chapters/"+d.ID+r.path, r.body, bkHeaders(principalHeader(fixtureViewer)))
		if rr.Code >= 300 {
			t.Fatalf("%s %s: status %d: %s", r.method, r.path, rr.Code, rr.Body.String())
		}
		if counter.roleForDocument != 1 || counter.listFolderDocuments != 0 {
			t.Fatalf("%s %s made %d RoleForDocument and %d ListFolderDocuments calls, want 1 and 0",
				r.method, r.path, counter.roleForDocument, counter.listFolderDocuments)
		}
	}
}

func TestBookSearchScopesBeforeLimit(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", BooksEnabled: true})
	ctx := context.Background()
	owner := principalHeader(fixtureOwner)
	folderID := createFolder(t, e, `{"title":"Fruit"}`, owner)
	mk := func(title, html string) string {
		d, _, err := e.store.CreateDocument(ctx, fixtureOwner, title, []byte(html))
		if err != nil {
			t.Fatalf("CreateDocument: %v", err)
		}
		if _, err := e.store.MoveDocumentToFolder(ctx, fixtureOwner, folderID, d.ID); err != nil {
			t.Fatalf("MoveDocumentToFolder: %v", err)
		}
		return d.ID
	}
	ch1 := mk("01 · Orchard", "<html><body><p>One kumquat grows here.</p></body></html>")
	ch2 := mk("02 · Market", "<html><body><p>A kumquat is sold here.</p></body></html>")
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/book", `{}`, bkHeaders(owner))
	assertStatus(t, rr, http.StatusCreated)
	bookID := bkString(t, rr.Body.Bytes(), "book_id")
	// Sixty newer, better matching documents in the folder but not in the outline.
	var note string
	for i := 0; i < 60; i++ {
		note = mk(fmt.Sprintf("Kumquat kumquat note %d", i), "<html><body><p>kumquat kumquat kumquat kumquat</p></body></html>")
	}

	// Without the chapter filter, the limit would cut the chapters off.
	plain, err := e.store.SearchDocuments(ctx, fixtureOwner, repo.DocumentSearch{Terms: []string{"kumquat"}, Folders: []string{folderID}}, false, 50)
	if err != nil {
		t.Fatalf("SearchDocuments: %v", err)
	}
	for _, d := range plain {
		if d.ID == ch1 || d.ID == ch2 {
			t.Fatalf("precondition: an unscoped search already finds chapter %s", d.ID)
		}
	}

	search := func(principal, query string, want int) []repo.Document {
		t.Helper()
		rr := do(t, e.h, http.MethodGet, "/v1/books/"+bookID+"/search?"+query, "", bkHeaders(principal))
		assertStatus(t, rr, want)
		if want != http.StatusOK {
			return nil
		}
		var out struct {
			Items []repo.Document `json:"items"`
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatalf("bad search JSON: %v", err)
		}
		return out.Items
	}
	ids := func(ds []repo.Document) map[string]bool {
		m := map[string]bool{}
		for _, d := range ds {
			m[d.ID] = true
		}
		return m
	}
	got := search(owner, "q=kumquat", http.StatusOK)
	if m := ids(got); len(got) != 2 || !m[ch1] || !m[ch2] {
		t.Fatalf("book search found %d documents %v, want exactly the chapters %s and %s", len(got), m, ch1, ch2)
	}
	if got[0].Snippet == "" && got[1].Snippet == "" {
		t.Fatalf("search results carry no snippet: %+v", got)
	}
	got = search(owner, "q=kumquat&document_id="+ch1, http.StatusOK)
	if len(got) != 1 || got[0].ID != ch1 {
		t.Fatalf("narrowed search = %+v, want only chapter one", got)
	}
	// in: cannot widen the search past the book.
	got = search(owner, "q="+url.QueryEscape("kumquat in:elsewhere"), http.StatusOK)
	if len(got) != 2 {
		t.Fatalf("in: changed the scope: %+v", got)
	}
	// A document outside the outline, or one the reader cannot open, is not found.
	search(owner, "q=kumquat&document_id="+note, http.StatusNotFound)
	if _, err := e.store.CreateGrant(ctx, "document", ch1, fixtureViewer, repo.RoleViewer, fixtureOwner); err != nil {
		t.Fatalf("grant: %v", err)
	}
	viewer := principalHeader(fixtureViewer)
	search(viewer, "q=kumquat&document_id="+ch2, http.StatusNotFound)
	got = search(viewer, "q=kumquat", http.StatusOK)
	if len(got) != 1 || got[0].ID != ch1 {
		t.Fatalf("viewer search = %+v, want only the chapter they can open", got)
	}
	search(owner, "q=", http.StatusBadRequest)
}
