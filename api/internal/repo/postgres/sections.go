package postgres

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"strings"

	"github.com/jackc/pgx/v5"
	"golang.org/x/sync/errgroup"

	"github.com/razorpay/slashdocs/api/internal/blob"
	dbsqlc "github.com/razorpay/slashdocs/api/internal/db/sqlc"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/internal/render"
)

// sectionBatchSize is how many versions IndexVersionSections indexes in one
// transaction.
const sectionBatchSize = 50

// splitSections is render.Sections; tests replace it to reach the parse
// error path, which real HTML input almost never takes.
var splitSections = render.Sections

// clampInt32 narrows n to int32, saturating at the bounds.
func clampInt32(n int) int32 {
	if n > math.MaxInt32 {
		return math.MaxInt32
	}
	if n < math.MinInt32 {
		return math.MinInt32
	}
	return int32(n)
}

// insertSections stores the sections of a version and marks it indexed. A
// version whose HTML cannot be split is marked indexed with no sections, so
// that indexing never blocks a publish and is not retried forever.
func insertSections(ctx context.Context, q *dbsqlc.Queries, versionID string, html []byte) error {
	secs, err := splitSections(html)
	if err != nil {
		slog.WarnContext(ctx, "version sections not indexed",
			slog.String("version_id", versionID), slog.Any("error", err))
		secs = nil
	}
	for _, sec := range secs {
		if err := q.InsertVersionSection(ctx, dbsqlc.InsertVersionSectionParams{
			VersionID: versionID,
			Ord:       clampInt32(sec.Order),
			SectionID: pgText(sec.ID),
			Title:     pgText(sec.Title),
			Level:     clampInt32(sec.Level),
			TextHash:  sec.Hash,
			Words:     clampInt32(sec.Words),
		}); err != nil {
			return fmt.Errorf("insert section %d of version %s: %w", sec.Order, versionID, err)
		}
	}
	if err := q.MarkVersionSectionsIndexed(ctx, versionID); err != nil {
		return fmt.Errorf("mark version %s sections indexed: %w", versionID, err)
	}
	return nil
}

// indexPublishedSections indexes a new version's sections when its document
// is in a book folder (A12); other versions are indexed on demand. It runs in
// a savepoint, so that a failed insert leaves the version unindexed (for
// EnsureVersionSections and the backfill) and never fails the publish.
func (s *Store) indexPublishedSections(ctx context.Context, tx pgx.Tx, documentID, versionID string, html []byte) error {
	inBook, err := s.q.WithTx(tx).DocumentInBook(ctx, documentID)
	if err != nil {
		return fmt.Errorf("find book of document %s: %w", documentID, err)
	}
	if !inBook {
		return nil
	}
	_, err = s.trySections(ctx, tx, versionID, html)
	return err
}

// trySections inserts a version's sections in a savepoint of tx. When the
// insert fails it rolls back to the savepoint, logs, and returns ok=false
// with a nil error, so that the rest of tx goes on and the version stays
// unindexed for EnsureVersionSections and the backfill. err is set only
// when the savepoint itself fails or ctx is done.
func (s *Store) trySections(ctx context.Context, tx pgx.Tx, versionID string, html []byte) (ok bool, err error) {
	sp, err := tx.Begin(ctx)
	if err != nil {
		return false, err
	}
	if err := insertSections(ctx, s.q.WithTx(sp), versionID, html); err != nil {
		if rbErr := sp.Rollback(ctx); rbErr != nil {
			return false, errors.Join(err, rbErr)
		}
		if ctx.Err() != nil {
			return false, ctx.Err()
		}
		slog.WarnContext(ctx, "version sections not indexed",
			slog.String("version_id", versionID), slog.Any("error", err))
		return false, nil
	}
	return true, sp.Commit(ctx)
}

// maxIndexAfterCommit bounds the versions indexAfterCommit indexes at once.
const maxIndexAfterCommit = 8

// indexLimitFor is how many versions indexAfterCommit indexes at once on a
// pool of maxConns connections: a quarter of the pool, at least one and at
// most maxIndexAfterCommit, so that a large book leaves connections for every
// other request on the server.
func indexLimitFor(maxConns int32) int {
	return max(1, min(maxIndexAfterCommit, int(maxConns)/4))
}

func (s *Store) indexAfterCommitLimit() int { return indexLimitFor(s.db.Config().MaxConns) }

// indexAfterCommit indexes versions best-effort once the caller's
// transaction has committed, outside the folder-tree lock, so that a blob
// read never runs under that lock and a failure never fails the caller. It
// indexes a few versions at once (indexAfterCommitLimit), so a large book
// does not pay one blob read per chapter in series. A version that fails
// stays unindexed for EnsureVersionSections and the backfill; one deleted
// meanwhile is skipped.
func (s *Store) indexAfterCommit(ctx context.Context, versionIDs ...string) {
	var g errgroup.Group
	g.SetLimit(s.indexAfterCommitLimit())
	for _, id := range versionIDs {
		if ctx.Err() != nil {
			break
		}
		g.Go(func() error {
			if err := s.EnsureVersionSections(ctx, id); err != nil && !errors.Is(err, repo.ErrNotFound) && ctx.Err() == nil {
				slog.WarnContext(ctx, "version sections not indexed",
					slog.String("version_id", id), slog.Any("error", err))
			}
			return nil
		})
	}
	_ = g.Wait() // every task returns nil; failures are logged above
}

