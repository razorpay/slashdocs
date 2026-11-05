package postgres_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

func TestChapterReadsLifecycle(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, _, _ := bookFixture(t, s, planned("Later"))
	reader, err := s.EnsureUserByEmail(ctx, "reader@example.com")
	if err != nil {
		t.Fatalf("EnsureUserByEmail: %v", err)
	}
	doc, v1, err := s.CreateDocument(ctx, owner, "Chapter", []byte("<p>one</p>"))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	read := func() (repo.ChapterRead, bool) {
		t.Helper()
		m, err := s.GetChapterReads(ctx, reader.ID, []string{doc.ID})
		if err != nil {
			t.Fatalf("GetChapterReads: %v", err)
		}
		r, ok := m[doc.ID]
		return r, ok
	}
	if _, ok := read(); ok {
		t.Fatal("a chapter never opened has no row")
	}
	// Updates without a row do nothing.
	if err := s.UpdateChapterProgress(ctx, reader.ID, doc.ID, 0.5, false); err != nil {
		t.Fatalf("UpdateChapterProgress: %v", err)
	}
	if _, ok := read(); ok {
		t.Fatal("progress must not create a row")
	}

	if err := s.OpenChapter(ctx, reader.ID, doc.ID, v1.ID); err != nil {
		t.Fatalf("OpenChapter: %v", err)
	}
	r, ok := read()
	if !ok || r.SeenVersionID != v1.ID || r.LastReadVersionID != v1.ID || r.ReachedEnd || r.Done || r.LastOpenedAt == "" {
		t.Fatalf("after first open: %+v", r)
	}

	v2, err := s.CreateVersion(ctx, doc.ID, v1.ID, "two", []byte("<p>two</p>"), owner)
	if err != nil {
		t.Fatalf("CreateVersion: %v", err)
	}
	if err := s.OpenChapter(ctx, reader.ID, doc.ID, v2.ID); err != nil {
		t.Fatalf("OpenChapter: %v", err)
	}
	if r, _ = read(); r.SeenVersionID != v1.ID || r.LastReadVersionID != v2.ID {
		t.Fatalf("reopening must keep seen and move last read: %+v", r)
	}

	// Progress only grows, and reaching the end sticks.
	if err := s.UpdateChapterProgress(ctx, reader.ID, doc.ID, 0.6, false); err != nil {
		t.Fatalf("UpdateChapterProgress: %v", err)
	}
	if err := s.UpdateChapterProgress(ctx, reader.ID, doc.ID, 0.2, true); err != nil {
		t.Fatalf("UpdateChapterProgress: %v", err)
	}
	if r, _ = read(); r.FurthestProgression < 0.59 || r.FurthestProgression > 0.61 || !r.ReachedEnd {
		t.Fatalf("progress: %+v", r)
	}

	if err := s.SetChapterDone(ctx, reader.ID, doc.ID, true); err != nil {
		t.Fatalf("SetChapterDone: %v", err)
	}
	if r, _ = read(); !r.Done {
		t.Fatalf("done: %+v", r)
	}
	if err := s.SetChapterDone(ctx, reader.ID, doc.ID, false); err != nil {
		t.Fatalf("SetChapterDone: %v", err)
	}
	if r, _ = read(); r.Done || !r.ReachedEnd {
		t.Fatalf("undone: %+v", r)
	}

	// Seen moves forward only (A7).
	if err := s.MarkChapterSeen(ctx, reader.ID, doc.ID, v2.ID); err != nil {
		t.Fatalf("MarkChapterSeen: %v", err)
	}
	if err := s.MarkChapterSeen(ctx, reader.ID, doc.ID, v1.ID); err != nil {
		t.Fatalf("MarkChapterSeen: %v", err)
	}
	if r, _ = read(); r.SeenVersionID != v2.ID {
		t.Fatalf("seen moved backwards: %+v", r)
	}

	// Another reader's state is separate.
	other, err := s.GetChapterReads(ctx, owner.ID, []string{doc.ID})
	if err != nil || len(other) != 0 {
		t.Fatalf("owner reads = %+v, %v; want none", other, err)
	}
}

