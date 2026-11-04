package postgres

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/razorpay/slashdocs/api/internal/books"
	dbsqlc "github.com/razorpay/slashdocs/api/internal/db/sqlc"
)

// TestBookAndVersionLocksAllowForeignKeyChecks proves the strength of the
// row locks that outline writers and section indexing take. Each must still
// exclude another writer (NO KEY UPDATE conflicts with itself) but must not
// block the KEY SHARE that foreign-key checks take: reading-position and
// chapter-read writes reference books and versions, and CreateVersion's
// parent_version_id references the current version.
func TestBookAndVersionLocksAllowForeignKeyChecks(t *testing.T) {
	s, _, owner := newFailingBlobStore(t)
	ctx := context.Background()
	f, err := s.CreateFolder(ctx, owner, "Book", "")
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.CreateBook(ctx, f.ID, books.Outline{Title: "Book", Parts: []books.Part{{Title: "I"}}}, owner)
	if err != nil {
		t.Fatal(err)
	}
	doc, v, err := s.CreateDocument(ctx, owner, "One", []byte(`<h2>A</h2><p>a</p>`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, doc.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Pool().Exec(ctx, `UPDATE versions SET sections_indexed=false WHERE id=$1`, v.ID); err != nil {
		t.Fatal(err)
	}

	for _, c := range []struct {
		name, table, id string
		lock            func(*dbsqlc.Queries) error
	}{
		{"GetBookForUpdate", "books", b.ID, func(q *dbsqlc.Queries) error {
			_, err := q.GetBookForUpdate(ctx, b.ID)
			return err
		}},
		{"GetVersionSectionsForUpdate", "versions", v.ID, func(q *dbsqlc.Queries) error {
			_, err := q.GetVersionSectionsForUpdate(ctx, v.ID)
			return err
		}},
		{"ListUnsectionedVersions", "versions", v.ID, func(q *dbsqlc.Queries) error {
			rows, err := q.ListUnsectionedVersions(ctx, dbsqlc.ListUnsectionedVersionsParams{RowLimit: 10})
			if err == nil && (len(rows) != 1 || rows[0].ID != v.ID) {
				return errors.New("backfill query did not return the unindexed version")
			}
			return err
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			holder, err := s.Pool().Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = holder.Rollback(ctx) }()
			if err := c.lock(s.q.WithTx(holder)); err != nil {
				t.Fatalf("%s: %v", c.name, err)
			}
			try := func(mode string) error {
				tx, err := s.Pool().Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer func() { _ = tx.Rollback(ctx) }()
				var id string
				return tx.QueryRow(ctx, `SELECT id FROM `+c.table+` WHERE id=$1 FOR `+mode+` NOWAIT`, c.id).Scan(&id)
			}
			if err := try("KEY SHARE"); err != nil {
				t.Errorf("a foreign-key check (KEY SHARE) on %s is blocked by %s: %v", c.table, c.name, err)
			}
			var pgErr *pgconn.PgError
			if err := try("NO KEY UPDATE"); !errors.As(err, &pgErr) || pgErr.Code != "55P03" {
				t.Errorf("a second writer (NO KEY UPDATE) on %s = %v, want lock_not_available while %s holds the row", c.table, err, c.name)
			}
		})
	}
}

// TestMoveDocumentToRootTakesTreeLockFirst checks A8 on the root-move path:
// the folder-tree lock comes first, before any document or book row lock,
// so the move serializes with CreateBook and the other move paths.
func TestMoveDocumentToRootTakesTreeLockFirst(t *testing.T) {
	s, _, owner := newFailingBlobStore(t)
	ctx := context.Background()
	f, err := s.CreateFolder(ctx, owner, "Book", "")
	if err != nil {
		t.Fatal(err)
	}
	doc, _, err := s.CreateDocument(ctx, owner, "One", []byte(`<p>a</p>`))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, doc.ID); err != nil {
		t.Fatal(err)
	}

	holder, err := s.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = holder.Rollback(ctx) }()
	if err := s.q.WithTx(holder).AcquireFolderTreeLock(ctx, folderTreeLockID); err != nil {
		t.Fatal(err)
	}
	moved := make(chan error, 1)
	go func() { moved <- s.MoveDocumentToRoot(ctx, f.ID, doc.ID) }()

	waiting := false
	for deadline := time.Now().Add(5 * time.Second); !waiting && time.Now().Before(deadline); {
		select {
		case err := <-moved:
			t.Fatalf("MoveDocumentToRoot finished (%v) while another transaction held the folder-tree lock", err)
		case <-time.After(10 * time.Millisecond):
		}
		var n int
		if err := s.Pool().QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity
			WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event = 'advisory'`).Scan(&n); err != nil {
			t.Fatal(err)
		}
		waiting = n > 0
	}
	if !waiting {
		t.Fatal("MoveDocumentToRoot never waited on the folder-tree lock")
	}
	// It waits before touching the document row.
	probe, err := s.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var id string
	probeErr := probe.QueryRow(ctx, `SELECT id FROM documents WHERE id=$1 FOR UPDATE NOWAIT`, doc.ID).Scan(&id)
	_ = probe.Rollback(ctx)
	if probeErr != nil {
		t.Errorf("document row locked before the folder-tree lock: %v", probeErr)
	}
	if err := holder.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-moved:
		if err != nil {
			t.Fatalf("MoveDocumentToRoot: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("MoveDocumentToRoot did not finish after the tree lock was released")
	}
	d, err := s.q.GetDocument(ctx, doc.ID)
	if err != nil || d.ParentFolderID != "" {
		t.Fatalf("document parent = %q, %v; want root", d.ParentFolderID, err)
	}
}
