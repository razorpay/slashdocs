package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/razorpay/slashdocs/api/internal/auth"
	dbsqlc "github.com/razorpay/slashdocs/api/internal/db/sqlc"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

func (s *Store) CreateApprovalRequest(ctx context.Context, documentID string, approver, requestedBy auth.Principal) (repo.ApprovalRequest, error) {
	id := newID("apr")
	err := s.q.InsertApprovalRequest(ctx, dbsqlc.InsertApprovalRequestParams{
		ID:              id,
		DocumentID:      documentID,
		ApproverType:    string(approver.Type),
		ApproverID:      approver.ID,
		RequestedByType: string(requestedBy.Type),
		RequestedByID:   requestedBy.ID,
	})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return repo.ApprovalRequest{}, repo.ErrConflict
		}
		return repo.ApprovalRequest{}, err
	}
	return repo.ApprovalRequest{ID: id, DocumentID: documentID, Approver: approver, RequestedBy: requestedBy}, nil
}

func (s *Store) ListApprovalRequests(ctx context.Context, documentID string) ([]repo.ApprovalRequest, error) {
	rows, err := s.q.ListApprovalRequests(ctx, documentID)
	if err != nil {
		return nil, err
	}
	out := make([]repo.ApprovalRequest, 0, len(rows))
	for _, r := range rows {
		out = append(out, repo.ApprovalRequest{
			ID:          r.ID,
			DocumentID:  r.DocumentID,
			Approver:    auth.Principal{Type: auth.PrincipalType(r.ApproverType), ID: r.ApproverID, Email: r.ApproverEmail, Name: r.ApproverName, PictureURL: r.ApproverPictureUrl},
			RequestedBy: auth.Principal{Type: auth.PrincipalType(r.RequestedByType), ID: r.RequestedByID, Email: r.RequestedByEmail, Name: r.RequestedByName},
		})
	}
	return out, nil
}

func (s *Store) DeleteApprovalRequest(ctx context.Context, documentID, requestID string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	approver, err := q.RevokeApprovalRequest(ctx, dbsqlc.RevokeApprovalRequestParams{RequestID: requestID, DocumentID: documentID})
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.ErrNotFound
	}
	if err != nil {
		return err
	}
	// A removed approver's decisions no longer count toward any version.
	if err := q.RevokeApprovalsForApprover(ctx, dbsqlc.RevokeApprovalsForApproverParams{
		DocumentID:   documentID,
		ApproverType: approver.ApproverType,
		ApproverID:   approver.ApproverID,
	}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) CreateOrUpdateApproval(ctx context.Context, documentID, versionID, decision, note string, approver auth.Principal) (repo.Approval, bool, error) {
	v, err := s.q.GetVersion(ctx, versionID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && v.DocumentID != documentID) {
		return repo.Approval{}, false, repo.ErrNotFound
	}
	if err != nil {
		return repo.Approval{}, false, err
	}
	assigned, err := s.q.HasActiveApprovalRequest(ctx, dbsqlc.HasActiveApprovalRequestParams{
		DocumentID:   documentID,
		ApproverType: string(approver.Type),
		ApproverID:   approver.ID,
	})
	if err != nil {
		return repo.Approval{}, false, err
	}
	if !assigned {
		return repo.Approval{}, false, repo.ErrForbidden
	}
	row, err := s.q.UpsertApproval(ctx, dbsqlc.UpsertApprovalParams{
		ID:           newID("apv"),
		DocumentID:   documentID,
		VersionID:    versionID,
		ApproverType: string(approver.Type),
		ApproverID:   approver.ID,
		Decision:     decision,
		Note:         note,
	})
	if err != nil {
		return repo.Approval{}, false, err
	}
	return repo.Approval{
		ID:         row.ID,
		DocumentID: documentID,
		VersionID:  versionID,
		Approver:   approver,
		Decision:   decision,
		Note:       note,
		DecidedAt:  pgTimeRFC3339(row.DecidedAt),
	}, row.Inserted, nil
}

func (s *Store) DeleteApproval(ctx context.Context, documentID, approvalID string, approver auth.Principal) error {
	row, err := s.q.GetApproval(ctx, dbsqlc.GetApprovalParams{ID: approvalID, DocumentID: documentID})
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.ErrNotFound
	}
	if err != nil {
		return err
	}
	if row.ApproverType != string(approver.Type) || row.ApproverID != approver.ID {
		return repo.ErrForbidden
	}
	revoked, err := s.q.RevokeApproval(ctx, approvalID)
	if err != nil {
		return err
	}
	if revoked == 0 {
		return repo.ErrNotFound
	}
	return nil
}

func (s *Store) ListApprovals(ctx context.Context, documentID, versionID string) ([]repo.Approval, error) {
	rows, err := s.q.ListVersionApprovals(ctx, dbsqlc.ListVersionApprovalsParams{DocumentID: documentID, VersionID: versionID})
	if err != nil {
		return nil, err
	}
	out := make([]repo.Approval, 0, len(rows))
	for _, r := range rows {
		out = append(out, repo.Approval{
			ID:                   r.ID,
			DocumentID:           documentID,
			VersionID:            r.VersionID,
			Approver:             auth.Principal{Type: auth.PrincipalType(r.ApproverType), ID: r.ApproverID, Email: r.ApproverEmail, Name: r.ApproverName, PictureURL: r.ApproverPictureUrl},
			Decision:             r.Decision,
			Note:                 r.Note,
			DecidedAt:            pgTimeRFC3339(r.DecidedAt),
			CarriedFromVersionID: r.CarriedFromVersionID,
		})
	}
	return out, nil
}

func (s *Store) DocumentApprovalSummaries(ctx context.Context, documentIDs []string) (map[string]repo.ApprovalSummary, error) {
	if len(documentIDs) == 0 {
		return map[string]repo.ApprovalSummary{}, nil
	}
	rows, err := s.q.DocumentApprovalSummaries(ctx, documentIDs)
	if err != nil {
		return nil, err
	}
	out := make(map[string]repo.ApprovalSummary, len(rows))
	for _, r := range rows {
		total, approved, changes := int(r.Total), int(r.Approved), int(r.ChangesRequested)
		out[r.DocumentID] = repo.ApprovalSummary{
			Total:            total,
			Approved:         approved,
			ChangesRequested: changes,
			Pending:          total - approved - changes,
			Status:           repo.DeriveApprovalStatus(total, approved, changes),
		}
	}
	return out, nil
}

// carryForwardApprovals copies active approved decisions from the base
// version onto a freshly inserted version, preserving the original decision
// time and the version that received the explicit decision. Runs inside the
// CreateVersion transaction. Returns the number of copied rows.
func carryForwardApprovals(ctx context.Context, q *dbsqlc.Queries, documentID, baseVersionID, newVersionID string) (int, error) {
	rows, err := q.ListCarryForwardApprovals(ctx, dbsqlc.ListCarryForwardApprovalsParams{DocumentID: documentID, VersionID: baseVersionID})
	if err != nil {
		return 0, err
	}
	for _, r := range rows {
		if err := q.InsertCarriedApproval(ctx, dbsqlc.InsertCarriedApprovalParams{
			ID:                   newID("apv"),
			DocumentID:           documentID,
			VersionID:            newVersionID,
			ApproverType:         r.ApproverType,
			ApproverID:           r.ApproverID,
			Note:                 r.Note,
			DecidedAt:            r.DecidedAt,
			CarriedFromVersionID: pgtype.Text{String: r.OriginVersionID, Valid: r.OriginVersionID != ""},
		}); err != nil {
			return 0, err
		}
	}
	return len(rows), nil
}
