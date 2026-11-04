package postgres

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"

	"github.com/jackc/pgx/v5/pgtype"

	dbsqlc "github.com/razorpay/slashdocs/api/internal/db/sqlc"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

func (s *Store) GetChapterReads(ctx context.Context, userID string, docIDs []string) (map[string]repo.ChapterRead, error) {
	rows, err := s.q.GetChapterReads(ctx, dbsqlc.GetChapterReadsParams{UserID: userID, DocumentIds: docIDs})
	if err != nil {
		return nil, err
	}
	out := make(map[string]repo.ChapterRead, len(rows))
	for _, r := range rows {
		out[r.DocumentID] = repo.ChapterRead{
			DocumentID:          r.DocumentID,
			SeenVersionID:       r.SeenVersionID,
			LastReadVersionID:   r.LastReadVersionID,
			FurthestProgression: real64(r.FurthestProgression),
			ReachedEnd:          r.ReachedEndAt.Valid,
			Done:                r.DoneAt.Valid,
			LastOpenedAt:        pgTimeRFC3339(r.LastOpenedAt),
		}
	}
	return out, nil
}

func (s *Store) OpenChapter(ctx context.Context, userID, documentID, versionID string) error {
	return s.q.UpsertChapterOpen(ctx, dbsqlc.UpsertChapterOpenParams{
		UserID: userID, DocumentID: documentID, VersionID: pgtype.Text{String: versionID, Valid: versionID != ""},
	})
}

func (s *Store) UpdateChapterProgress(ctx context.Context, userID, documentID string, progression float64, reachedEnd bool) error {
	return s.q.UpdateChapterProgress(ctx, dbsqlc.UpdateChapterProgressParams{
		Progression: float32(clamp01(progression)), ReachedEnd: reachedEnd, UserID: userID, DocumentID: documentID,
	})
}

func (s *Store) SetChapterDone(ctx context.Context, userID, documentID string, done bool) error {
	return s.q.SetChapterDone(ctx, dbsqlc.SetChapterDoneParams{Done: done, UserID: userID, DocumentID: documentID})
}

func (s *Store) MarkChapterSeen(ctx context.Context, userID, documentID, versionID string) error {
	return s.q.MarkChapterSeen(ctx, dbsqlc.MarkChapterSeenParams{
		VersionID: pgtype.Text{String: versionID, Valid: versionID != ""}, UserID: userID, DocumentID: documentID,
	})
}

func (s *Store) SaveReadingPosition(ctx context.Context, userID, bookID string, p repo.ReadingPosition) (bool, error) {
	anchor, err := json.Marshal(p.Anchor)
	if err != nil {
		return false, fmt.Errorf("encode anchor: %w", err)
	}
	n, err := s.q.UpsertReadingPosition(ctx, dbsqlc.UpsertReadingPositionParams{
		UserID:      userID,
		BookID:      bookID,
		DeviceID:    p.DeviceID,
		DocumentID:  p.DocumentID,
		VersionID:   p.VersionID,
		SectionID:   pgText(p.SectionID),
		Anchor:      anchor,
		Progression: float32(clamp01(p.Progression)),
		ClientTs:    pgtype.Timestamptz{Time: p.ClientTS, Valid: true},
	})
	if err != nil {
		return false, err
	}
	return n > 0, nil
}

func (s *Store) ListReadingPositions(ctx context.Context, userID, bookID string) ([]repo.ReadingPosition, error) {
	rows, err := s.q.ListReadingPositions(ctx, dbsqlc.ListReadingPositionsParams{UserID: userID, BookID: bookID})
	if err != nil {
		return nil, err
	}
	out := make([]repo.ReadingPosition, 0, len(rows))
	for _, r := range rows {
		p := repo.ReadingPosition{
			DeviceID:    r.DeviceID,
			DocumentID:  r.DocumentID,
			VersionID:   r.VersionID,
			SectionID:   r.SectionID,
			Progression: real64(r.Progression),
			ClientTS:    r.ClientTs.Time.UTC(),
			UpdatedAt:   pgTimeRFC3339(r.UpdatedAt),
		}
		if err := json.Unmarshal(r.Anchor, &p.Anchor); err != nil {
			return nil, fmt.Errorf("decode anchor of device %s: %w", r.DeviceID, err)
		}
		out = append(out, p)
	}
	return out, nil
}

// clamp01 keeps a progression inside the [0,1] range that the columns check.
func clamp01(f float64) float64 {
	switch {
	case f != f || f < 0: // NaN reads as no progress
		return 0
	case f > 1:
		return 1
	}
	return f
}

// real64 widens a REAL column to the float64 it reads as, so 0.4 stays 0.4
// rather than 0.4000000059604645.
func real64(f float32) float64 {
	v, _ := strconv.ParseFloat(strconv.FormatFloat(float64(f), 'g', -1, 32), 64)
	return v
}
