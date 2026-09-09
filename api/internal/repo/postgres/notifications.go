package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/razorpay/aidocs/api/internal/auth"
	"github.com/razorpay/aidocs/api/internal/repo"
)

func (s *Store) SetCommentNotificationsEnabled(enabled bool) { s.commentNotifications = enabled }

func (s *Store) NotificationPreferences(ctx context.Context, p auth.Principal, documentID string) (repo.NotificationPreferences, error) {
	var global, muted bool
	err := s.db.QueryRow(ctx, `SELECT
		COALESCE((SELECT enabled FROM notification_preferences WHERE principal_type=$1 AND principal_id=$2), true),
		EXISTS(SELECT 1 FROM document_notification_mutes WHERE principal_type=$1 AND principal_id=$2 AND document_id=$3)`,
		p.Type, p.ID, documentID).Scan(&global, &muted)
	enabled := global
	if documentID != "" {
		enabled = !muted
	}
	return repo.NotificationPreferences{Enabled: enabled, EffectiveEnabled: global && !muted}, err
}

func (s *Store) SetNotificationPreferences(ctx context.Context, p auth.Principal, documentID string, enabled bool) (repo.NotificationPreferences, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.NotificationPreferences{}, err
	}
	defer rollback(ctx, tx)
	switch {
	case documentID == "":
		_, err = tx.Exec(ctx, `INSERT INTO notification_preferences(principal_type,principal_id,enabled) VALUES($1,$2,$3)
			ON CONFLICT(principal_type,principal_id) DO UPDATE SET enabled=excluded.enabled`, p.Type, p.ID, enabled)
	case enabled:
		_, err = tx.Exec(ctx, `DELETE FROM document_notification_mutes WHERE principal_type=$1 AND principal_id=$2 AND document_id=$3`, p.Type, p.ID, documentID)
	default:
		_, err = tx.Exec(ctx, `INSERT INTO document_notification_mutes(principal_type,principal_id,document_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, p.Type, p.ID, documentID)
	}
	if err != nil {
		return repo.NotificationPreferences{}, err
	}
	if !enabled && p.Type == auth.PrincipalUser {
		// Re-enabling starts with future activity; it never replays a muted backlog.
		_, err = tx.Exec(ctx, `DELETE FROM comment_notification_outbox o USING comments c WHERE o.comment_id=c.id AND o.recipient_id=$1 AND ($2='' OR c.document_id=$2)`, p.ID, documentID)
		if err != nil {
			return repo.NotificationPreferences{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.NotificationPreferences{}, err
	}
	return s.NotificationPreferences(ctx, p, documentID)
}

// The comment and its recipients commit together. Metadata comes from canonical
// persisted mentions, never from email strings supplied by the client.
func (s *Store) enqueueCommentNotifications(ctx context.Context, tx pgx.Tx, commentID string) error {
	if !s.commentNotifications {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO comment_notification_outbox(comment_id,recipient_id,reason)
		SELECT c.id, recipients.id, CASE WHEN bool_or(recipients.mentioned) THEN 'mention' ELSE 'owner' END
		FROM comments c JOIN documents d ON d.id=c.document_id
		CROSS JOIN LATERAL (
			SELECT cm.principal_id AS id, true AS mentioned FROM comment_mentions cm WHERE cm.comment_id=c.id AND cm.principal_type='user'
			UNION ALL SELECT d.owner_id, false WHERE d.owner_type='user'
		) recipients
		WHERE c.id=$1 AND NOT (c.author_type='user' AND c.author_id=recipients.id)
		AND NOT EXISTS(SELECT 1 FROM notification_preferences p WHERE p.principal_type='user' AND p.principal_id=recipients.id AND NOT p.enabled)
		AND NOT EXISTS(SELECT 1 FROM document_notification_mutes m WHERE m.principal_type='user' AND m.principal_id=recipients.id AND m.document_id=d.id)
		GROUP BY c.id, recipients.id ON CONFLICT DO NOTHING`, commentID)
	return err
}

// Editing a comment only notifies users added by that edit. Existing mentions,
// the document owner, and service accounts do not receive another message.
func (s *Store) enqueueNewCommentMentionNotifications(ctx context.Context, tx pgx.Tx, commentID string, recipientIDs []string) error {
	if !s.commentNotifications || len(recipientIDs) == 0 {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO comment_notification_outbox AS queued(comment_id,recipient_id,reason)
		SELECT c.id, recipient.id, 'mention'
		FROM comments c JOIN documents d ON d.id=c.document_id
		CROSS JOIN unnest($2::text[]) AS recipient(id)
		WHERE c.id=$1 AND NOT (c.author_type='user' AND c.author_id=recipient.id)
		AND NOT EXISTS(SELECT 1 FROM notification_preferences p WHERE p.principal_type='user' AND p.principal_id=recipient.id AND NOT p.enabled)
		AND NOT EXISTS(SELECT 1 FROM document_notification_mutes m WHERE m.principal_type='user' AND m.principal_id=recipient.id AND m.document_id=d.id)
		ON CONFLICT(comment_id,recipient_id) DO UPDATE SET reason='mention', available_at=LEAST(queued.available_at, now())`, commentID, recipientIDs)
	return err
}

// A lease outlives the sender's deadline and lets another process recover work
// after a crash. Successful delivery deletes the row immediately.
func (s *Store) ClaimCommentNotification(ctx context.Context) (*repo.CommentNotification, error) {
	if _, err := s.db.Exec(ctx, `DELETE FROM comment_notification_outbox WHERE created_at < now()-interval '24 hours'`); err != nil {
		return nil, err
	}
	var n repo.CommentNotification
	err := s.db.QueryRow(ctx, `UPDATE comment_notification_outbox o SET available_at=now()+interval '1 minute', attempts=o.attempts+1
		FROM (SELECT comment_id, recipient_id FROM comment_notification_outbox WHERE available_at<=now()
		ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) pending
		WHERE o.comment_id=pending.comment_id AND o.recipient_id=pending.recipient_id
		RETURNING o.comment_id,o.recipient_id,o.reason,o.attempts`).Scan(&n.CommentID, &n.RecipientID, &n.Reason, &n.Attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &n, err
}

func (s *Store) FinishCommentNotification(ctx context.Context, n repo.CommentNotification, retryAfter time.Duration) error {
	if retryAfter <= 0 {
		_, err := s.db.Exec(ctx, `DELETE FROM comment_notification_outbox WHERE comment_id=$1 AND recipient_id=$2 AND attempts=$3`, n.CommentID, n.RecipientID, n.Attempts)
		return err
	}
	_, err := s.db.Exec(ctx, `UPDATE comment_notification_outbox SET available_at=now()+$4*interval '1 second' WHERE comment_id=$1 AND recipient_id=$2 AND attempts=$3`, n.CommentID, n.RecipientID, n.Attempts, retryAfter.Seconds())
	return err
}

// A database gate applies across replicas, separately from Slack's rate limits.
func (s *Store) ReserveNotificationDelivery(ctx context.Context, userID string) (bool, error) {
	tag, err := s.db.Exec(ctx, `UPDATE users SET next_notification_at=now()+interval '6 seconds' WHERE id=$1 AND next_notification_at<=now()`, userID)
	return tag.RowsAffected() > 0, err
}