func TestSaveReadingPositionIgnoresStaleWrites(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, _, b := bookFixture(t, s, planned("Later"))
	reader, err := s.EnsureUserByEmail(ctx, "reader@example.com")
	if err != nil {
		t.Fatalf("EnsureUserByEmail: %v", err)
	}
	doc, v1, err := s.CreateDocument(ctx, owner, "Chapter", []byte("<p>one</p>"))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	t2 := time.Now().UTC().Truncate(time.Microsecond)
	p := repo.ReadingPosition{
		DeviceID: "device_laptop_1", DocumentID: doc.ID, VersionID: v1.ID, SectionID: "intro",
		Anchor:      repo.Anchor{Quote: "one", Suffix: " more", StartOffset: 1, EndOffset: 4},
		Progression: 0.25, ClientTS: t2,
	}
	saved, err := s.SaveReadingPosition(ctx, reader.ID, b.ID, p)
	if err != nil || !saved {
		t.Fatalf("first save = %v, %v; want saved", saved, err)
	}
	older := p
	older.SectionID, older.ClientTS = "outro", t2.Add(-time.Minute)
	if saved, err = s.SaveReadingPosition(ctx, reader.ID, b.ID, older); err != nil || saved {
		t.Fatalf("stale save = %v, %v; want ignored", saved, err)
	}
	same := p
	same.SectionID = "same"
	if saved, err = s.SaveReadingPosition(ctx, reader.ID, b.ID, same); err != nil || saved {
		t.Fatalf("save with the same timestamp = %v, %v; want ignored", saved, err)
	}
	phone := p
	phone.DeviceID, phone.ClientTS = "device_phone_22", t2.Add(time.Second)
	if saved, err = s.SaveReadingPosition(ctx, reader.ID, b.ID, phone); err != nil || !saved {
		t.Fatalf("other device save = %v, %v; want saved", saved, err)
	}

	got, err := s.ListReadingPositions(ctx, reader.ID, b.ID)
	if err != nil {
		t.Fatalf("ListReadingPositions: %v", err)
	}
	if len(got) != 2 || got[0].DeviceID != "device_phone_22" || got[1].DeviceID != "device_laptop_1" {
		t.Fatalf("positions = %+v, want phone then laptop", got)
	}
	l := got[1]
	if l.SectionID != "intro" || !l.ClientTS.Equal(t2) || l.Anchor != p.Anchor || l.Progression != 0.25 ||
		l.DocumentID != doc.ID || l.VersionID != v1.ID || l.UpdatedAt == "" {
		t.Fatalf("laptop position = %+v, want %+v", l, p)
	}
	if mine, err := s.ListReadingPositions(ctx, owner.ID, b.ID); err != nil || len(mine) != 0 {
		t.Fatalf("owner positions = %+v, %v; want none", mine, err)
	}
}

// A reader keeps at most repo.MaxReadingDevices positions per book: the
// device id comes from the client, so new ids must not grow the table or
// GET /state without bound.
func TestReadingPositionsKeepTheNewestDevices(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, _, b := bookFixture(t, s, planned("Later"))
	reader, err := s.EnsureUserByEmail(ctx, "reader@example.com")
	if err != nil {
		t.Fatalf("EnsureUserByEmail: %v", err)
	}
	doc, v1, err := s.CreateDocument(ctx, owner, "Chapter", []byte("<p>one</p>"))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	start := time.Now().UTC().Truncate(time.Microsecond).Add(-time.Hour)
	extra := 5
	for i := 0; i < repo.MaxReadingDevices+extra; i++ {
		p := repo.ReadingPosition{DeviceID: fmt.Sprintf("device_%04d", i), DocumentID: doc.ID, VersionID: v1.ID,
			ClientTS: start.Add(time.Duration(i) * time.Second)}
		if saved, err := s.SaveReadingPosition(ctx, reader.ID, b.ID, p); err != nil || !saved {
			t.Fatalf("save %d = %v, %v", i, saved, err)
		}
	}
	got, err := s.ListReadingPositions(ctx, reader.ID, b.ID)
	if err != nil {
		t.Fatalf("ListReadingPositions: %v", err)
	}
	if len(got) != repo.MaxReadingDevices {
		t.Fatalf("got %d positions, want %d", len(got), repo.MaxReadingDevices)
	}
	if want := fmt.Sprintf("device_%04d", repo.MaxReadingDevices+extra-1); got[0].DeviceID != want {
		t.Fatalf("newest = %s, want %s", got[0].DeviceID, want)
	}
	var rows int
	if err := s.Pool().QueryRow(ctx, `SELECT count(*) FROM reading_positions WHERE user_id=$1 AND book_id=$2`, reader.ID, b.ID).Scan(&rows); err != nil {
		t.Fatalf("count: %v", err)
	}
	if rows != repo.MaxReadingDevices {
		t.Fatalf("table holds %d rows, want the newest %d", rows, repo.MaxReadingDevices)
	}
	// A write older than every kept device does not displace one.
	if _, err := s.SaveReadingPosition(ctx, reader.ID, b.ID, repo.ReadingPosition{DeviceID: "device_0000", DocumentID: doc.ID, VersionID: v1.ID, ClientTS: start}); err != nil {
		t.Fatalf("re-save: %v", err)
	}
	if got, _ := s.ListReadingPositions(ctx, reader.ID, b.ID); len(got) != repo.MaxReadingDevices || got[len(got)-1].DeviceID == "device_0000" {
		t.Fatalf("an old device displaced a newer one: %d positions, last %s", len(got), got[len(got)-1].DeviceID)
	}
}