// pgText makes heading text safe to store: PostgreSQL text must be valid
// UTF-8 and cannot hold NUL bytes.
func pgText(s string) string {
	return strings.ReplaceAll(strings.ToValidUTF8(s, "\uFFFD"), "\x00", "")
}

// EnsureVersionSections indexes the version's sections when it is not
// indexed yet. It reads the blob before it opens a transaction, so that a
// slow blob read holds neither a pooled connection nor the version row lock
// (which DeleteDocument and other indexers wait on). It then locks the row,
// re-checks, and inserts, so that concurrent callers insert the sections
// once. A missing blob indexes as an empty document, like search indexing.
func (s *Store) EnsureVersionSections(ctx context.Context, versionID string) error {
	// Outside a transaction the row lock lasts only for this statement.
	v, err := s.q.GetVersionSectionsForUpdate(ctx, versionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("read version %s: %w", versionID, err)
	}
	if v.SectionsIndexed {
		return nil
	}
	doc, _, err := s.blobs.Get(ctx, v.HtmlBlobKey)
	if err != nil && !errors.Is(err, blob.ErrNotFound) {
		return fmt.Errorf("read version %s: %w", versionID, err)
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	locked, err := q.GetVersionSectionsForUpdate(ctx, versionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lock version %s: %w", versionID, err)
	}
	if locked.SectionsIndexed {
		return nil // another caller indexed it meanwhile
	}
	if err := insertSections(ctx, q, versionID, doc); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) ListVersionSections(ctx context.Context, versionID string) ([]repo.SectionInfo, error) {
	rows, err := s.q.ListVersionSections(ctx, versionID)
	if err != nil {
		return nil, err
	}
	out := make([]repo.SectionInfo, 0, len(rows))
	for _, r := range rows {
		out = append(out, repo.SectionInfo{ID: r.SectionID, Title: r.Title, Hash: r.TextHash, Level: int(r.Level), Order: int(r.Ord), Words: int(r.Words)})
	}
	return out, nil
}

func (s *Store) UnindexedVersions(ctx context.Context, versionIDs []string) ([]string, error) {
	ids, err := s.q.UnindexedVersions(ctx, versionIDs)
	if err != nil {
		return nil, err
	}
	if ids == nil {
		ids = []string{}
	}
	return ids, nil
}

func (s *Store) VersionWords(ctx context.Context, versionIDs []string) (map[string]int, error) {
	rows, err := s.q.VersionWords(ctx, versionIDs)
	if err != nil {
		return nil, err
	}
	out := make(map[string]int, len(rows))
	for _, r := range rows {
		out[r.VersionID] = int(r.Words)
	}
	return out, nil
}

func (s *Store) ListVersionsAfter(ctx context.Context, documentID, afterVersionID string) ([]repo.VersionNote, error) {
	rows, err := s.q.ListVersionsAfter(ctx, dbsqlc.ListVersionsAfterParams{DocumentID: documentID, AfterVersionID: afterVersionID})
	if err != nil {
		return nil, err
	}
	out := make([]repo.VersionNote, 0, len(rows))
	for _, r := range rows {
		out = append(out, repo.VersionNote{ID: r.ID, Number: int(r.Number), ChangeSummary: r.ChangeSummary, CreatedAt: pgTimeRFC3339(r.CreatedAt)})
	}
	return out, nil
}

// IndexVersionSections gives sections to versions of documents in book
// folders that were published before Book mode or before their folder became
// a book. Each batch locks its versions, so all servers can run it at the
// same time. A version whose blob cannot be read is skipped until the next
// run. It returns the number of versions that it indexed.
func (s *Store) IndexVersionSections(ctx context.Context) (indexed int, err error) {
	var skipped []string
	for {
		n, failed, err := s.indexSectionBatch(ctx, skipped)
		indexed += n
		skipped = append(skipped, failed...)
		if err != nil || n+len(failed) == 0 {
			return indexed, err
		}
	}
}

func (s *Store) indexSectionBatch(ctx context.Context, skipped []string) (indexed int, failed []string, err error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return 0, nil, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	versions, err := q.ListUnsectionedVersions(ctx, dbsqlc.ListUnsectionedVersionsParams{Skipped: skipped, RowLimit: sectionBatchSize})
	if err != nil {
		return 0, nil, err
	}
	for _, v := range versions {
		doc, _, err := s.blobs.Get(ctx, v.HtmlBlobKey)
		// A missing blob gets no sections, so that it is not read again.
		if err != nil && !errors.Is(err, blob.ErrNotFound) {
			if ctx.Err() != nil {
				return 0, nil, ctx.Err()
			}
			slog.WarnContext(ctx, "version sections not indexed",
				slog.String("version_id", v.ID), slog.Any("error", err))
			failed = append(failed, v.ID)
			continue
		}
		ok, err := s.trySections(ctx, tx, v.ID, doc)
		if err != nil {
			return 0, nil, err
		}
		if !ok {
			failed = append(failed, v.ID)
			continue
		}
		indexed++
	}
	return indexed, failed, tx.Commit(ctx)
}
