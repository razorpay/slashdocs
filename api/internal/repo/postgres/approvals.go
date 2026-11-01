package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/razorpay/slashdocs/api/internal/auth"
	dbsqlc "github.com/razorpay/slashdocs/api/internal/db/sqlc"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// lockDocument makes the approval writes on a document take turns, and returns
// its current version ID. Every approval write calls it first in its
// transaction, so the status that each change records counts all changes
// before it.
func lockDocument(ctx context.Context, q *dbsqlc.Queries, documentID string) (string, error) {
	currentID, err := q.LockDocumentForApproval(ctx, documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", repo.ErrNotFound
	}
	return currentID.String, err
}

// lockForApproval locks the document against a concurrent version push and
// returns its current version. It refuses principals who created a version:
// they wrote what is under review. Neither check can go stale before the
// write commits.
func lockForApproval(ctx context.Context, q *dbsqlc.Queries, documentID string, approver auth.Principal) (dbsqlc.GetVersionRow, error) {
	currentID, err := lockDocument(ctx, q, documentID)
	if err != nil {
		return dbsqlc.GetVersionRow{}, err
	}
	current, err := q.GetVersion(ctx, currentID)
	if err != nil {
		return current, err
	}
	author, err := q.CreatedVersionOf(ctx, dbsqlc.CreatedVersionOfParams{DocumentID: documentID, PrincipalType: string(approver.Type), PrincipalID: approver.ID})
	if err != nil {
		return current, err
	}
	if author {
		return current, repo.ErrApproverIsAuthor
	}
	return current, nil
}

