package postgres_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/razorpay/slashdocs/api/internal/repo"
)

// TestDeleteChapterDoesNotDeadlockWithReadingPositionSave replays the
// interleaving of a chapter delete with a reader saving their position in
// the same book. The position insert's foreign-key checks take KEY SHARE on
// the books row and then on the documents row. DeleteDocument holds the
// document row and then locks the book. If that book lock conflicts with
// KEY SHARE (FOR UPDATE does), the two wait on each other and PostgreSQL
// aborts one of them with "deadlock detected".
func TestDeleteChapterDoesNotDeadlockWithReadingPositionSave(t *testing.T) {
	s := newStore(t)
	ctx := context.Background()
	owner, f, b := bookFixture(t, s, planned("One", "Two"))
	one, v1, err := s.CreateDocument(ctx, owner, "One", []byte(`<p>1</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	two, v2, err := s.CreateDocument(ctx, owner, "Two", []byte(`<p>2</p>`))
	if err != nil {
		t.Fatalf("CreateDocument: %v", err)
	}
	for _, d := range []repo.Document{one, two} {
		if _, err := s.MoveDocumentToFolder(ctx, owner, f.ID, d.ID); err != nil {
			t.Fatalf("MoveDocumentToFolder: %v", err)
		}
	}
	const insertPosition = `INSERT INTO reading_positions(user_id,book_id,device_id,document_id,version_id,progression,client_ts)
		VALUES($1,$2,$3,$4,$5,0.5,now())`

	// The reader's transaction: its first foreign-key check holds KEY SHARE
	// on the book row until it commits.
	reader, err := s.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = reader.Rollback(ctx) }()
	if _, err := reader.Exec(ctx, insertPosition, owner.ID, b.ID, "device-aaaa", two.ID, v2.ID); err != nil {
		t.Fatalf("insert position on chapter two: %v", err)
	}

	deleted := make(chan error, 1)
	go func() { deleted <- s.DeleteDocument(ctx, one.ID) }()

	// Let DeleteDocument either finish or block on the book row.
	var deleteErr error
	deleteDone := false
	deadline := time.Now().Add(5 * time.Second)
	for !deleteDone {
		select {
		case deleteErr = <-deleted:
			deleteDone = true
			continue
		case <-time.After(20 * time.Millisecond):
		}
		pollCtx, cancel := context.WithTimeout(ctx, 20*time.Millisecond)
		blocked := waitForLockWaiters(pollCtx, s.Pool(), 1) == nil
		cancel()
		if blocked {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("DeleteDocument neither finished nor waited on a lock")
		}
	}

	// The reader now references the deleted chapter: its document FK check
	// must fail cleanly, not deadlock.
	_, insertErr := reader.Exec(ctx, insertPosition, owner.ID, b.ID, "device-bbbb", one.ID, v1.ID)
	_ = reader.Rollback(ctx)
	if !deleteDone {
		select {
		case deleteErr = <-deleted:
		case <-time.After(10 * time.Second):
			t.Fatal("DeleteDocument did not finish after the reader rolled back")
		}
	}
	if deleteErr != nil {
		t.Fatalf("DeleteDocument: %v", deleteErr)
	}
	var pgErr *pgconn.PgError
	if !errors.As(insertErr, &pgErr) || pgErr.Code != "23503" {
		t.Fatalf("position insert on the deleted chapter = %v, want foreign-key violation 23503", insertErr)
	}
	if !deleteDone {
		t.Fatal("DeleteDocument waited on the reader's KEY SHARE lock on the book row")
	}
}
