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

// CreateApprovalRequest seals no version: a request is for no content. The
// decision seals the open version when it is made.
func (s *Store) CreateApprovalRequest(ctx context.Context, documentID string, approver, requestedBy auth.Principal) (repo.ApprovalRequest, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.ApprovalRequest{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if _, err := lock(ctx, q, documentID); err != nil {
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
	if _, err := lock(ctx, q, documentID); err != nil {
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

func (s *Store) CreateOrUpdateApproval(ctx context.Context, documentID, versionID string, seq *int64, decision, note string, approver auth.Principal) (repo.Approval, bool, error) {
	// A person who is not an approver does not start the seal, which writes
	// a blob. The check is again under the lock.
	if err := assigned(ctx, s.q, documentID, approver); err != nil {
		return repo.Approval{}, false, err
	}
	// An approval is for a sealed version: its content cannot change before
	// the write commits, or after it. The seal is made before the lock.
	var ready sealing
	reached := false
	defer func() {
		if !reached {
			s.abandon(ctx, ready)
		}
	}()
	tx, doc, err := s.lockAfter(ctx, documentID, func(q *dbsqlc.Queries, doc live, state liveState) (err error) {
		s.abandon(ctx, ready)
		ready, err = s.sealOf(ctx, q, doc, state)
		return err
	})
	if err != nil {
		return repo.Approval{}, false, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	sitting := doc.version.ID
	if err := othersType(ctx, q, doc, approver); err != nil {
		return repo.Approval{}, false, err
	}
	// seq, when set, is the seq that the page of the approver shows. On
	// another seq, the approver did not see the document.
	if seq != nil && *seq != doc.seq {
		return repo.Approval{}, false, &repo.VersionConflictError{LatestVersionID: doc.version.ID, Seq: doc.seq}
	}
	if err := s.seal(ctx, q, &doc, &ready, approver); err != nil {
		return repo.Approval{}, false, err
	}
	// A sitting that changed nothing is no version, and the seal removed it.
	// The decision is then for the version before, which has the same text.
	if versionID == sitting {
		versionID = doc.version.ID
	}
	v, err := decidedVersion(ctx, q, doc, versionID)
	if err != nil {
		return repo.Approval{}, false, err
	}
	if err := assigned(ctx, q, documentID, approver); err != nil {
		return repo.Approval{}, false, err
	}
	row, err := s.decide(ctx, tx, dbsqlc.UpsertApprovalParams{
		ID:           newID("apv"),
		DocumentID:   documentID,
		VersionID:    versionID,
		Sha256:       v.Sha256,
		ApproverType: string(approver.Type),
		ApproverID:   approver.ID,
		Decision:     decision,
		Note:         note,
	}, approver)
	if err != nil {
		return repo.Approval{}, false, err
	}
	if reached, err = commitSeals(ctx, tx); err != nil {
		return repo.Approval{}, false, err
	}
	s.forget(ctx, ready)
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

// decide stores the decision d of approver. When it changed the decision
// before, it also stores its notification and its approval event.
func (s *Store) decide(ctx context.Context, tx pgx.Tx, d dbsqlc.UpsertApprovalParams, approver auth.Principal) (dbsqlc.UpsertApprovalRow, error) {
	q := s.q.WithTx(tx)
	row, err := q.UpsertApproval(ctx, d)
	if err != nil || !row.Changed {
		return row, err
	}
	if err := s.enqueueApprovalNotification(ctx, tx, d.DocumentID, approver, approver, repo.ApprovalNotificationDecided); err != nil {
		return row, err
	}
	return row, s.recordApprovalEvent(ctx, q, approvalEvent{documentID: d.DocumentID, kind: approvalDecisionEvent[d.Decision], approver: approver, actor: approver, note: d.Note})
}

// othersType returns ErrEditing when another person than approver types in
// the open version of doc. A decision while another person types is for
// text that their next key changes: that key opens a new version, with no
// approvals. A caller that names no seq, such as the CLI, decides on the
// live document.
func othersType(ctx context.Context, q *dbsqlc.Queries, doc live, approver auth.Principal) error {
	if !doc.version.Open {
		return nil
	}
	typing, err := q.HasRecentOperationOfAnother(ctx, dbsqlc.HasRecentOperationOfAnotherParams{DocumentID: doc.id, Seconds: typingQuiet.Seconds(), AuthorType: string(approver.Type), AuthorID: approver.ID})
	if err == nil && typing {
		return repo.ErrEditing
	}
	return err
}

// decidedVersion returns the version versionID of doc, on which an approver
// decides. Its content must be the content of the current version.
func decidedVersion(ctx context.Context, q *dbsqlc.Queries, doc live, versionID string) (dbsqlc.GetVersionRow, error) {
	v, err := q.GetVersion(ctx, versionID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && v.DocumentID != doc.id) {
		return v, repo.ErrNotFound
	}
	if err != nil {
		return v, err
	}
	current, err := q.GetVersion(ctx, doc.version.ID)
	if err != nil {
		return v, err
	}
	// A decision is about the content the approver read. When the document has
	// other content now, the decision would vouch for replaced text.
	if v.Sha256 != current.Sha256 {
		return v, &repo.VersionConflictError{LatestVersionID: current.ID, Seq: doc.seq}
	}
	return v, nil
}

// assigned returns ErrForbidden when approver has no active request to
// decide on the document.
func assigned(ctx context.Context, q *dbsqlc.Queries, documentID string, approver auth.Principal) error {
	active, err := q.HasActiveApprovalRequest(ctx, dbsqlc.HasActiveApprovalRequestParams{
		DocumentID:   documentID,
		ApproverType: string(approver.Type),
		ApproverID:   approver.ID,
	})
	if err == nil && !active {
		return repo.ErrForbidden
	}
	return err
}

func (s *Store) DeleteApproval(ctx context.Context, documentID, approvalID string, approver auth.Principal) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if _, err := lock(ctx, q, documentID); err != nil {
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

func (s *Store) ListLatestApprovals(ctx context.Context, documentID string) ([]repo.Approval, error) {
	rows, err := s.q.ListLatestApprovals(ctx, documentID)
	if err != nil {
		return nil, err
	}
	out := make([]repo.Approval, 0, len(rows))
	for _, r := range rows {
		out = append(out, repo.Approval{
			DocumentID: documentID,
			SHA256:     r.Sha256,
			Approver:   auth.Principal{Type: auth.PrincipalType(r.ApproverType), ID: r.ApproverID},
			Decision:   r.Decision,
			DecidedAt:  pgTimeRFC3339(r.DecidedAt),
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