func (s *Store) CreateApprovalRequest(ctx context.Context, documentID string, approver, requestedBy auth.Principal) (repo.ApprovalRequest, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.ApprovalRequest{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if _, err := lockForApproval(ctx, q, documentID, approver); err != nil {
		return repo.ApprovalRequest{}, err
	}
	id := newID("apr")
	err = q.InsertApprovalRequest(ctx, dbsqlc.InsertApprovalRequestParams{
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
	if err := s.enqueueApprovalNotification(ctx, tx, documentID, approver, requestedBy, repo.ApprovalNotificationRequested); err != nil {
		return repo.ApprovalRequest{}, err
	}
	if err := s.recordApprovalEvent(ctx, q, approvalEvent{documentID: documentID, kind: repo.ApprovalEventRequested, approver: approver, actor: requestedBy}); err != nil {
		return repo.ApprovalRequest{}, err
	}
	if err := tx.Commit(ctx); err != nil {
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

func (s *Store) DeleteApprovalRequest(ctx context.Context, documentID, requestID string, removedBy auth.Principal) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if _, err := lockDocument(ctx, q, documentID); err != nil {
		return err
	}
	approver, err := q.RevokeApprovalRequest(ctx, dbsqlc.RevokeApprovalRequestParams{RequestID: requestID, DocumentID: documentID})
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.ErrNotFound
	}
	if err != nil {
		return err
	}
	removed := auth.Principal{Type: auth.PrincipalType(approver.ApproverType), ID: approver.ApproverID}
	if err := s.dropApproverDecisions(ctx, q, documentID, removed, removedBy); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// dropApproverDecisions revokes the decisions of an approver who was just
// removed, which no longer count toward any content, and records the removal.
func (s *Store) dropApproverDecisions(ctx context.Context, q *dbsqlc.Queries, documentID string, approver, removedBy auth.Principal) error {
	if err := q.RevokeApprovalsForApprover(ctx, dbsqlc.RevokeApprovalsForApproverParams{
		DocumentID:   documentID,
		ApproverType: string(approver.Type),
		ApproverID:   approver.ID,
	}); err != nil {
		return err
	}
	return s.recordApprovalEvent(ctx, q, approvalEvent{documentID: documentID, kind: repo.ApprovalEventRemoved, approver: approver, actor: removedBy})
}

// removeAuthorApprovers removes the approvers who are the same author as the
// creator of a new version (the creator, or the owner of the creator's bot),
// with their decisions: they now wrote part of what is under review. Runs
// inside the CreateVersion transaction.
func (s *Store) removeAuthorApprovers(ctx context.Context, q *dbsqlc.Queries, documentID string, author auth.Principal) error {
	removed, err := q.RevokeAuthorApprovers(ctx, dbsqlc.RevokeAuthorApproversParams{DocumentID: documentID, AuthorType: string(author.Type), AuthorID: author.ID})
	if err != nil {
		return err
	}
	for _, r := range removed {
		approver := auth.Principal{Type: auth.PrincipalType(r.ApproverType), ID: r.ApproverID}
		if err := s.dropApproverDecisions(ctx, q, documentID, approver, author); err != nil {
			return err
		}
	}
	return nil
}

// removeApproversWithoutAccess removes, with their decisions, the approvers of
// the documents at or under a resource who can no longer read their document.
// They could not decide, so the document would wait for them forever. Runs
// inside the transaction that revokes a grant on the resource.
func (s *Store) removeApproversWithoutAccess(ctx context.Context, q *dbsqlc.Queries, resourceID string, revokedBy auth.Principal) error {
	removed, err := q.LockApproversWithoutAccess(ctx, resourceID)
	if err != nil {
		return err
	}
	for _, r := range removed {
		approver := auth.Principal{Type: auth.PrincipalType(r.ApproverType), ID: r.ApproverID}
		if err := q.RevokeApproverRequest(ctx, dbsqlc.RevokeApproverRequestParams(r)); err != nil {
			return err
		}
		if err := s.dropApproverDecisions(ctx, q, r.DocumentID, approver, revokedBy); err != nil {
			return err
		}
	}
	return nil
}

var approvalDecisionEvent = map[string]string{
	repo.DecisionApproved: repo.ApprovalEventApproved,
	repo.DecisionRejected: repo.ApprovalEventRejected,
}

func (s *Store) CreateOrUpdateApproval(ctx context.Context, documentID, versionID, decision, note string, approver auth.Principal) (repo.Approval, bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.Approval{}, false, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	v, err := q.GetVersion(ctx, versionID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && v.DocumentID != documentID) {
		return repo.Approval{}, false, repo.ErrNotFound
	}
	if err != nil {
		return repo.Approval{}, false, err
	}
	current, err := lockForApproval(ctx, q, documentID, approver)
	if err != nil {
		return repo.Approval{}, false, err
	}
	// A decision is about the content the approver read. When the document has
	// other content now, the decision would vouch for replaced text.
	if v.Sha256 != current.Sha256 {
		return repo.Approval{}, false, &repo.VersionConflictError{LatestVersionID: current.ID}
	}
	assigned, err := q.HasActiveApprovalRequest(ctx, dbsqlc.HasActiveApprovalRequestParams{
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
	row, err := q.UpsertApproval(ctx, dbsqlc.UpsertApprovalParams{
		ID:           newID("apv"),
		DocumentID:   documentID,
		VersionID:    versionID,
		Sha256:       v.Sha256,
		ApproverType: string(approver.Type),
		ApproverID:   approver.ID,
		Decision:     decision,
		Note:         note,
	})
	if err != nil {
		return repo.Approval{}, false, err
	}
	if row.Changed {
		if err := s.enqueueApprovalNotification(ctx, tx, documentID, approver, approver, repo.ApprovalNotificationDecided); err != nil {
			return repo.Approval{}, false, err
		}
		if err := s.recordApprovalEvent(ctx, q, approvalEvent{documentID: documentID, kind: approvalDecisionEvent[decision], approver: approver, actor: approver, note: note}); err != nil {
			return repo.Approval{}, false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.Approval{}, false, err
	}
	return repo.Approval{
		ID:            row.ID,
		DocumentID:    documentID,
		VersionID:     versionID,
		VersionNumber: int(v.Number),
		SHA256:        v.Sha256,
		Approver:      approver,
		Decision:      decision,
		Note:          note,
		DecidedAt:     pgTimeRFC3339(row.DecidedAt),
	}, row.Inserted, nil
}

func (s *Store) DeleteApproval(ctx context.Context, documentID, approvalID string, approver auth.Principal) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if _, err := lockDocument(ctx, q, documentID); err != nil {
		return err
	}
	row, err := q.GetApproval(ctx, dbsqlc.GetApprovalParams{ID: approvalID, DocumentID: documentID})
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.ErrNotFound
	}
	if err != nil {
		return err
	}
	if row.ApproverType != string(approver.Type) || row.ApproverID != approver.ID {
		return repo.ErrForbidden
	}
	if err := q.RevokeApproval(ctx, approvalID); err != nil {
		return err
	}
	if err := s.recordApprovalEvent(ctx, q, approvalEvent{documentID: documentID, kind: repo.ApprovalEventRevoked, approver: approver, actor: approver}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) ListApprovals(ctx context.Context, documentID, sha256 string) ([]repo.Approval, error) {
	rows, err := s.q.ListContentApprovals(ctx, dbsqlc.ListContentApprovalsParams{DocumentID: documentID, Sha256: sha256})
	if err != nil {
		return nil, err
	}
	out := make([]repo.Approval, 0, len(rows))
	for _, r := range rows {
		out = append(out, repo.Approval{
			ID:            r.ID,
			DocumentID:    documentID,
			VersionID:     r.VersionID,
			VersionNumber: int(r.VersionNumber),
			SHA256:        r.Sha256,
			Approver:      auth.Principal{Type: auth.PrincipalType(r.ApproverType), ID: r.ApproverID, Email: r.ApproverEmail, Name: r.ApproverName, PictureURL: r.ApproverPictureUrl},
			Decision:      r.Decision,
			Note:          r.Note,
			DecidedAt:     pgTimeRFC3339(r.DecidedAt),
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
		out[r.DocumentID] = approvalSummary(r)
	}
	return out, nil
}

func approvalSummary(r dbsqlc.DocumentApprovalSummariesRow) repo.ApprovalSummary {
	total, approved, rejected := int(r.Total), int(r.Approved), int(r.Rejected)
	return repo.ApprovalSummary{
		Total:    total,
		Approved: approved,
		Rejected: rejected,
		Pending:  total - approved - rejected,
		Status:   repo.DeriveApprovalStatus(total, approved, rejected),
	}
}
