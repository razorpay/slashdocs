package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/razorpay/slashdocs/api/internal/auth"
	dbsqlc "github.com/razorpay/slashdocs/api/internal/db/sqlc"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// EnableApprovalEvents makes approval changes queue webhook events whose
// document links point at appOrigin. Without it, nothing is queued.
func (s *Store) EnableApprovalEvents(appOrigin string) {
	s.approvalEventOrigin = strings.TrimRight(appOrigin, "/")
}

// approvalEvent is one change to a document's approvals. Approver is empty for
// a new version.
type approvalEvent struct {
	documentID string
	kind       string
	approver   auth.Principal
	actor      auth.Principal
	note       string
}

// recordApprovalEvent queues the webhook event for a change, in the
// transaction of the change, with the approval status after it. A new version
// of a document without approvers changes nothing that a receiver tracks.
func (s *Store) recordApprovalEvent(ctx context.Context, q *dbsqlc.Queries, e approvalEvent) error {
	if s.approvalEventOrigin == "" {
		return nil
	}
	rows, err := q.DocumentApprovalSummaries(ctx, []string{e.documentID})
	if err != nil {
		return err
	}
	var summary repo.ApprovalSummary
	if len(rows) == 1 {
		summary = approvalSummary(rows[0])
	}
	if e.kind == repo.ApprovalEventVersionCreated && summary.Total == 0 {
		return nil
	}
	summaryJSON, err := json.Marshal(summary)
	if err != nil {
		return err
	}
	return q.InsertApprovalEvent(ctx, dbsqlc.InsertApprovalEventParams{
		ID:           newID("evt"),
		EventType:    e.kind,
		DocumentID:   e.documentID,
		DocumentUrl:  s.approvalEventOrigin + "/app/d/" + url.PathEscape(e.documentID),
		ApproverType: string(e.approver.Type),
		ApproverID:   e.approver.ID,
		ActorType:    string(e.actor.Type),
		ActorID:      e.actor.ID,
		Note:         e.note,
		Status:       summary.Status,
		Summary:      summaryJSON,
	})
}

// ClaimApprovalEvent leases the next due event. The lease outlives the
// sender's deadline, so another process recovers the work after a crash.
func (s *Store) ClaimApprovalEvent(ctx context.Context) (*repo.ApprovalEvent, error) {
	var e repo.ApprovalEvent
	err := s.db.QueryRow(ctx, `UPDATE approval_event_outbox o SET available_at=now()+interval '1 minute',attempts=o.attempts+1
		FROM (SELECT id FROM approval_event_outbox WHERE available_at<=now()
			ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1) pending
		WHERE o.id=pending.id
		RETURNING o.id,o.payload,o.attempts`).Scan(&e.ID, &e.Payload, &e.Attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &e, err
}

// FinishApprovalEvent deletes a delivered event, or schedules the next attempt.
// The attempts match keeps it from touching a newer claim of the same event.
func (s *Store) FinishApprovalEvent(ctx context.Context, e repo.ApprovalEvent, retryAfter time.Duration) error {
	if retryAfter <= 0 {
		_, err := s.db.Exec(ctx, `DELETE FROM approval_event_outbox WHERE id=$1 AND attempts=$2`, e.ID, e.Attempts)
		return err
	}
	_, err := s.db.Exec(ctx, `UPDATE approval_event_outbox SET available_at=now()+$3*interval '1 second' WHERE id=$1 AND attempts=$2`,
		e.ID, e.Attempts, retryAfter.Seconds())
	return err
}

// ExpireApprovalEvents deletes events still undelivered after maxAge and
// returns how many it deleted.
func (s *Store) ExpireApprovalEvents(ctx context.Context, maxAge time.Duration) (int64, error) {
	tag, err := s.db.Exec(ctx, `DELETE FROM approval_event_outbox WHERE created_at < now()-$1*interval '1 second'`, maxAge.Seconds())
	return tag.RowsAffected(), err
}
