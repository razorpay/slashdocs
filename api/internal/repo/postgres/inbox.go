package postgres

import (
	"context"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

func (s *Store) Inbox(ctx context.Context, p auth.Principal, offset int) ([]repo.InboxItem, error) {
	rows, err := s.db.Query(ctx, `WITH mine AS (
		-- The threads of the principal, with the time of their newest message
		-- in each. A message of theirs reads every message before it.
		SELECT thread_id, max(said) AS said FROM (
			SELECT root_comment_id AS thread_id, created_at AS said FROM comments
			WHERE author_type=$1 AND author_id=$2
			UNION ALL
			SELECT c.root_comment_id, NULL FROM comment_mentions m JOIN comments c ON c.id=m.comment_id
			WHERE m.principal_type=$1 AND m.principal_id=$2
			UNION ALL
			SELECT c.id, NULL FROM documents d JOIN comments c ON c.document_id=d.id AND c.parent_comment_id IS NULL
			WHERE d.owner_type=$1 AND d.owner_id=$2
		) t GROUP BY thread_id
	), threads AS (
		-- Each open thread with its newest message by someone else that the
		-- principal did not read.
		SELECT DISTINCT ON (t.id) 'thread' AS kind, t.document_id, t.id AS comment_id,
			c.author_type, c.author_id, c.author_email, c.author_name, c.body, c.created_at AS at
		FROM mine
		JOIN comments t ON t.id=mine.thread_id AND t.status='open'
		JOIN comments c ON c.document_id=t.document_id AND c.root_comment_id=t.id
			AND NOT (c.author_type=$1 AND c.author_id=$2)
		LEFT JOIN comment_reads r ON r.thread_id=t.id AND r.principal_type=$1 AND r.principal_id=$2
		WHERE c.created_at > COALESCE(GREATEST(r.read_at, mine.said), '-infinity')
		ORDER BY t.id, c.created_at DESC
	), approvals AS (
		-- Each document that the principal approves, with no decision of
		-- theirs on the content of its current version, since that version.
		SELECT 'approval' AS kind, r.document_id, '' AS comment_id,
			r.requested_by_type, r.requested_by_id, COALESCE(u.email,''), COALESCE(u.name,sa.name,''), '' AS body,
			GREATEST(r.created_at, cv.created_at)
		FROM approval_requests r
		JOIN documents d ON d.id=r.document_id
		JOIN versions cv ON cv.id=d.current_version_id
		LEFT JOIN users u ON r.requested_by_type='user' AND u.id=r.requested_by_id
		LEFT JOIN service_accounts sa ON r.requested_by_type='service_account' AND sa.id=r.requested_by_id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
		WHERE r.approver_type=$1 AND r.approver_id=$2 AND r.revoked_at IS NULL
		AND NOT EXISTS (SELECT 1 FROM approvals a WHERE a.document_id=r.document_id AND a.sha256=cv.sha256
			AND a.revoked_at IS NULL AND a.approver_type=r.approver_type AND a.approver_id=r.approver_id)
	)
	SELECT i.kind, i.document_id, d.title, i.comment_id,
		i.author_type, i.author_id, i.author_email, i.author_name, i.body, i.at
	FROM (SELECT * FROM threads UNION ALL SELECT * FROM approvals) i
	JOIN documents d ON d.id=i.document_id
	ORDER BY i.at DESC, i.document_id, i.comment_id LIMIT $3 OFFSET $4`, p.Type, p.ID, repo.InboxPage, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []repo.InboxItem{}
	for rows.Next() {
		var it repo.InboxItem
		var at time.Time
		if err := rows.Scan(&it.Kind, &it.DocumentID, &it.DocumentTitle, &it.CommentID,
			&it.From.Type, &it.From.ID, &it.From.Email, &it.From.Name, &it.Body, &at); err != nil {
			return nil, err
		}
		it.At = at.UTC().Format(time.RFC3339Nano)
		items = append(items, it)
	}
	return items, rows.Err()
}
