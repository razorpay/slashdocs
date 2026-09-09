package postgres

import (
	"context"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"

	"github.com/razorpay/aidocs/api/internal/auth"
	"github.com/razorpay/aidocs/api/internal/repo"
)

func (s *Store) SetNotificationsEnabled(enabled bool) { s.notificationsEnabled = enabled }

type documentAccessSnapshot map[string]repo.Role

func accessNotificationSource(principal auth.Principal) string {
	if principal.Type == auth.PrincipalUser {
		return "direct"
	}
	return "opened"
}

func documentGrantAccessSnapshot(ctx context.Context, tx pgx.Tx, resourceType, resourceID string, principal auth.Principal) (documentAccessSnapshot, error) {
	if resourceType != "document" {
		return nil, nil
	}
	var recipientIDs []string
	switch principal.Type {
	case auth.PrincipalUser:
		var role repo.Role
		if err := tx.QueryRow(ctx, `SELECT COALESCE((SELECT role FROM resource_grants
			WHERE resource_type='document' AND resource_id=$1 AND principal_type='user'
			AND principal_id=$2 AND revoked_at IS NULL), '')`, resourceID, principal.ID).Scan(&role); err != nil {
			return nil, err
		}
		return documentAccessSnapshot{principal.ID: role}, nil
	case auth.PrincipalAnyone:
		rows, err := tx.Query(ctx, `SELECT w.principal_id
			FROM document_workspace_entries w JOIN users u ON u.id=w.principal_id
			WHERE w.document_id=$1 AND w.principal_type='user'`, resourceID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err := rows.Scan(&id); err != nil {
				return nil, err
			}
			recipientIDs = append(recipientIDs, id)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	default:
		return nil, nil
	}
	if len(recipientIDs) == 0 {
		return documentAccessSnapshot{}, nil
	}
	rows, err := tx.Query(ctx, `WITH RECURSIVE ancestors(resource_id, resource_type, depth) AS (
		SELECT $1::text, 'document'::text, 0
		UNION ALL
		SELECT f.id, 'folder'::text, a.depth+1
		FROM ancestors a
		JOIN LATERAL (
			SELECT CASE WHEN a.resource_type='document' THEN (SELECT parent_folder_id FROM documents WHERE id=a.resource_id)
				ELSE (SELECT parent_folder_id FROM folders WHERE id=a.resource_id) END AS parent_id
		) parent ON parent.parent_id IS NOT NULL
		JOIN folders f ON f.id=parent.parent_id
		WHERE a.depth < 64
	)
	SELECT recipient.id,
		CASE WHEN d.owner_type='user' AND d.owner_id=recipient.id THEN 'owner'
		ELSE COALESCE((
			SELECT g.role FROM resource_grants g
			WHERE g.revoked_at IS NULL
			  AND g.resource_id IN (SELECT resource_id FROM ancestors)
			  AND (g.principal_type='anyone'
			    OR (g.principal_type='user' AND g.principal_id=recipient.id)
			    OR (g.principal_type='google_group' AND EXISTS (
			      SELECT 1 FROM google_group_memberships gm
			      WHERE gm.user_id=recipient.id AND gm.group_id=g.principal_id)))
			ORDER BY CASE g.role WHEN 'owner' THEN 4 WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 WHEN 'viewer' THEN 1 ELSE 0 END DESC
			LIMIT 1
		), '') END AS role
	FROM unnest($2::text[]) AS recipient(id)
	CROSS JOIN documents d
	WHERE d.id=$1`, resourceID, recipientIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := make(documentAccessSnapshot, len(recipientIDs))
	for rows.Next() {
		var id string
		var role repo.Role
		if err := rows.Scan(&id, &role); err != nil {
			return nil, err
		}
		result[id] = role
	}
	return result, rows.Err()
}

func accessNotificationReason(previous, next repo.Role) string {
	switch {
	case previous == repo.RoleNone:
		return "access_shared"
	case next == repo.RoleNone:
		return "access_removed"
	default:
		return "access_updated"
	}
}

func (s *Store) enqueueDocumentAccessChanges(ctx context.Context, tx pgx.Tx, documentID, source string, actor auth.Principal, before, after documentAccessSnapshot) error {
	if !s.notificationsEnabled {
		return nil
	}
	recipientIDs := make([]string, 0, len(before))
	previousRoles := make([]string, 0, len(before))
	nextRoles := make([]string, 0, len(before))
	reasons := make([]string, 0, len(before))
	for recipientID, previousRole := range before {
		nextRole := after[recipientID]
		if previousRole == nextRole || (actor.Type == auth.PrincipalUser && actor.ID == recipientID) {
			continue
		}
		recipientIDs = append(recipientIDs, recipientID)
		previousRoles = append(previousRoles, string(previousRole))
		nextRoles = append(nextRoles, string(nextRole))
		reasons = append(reasons, accessNotificationReason(previousRole, nextRole))
	}
	if len(recipientIDs) == 0 {
		return nil
	}
	// The workspace-entry primary key bounds an org-wide snapshot to users who
	// opened this document. Batch the changed subset so enqueueing always takes
	// one database round trip rather than two per viewer.
	_, err := tx.Exec(ctx, `WITH changes AS (
		SELECT recipient_id,previous_role,role,reason
		FROM unnest($2::text[],$3::text[],$4::text[],$5::text[])
			AS changed(recipient_id,previous_role,role,reason)
	), upserted AS (
		INSERT INTO document_access_notification_outbox AS queued
			(document_id,recipient_id,source,reason,previous_role,role)
		SELECT $1,changed.recipient_id,$6,changed.reason,changed.previous_role,changed.role
		FROM changes changed
		JOIN users u ON u.id=changed.recipient_id
		WHERE NOT EXISTS(SELECT 1 FROM notification_preferences p WHERE p.principal_type='user' AND p.principal_id=changed.recipient_id AND NOT p.enabled)
		AND NOT EXISTS(SELECT 1 FROM document_notification_mutes m WHERE m.principal_type='user' AND m.principal_id=changed.recipient_id AND m.document_id=$1)
		ON CONFLICT(document_id,recipient_id,source) DO UPDATE SET
			reason=CASE
				WHEN queued.previous_role='' AND EXCLUDED.role<>'' THEN 'access_shared'
				WHEN queued.previous_role<>'' AND EXCLUDED.role='' THEN 'access_removed'
				ELSE 'access_updated' END,
			role=EXCLUDED.role,attempts=0,available_at=now(),created_at=now()
		RETURNING document_id,recipient_id,source
	)
	DELETE FROM document_access_notification_outbox queued
	USING upserted
	WHERE queued.document_id=upserted.document_id AND queued.recipient_id=upserted.recipient_id
	AND queued.source=upserted.source AND queued.previous_role=queued.role`,
		documentID, recipientIDs, previousRoles, nextRoles, reasons, source)
	return err
}

// RequestDocumentAccess deliberately returns no existence or owner detail. A
// repeated request within 24 hours is accepted but does not notify again.
func (s *Store) RequestDocumentAccess(ctx context.Context, requester auth.Principal, documentID string) error {
	if requester.Type != auth.PrincipalUser && requester.Type != auth.PrincipalServiceAccount {
		return nil
	}
	role, err := s.RoleForDocument(ctx, requester, documentID)
	if err != nil || role != repo.RoleNone || !s.notificationsEnabled {
		return err
	}
	label := requester.Name
	if requester.Email != "" {
		label = requester.Email
		if requester.Name != "" {
			label = requester.Name + " (" + requester.Email + ")"
		}
	}
	if requester.Type == auth.PrincipalServiceAccount {
		sa, lookupErr := s.GetServiceAccount(ctx, requester.ID)
		if lookupErr != nil {
			if errors.Is(lookupErr, repo.ErrNotFound) {
				return nil
			}
			return lookupErr
		}
		label = sa.Name
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	_, err = tx.Exec(ctx, `WITH requested AS (
		INSERT INTO document_access_requests(document_id,requester_type,requester_id)
		SELECT d.id,$2,$3 FROM documents d WHERE d.id=$1
		ON CONFLICT(document_id,requester_type,requester_id) DO UPDATE SET requested_at=now()
		WHERE document_access_requests.requested_at <= now()-interval '24 hours'
		RETURNING document_id
	), recipient AS (
		SELECT CASE WHEN d.owner_type='user' THEN d.owner_id ELSE sa.owner_user_id END AS user_id
		FROM requested r JOIN documents d ON d.id=r.document_id
		LEFT JOIN service_accounts sa ON d.owner_type='service_account' AND sa.id=d.owner_id
	)
	INSERT INTO document_access_request_notification_outbox
		(document_id,requester_type,requester_id,requester_label,recipient_id)
	SELECT $1,$2,$3,$4,recipient.user_id FROM recipient
	WHERE recipient.user_id IS NOT NULL AND NOT ($2='user' AND recipient.user_id=$3)
	AND NOT EXISTS(SELECT 1 FROM notification_preferences p WHERE p.principal_type='user' AND p.principal_id=recipient.user_id AND NOT p.enabled)
	AND NOT EXISTS(SELECT 1 FROM document_notification_mutes m WHERE m.principal_type='user' AND m.principal_id=recipient.user_id AND m.document_id=$1)
	ON CONFLICT(document_id,requester_type,requester_id) DO UPDATE SET
		requester_label=excluded.requester_label,recipient_id=excluded.recipient_id,
		attempts=0,available_at=now(),created_at=now()`, documentID, requester.Type, requester.ID, label)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}

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
		_, err = tx.Exec(ctx, `DELETE FROM document_access_notification_outbox WHERE recipient_id=$1 AND ($2='' OR document_id=$2)`, p.ID, documentID)
		if err != nil {
			return repo.NotificationPreferences{}, err
		}
		_, err = tx.Exec(ctx, `DELETE FROM document_access_request_notification_outbox WHERE recipient_id=$1 AND ($2='' OR document_id=$2)`, p.ID, documentID)
		if err != nil {
			return repo.NotificationPreferences{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.NotificationPreferences{}, err
	}
	return s.NotificationPreferences(ctx, p, documentID)
}

// The comment and its subscriptions commit together. Each event source proposes
// a recipient and reason; the priority step selects one message per recipient.
// Mentions override replies, and replies override ordinary owner activity.
// All recipients then pass through the same self, preference, and mute policy.
func (s *Store) enqueueCommentNotifications(ctx context.Context, tx pgx.Tx, commentID string) error {
	if !s.notificationsEnabled {
		return nil
	}
	_, err := tx.Exec(ctx, `WITH notification_subscriptions AS (
		SELECT c.id AS comment_id, cm.principal_id AS recipient_id, 'mention'::text AS reason, 3 AS priority
		FROM comments c JOIN comment_mentions cm ON cm.comment_id=c.id AND cm.principal_type='user'
		WHERE c.id=$1
		UNION ALL
		SELECT c.id, parent.author_id, 'reply', 2
		FROM comments c JOIN comments parent ON parent.id=c.parent_comment_id AND parent.author_type='user'
		WHERE c.id=$1
		UNION ALL
		SELECT c.id, d.owner_id, 'owner', 1
		FROM comments c JOIN documents d ON d.id=c.document_id AND d.owner_type='user'
		WHERE c.id=$1
	), resolved_subscriptions AS (
		SELECT DISTINCT ON (comment_id,recipient_id) comment_id,recipient_id,reason
		FROM notification_subscriptions
		ORDER BY comment_id,recipient_id,priority DESC
	)
	INSERT INTO comment_notification_outbox(comment_id,recipient_id,reason)
	SELECT c.id, subscription.recipient_id, subscription.reason
	FROM comments c
	JOIN documents d ON d.id=c.document_id
	JOIN resolved_subscriptions subscription ON subscription.comment_id=c.id
	WHERE c.id=$1 AND NOT (c.author_type='user' AND c.author_id=subscription.recipient_id)
	AND EXISTS(SELECT 1 FROM users WHERE id=subscription.recipient_id)
	AND NOT EXISTS(SELECT 1 FROM notification_preferences p WHERE p.principal_type='user' AND p.principal_id=subscription.recipient_id AND NOT p.enabled)
	AND NOT EXISTS(SELECT 1 FROM document_notification_mutes m WHERE m.principal_type='user' AND m.principal_id=subscription.recipient_id AND m.document_id=d.id)
	ON CONFLICT DO NOTHING`, commentID)
	return err
}

// Editing a comment only notifies users added by that edit. Existing mentions,
// the document owner, and service accounts do not receive another message.
func (s *Store) enqueueNewCommentMentionNotifications(ctx context.Context, tx pgx.Tx, commentID string, recipientIDs []string) error {
	if !s.notificationsEnabled || len(recipientIDs) == 0 {
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

func (s *Store) ClaimDocumentAccessNotification(ctx context.Context) (*repo.DocumentAccessNotification, error) {
	if _, err := s.db.Exec(ctx, `DELETE FROM document_access_notification_outbox WHERE created_at < now()-interval '24 hours'`); err != nil {
		return nil, err
	}
	var n repo.DocumentAccessNotification
	err := s.db.QueryRow(ctx, `UPDATE document_access_notification_outbox o SET available_at=now()+interval '1 minute', attempts=o.attempts+1
		FROM (SELECT document_id, recipient_id, source FROM document_access_notification_outbox WHERE available_at<=now()
		ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) pending
		WHERE o.document_id=pending.document_id AND o.recipient_id=pending.recipient_id AND o.source=pending.source
		RETURNING o.document_id,o.recipient_id,o.source,o.reason,o.previous_role,o.role,o.attempts`).Scan(
		&n.DocumentID, &n.RecipientID, &n.Source, &n.Reason, &n.PreviousRole, &n.Role, &n.Attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &n, err
}

func (s *Store) DirectDocumentGrantRole(ctx context.Context, documentID, userID string) (repo.Role, error) {
	var role repo.Role
	err := s.db.QueryRow(ctx, `SELECT COALESCE((SELECT role FROM resource_grants
		WHERE resource_type='document' AND resource_id=$1 AND principal_type='user'
		AND principal_id=$2 AND revoked_at IS NULL), '')`, documentID, userID).Scan(&role)
	return role, err
}

func (s *Store) FinishDocumentAccessNotification(ctx context.Context, n repo.DocumentAccessNotification, retryAfter time.Duration) error {
	if retryAfter <= 0 {
		_, err := s.db.Exec(ctx, `DELETE FROM document_access_notification_outbox WHERE document_id=$1 AND recipient_id=$2 AND source=$3 AND attempts=$4`, n.DocumentID, n.RecipientID, n.Source, n.Attempts)
		return err
	}
	_, err := s.db.Exec(ctx, `UPDATE document_access_notification_outbox SET available_at=now()+$5*interval '1 second' WHERE document_id=$1 AND recipient_id=$2 AND source=$3 AND attempts=$4`, n.DocumentID, n.RecipientID, n.Source, n.Attempts, retryAfter.Seconds())
	return err
}

func (s *Store) ClaimDocumentAccessRequestNotification(ctx context.Context) (*repo.DocumentAccessRequestNotification, error) {
	if _, err := s.db.Exec(ctx, `DELETE FROM document_access_request_notification_outbox WHERE created_at < now()-interval '24 hours'`); err != nil {
		return nil, err
	}
	var n repo.DocumentAccessRequestNotification
	err := s.db.QueryRow(ctx, `UPDATE document_access_request_notification_outbox o SET available_at=now()+interval '1 minute',attempts=o.attempts+1
		FROM (SELECT document_id,requester_type,requester_id FROM document_access_request_notification_outbox
			WHERE available_at<=now() ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1) pending
		WHERE o.document_id=pending.document_id AND o.requester_type=pending.requester_type AND o.requester_id=pending.requester_id
		RETURNING o.document_id,o.requester_type,o.requester_id,o.requester_label,o.recipient_id,o.attempts`).Scan(
		&n.DocumentID, &n.RequesterType, &n.RequesterID, &n.RequesterLabel, &n.RecipientID, &n.Attempts)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return &n, err
}

func (s *Store) FinishDocumentAccessRequestNotification(ctx context.Context, n repo.DocumentAccessRequestNotification, retryAfter time.Duration) error {
	if retryAfter <= 0 {
		_, err := s.db.Exec(ctx, `DELETE FROM document_access_request_notification_outbox
			WHERE document_id=$1 AND requester_type=$2 AND requester_id=$3 AND attempts=$4`, n.DocumentID, n.RequesterType, n.RequesterID, n.Attempts)
		return err
	}
	_, err := s.db.Exec(ctx, `UPDATE document_access_request_notification_outbox SET available_at=now()+$5*interval '1 second'
		WHERE document_id=$1 AND requester_type=$2 AND requester_id=$3 AND attempts=$4`, n.DocumentID, n.RequesterType, n.RequesterID, n.Attempts, retryAfter.Seconds())
	return err
}

// A database gate applies across replicas, separately from Slack's rate limits.
func (s *Store) ReserveNotificationDelivery(ctx context.Context, userID string) (bool, error) {
	tag, err := s.db.Exec(ctx, `UPDATE users SET next_notification_at=now()+interval '6 seconds' WHERE id=$1 AND next_notification_at<=now()`, userID)
	return tag.RowsAffected() > 0, err
}
