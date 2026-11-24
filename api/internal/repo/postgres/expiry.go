package postgres

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	dbsqlc "github.com/razorpay/slashdocs/api/internal/db/sqlc"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// expiryParam is an expiry time as a query takes it. The zero time is null:
// the document has no expiry. PostgreSQL keeps microseconds, so the time is
// cut to them, and a read gives the time that the write returned.
func expiryParam(at time.Time) pgtype.Timestamptz {
	return pgtype.Timestamptz{Time: at.UTC().Truncate(time.Microsecond), Valid: !at.IsZero()}
}

func (s *Store) ChangeDocument(ctx context.Context, id string, change repo.DocumentChange) (repo.Document, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.Document{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if change.Title != nil {
		if err := q.UpdateDocumentTitle(ctx, dbsqlc.UpdateDocumentTitleParams{Title: *change.Title, ID: id}); err != nil {
			return repo.Document{}, err
		}
	}
	switch {
	case change.ExpiresAt == nil:
	case change.OnlyLater:
		moved, err := q.MoveDocumentExpiryLater(ctx, dbsqlc.MoveDocumentExpiryLaterParams{ExpiresAt: expiryParam(*change.ExpiresAt), ID: id, MaxChanges: repo.MaxExpiryEditorChanges})
		if err != nil {
			return repo.Document{}, err
		}
		if moved == 0 {
			// The rollback takes back a new title.
			r, err := q.GetDocument(ctx, id)
			if errors.Is(err, pgx.ErrNoRows) {
				return repo.Document{}, repo.ErrNotFound
			}
			if err != nil {
				return repo.Document{}, err
			}
			if r.ExpiresAt.Valid && r.ExpiryEditorChanges >= repo.MaxExpiryEditorChanges {
				return repo.Document{}, repo.ErrExpiryChangesUsed
			}
			return repo.Document{}, repo.ErrExpiryNotLater
		}
	default:
		if err := q.SetDocumentExpiry(ctx, dbsqlc.SetDocumentExpiryParams{ExpiresAt: expiryParam(*change.ExpiresAt), ID: id}); err != nil {
			return repo.Document{}, err
		}
	}
	r, err := q.GetDocument(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.Document{}, repo.ErrNotFound
	}
	if err != nil {
		return repo.Document{}, err
	}
	return docFromGet(r), tx.Commit(ctx)
}

// deleteDocument deletes a document in the transaction of q, which holds
// the row of the document. It first puts the document in the list of blob
// deletions: the delete removes the versions, and with them the names of
// the blobs. A write that had the row before made its blobs already, and a
// write after it finds no document and deletes its own.
func deleteDocument(ctx context.Context, q *dbsqlc.Queries, id string) error {
	if err := q.QueueBlobDeletion(ctx, id); err != nil {
		return err
	}
	deleted, err := q.DeleteDocument(ctx, id)
	if err != nil {
		return err
	}
	if deleted > 0 {
		// The event rows cascade with the document, so the notification tells
		// brokers to fetch, observe ErrNotFound, and close active subscribers.
		return q.NotifyDocumentKVEvent(ctx, id)
	}
	return nil
}

func (s *Store) DeleteDocument(ctx context.Context, id string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if _, err := q.LockDocumentForDelete(ctx, id); errors.Is(err, pgx.ErrNoRows) {
		return nil
	} else if err != nil {
		return err
	}
	if err := deleteDocument(ctx, q, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// ExpiredDocument is a document that the sweep deleted. The row is gone, so
// it holds what the log of the sweep tells: whose document it was, and when
// it expired.
type ExpiredDocument struct {
	ID        string
	OwnerType string
	OwnerID   string
	ExpiresAt time.Time
}

var errNoneExpired = errors.New("no document is expired")

// DeleteExpiredDocuments deletes the documents whose expiry time passed, the
// oldest first, until it deleted limit of them or looked at limit of them.
// Each one has a transaction of its own. Every server calls it: a document
// that another server deletes, or that a write holds, is passed over, and a
// later call takes it. A delete that fails is in the error, and the call
// goes on with the next document.
func (s *Store) DeleteExpiredDocuments(ctx context.Context, limit int) ([]ExpiredDocument, error) {
	var (
		deleted  []ExpiredDocument
		skipped  []string
		failures []error
	)
	for len(deleted)+len(skipped) < limit {
		doc, err := s.deleteExpiredDocument(ctx, skipped)
		switch {
		case errors.Is(err, errNoneExpired):
			return deleted, errors.Join(failures...)
		case err != nil && doc.ID == "":
			// The server found no document to try. The next call does this
			// again, so the round ends here.
			return deleted, errors.Join(append(failures, err)...)
		case err != nil:
			skipped = append(skipped, doc.ID)
			failures = append(failures, fmt.Errorf("delete the expired document %s: %w", doc.ID, err))
		default:
			deleted = append(deleted, doc)
		}
	}
	return deleted, errors.Join(failures...)
}

// deleteExpiredDocument deletes one expired document that is not in
// skipped. It returns the document with the error when its delete fails, and
// errNoneExpired when there is none.
func (s *Store) deleteExpiredDocument(ctx context.Context, skipped []string) (ExpiredDocument, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return ExpiredDocument{}, fmt.Errorf("find an expired document: %w", err)
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	row, err := q.LockExpiredDocument(ctx, skipped)
	if errors.Is(err, pgx.ErrNoRows) {
		return ExpiredDocument{}, errNoneExpired
	}
	if err != nil {
		return ExpiredDocument{}, fmt.Errorf("find an expired document: %w", err)
	}
	doc := ExpiredDocument{ID: row.ID, OwnerType: row.OwnerType, OwnerID: row.OwnerID, ExpiresAt: row.ExpiresAt.Time}
	if err := deleteDocument(ctx, q, doc.ID); err != nil {
		return doc, err
	}
	return doc, tx.Commit(ctx)
}

const (
	// blobLease is how long a server has the blobs of a document. It is more
	// than the deletes of a document with many versions take.
	blobLease = 15 * time.Minute
	// blobCallTimeout is the most that the delete of one blob takes.
	blobCallTimeout = 30 * time.Second
	// blobListTimeout is the most that the list of the blobs of a document
	// takes. A document with many versions has many pages.
	blobListTimeout = 2 * time.Minute
	// blobRetryMax is the longest wait between two attempts on a document.
	blobRetryMax = 6 * time.Hour
	// blobFailuresInARow ends a purge: the blob store is probably down, and
	// each more document would wait for its timeout.
	blobFailuresInARow = 3
)

// BlobPurge tells what a call of PurgeDeletedBlobs did.
type BlobPurge struct {
	// Purged is the number of documents whose blobs are gone.
	Purged int
	// Failed is the number of documents that have a blob that the store did
	// not delete. They stay in the list for a later call.
	Failed int
	// Err is the first of those failures.
	Err error
}

// PurgeDeletedBlobs removes the blobs of up to limit deleted documents from
// the blob store. It takes a document when it was deleted more than
// retention ago. All blobs of a document have a key that starts with its
// prefix, so the purge also finds the blobs that no version named.
//
// It holds no transaction and no connection while it waits for the blob
// store. A document that fails waits longer after each attempt. A server
// that stops in the middle loses nothing: its lease on the document ends,
// and another call takes it.
func (s *Store) PurgeDeletedBlobs(ctx context.Context, retention time.Duration, limit int) (BlobPurge, error) {
	var purge BlobPurge
	for inARow := 0; purge.Purged+purge.Failed < limit && inARow < blobFailuresInARow; {
		claim, err := s.q.ClaimBlobDeletion(ctx, dbsqlc.ClaimBlobDeletionParams{LeaseSeconds: blobLease.Seconds(), RetentionSeconds: retention.Seconds()})
		if errors.Is(err, pgx.ErrNoRows) {
			return purge, nil
		}
		if err != nil {
			return purge, fmt.Errorf("take a deleted document from the list of blob deletions: %w", err)
		}
		removed, err := s.removeBlobs(ctx, claim.DocumentID)
		// A server that stops is no failure of the blob store. The document
		// keeps its lease, and a later call takes it.
		if err != nil && ctx.Err() != nil {
			return purge, ctx.Err()
		}
		if err != nil {
			inARow++
			purge.Failed++
			if purge.Err == nil {
				purge.Err = fmt.Errorf("remove the blobs of the deleted document %s: %w", claim.DocumentID, err)
			}
			retry := dbsqlc.RetryBlobDeletionParams{RetrySeconds: blobRetryAfter(claim.Attempts).Seconds(), DocumentID: claim.DocumentID, Attempts: claim.Attempts}
			if err := s.q.RetryBlobDeletion(ctx, retry); err != nil {
				return purge, fmt.Errorf("put off the blob deletion of the document %s: %w", claim.DocumentID, err)
			}
			continue
		}
		inARow = 0
		if err := s.q.FinishBlobDeletion(ctx, dbsqlc.FinishBlobDeletionParams(claim)); err != nil {
			return purge, fmt.Errorf("take the document %s out of the list of blob deletions: %w", claim.DocumentID, err)
		}
		if removed {
			purge.Purged++
		}
	}
	return purge, nil
}

// removeBlobs deletes the blobs of a deleted document. It reports false, and
// deletes nothing, when a document has the ID.
func (s *Store) removeBlobs(ctx context.Context, documentID string) (bool, error) {
	// A delete puts a document in the list, and an ID is not used again, so
	// no document has the ID. The blobs of a document that is there must
	// stay, whatever put it in the list.
	living, err := s.q.DocumentExists(ctx, documentID)
	if err != nil {
		return false, fmt.Errorf("look for the document: %w", err)
	}
	if living {
		slog.ErrorContext(ctx, "a document that exists was in the list of blob deletions; its blobs stay", slog.String("document_id", documentID))
		return false, nil
	}
	prefix := documentBlobPrefix(documentID)
	var keys []string
	err = blobCall(ctx, blobListTimeout, func(ctx context.Context) (err error) {
		keys, err = s.blobs.List(ctx, prefix)
		return err
	})
	if err != nil {
		return false, err
	}
	for _, key := range keys {
		// The store lists the keys of the prefix. The purge deletes blobs
		// for good, so it does not trust the store with that.
		if !strings.HasPrefix(key, prefix) {
			slog.ErrorContext(ctx, "the blob store listed a key that is not under the prefix; the blob stays", slog.String("prefix", prefix), slog.String("key", key))
			continue
		}
		if err := blobCall(ctx, blobCallTimeout, func(ctx context.Context) error { return s.blobs.Delete(ctx, key) }); err != nil {
			return false, err
		}
	}
	return true, nil
}

// blobCall gives one call to the blob store a timeout.
func blobCall(ctx context.Context, timeout time.Duration, call func(context.Context) error) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	return call(ctx)
}

// blobRetryAfter is the wait after an attempt that failed: 2 minutes after
// the first, and twice as long after each more, up to blobRetryMax. attempts
// comes from the database, so a value that cannot be is taken as none.
func blobRetryAfter(attempts int32) time.Duration {
	return min(blobRetryMax, time.Minute<<min(max(attempts, 0), 10))
}

// BlobBacklog is the list of blob deletions: how many documents wait, and
// for how long the oldest one waits.
type BlobBacklog struct {
	Documents int
	Oldest    time.Duration
}

func (s *Store) BlobDeletionBacklog(ctx context.Context) (BlobBacklog, error) {
	row, err := s.q.BlobDeletionBacklog(ctx)
	if err != nil {
		return BlobBacklog{}, err
	}
	return BlobBacklog{Documents: int(row.Documents), Oldest: time.Duration(row.OldestSeconds * float64(time.Second))}, nil
}
