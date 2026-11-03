package postgres

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/jackc/pgx/v5"

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
			Ord:       int32(sec.Order),
			SectionID: pgText(sec.ID),
			Title:     pgText(sec.Title),
			Level:     int32(sec.Level),
			TextHash:  sec.Hash,
			Words:     int32(sec.Words),
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
	sp, err := tx.Begin(ctx)
	if err != nil {
		return err
	}
	if err := insertSections(ctx, s.q.WithTx(sp), versionID, html); err != nil {
		if rbErr := sp.Rollback(ctx); rbErr != nil {
			return errors.Join(err, rbErr)
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
		slog.WarnContext(ctx, "version sections not indexed at publish",
			slog.String("version_id", versionID), slog.Any("error", err))
		return nil
	}
	return sp.Commit(ctx)
}

// pgText makes heading text safe to store: PostgreSQL text must be valid
// UTF-8 and cannot hold NUL bytes.
func pgText(s string) string {
	return strings.ReplaceAll(strings.ToValidUTF8(s, "\uFFFD"), "\x00", "")
}

// ensureSections indexes the version through q when it is not indexed yet.
// It locks the version row, so that concurrent callers insert its sections
// once. A missing blob indexes as an empty document, like search indexing.
func (s *Store) ensureSections(ctx context.Context, q *dbsqlc.Queries, versionID string) error {
	v, err := q.GetVersionSectionsForUpdate(ctx, versionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("lock version %s: %w", versionID, err)
	}
	if v.SectionsIndexed {
		return nil
	}
	doc, _, err := s.blobs.Get(ctx, v.HtmlBlobKey)
	if err != nil && !errors.Is(err, blob.ErrNotFound) {
		return fmt.Errorf("read version %s: %w", versionID, err)
	}
	return insertSections(ctx, q, versionID, doc)
}

func (s *Store) EnsureVersionSections(ctx context.Context, versionID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	if err := s.ensureSections(ctx, s.q.WithTx(tx), versionID); err != nil {
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
		if err := insertSections(ctx, q, v.ID, doc); err != nil {
			return 0, nil, err
		}
		indexed++
	}
	return indexed, failed, tx.Commit(ctx)
}
