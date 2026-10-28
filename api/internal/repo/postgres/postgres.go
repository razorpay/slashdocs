package postgres

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"sort"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/blob"
	dbsqlc "github.com/razorpay/slashdocs/api/internal/db/sqlc"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// htmlContentType is the content type stored for all version HTML blobs.
const htmlContentType = "text/html; charset=utf-8"

type Store struct {
	notificationsEnabled bool
	db                   *pgxpool.Pool
	q                    *dbsqlc.Queries
	blobs                blob.Store
}

// rollback closes a transaction on every early-return path. pgx returns
// ErrTxClosed after a successful commit, which is expected and needs no action.
func rollback(ctx context.Context, tx pgx.Tx) {
	_ = tx.Rollback(ctx)
}

func New(db *pgxpool.Pool) *Store { return NewWithBlob(db, nil) }
func NewWithBlob(db *pgxpool.Pool, blobs blob.Store) *Store {
	if blobs == nil {
		// Tests/local callers that do not wire S3 still use a blob store;
		// version HTML is never duplicated in Postgres.
		blobs = blob.NewMemory()
	}
	return &Store{db: db, q: dbsqlc.New(db), blobs: blobs}
}
func Connect(ctx context.Context, databaseURL string) (*Store, error) {
	return ConnectWithBlob(ctx, databaseURL, nil)
}
func ConnectWithBlob(ctx context.Context, databaseURL string, blobs blob.Store) (*Store, error) {
	p, err := pgxpool.New(ctx, databaseURL)
	if err != nil {
		return nil, err
	}
	if err := p.Ping(ctx); err != nil {
		p.Close()
		return nil, err
	}
	return NewWithBlob(p, blobs), nil
}
func (s *Store) Close()                         { s.db.Close() }
func (s *Store) Pool() *pgxpool.Pool            { return s.db }
func (s *Store) Ping(ctx context.Context) error { return s.db.Ping(ctx) }

func (s *Store) ResolveBearerToken(ctx context.Context, tokenHash string) (auth.Principal, error) {
	u, err := s.q.ResolveCLIToken(ctx, tokenHash)
	if err == nil {
		// Best-effort last-used bookkeeping; a failed touch must not fail auth.
		_ = s.q.TouchCLIToken(ctx, tokenHash)
		return auth.Principal{Type: auth.PrincipalType(u.PrincipalType), ID: u.ID, Email: u.Email, Name: u.Name, PictureURL: u.PictureUrl}, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return auth.Principal{}, err
	}
	sa, err := s.q.ResolveServiceAccountToken(ctx, tokenHash)
	if errors.Is(err, pgx.ErrNoRows) {
		return auth.Principal{}, repo.ErrNotFound
	}
	if err == nil {
		// Best-effort last-used bookkeeping; a failed touch must not fail auth.
		_ = s.q.TouchServiceAccountToken(ctx, tokenHash)
		return auth.Principal{Type: auth.PrincipalType(sa.PrincipalType), ID: sa.ID, Email: sa.Email, Name: sa.Name, PictureURL: sa.PictureUrl}, nil
	}
	return auth.Principal{}, err
}
func (s *Store) ResolveUser(ctx context.Context, id string) (auth.Principal, error) {
	u, err := s.q.GetUserByID(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return auth.Principal{}, repo.ErrNotFound
	}
	if err != nil {
		return auth.Principal{}, err
	}
	return auth.Principal{Type: auth.PrincipalUser, ID: u.ID, Email: u.Email, Name: u.Name, PictureURL: u.PictureUrl}, nil
}
func (s *Store) UpsertGoogleUser(ctx context.Context, id, email, name, googleSub, pictureURL string) (auth.Principal, error) {
	err := s.q.UpsertGoogleUser(ctx, dbsqlc.UpsertGoogleUserParams{ID: id, Email: email, Name: name, GoogleSub: pgtype.Text{String: googleSub, Valid: true}, PictureUrl: pictureURL})
	if err != nil {
		return auth.Principal{}, err
	}
	u, err := s.q.GetUserByGoogleSub(ctx, pgtype.Text{String: googleSub, Valid: true})
	if err != nil {
		return auth.Principal{}, err
	}
	return auth.Principal{Type: auth.PrincipalUser, ID: u.ID, Email: u.Email, Name: u.Name, PictureURL: u.PictureUrl}, nil
}
func (s *Store) UserByEmail(ctx context.Context, email string) (auth.Principal, error) {
	u, err := s.q.GetSignedInUserByEmail(ctx, email)
	if errors.Is(err, pgx.ErrNoRows) {
		return auth.Principal{}, repo.ErrNotFound
	}
	if err != nil {
		return auth.Principal{}, err
	}
	return auth.Principal{Type: auth.PrincipalUser, ID: u.ID, Email: u.Email, Name: u.Name, PictureURL: u.PictureUrl}, nil
}

func (s *Store) SearchUsersByEmail(ctx context.Context, query string) ([]auth.Principal, error) {
	rows, err := s.q.SearchUsersByEmail(ctx, query)
	if err != nil {
		return nil, err
	}
	out := make([]auth.Principal, 0, len(rows))
	for _, u := range rows {
		out = append(out, auth.Principal{Type: auth.PrincipalUser, ID: u.ID, Email: u.Email, Name: u.Name, PictureURL: u.PictureUrl})
	}
	return out, nil
}

func (s *Store) SearchContacts(ctx context.Context, caller auth.Principal, query string) ([]auth.Principal, error) {
	rows, err := s.q.SearchContacts(ctx, dbsqlc.SearchContactsParams{Query: query, CallerType: string(caller.Type), CallerID: caller.ID})
	if err != nil {
		return nil, err
	}
	out := make([]auth.Principal, 0, len(rows))
	for _, u := range rows {
		out = append(out, auth.Principal{Type: auth.PrincipalUser, ID: u.ID, Email: u.Email, Name: u.Name, PictureURL: u.PictureUrl})
	}
	return out, nil
}

func (s *Store) EnsureUserByEmail(ctx context.Context, email string) (auth.Principal, error) {
	u, err := s.UserByEmail(ctx, email)
	if err == nil {
		return u, nil
	}
	if !errors.Is(err, repo.ErrNotFound) {
		return auth.Principal{}, err
	}
	id := newID("usr")
	if err := s.q.InsertPlaceholderUser(ctx, dbsqlc.InsertPlaceholderUserParams{ID: id, Email: email}); err != nil {
		return auth.Principal{}, err
	}
	return auth.Principal{Type: auth.PrincipalUser, ID: id, Email: email}, nil
}

func (s *Store) GoogleGroupMembershipSnapshot(ctx context.Context, userID string) (repo.GoogleGroupMembershipSnapshot, error) {
	var snapshot repo.GoogleGroupMembershipSnapshot
	var lastSuccess pgtype.Timestamptz
	err := s.db.QueryRow(ctx, `
		SELECT last_attempt_at, last_success_at, last_error_code
		FROM google_group_sync_state WHERE user_id=$1`, userID).
		Scan(&snapshot.LastAttemptAt, &lastSuccess, &snapshot.LastErrorCode)
	if errors.Is(err, pgx.ErrNoRows) {
		return snapshot, nil
	}
	if err != nil {
		return snapshot, err
	}
	if lastSuccess.Valid {
		snapshot.LastSuccessAt = lastSuccess.Time
	}
	rows, err := s.db.Query(ctx, `SELECT group_id FROM google_group_memberships WHERE user_id=$1 ORDER BY group_id`, userID)
	if err != nil {
		return snapshot, err
	}
	defer rows.Close()
	for rows.Next() {
		var groupID string
		if err := rows.Scan(&groupID); err != nil {
			return snapshot, err
		}
		snapshot.GroupIDs = append(snapshot.GroupIDs, groupID)
	}
	return snapshot, rows.Err()
}

func (s *Store) ReplaceGoogleGroupMemberships(ctx context.Context, userID string, groups []repo.GoogleGroup, syncedAt time.Time) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	for _, group := range groups {
		// ACL rows reference the immutable groups/{id}; mutable addresses and
		// display names are refreshed metadata only.
		if _, err := tx.Exec(ctx, `
			INSERT INTO google_groups(id,customer_id,email,display_name,last_verified_at)
			VALUES($1,$2,$3,$4,$5)
			ON CONFLICT(id) DO UPDATE SET customer_id=EXCLUDED.customer_id,
			  email=EXCLUDED.email, display_name=EXCLUDED.display_name,
			  last_verified_at=EXCLUDED.last_verified_at, updated_at=now()`,
			group.ID, group.CustomerID, group.Email, group.Name, syncedAt); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM google_group_memberships WHERE user_id=$1`, userID); err != nil {
		return err
	}
	for _, group := range groups {
		if _, err := tx.Exec(ctx, `INSERT INTO google_group_memberships(user_id,group_id,synced_at) VALUES($1,$2,$3)`, userID, group.ID, syncedAt); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO google_group_sync_state(user_id,last_attempt_at,last_success_at,last_error_code)
		VALUES($1,$2,$2,'')
		ON CONFLICT(user_id) DO UPDATE SET last_attempt_at=EXCLUDED.last_attempt_at,
		  last_success_at=EXCLUDED.last_success_at, last_error_code=''`, userID, syncedAt); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (s *Store) RecordGoogleGroupMembershipFailure(ctx context.Context, userID, errorCode string, attemptedAt time.Time) error {
	// Failed refreshes deliberately retain the old membership rows for
	// diagnostics. Authorization separately ignores them once last_success_at
	// is outside the configured freshness window.
	_, err := s.db.Exec(ctx, `
		INSERT INTO google_group_sync_state(user_id,last_attempt_at,last_error_code)
		VALUES($1,$2,$3)
		ON CONFLICT(user_id) DO UPDATE SET last_attempt_at=EXCLUDED.last_attempt_at,
		  last_error_code=EXCLUDED.last_error_code`, userID, attemptedAt, errorCode)
	return err
}

func (s *Store) UpsertGoogleGroup(ctx context.Context, group repo.GoogleGroup) error {
	_, err := s.db.Exec(ctx, `
		INSERT INTO google_groups(id,customer_id,email,display_name,last_verified_at)
		VALUES($1,$2,$3,$4,$5)
		ON CONFLICT(id) DO UPDATE SET customer_id=EXCLUDED.customer_id,
		  email=EXCLUDED.email, display_name=EXCLUDED.display_name,
		  last_verified_at=EXCLUDED.last_verified_at, updated_at=now()`,
		group.ID, group.CustomerID, group.Email, group.Name, group.LastVerifiedAt)
	return err
}
func (s *Store) CreateCLICredential(ctx context.Context, userID, name, tokenHash string) (string, error) {
	id := newID("cred")
	err := s.q.CreateCLICredential(ctx, dbsqlc.CreateCLICredentialParams{ID: id, UserID: userID, Name: name, TokenHash: tokenHash})
	return id, err
}
func (s *Store) ListCLICredentials(ctx context.Context, userID string) ([]repo.CLICredential, error) {
	rows, err := s.q.ListCLICredentials(ctx, userID)
	if err != nil {
		return nil, err
	}
	out := make([]repo.CLICredential, 0, len(rows))
	for _, r := range rows {
		out = append(out, repo.CLICredential{ID: r.ID, Name: r.Name})
	}
	return out, nil
}
func (s *Store) RevokeCLICredential(ctx context.Context, userID, credentialID string) error {
	return s.q.RevokeCLICredential(ctx, dbsqlc.RevokeCLICredentialParams{ID: credentialID, UserID: userID})
}

func (s *Store) RoleForDocument(ctx context.Context, p auth.Principal, documentID string) (repo.Role, error) {
	owner, err := s.q.GetDocumentOwner(ctx, documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		// A missing document and an unshared one are the same permission
		// verdict (RoleNone), not an error; errors are reserved for lookup
		// faults so callers can map them to a 500 rather than a 403.
		return repo.RoleNone, nil
	}
	if err != nil {
		return "", err
	}
	best := repo.RoleNone
	if string(p.Type) == owner.OwnerType && p.ID == owner.OwnerID {
		best = repo.RoleOwner
	}
	grants, err := s.q.ListDocumentInheritedGrants(ctx, documentID)
	if err != nil {
		return "", err
	}
	for _, g := range grants {
		if principalHasGrant(p, g.PrincipalType, g.PrincipalID) {
			best = repo.MaxRole(best, repo.Role(g.Role))
		}
	}
	return best, nil
}

func principalHasGrant(p auth.Principal, principalType, principalID string) bool {
	if principalType == string(auth.PrincipalAnyone) || (principalType == string(p.Type) && principalID == p.ID) {
		return true
	}
	if p.Type != auth.PrincipalUser || principalType != string(auth.PrincipalGoogleGroup) {
		return false
	}
	for _, groupID := range p.GoogleGroupIDs {
		if groupID == principalID {
			return true
		}
	}
	return false
}

func (s *Store) CreateDocument(ctx context.Context, owner auth.Principal, title string, html []byte) (repo.Document, repo.Version, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.Document{}, repo.Version{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if owner.Type == auth.PrincipalUser {
		if err := upsertUser(ctx, q, owner); err != nil {
			return repo.Document{}, repo.Version{}, err
		}
	}
	docID, verID := newID("doc"), newID("ver")
	blobKey := fmt.Sprintf("docs/%s/%s.html", docID, verID)
	sum := sha(html)
	if err := s.blobs.Put(ctx, blobKey, htmlContentType, html); err != nil {
		return repo.Document{}, repo.Version{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = s.blobs.Delete(context.WithoutCancel(ctx), blobKey)
		}
	}()
	if err := q.InsertDocument(ctx, dbsqlc.InsertDocumentParams{ID: docID, Title: title, OwnerType: string(owner.Type), OwnerID: owner.ID}); err != nil {
		return repo.Document{}, repo.Version{}, err
	}
	createdAt, err := q.InsertInitialVersion(ctx, dbsqlc.InsertInitialVersionParams{ID: verID, DocumentID: docID, HtmlBlobKey: blobKey, Sha256: sum, CreatedByType: string(owner.Type), CreatedByID: owner.ID, SearchText: searchText(html)})
	if err != nil {
		return repo.Document{}, repo.Version{}, err
	}
	if err := q.UpdateDocumentCurrentVersion(ctx, dbsqlc.UpdateDocumentCurrentVersionParams{CurrentVersionID: pgtype.Text{String: verID, Valid: true}, ID: docID}); err != nil {
		return repo.Document{}, repo.Version{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.Document{}, repo.Version{}, err
	}
	committed = true
	return repo.Document{ID: docID, Title: title, Owner: owner, CurrentVersionID: verID}, repo.Version{ID: verID, Number: 1, DocumentID: docID, CreatedBy: owner, SHA256: sum, CreatedAt: pgTimeRFC3339(createdAt)}, nil
}
func (s *Store) GetDocument(ctx context.Context, id string) (repo.Document, error) {
	r, err := s.q.GetDocument(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.Document{}, repo.ErrNotFound
	}
	if err != nil {
		return repo.Document{}, err
	}
	return docFromGet(r), nil
}

func (s *Store) CreateServiceAccount(ctx context.Context, owner auth.Principal, name string) (repo.ServiceAccount, error) {
	if owner.Type != auth.PrincipalUser {
		return repo.ServiceAccount{}, errors.New("owner must be user")
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.ServiceAccount{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if err := upsertUser(ctx, q, owner); err != nil {
		return repo.ServiceAccount{}, err
	}
	id := newID("sa")
	if err := q.InsertServiceAccount(ctx, dbsqlc.InsertServiceAccountParams{ID: id, Name: name, OwnerUserID: owner.ID}); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return repo.ServiceAccount{}, repo.ErrConflict
		}
		return repo.ServiceAccount{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.ServiceAccount{}, err
	}
	return repo.ServiceAccount{ID: id, Name: name, Owner: owner}, nil
}
func (s *Store) GetServiceAccount(ctx context.Context, id string) (repo.ServiceAccount, error) {
	r, err := s.q.GetServiceAccount(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.ServiceAccount{}, repo.ErrNotFound
	}
	if err != nil {
		return repo.ServiceAccount{}, err
	}
	return repo.ServiceAccount{ID: r.ID, Name: r.Name, Disabled: r.Disabled, Owner: auth.Principal{Type: auth.PrincipalUser, ID: r.OwnerID, Email: r.OwnerEmail, Name: r.OwnerName}}, nil
}
func (s *Store) GetServiceAccountByName(ctx context.Context, name string) (repo.ServiceAccount, error) {
	r, err := s.q.GetServiceAccountByName(ctx, name)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.ServiceAccount{}, repo.ErrNotFound
	}
	if err != nil {
		return repo.ServiceAccount{}, err
	}
	return repo.ServiceAccount{ID: r.ID, Name: r.Name, Disabled: r.Disabled, Owner: auth.Principal{Type: auth.PrincipalUser, ID: r.OwnerID, Email: r.OwnerEmail, Name: r.OwnerName}}, nil
}
func (s *Store) PrincipalExists(ctx context.Context, p auth.Principal) (bool, error) {
	switch p.Type {
	case auth.PrincipalUser:
		return s.q.UserExists(ctx, p.ID)
	case auth.PrincipalServiceAccount:
		return s.q.ServiceAccountExists(ctx, p.ID)
	case auth.PrincipalGoogleGroup:
		var exists bool
		err := s.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM google_groups WHERE id=$1)`, p.ID).Scan(&exists)
		return exists, err
	default:
		return false, nil
	}
}

// CreateGrant changes access without creating or updating user profiles.
func (s *Store) CreateGrant(ctx context.Context, resourceType, resourceID string, principal auth.Principal, role repo.Role, grantedBy auth.Principal) (repo.Grant, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.Grant{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	before, err := documentGrantAccessSnapshot(ctx, tx, resourceType, resourceID, principal)
	if err != nil {
		return repo.Grant{}, err
	}
	// A revoked grant for this (resource, principal) is resurrected under its
	// original id by the upsert's conflict clause; use the persisted id, not
	// the candidate, or revoking the returned grant 404s.
	persistedID, err := q.UpsertResourceGrant(ctx, dbsqlc.UpsertResourceGrantParams{
		ID:              newID("gr"),
		ResourceType:    resourceType,
		ResourceID:      resourceID,
		PrincipalType:   string(principal.Type),
		PrincipalID:     principal.ID,
		Role:            string(role),
		GrantedByType:   string(grantedBy.Type),
		GrantedByUserID: grantedBy.ID,
	})
	if err != nil {
		return repo.Grant{}, err
	}
	after, err := documentGrantAccessSnapshot(ctx, tx, resourceType, resourceID, principal)
	if err != nil {
		return repo.Grant{}, err
	}
	if err := s.enqueueDocumentAccessChanges(ctx, tx, resourceID, accessNotificationSource(principal), grantedBy, before, after); err != nil {
		return repo.Grant{}, err
	}
	if err := clearGrantedAccessRequests(ctx, tx, resourceType, resourceID, principal); err != nil {
		return repo.Grant{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.Grant{}, err
	}
	return repo.Grant{ID: persistedID, DocumentID: resourceID, ResourceType: resourceType, ResourceID: resourceID, Principal: principal, Role: role, GrantedBy: grantedBy}, nil
}

func clearGrantedAccessRequests(ctx context.Context, tx pgx.Tx, resourceType, resourceID string, principal auth.Principal) error {
	if resourceType != "document" {
		return nil
	}
	if principal.Type == auth.PrincipalAnyone {
		if _, err := tx.Exec(ctx, `DELETE FROM document_access_request_notification_outbox WHERE document_id=$1`, resourceID); err != nil {
			return err
		}
		_, err := tx.Exec(ctx, `DELETE FROM document_access_requests WHERE document_id=$1`, resourceID)
		return err
	}
	if principal.Type != auth.PrincipalUser && principal.Type != auth.PrincipalServiceAccount {
		return nil
	}
	if _, err := tx.Exec(ctx, `DELETE FROM document_access_request_notification_outbox WHERE document_id=$1 AND requester_type=$2 AND requester_id=$3`, resourceID, principal.Type, principal.ID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `DELETE FROM document_access_requests WHERE document_id=$1 AND requester_type=$2 AND requester_id=$3`, resourceID, principal.Type, principal.ID)
	return err
}

// keepsApprovals decides whether a new version carries the base version's
// approved decisions forward: when the publisher asked for it, or when nothing
// changed (the same bytes as the base version).
func keepsApprovals(ctx context.Context, q *dbsqlc.Queries, baseVersionID, newSHA256 string, asked bool) (bool, error) {
	if asked {
		return true, nil
	}
	base, err := q.GetVersion(ctx, baseVersionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return base.Sha256 == newSHA256, nil
}

func (s *Store) CreateVersion(ctx context.Context, documentID, baseVersionID, changeSummary string, html []byte, createdBy auth.Principal, keepApprovals bool) (repo.Version, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.Version{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	cur, err := q.GetDocumentVersionForUpdate(ctx, documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.Version{}, repo.ErrNotFound
	}
	if err != nil {
		return repo.Version{}, err
	}
	if cur.CurrentVersionID.String != baseVersionID {
		return repo.Version{ID: cur.CurrentVersionID.String}, &repo.VersionConflictError{LatestVersionID: cur.CurrentVersionID.String}
	}
	id := newID("ver")
	blobKey := fmt.Sprintf("docs/%s/%s.html", documentID, id)
	sum := sha(html)
	if err := s.blobs.Put(ctx, blobKey, htmlContentType, html); err != nil {
		return repo.Version{}, err
	}
	committed := false
	defer func() {
		if !committed {
			_ = s.blobs.Delete(context.WithoutCancel(ctx), blobKey)
		}
	}()
	createdAt, err := q.InsertVersion(ctx, dbsqlc.InsertVersionParams{ID: id, DocumentID: documentID, Number: cur.NextNumber, HtmlBlobKey: blobKey, Sha256: sum, ParentVersionID: pgtype.Text{String: cur.CurrentVersionID.String, Valid: cur.CurrentVersionID.Valid}, CreatedByType: string(createdBy.Type), CreatedByID: createdBy.ID, ChangeSummary: changeSummary, SearchText: searchText(html)})
	if err != nil {
		return repo.Version{}, err
	}
	if err := q.UpdateDocumentCurrentVersion(ctx, dbsqlc.UpdateDocumentCurrentVersionParams{CurrentVersionID: pgtype.Text{String: id, Valid: true}, ID: documentID}); err != nil {
		return repo.Version{}, err
	}
	// A change of content is a new thing to approve, so every approver decides
	// again. Approvals follow the document only when the publisher asks to keep
	// them, or when nothing changed (the same bytes as the base version);
	// approvers who requested changes (or never decided) start pending on the
	// new version either way.
	carried := 0
	keep, err := keepsApprovals(ctx, q, baseVersionID, sum, keepApprovals)
	if err != nil {
		return repo.Version{}, err
	}
	if keep {
		carried, err = carryForwardApprovals(ctx, q, documentID, baseVersionID, id, createdBy)
		if err != nil {
			return repo.Version{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.Version{}, err
	}
	committed = true
	return repo.Version{ID: id, Number: int(cur.NextNumber), DocumentID: documentID, CreatedBy: createdBy, ChangeSummary: changeSummary, SHA256: sum, CarriedApprovals: carried, CreatedAt: pgTimeRFC3339(createdAt)}, nil
}
func (s *Store) CreateComment(ctx context.Context, documentID, versionID, body string, anchor repo.Anchor, author auth.Principal, mentions []repo.CommentMention) (repo.Comment, error) {
	body = repo.NormalizeCommentBody(body)
	if body == "" {
		return repo.Comment{}, repo.ErrInvalidCommentBody
	}
	b, err := json.Marshal(anchor)
	if err != nil {
		return repo.Comment{}, err
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.Comment{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	v, err := q.GetVersion(ctx, versionID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && v.DocumentID != documentID) {
		return repo.Comment{}, repo.ErrNotFound
	}
	if err != nil {
		return repo.Comment{}, err
	}
	mentions, err = canonicalCommentMentions(ctx, q, body, mentions, nil)
	if err != nil {
		return repo.Comment{}, err
	}
	id := newID("cmt")
	createdAt, err := q.InsertComment(ctx, dbsqlc.InsertCommentParams{ID: id, DocumentID: documentID, CreatedOnVersionID: versionID, AuthorType: string(author.Type), AuthorID: author.ID, AuthorEmail: author.Email, AuthorName: author.Name, Body: body, SelectedText: anchor.Quote, AnchorJson: b})
	if err != nil {
		return repo.Comment{}, err
	}
	if err := insertCommentMentions(ctx, q, id, mentions); err != nil {
		return repo.Comment{}, err
	}
	if err := s.enqueueCommentNotifications(ctx, tx, id); err != nil {
		return repo.Comment{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.Comment{}, err
	}
	return repo.Comment{ID: id, DocumentID: documentID, VersionID: versionID, Author: author, Body: body, SelectedText: anchor.Quote, Anchor: anchor, Status: repo.StatusOpen, RootCommentID: id, Mentions: mentions, CreatedAt: pgTimeRFC3339(createdAt)}, nil
}
func (s *Store) CreateCommentReply(ctx context.Context, documentID, parentCommentID, body string, author auth.Principal, mentions []repo.CommentMention) (repo.Comment, error) {
	body = repo.NormalizeCommentBody(body)
	if body == "" {
		return repo.Comment{}, repo.ErrInvalidCommentBody
	}
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.Comment{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	row, err := q.GetCommentForReply(ctx, parentCommentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.Comment{}, repo.ErrNotFound
	}
	if err != nil {
		return repo.Comment{}, err
	}
	parent := commentFromReply(row)
	if parent.DocumentID != documentID {
		return repo.Comment{}, repo.ErrNotFound
	}
	mentions, err = canonicalCommentMentions(ctx, q, body, mentions, nil)
	if err != nil {
		return repo.Comment{}, err
	}
	rootID := parent.RootCommentID
	if rootID == "" {
		rootID = parent.ID
	}
	id := newID("cmt")
	createdAt, err := q.InsertCommentReply(ctx, dbsqlc.InsertCommentReplyParams{ID: id, DocumentID: documentID, CreatedOnVersionID: parent.VersionID, AuthorType: string(author.Type), AuthorID: author.ID, AuthorEmail: author.Email, AuthorName: author.Name, Body: body, ParentCommentID: pgtype.Text{String: parent.ID, Valid: true}, RootCommentID: rootID})
	if err != nil {
		return repo.Comment{}, err
	}
	if err := insertCommentMentions(ctx, q, id, mentions); err != nil {
		return repo.Comment{}, err
	}
	if err := s.enqueueCommentNotifications(ctx, tx, id); err != nil {
		return repo.Comment{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.Comment{}, err
	}
	return repo.Comment{ID: id, DocumentID: documentID, VersionID: parent.VersionID, Author: author, Body: body, Status: repo.StatusOpen, ParentCommentID: parent.ID, RootCommentID: rootID, Mentions: mentions, CreatedAt: pgTimeRFC3339(createdAt)}, nil
}

type mentionPrincipalKey struct {
	typeName auth.PrincipalType
	id       string
}

type historicalMentionKey struct {
	principal mentionPrincipalKey
	label     string
}

func canonicalCommentMentions(ctx context.Context, q *dbsqlc.Queries, body string, mentions, historical []repo.CommentMention) ([]repo.CommentMention, error) {
	ordered, err := repo.ValidateCommentMentionRanges(body, mentions)
	if err != nil {
		return nil, err
	}
	return resolveCanonicalCommentMentions(ctx, q, ordered, historical)
}

func resolveCanonicalCommentMentions(ctx context.Context, q *dbsqlc.Queries, ordered, historical []repo.CommentMention) ([]repo.CommentMention, error) {
	historicalCounts := make(map[historicalMentionKey]int, len(historical))
	for _, mention := range historical {
		key := historicalMentionKey{
			principal: mentionPrincipalKey{typeName: mention.Principal.Type, id: mention.Principal.ID},
			label:     mention.LabelText,
		}
		historicalCounts[key]++
	}

	canonical := make([]repo.CommentMention, 0, len(ordered))
	principals := make(map[mentionPrincipalKey]auth.Principal, len(ordered))
	for _, mention := range ordered {
		key := mentionPrincipalKey{typeName: mention.Principal.Type, id: mention.Principal.ID}
		principal, ok := principals[key]
		if !ok {
			var lookupErr error
			switch key.typeName {
			case auth.PrincipalUser:
				var user dbsqlc.GetMentionUserRow
				user, lookupErr = q.GetMentionUser(ctx, key.id)
				if lookupErr == nil {
					principal = auth.Principal{Type: auth.PrincipalUser, ID: user.ID, Email: user.Email, Name: user.Name, PictureURL: user.PictureUrl}
				}
			case auth.PrincipalServiceAccount:
				var serviceAccount dbsqlc.GetMentionServiceAccountRow
				serviceAccount, lookupErr = q.GetMentionServiceAccount(ctx, key.id)
				if lookupErr == nil {
					principal = auth.Principal{Type: auth.PrincipalServiceAccount, ID: serviceAccount.ID, Name: serviceAccount.Name}
				}
			default:
				return nil, fmt.Errorf("%w: principal type must be user or service_account", repo.ErrInvalidCommentMention)
			}
			if errors.Is(lookupErr, pgx.ErrNoRows) {
				return nil, fmt.Errorf("%w: principal does not exist", repo.ErrInvalidCommentMention)
			}
			if lookupErr != nil {
				return nil, lookupErr
			}
			principals[key] = principal
		}
		mention.Principal = principal
		if !repo.CommentMentionMatchesCanonicalLabel(mention) {
			historicalKey := historicalMentionKey{principal: key, label: mention.LabelText}
			if historicalCounts[historicalKey] == 0 {
				return nil, fmt.Errorf("%w: range does not exactly match the principal label", repo.ErrInvalidCommentMention)
			}
			historicalCounts[historicalKey]--
		}
		canonical = append(canonical, repo.CommentMention{
			Principal:   principal,
			OffsetUTF16: mention.OffsetUTF16,
			LengthUTF16: mention.LengthUTF16,
			LabelText:   mention.LabelText,
		})
	}
	return canonical, nil
}

func insertCommentMentions(ctx context.Context, q *dbsqlc.Queries, commentID string, mentions []repo.CommentMention) error {
	for _, mention := range mentions {
		if err := q.InsertCommentMention(ctx, dbsqlc.InsertCommentMentionParams{
			CommentID:     commentID,
			PrincipalType: string(mention.Principal.Type),
			PrincipalID:   mention.Principal.ID,
			OffsetUtf16:   mention.OffsetUTF16,
			LengthUtf16:   mention.LengthUTF16,
			LabelText:     mention.LabelText,
		}); err != nil {
			return err
		}
	}
	return nil
}

func commentMentionsByID(ctx context.Context, q *dbsqlc.Queries, commentIDs []string) (map[string][]repo.CommentMention, error) {
	byID := make(map[string][]repo.CommentMention, len(commentIDs))
	for _, id := range commentIDs {
		byID[id] = []repo.CommentMention{}
	}
	if len(commentIDs) == 0 {
		return byID, nil
	}
	rows, err := q.ListCommentMentions(ctx, commentIDs)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		byID[row.CommentID] = append(byID[row.CommentID], repo.CommentMention{
			Principal: auth.Principal{
				Type:       auth.PrincipalType(row.PrincipalType),
				ID:         row.PrincipalID,
				Email:      row.PrincipalEmail,
				Name:       row.PrincipalName,
				PictureURL: row.PrincipalPictureUrl,
			},
			OffsetUTF16: int64(row.OffsetUtf16),
			LengthUTF16: int64(row.LengthUtf16),
			LabelText:   row.LabelText,
		})
	}
	return byID, nil
}

// commentReactionsByID bulk-loads reactions for a set of comments so callers
// avoid a per-comment round trip, mirroring commentMentionsByID. Every
// requested ID is seeded with an empty slice so a comment without reactions
// renders as [] rather than null.
func commentReactionsByID(ctx context.Context, q *dbsqlc.Queries, commentIDs []string) (map[string][]repo.CommentReaction, error) {
	byID := make(map[string][]repo.CommentReaction, len(commentIDs))
	for _, id := range commentIDs {
		byID[id] = []repo.CommentReaction{}
	}
	if len(commentIDs) == 0 {
		return byID, nil
	}
	rows, err := q.ListCommentReactions(ctx, commentIDs)
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		byID[row.CommentID] = append(byID[row.CommentID], repo.CommentReaction{
			Principal: auth.Principal{
				Type:  auth.PrincipalType(row.PrincipalType),
				ID:    row.PrincipalID,
				Name:  row.PrincipalName,
				Email: row.PrincipalEmail,
			},
			Emoji: row.Emoji,
		})
	}
	return byID, nil
}

func (s *Store) PutCommentReaction(ctx context.Context, commentID string, p auth.Principal, emoji string) error {
	return s.q.PutCommentReaction(ctx, dbsqlc.PutCommentReactionParams{
		CommentID: commentID, PrincipalType: string(p.Type), PrincipalID: p.ID, Emoji: emoji,
	})
}

func (s *Store) DeleteCommentReaction(ctx context.Context, commentID string, p auth.Principal, emoji string) error {
	return s.q.DeleteCommentReaction(ctx, dbsqlc.DeleteCommentReactionParams{
		CommentID: commentID, PrincipalType: string(p.Type), PrincipalID: p.ID, Emoji: emoji,
	})
}

func upsertUser(ctx context.Context, q *dbsqlc.Queries, p auth.Principal) error {
	return q.UpsertUser(ctx, dbsqlc.UpsertUserParams{ID: p.ID, Email: p.Email, Name: p.Name})
}
func sha(b []byte) string { s := sha256.Sum256(b); return hex.EncodeToString(s[:]) }

func sortedKVKeys(m map[string]json.RawMessage) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func sortedStrings(items []string) []string {
	out := append([]string(nil), items...)
	sort.Strings(out)
	return out
}

func pgTimeRFC3339(ts pgtype.Timestamptz) string {
	if !ts.Valid {
		return ""
	}
	return ts.Time.UTC().Format(time.RFC3339Nano)
}

func (s *Store) ListDocuments(ctx context.Context, p auth.Principal) ([]repo.Document, error) {
	rows, err := s.q.ListDocuments(ctx, dbsqlc.ListDocumentsParams{OwnerID: p.ID, OwnerType: string(p.Type), Column3: p.GoogleGroupIDs})
	if err != nil {
		return nil, err
	}
	out := make([]repo.Document, 0, len(rows))
	for _, r := range rows {
		out = append(out, docFromList(r))
	}
	return out, nil
}
func (s *Store) SearchDocuments(ctx context.Context, p auth.Principal, search repo.DocumentSearch, includeOrgWide bool, limit int32) ([]repo.Document, error) {
	rows, err := s.q.SearchDocuments(ctx, dbsqlc.SearchDocumentsParams{
		MatchQuery:     tsquery(search.Terms, " & "),
		ExcludeQuery:   tsquery(search.ExcludedTerms, " | "),
		Owners:         search.Owners,
		Folders:        search.Folders,
		Labels:         search.Labels,
		UpdatedSince:   pgtype.Timestamptz{Time: search.UpdatedSince, Valid: !search.UpdatedSince.IsZero()},
		UpdatedBefore:  pgtype.Timestamptz{Time: search.UpdatedBefore, Valid: !search.UpdatedBefore.IsZero()},
		OwnerID:        p.ID,
		OwnerType:      string(p.Type),
		GoogleGroupIds: p.GoogleGroupIDs,
		IncludeOrgWide: includeOrgWide,
		RowLimit:       limit,
	})
	if err != nil {
		return nil, err
	}
	out := make([]repo.Document, 0, len(rows))
	for _, r := range rows {
		d := docFromSearch(r)
		if search.IncludeLabels {
			d.Labels, err = s.q.ListDocumentLabels(ctx, r.ID)
			if err != nil {
				return nil, err
			}
		}
		out = append(out, d)
	}
	return out, nil
}
func (s *Store) RecordDocumentOpened(ctx context.Context, documentID string, p auth.Principal) error {
	return s.q.RecordWorkspaceEntry(ctx, dbsqlc.RecordWorkspaceEntryParams{
		DocumentID:    documentID,
		PrincipalType: string(p.Type),
		PrincipalID:   p.ID,
	})
}
func (s *Store) UpdateDocument(ctx context.Context, id, title string) (repo.Document, error) {
	if title != "" {
		if err := s.q.UpdateDocumentTitle(ctx, dbsqlc.UpdateDocumentTitleParams{Title: title, ID: id}); err != nil {
			return repo.Document{}, err
		}
	}
	return s.GetDocument(ctx, id)
}
func (s *Store) DeleteDocument(ctx context.Context, id string) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	deleted, err := q.DeleteDocument(ctx, id)
	if err != nil {
		return err
	}
	if deleted > 0 {
		// The event rows cascade with the document, so the notification tells
		// brokers to fetch, observe ErrNotFound, and close active subscribers.
		if err := q.NotifyDocumentKVEvent(ctx, id); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

func (s *Store) ListDocumentsByLabel(ctx context.Context, p auth.Principal, label string) ([]repo.Document, error) {
	rows, err := s.q.ListAccessibleDocumentsByLabel(ctx, dbsqlc.ListAccessibleDocumentsByLabelParams{
		OwnerID: p.ID, OwnerType: string(p.Type), Label: label, GoogleGroupIds: p.GoogleGroupIDs,
	})
	if err != nil {
		return nil, err
	}
	out := make([]repo.Document, 0, len(rows))
	for _, r := range rows {
		d := repo.Document{ID: r.ID, Title: r.Title, CurrentVersionID: r.CurrentVersionID.String, Owner: auth.Principal{Type: auth.PrincipalType(r.OwnerType), ID: r.OwnerID, Email: r.OwnerEmail, Name: r.OwnerName}}
		if r.UpdatedAt.Valid {
			d.UpdatedAt = r.UpdatedAt.Time.UTC().Format(time.RFC3339Nano)
		}
		d.Labels, err = s.q.ListDocumentLabels(ctx, r.ID)
		if err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, nil
}

func (s *Store) ListDocumentLabels(ctx context.Context, documentID string) ([]string, error) {
	return s.q.ListDocumentLabels(ctx, documentID)
}

func (s *Store) ReplaceDocumentLabels(ctx context.Context, documentID string, labels []string, actor auth.Principal) ([]string, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if err := q.DeleteDocumentLabels(ctx, documentID); err != nil {
		return nil, err
	}
	for _, label := range labels {
		if err := q.InsertDocumentLabel(ctx, dbsqlc.InsertDocumentLabelParams{DocumentID: documentID, Label: label, CreatedByType: string(actor.Type), CreatedByID: actor.ID}); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return append([]string(nil), labels...), nil
}

func (s *Store) UpsertGitHubConnection(ctx context.Context, c repo.GitHubConnection) error {
	return s.q.UpsertGitHubConnection(ctx, dbsqlc.UpsertGitHubConnectionParams{UserID: c.UserID, GithubUserID: c.GitHubUserID, Login: c.Login, AvatarUrl: c.AvatarURL, AccessTokenCiphertext: c.AccessTokenCiphertext})
}

func (s *Store) GetGitHubConnection(ctx context.Context, userID string) (repo.GitHubConnection, error) {
	r, err := s.q.GetGitHubConnection(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.GitHubConnection{}, repo.ErrNotFound
	}
	if err != nil {
		return repo.GitHubConnection{}, err
	}
	return repo.GitHubConnection{UserID: r.UserID, GitHubUserID: r.GithubUserID, Login: r.Login, AvatarURL: r.AvatarUrl, AccessTokenCiphertext: r.AccessTokenCiphertext, UpdatedAt: pgTimeRFC3339(r.UpdatedAt)}, nil
}

func (s *Store) DeleteGitHubConnection(ctx context.Context, userID string) error {
	n, err := s.q.DeleteGitHubConnection(ctx, userID)
	if err != nil {
		return err
	}
	if n == 0 {
		return repo.ErrNotFound
	}
	return nil
}
func (s *Store) ListGitHubAuthorAccess(ctx context.Context, documentID, owner, repoName string, freshAfter time.Time) ([]repo.GitHubAuthorAccess, error) {
	rows, err := s.q.ListGitHubAuthorAccess(ctx, dbsqlc.ListGitHubAuthorAccessParams{DocumentID: documentID, Owner: owner, Repo: repoName, FreshAfter: pgtype.Timestamptz{Time: freshAfter, Valid: true}})
	if err != nil {
		return nil, err
	}
	out := make([]repo.GitHubAuthorAccess, len(rows))
	for i, r := range rows {
		out[i] = repo.GitHubAuthorAccess{Author: auth.Principal{Type: auth.PrincipalType(r.CreatedByType), ID: r.CreatedByID}, UserID: r.UserID.String, AccessTokenCiphertext: r.AccessTokenCiphertext}
		if r.CanRead.Valid {
			out[i].CanRead = &r.CanRead.Bool
		}
	}
	return out, nil
}

func (s *Store) RecordGitHubRepoAccess(ctx context.Context, userID, owner, repoName string, canRead bool) error {
	return s.q.UpsertGitHubRepoAccess(ctx, dbsqlc.UpsertGitHubRepoAccessParams{UserID: userID, Owner: owner, Repo: repoName, CanRead: canRead})
}

func (s *Store) ListServiceAccounts(ctx context.Context, owner auth.Principal) ([]repo.ServiceAccount, error) {
	rows, err := s.q.ListServiceAccounts(ctx, owner.ID)
	if err != nil {
		return nil, err
	}
	out := make([]repo.ServiceAccount, 0, len(rows))
	for _, r := range rows {
		out = append(out, repo.ServiceAccount{ID: r.ID, Name: r.Name, Disabled: r.Disabled, Owner: auth.Principal{Type: auth.PrincipalUser, ID: r.OwnerID, Email: r.OwnerEmail, Name: r.OwnerName}})
	}
	return out, nil
}
func (s *Store) UpdateServiceAccount(ctx context.Context, id, name string, disabled *bool) (repo.ServiceAccount, error) {
	if name != "" {
		if err := s.q.UpdateServiceAccountName(ctx, dbsqlc.UpdateServiceAccountNameParams{Name: name, ID: id}); err != nil {
			return repo.ServiceAccount{}, err
		}
	}
	if disabled != nil {
		if *disabled {
			if err := s.q.DisableServiceAccount(ctx, id); err != nil {
				return repo.ServiceAccount{}, err
			}
		} else {
			if err := s.q.EnableServiceAccount(ctx, id); err != nil {
				return repo.ServiceAccount{}, err
			}
		}
	}
	return s.GetServiceAccount(ctx, id)
}
func (s *Store) CreateServiceAccountKey(ctx context.Context, saID, name, tokenHash string) (string, error) {
	id := newID("sak")
	err := s.q.InsertServiceAccountKey(ctx, dbsqlc.InsertServiceAccountKeyParams{ID: id, ServiceAccountID: saID, Name: name, TokenHash: tokenHash})
	return id, err
}
func (s *Store) ListServiceAccountKeys(ctx context.Context, saID string) ([]repo.ServiceAccountKey, error) {
	rows, err := s.q.ListServiceAccountKeys(ctx, saID)
	if err != nil {
		return nil, err
	}
	out := make([]repo.ServiceAccountKey, 0, len(rows))
	for _, r := range rows {
		out = append(out, repo.ServiceAccountKey{ID: r.ID, Name: r.Name})
	}
	return out, nil
}
func (s *Store) RevokeServiceAccountKey(ctx context.Context, saID, keyID string) error {
	return s.q.RevokeServiceAccountKey(ctx, dbsqlc.RevokeServiceAccountKeyParams{ServiceAccountID: saID, ID: keyID})
}
func (s *Store) ListGrants(ctx context.Context, resourceID string) ([]repo.Grant, error) {
	rows, err := s.q.ListResourceGrants(ctx, resourceID)
	if err != nil {
		return nil, err
	}
	out := make([]repo.Grant, 0, len(rows))
	for _, r := range rows {
		out = append(out, repo.Grant{
			ID:           r.ID,
			DocumentID:   resourceID,
			ResourceType: r.ResourceType,
			ResourceID:   r.ResourceID,
			Principal:    auth.Principal{Type: auth.PrincipalType(r.PrincipalType), ID: r.PrincipalID, Email: r.PrincipalEmail, Name: r.PrincipalName, PictureURL: r.PrincipalPictureUrl},
			Role:         repo.Role(r.Role),
			GrantedBy:    auth.Principal{Type: auth.PrincipalType(r.GrantedByType), ID: r.GrantedByUserID, Email: r.GrantedByEmail, Name: r.GrantedByName},
		})
	}
	return out, nil
}

type grantQueryRower interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

// lockGrant reads an active grant and locks it for the rest of the transaction.
func lockGrant(ctx context.Context, db grantQueryRower, resourceID, grantID string) (repo.Grant, error) {
	const query = `
		SELECT g.id,g.resource_type,g.resource_id,g.principal_type,g.principal_id,
		       COALESCE(u.email,gg.email,''),COALESCE(u.name,sa.name,gg.display_name,''),
		       g.role,g.granted_by_type,g.granted_by_user_id,
		       COALESCE(gu.email,''),COALESCE(gu.name,gsa.name,'')
		FROM resource_grants g
		LEFT JOIN users u ON g.principal_type='user' AND g.principal_id=u.id
		LEFT JOIN service_accounts sa ON g.principal_type='service_account' AND g.principal_id=sa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
		LEFT JOIN google_groups gg ON g.principal_type='google_group' AND g.principal_id=gg.id
		LEFT JOIN users gu ON g.granted_by_type='user' AND g.granted_by_user_id=gu.id
		LEFT JOIN service_accounts gsa ON g.granted_by_type='service_account' AND g.granted_by_user_id=gsa.id -- nosemgrep: detected-google-gcm-service-account - slashdocs-native principal type/table, not a Google credential.
		WHERE g.id=$1 AND g.resource_id=$2 AND g.revoked_at IS NULL
		FOR UPDATE OF g`
	row := db.QueryRow(ctx, query, grantID, resourceID)
	var g repo.Grant
	var principalType, grantedByType string
	err := row.Scan(&g.ID, &g.ResourceType, &g.ResourceID, &principalType, &g.Principal.ID,
		&g.Principal.Email, &g.Principal.Name, &g.Role, &grantedByType, &g.GrantedBy.ID,
		&g.GrantedBy.Email, &g.GrantedBy.Name)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.Grant{}, repo.ErrNotFound
	}
	if err != nil {
		return repo.Grant{}, err
	}
	g.DocumentID = g.ResourceID
	g.Principal.Type = auth.PrincipalType(principalType)
	g.GrantedBy.Type = auth.PrincipalType(grantedByType)
	return g, nil
}

func (s *Store) UpdateGrant(ctx context.Context, resourceID, grantID string, role repo.Role, updatedBy auth.Principal) (repo.Grant, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.Grant{}, err
	}
	defer rollback(ctx, tx)
	existing, err := lockGrant(ctx, tx, resourceID, grantID)
	if err != nil {
		return repo.Grant{}, err
	}
	before, err := documentGrantAccessSnapshot(ctx, tx, existing.ResourceType, resourceID, existing.Principal)
	if err != nil {
		return repo.Grant{}, err
	}
	if _, err := s.q.WithTx(tx).UpdateResourceGrantRole(ctx, dbsqlc.UpdateResourceGrantRoleParams{Role: string(role), GrantID: grantID, ResourceID: resourceID}); err != nil {
		return repo.Grant{}, err
	}
	after, err := documentGrantAccessSnapshot(ctx, tx, existing.ResourceType, resourceID, existing.Principal)
	if err != nil {
		return repo.Grant{}, err
	}
	if err := s.enqueueDocumentAccessChanges(ctx, tx, resourceID, accessNotificationSource(existing.Principal), updatedBy, before, after); err != nil {
		return repo.Grant{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.Grant{}, err
	}
	existing.Role = role
	return existing, nil
}
func (s *Store) DeleteGrant(ctx context.Context, resourceID, grantID string, deletedBy auth.Principal) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	existing, err := lockGrant(ctx, tx, resourceID, grantID)
	if err != nil {
		return err
	}
	before, err := documentGrantAccessSnapshot(ctx, tx, existing.ResourceType, resourceID, existing.Principal)
	if err != nil {
		return err
	}
	revoked, err := s.q.WithTx(tx).RevokeResourceGrant(ctx, dbsqlc.RevokeResourceGrantParams{GrantID: grantID, ResourceID: resourceID})
	if err != nil {
		return err
	}
	if revoked == 0 {
		return repo.ErrNotFound
	}
	after, err := documentGrantAccessSnapshot(ctx, tx, existing.ResourceType, resourceID, existing.Principal)
	if err != nil {
		return err
	}
	if err := s.enqueueDocumentAccessChanges(ctx, tx, resourceID, accessNotificationSource(existing.Principal), deletedBy, before, after); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *Store) ListVersions(ctx context.Context, documentID string) ([]repo.Version, error) {
	rows, err := s.q.ListVersions(ctx, documentID)
	if err != nil {
		return nil, err
	}
	out := make([]repo.Version, 0, len(rows))
	for _, r := range rows {
		out = append(out, repo.Version{ID: r.ID, Number: int(r.Number), DocumentID: r.DocumentID, CreatedBy: auth.Principal{Type: auth.PrincipalType(r.CreatedByType), ID: r.CreatedByID, Email: r.CreatedByEmail, Name: r.CreatedByName, PictureURL: r.CreatedByPictureUrl}, ChangeSummary: r.ChangeSummary, SHA256: r.Sha256, CreatedAt: pgTimeRFC3339(r.CreatedAt)})
	}
	return out, nil
}
func (s *Store) GetVersion(ctx context.Context, id string) (repo.Version, error) {
	r, err := s.q.GetVersion(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.Version{}, repo.ErrNotFound
	}
	if err != nil {
		return repo.Version{}, err
	}
	return repo.Version{ID: r.ID, Number: int(r.Number), DocumentID: r.DocumentID, CreatedBy: auth.Principal{Type: auth.PrincipalType(r.CreatedByType), ID: r.CreatedByID, Email: r.CreatedByEmail, Name: r.CreatedByName, PictureURL: r.CreatedByPictureUrl}, ChangeSummary: r.ChangeSummary, SHA256: r.Sha256, CreatedAt: pgTimeRFC3339(r.CreatedAt)}, nil
}
func (s *Store) GetVersionHTML(ctx context.Context, id string) ([]byte, error) {
	key, err := s.q.GetVersionBlobKey(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, repo.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	b, _, err := s.blobs.Get(ctx, key)
	if errors.Is(err, blob.ErrNotFound) {
		return nil, repo.ErrNotFound
	}
	return b, err
}
func (s *Store) GetComment(ctx context.Context, id string) (repo.Comment, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return repo.Comment{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	r, err := q.GetComment(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.Comment{}, repo.ErrNotFound
	}
	if err != nil {
		return repo.Comment{}, err
	}
	comment := commentFromGet(r)
	mentions, err := commentMentionsByID(ctx, q, []string{id})
	if err != nil {
		return repo.Comment{}, err
	}
	comment.Mentions = mentions[id]
	reactions, err := commentReactionsByID(ctx, q, []string{id})
	if err != nil {
		return repo.Comment{}, err
	}
	comment.Reactions = reactions[id]
	if err := tx.Commit(ctx); err != nil {
		return repo.Comment{}, err
	}
	return comment, nil
}
func (s *Store) ListComments(ctx context.Context, documentID, status, versionID string) ([]repo.Comment, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	rows, err := q.ListComments(ctx, dbsqlc.ListCommentsParams{DocumentID: documentID, Status: status, VersionID: versionID})
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(rows))
	out := make([]repo.Comment, 0, len(rows))
	for _, r := range rows {
		ids = append(ids, r.ID)
		out = append(out, commentFromList(r))
	}
	mentions, err := commentMentionsByID(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	reactions, err := commentReactionsByID(ctx, q, ids)
	if err != nil {
		return nil, err
	}
	for i := range out {
		out[i].Mentions = mentions[out[i].ID]
		out[i].Reactions = reactions[out[i].ID]
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}
func (s *Store) UpdateComment(ctx context.Context, id string, update repo.CommentUpdate) (repo.Comment, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.Comment{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	row, err := q.GetCommentForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.Comment{}, repo.ErrNotFound
	}
	if err != nil {
		return repo.Comment{}, err
	}
	effectiveBody, bodyChanged, err := commentBodyForUpdate(row.Body, update.Body)
	if err != nil {
		return repo.Comment{}, err
	}
	comment := commentFromUpdate(row, bodyChanged)
	previousMentionsByID, err := commentMentionsByID(ctx, q, []string{id})
	if err != nil {
		return repo.Comment{}, err
	}
	previousMentions := previousMentionsByID[id]
	nextMentions, replaceMentions, err := prepareCommentMentionUpdate(ctx, q, effectiveBody, bodyChanged, update.Mentions, previousMentions)
	if err != nil {
		return repo.Comment{}, err
	}
	if err := applyCommentUpdate(ctx, q, id, effectiveBody, bodyChanged, update.Status, nextMentions, replaceMentions); err != nil {
		return repo.Comment{}, err
	}
	if replaceMentions {
		if err := s.enqueueNewCommentMentionNotifications(ctx, tx, id, newlyMentionedUserIDs(previousMentions, nextMentions)); err != nil {
			return repo.Comment{}, err
		}
	}
	comment.Body = effectiveBody
	if update.Status != "" {
		updated, err := q.GetComment(ctx, id)
		if err != nil {
			return repo.Comment{}, err
		}
		comment = commentFromGet(updated)
	}
	mentions, err := commentMentionsByID(ctx, q, []string{id})
	if err != nil {
		return repo.Comment{}, err
	}
	comment.Mentions = mentions[id]
	reactions, err := commentReactionsByID(ctx, q, []string{id})
	if err != nil {
		return repo.Comment{}, err
	}
	comment.Reactions = reactions[id]
	if err := tx.Commit(ctx); err != nil {
		return repo.Comment{}, err
	}
	return comment, nil
}

func commentBodyForUpdate(current string, requested *string) (string, bool, error) {
	if requested == nil {
		return current, false, nil
	}
	normalized := repo.NormalizeCommentBody(*requested)
	if normalized == "" {
		return "", false, repo.ErrInvalidCommentBody
	}
	return normalized, normalized != current, nil
}

func prepareCommentMentionUpdate(ctx context.Context, q *dbsqlc.Queries, body string, bodyChanged bool, requested *[]repo.CommentMention, historical []repo.CommentMention) ([]repo.CommentMention, bool, error) {
	if requested == nil {
		if bodyChanged {
			return []repo.CommentMention{}, true, nil
		}
		return nil, false, nil
	}
	prepared, err := repo.ValidateCommentMentionRanges(body, *requested)
	if err != nil {
		return nil, false, err
	}
	next, err := resolveCanonicalCommentMentions(ctx, q, prepared, historical)
	return next, true, err
}

func newlyMentionedUserIDs(previous, next []repo.CommentMention) []string {
	seen := make(map[string]struct{}, len(previous))
	for _, mention := range previous {
		if mention.Principal.Type == auth.PrincipalUser {
			seen[mention.Principal.ID] = struct{}{}
		}
	}
	added := make([]string, 0, len(next))
	for _, mention := range next {
		if mention.Principal.Type != auth.PrincipalUser {
			continue
		}
		if _, exists := seen[mention.Principal.ID]; exists {
			continue
		}
		seen[mention.Principal.ID] = struct{}{}
		added = append(added, mention.Principal.ID)
	}
	return added
}

func applyCommentUpdate(ctx context.Context, q *dbsqlc.Queries, commentID, body string, bodyChanged bool, status string, mentions []repo.CommentMention, replaceMentions bool) error {
	if bodyChanged {
		if err := q.UpdateCommentBody(ctx, dbsqlc.UpdateCommentBodyParams{Body: body, ID: commentID}); err != nil {
			return err
		}
	}
	if status != "" {
		if err := q.UpdateCommentStatus(ctx, dbsqlc.UpdateCommentStatusParams{Status: status, ID: commentID}); err != nil {
			return err
		}
	}
	if !replaceMentions {
		return nil
	}
	if err := q.DeleteCommentMentions(ctx, commentID); err != nil {
		return err
	}
	return insertCommentMentions(ctx, q, commentID, mentions)
}

func (s *Store) DeleteComment(ctx context.Context, id string) error {
	return s.q.DeleteComment(ctx, id)
}

// CurrentDocumentKVRevision returns the persisted high-water mark used to
// initialize the process-local event broker for a document.
func (s *Store) CurrentDocumentKVRevision(ctx context.Context, documentID string) (int64, error) {
	return s.q.GetDocumentKVRevision(ctx, documentID)
}

func (s *Store) ListDocumentKV(ctx context.Context, documentID string) (repo.DocumentKVSnapshot, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return repo.DocumentKVSnapshot{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if _, err := q.GetDocumentOwner(ctx, documentID); errors.Is(err, pgx.ErrNoRows) {
		return repo.DocumentKVSnapshot{}, repo.ErrNotFound
	} else if err != nil {
		return repo.DocumentKVSnapshot{}, err
	}
	rows, err := q.ListDocumentKV(ctx, documentID)
	if err != nil {
		return repo.DocumentKVSnapshot{}, err
	}
	rev, err := q.GetDocumentKVRevision(ctx, documentID)
	if err != nil {
		return repo.DocumentKVSnapshot{}, err
	}
	items := make(map[string]json.RawMessage, len(rows))
	for _, row := range rows {
		items[row.Key] = append(json.RawMessage(nil), row.Value...)
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.DocumentKVSnapshot{}, err
	}
	return repo.DocumentKVSnapshot{Revision: rev, Items: items}, nil
}

func (s *Store) ListDocumentKVEvents(ctx context.Context, documentID string, afterRevision int64, limit int32) ([]repo.DocumentKVEvent, error) {
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{
		IsoLevel:   pgx.RepeatableRead,
		AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return nil, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if _, err := q.GetDocumentOwner(ctx, documentID); errors.Is(err, pgx.ErrNoRows) {
		return nil, repo.ErrNotFound
	} else if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 100
	}
	rows, err := q.ListDocumentKVEventsAfter(ctx, dbsqlc.ListDocumentKVEventsAfterParams{
		DocumentID: documentID,
		Revision:   afterRevision,
		Limit:      limit,
	})
	if err != nil {
		return nil, err
	}
	out, err := documentKVEvents(rows)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	return out, nil
}

func (s *Store) ListDocumentPresence(ctx context.Context, documentID string, maxAge time.Duration) ([]repo.DocumentKVEvent, error) {
	maxAgeSeconds := int64(maxAge / time.Second)
	if maxAgeSeconds > math.MaxInt32 {
		maxAgeSeconds = math.MaxInt32
	}
	rows, err := s.q.ListRecentDocumentPresenceEvents(ctx, dbsqlc.ListRecentDocumentPresenceEventsParams{
		DocumentID:    documentID,
		MaxAgeSeconds: int32(maxAgeSeconds),
	})
	if err != nil {
		return nil, err
	}
	return documentKVEvents(rows)
}

func documentKVEvents(rows []dbsqlc.DocumentKvEvent) ([]repo.DocumentKVEvent, error) {
	out := make([]repo.DocumentKVEvent, 0, len(rows))
	for _, row := range rows {
		var changes []repo.DocumentKVChange
		if err := json.Unmarshal(row.Changes, &changes); err != nil {
			return nil, err
		}
		actor := auth.Principal{
			Type:  auth.PrincipalType(row.UpdatedByType),
			ID:    row.UpdatedByID,
			Email: row.UpdatedByEmail,
			Name:  row.UpdatedByName,
		}
		out = append(out, repo.DocumentKVEvent{
			DocumentID: row.DocumentID,
			Revision:   row.Revision,
			Kind:       row.Kind,
			Changes:    changes,
			Data:       row.Data,
			UpdatedAt:  pgTimeRFC3339(row.UpdatedAt),
			UpdatedBy:  &actor,
		})
	}
	return out, nil
}

func (s *Store) PatchDocumentKV(ctx context.Context, documentID string, set map[string]json.RawMessage, deleteKeys []string, actor auth.Principal) (repo.DocumentKVPatchResult, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.DocumentKVPatchResult{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if _, err := q.LockDocumentForKV(ctx, documentID); errors.Is(err, pgx.ErrNoRows) {
		return repo.DocumentKVPatchResult{}, repo.ErrNotFound
	} else if err != nil {
		return repo.DocumentKVPatchResult{}, err
	}
	currentRev, err := q.GetDocumentKVRevision(ctx, documentID)
	if err != nil {
		return repo.DocumentKVPatchResult{}, err
	}
	if len(set) == 0 && len(deleteKeys) == 0 {
		if err := tx.Commit(ctx); err != nil {
			return repo.DocumentKVPatchResult{}, err
		}
		return repo.DocumentKVPatchResult{Revision: currentRev, Changes: []repo.DocumentKVChange{}, UpdatedBy: &actor}, nil
	}
	rev := currentRev + 1
	now := time.Now().UTC().Format(time.RFC3339Nano)
	changes := make([]repo.DocumentKVChange, 0, len(set)+len(deleteKeys))
	actorType := string(actor.Type)
	for _, key := range sortedKVKeys(set) {
		value := append(json.RawMessage(nil), set[key]...)
		if err := q.UpsertDocumentKV(ctx, dbsqlc.UpsertDocumentKVParams{DocumentID: documentID, Key: key, Value: value, Revision: rev, UpdatedByType: actorType, UpdatedByID: actor.ID, UpdatedByEmail: actor.Email, UpdatedByName: actor.Name}); err != nil {
			return repo.DocumentKVPatchResult{}, err
		}
		changes = append(changes, repo.DocumentKVChange{Key: key, Value: value, Revision: rev, UpdatedAt: now, UpdatedBy: &actor, Operation: "set"})
	}
	for _, key := range sortedStrings(deleteKeys) {
		if err := q.DeleteDocumentKV(ctx, dbsqlc.DeleteDocumentKVParams{DocumentID: documentID, Key: key, Revision: rev, UpdatedByType: actorType, UpdatedByID: actor.ID, UpdatedByEmail: actor.Email, UpdatedByName: actor.Name}); err != nil {
			return repo.DocumentKVPatchResult{}, err
		}
		changes = append(changes, repo.DocumentKVChange{Key: key, Deleted: true, Revision: rev, UpdatedAt: now, UpdatedBy: &actor, Operation: "delete"})
	}
	rawChanges, err := json.Marshal(changes)
	if err != nil {
		return repo.DocumentKVPatchResult{}, err
	}
	// PostgreSQL delivers NOTIFY only if this transaction commits, so listeners
	// can never observe a revision whose KV rows or event-log row rolled back.
	if err := insertAndNotifyDocumentKVEvent(ctx, q, dbsqlc.InsertDocumentKVEventParams{DocumentID: documentID, Revision: rev, Kind: repo.DocumentEventKV, Changes: rawChanges, UpdatedByType: actorType, UpdatedByID: actor.ID, UpdatedByEmail: actor.Email, UpdatedByName: actor.Name}); err != nil {
		return repo.DocumentKVPatchResult{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.DocumentKVPatchResult{}, err
	}
	return repo.DocumentKVPatchResult{Revision: rev, Changes: changes, UpdatedBy: &actor}, nil
}

// presenceRetention bounds how long presence events stay in the log. Readers
// only use the last minute; the slack keeps reconnect replays meaningful.
const presenceRetention = 10 * time.Minute

func (s *Store) AppendDocumentEvent(ctx context.Context, documentID, kind string, data json.RawMessage, actor auth.Principal) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if _, err := q.LockDocumentForKV(ctx, documentID); errors.Is(err, pgx.ErrNoRows) {
		return repo.ErrNotFound
	} else if err != nil {
		return err
	}
	rev, err := q.GetDocumentKVRevision(ctx, documentID)
	if err != nil {
		return err
	}
	if kind == repo.DocumentEventPresence {
		if err := q.DeleteStaleDocumentPresenceEvents(ctx, dbsqlc.DeleteStaleDocumentPresenceEventsParams{DocumentID: documentID, MaxAgeSeconds: int32(presenceRetention / time.Second)}); err != nil {
			return err
		}
	}
	if err := insertAndNotifyDocumentKVEvent(ctx, q, dbsqlc.InsertDocumentKVEventParams{DocumentID: documentID, Revision: rev + 1, Kind: kind, Changes: []byte("[]"), Data: data, UpdatedByType: string(actor.Type), UpdatedByID: actor.ID, UpdatedByEmail: actor.Email, UpdatedByName: actor.Name}); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func insertAndNotifyDocumentKVEvent(ctx context.Context, q *dbsqlc.Queries, event dbsqlc.InsertDocumentKVEventParams) error {
	if err := q.InsertDocumentKVEvent(ctx, event); err != nil {
		return err
	}
	return q.NotifyDocumentKVEvent(ctx, event.DocumentID)
}

func (s *Store) CreateOwnershipTransfer(ctx context.Context, saID string, from auth.Principal, toEmail string) (repo.OwnershipTransfer, error) {
	toID, err := s.q.GetUserIDByEmail(ctx, toEmail)
	if errors.Is(err, pgx.ErrNoRows) {
		toID = newID("usr")
		err = s.q.InsertPlaceholderUser(ctx, dbsqlc.InsertPlaceholderUserParams{ID: toID, Email: toEmail})
	}
	if err != nil {
		return repo.OwnershipTransfer{}, err
	}
	id := newID("xfer")
	err = s.q.InsertOwnershipTransfer(ctx, dbsqlc.InsertOwnershipTransferParams{ID: id, ServiceAccountID: saID, FromUserID: from.ID, ToUserID: toID})
	return repo.OwnershipTransfer{ID: id, ServiceAccountID: saID, FromUserID: from.ID, ToUserID: toID, Status: repo.StatusPending}, err
}
func (s *Store) ListOwnershipTransfers(ctx context.Context, user auth.Principal) ([]repo.OwnershipTransfer, error) {
	rows, err := s.q.ListOwnershipTransfers(ctx, user.ID)
	if err != nil {
		return nil, err
	}
	out := make([]repo.OwnershipTransfer, 0, len(rows))
	for _, r := range rows {
		out = append(out, repo.OwnershipTransfer{ID: r.ID, ServiceAccountID: r.ServiceAccountID, FromUserID: r.FromUserID, ToUserID: r.ToUserID, Status: r.Status})
	}
	return out, nil
}
func (s *Store) AcceptOwnershipTransfer(ctx context.Context, id string, user auth.Principal) (repo.OwnershipTransfer, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.OwnershipTransfer{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	r, err := q.GetOwnershipTransferForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.OwnershipTransfer{}, repo.ErrNotFound
	}
	if err != nil {
		return repo.OwnershipTransfer{}, err
	}
	x := repo.OwnershipTransfer{ID: r.ID, ServiceAccountID: r.ServiceAccountID, FromUserID: r.FromUserID, ToUserID: r.ToUserID, Status: r.Status}
	if x.ToUserID != user.ID {
		return x, repo.ErrNotTransferTarget
	}
	if x.Status != repo.StatusPending {
		return x, repo.ErrTransferNotPending
	}
	if err := q.UpdateServiceAccountOwner(ctx, dbsqlc.UpdateServiceAccountOwnerParams{OwnerUserID: user.ID, ID: x.ServiceAccountID}); err != nil {
		return x, err
	}
	if _, err := q.AcceptOwnershipTransfer(ctx, id); err != nil {
		return x, err
	}
	x.Status = repo.StatusAccepted
	return x, tx.Commit(ctx)
}
func (s *Store) DeclineOwnershipTransfer(ctx context.Context, id string, user auth.Principal) error {
	_, err := s.q.DeclineOwnershipTransfer(ctx, dbsqlc.DeclineOwnershipTransferParams{ID: id, FromUserID: user.ID})
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.ErrNotFound
	}
	return err
}

func docFromGet(r dbsqlc.GetDocumentRow) repo.Document {
	return repo.Document{ID: r.ID, Title: r.Title, CurrentVersionID: r.CurrentVersionID.String, Owner: auth.Principal{Type: auth.PrincipalType(r.OwnerType), ID: r.OwnerID, Email: r.OwnerEmail, Name: r.OwnerName}, ParentFolderID: r.ParentFolderID}
}
func docFromList(r dbsqlc.ListDocumentsRow) repo.Document {
	d := repo.Document{ID: r.ID, Title: r.Title, CurrentVersionID: r.CurrentVersionID.String, Owner: auth.Principal{Type: auth.PrincipalType(r.OwnerType), ID: r.OwnerID, Email: r.OwnerEmail, Name: r.OwnerName}}
	if r.UpdatedAt.Valid {
		d.UpdatedAt = r.UpdatedAt.Time.Format(time.RFC3339)
	}
	return d
}
func docFromSearch(r dbsqlc.SearchDocumentsRow) repo.Document {
	d := repo.Document{ID: r.ID, Title: r.Title, CurrentVersionID: r.CurrentVersionID.String, Owner: auth.Principal{Type: auth.PrincipalType(r.OwnerType), ID: r.OwnerID, Email: r.OwnerEmail, Name: r.OwnerName}, ParentFolderID: r.ParentFolderID, Snippet: r.Snippet}
	if r.ParentFolderID != "" {
		d.ParentFolder = &repo.FolderBreadcrumb{ID: r.ParentFolderID, Title: r.ParentFolderTitle}
	}
	if r.UpdatedAt.Valid {
		d.UpdatedAt = r.UpdatedAt.Time.Format(time.RFC3339)
	}
	return d
}
func commentFromGet(r dbsqlc.GetCommentRow) repo.Comment {
	c := repo.Comment{ID: r.ID, DocumentID: r.DocumentID, VersionID: r.CreatedOnVersionID, Author: auth.Principal{Type: auth.PrincipalType(r.AuthorType), ID: r.AuthorID, Email: r.AuthorEmail, Name: r.AuthorName}, Body: r.Body, SelectedText: r.SelectedText, Status: r.Status, RootCommentID: r.RootCommentID, CreatedAt: pgTimeRFC3339(r.CreatedAt), ResolvedAt: pgTimeRFC3339(r.ResolvedAt), Edited: r.Edited}
	if r.ParentCommentID.Valid {
		c.ParentCommentID = r.ParentCommentID.String
	}
	// The anchor is best-effort presentation metadata (replies store "{}"); a
	// malformed anchor must not make the comment itself unreadable.
	_ = json.Unmarshal(r.AnchorJson, &c.Anchor)
	return c
}
func commentFromReply(r dbsqlc.GetCommentForReplyRow) repo.Comment {
	c := repo.Comment{ID: r.ID, DocumentID: r.DocumentID, VersionID: r.CreatedOnVersionID, Author: auth.Principal{Type: auth.PrincipalType(r.AuthorType), ID: r.AuthorID, Email: r.AuthorEmail, Name: r.AuthorName}, Body: r.Body, SelectedText: r.SelectedText, Status: r.Status, RootCommentID: r.RootCommentID, CreatedAt: pgTimeRFC3339(r.CreatedAt), ResolvedAt: pgTimeRFC3339(r.ResolvedAt), Edited: r.Edited}
	if r.ParentCommentID.Valid {
		c.ParentCommentID = r.ParentCommentID.String
	}
	_ = json.Unmarshal(r.AnchorJson, &c.Anchor)
	return c
}
func commentFromUpdate(r dbsqlc.GetCommentForUpdateRow, bodyChanged bool) repo.Comment {
	c := repo.Comment{ID: r.ID, DocumentID: r.DocumentID, VersionID: r.CreatedOnVersionID, Author: auth.Principal{Type: auth.PrincipalType(r.AuthorType), ID: r.AuthorID, Email: r.AuthorEmail, Name: r.AuthorName}, Body: r.Body, SelectedText: r.SelectedText, Status: r.Status, RootCommentID: r.RootCommentID, CreatedAt: pgTimeRFC3339(r.CreatedAt), ResolvedAt: pgTimeRFC3339(r.ResolvedAt), Edited: r.Edited || bodyChanged}
	if r.ParentCommentID.Valid {
		c.ParentCommentID = r.ParentCommentID.String
	}
	_ = json.Unmarshal(r.AnchorJson, &c.Anchor)
	return c
}
func commentFromList(r dbsqlc.ListCommentsRow) repo.Comment {
	c := repo.Comment{ID: r.ID, DocumentID: r.DocumentID, VersionID: r.CreatedOnVersionID, Author: auth.Principal{Type: auth.PrincipalType(r.AuthorType), ID: r.AuthorID, Email: r.AuthorEmail, Name: r.AuthorName}, Body: r.Body, SelectedText: r.SelectedText, Status: r.Status, RootCommentID: r.RootCommentID, CreatedAt: pgTimeRFC3339(r.CreatedAt), ResolvedAt: pgTimeRFC3339(r.ResolvedAt), Edited: r.Edited}
	if r.ParentCommentID.Valid {
		c.ParentCommentID = r.ParentCommentID.String
	}
	// See commentFromGet: a malformed anchor is tolerated deliberately.
	_ = json.Unmarshal(r.AnchorJson, &c.Anchor)
	return c
}

func (s *Store) ListEffectiveAccess(ctx context.Context, rt, rid string) ([]repo.EffectiveAccessItem, error) {
	chain, err := s.q.ListResourceAncestors(ctx, dbsqlc.ListResourceAncestorsParams{ResourceType: rt, ResourceID: rid})
	if err != nil {
		return nil, err
	}
	if len(chain) == 0 {
		return []repo.EffectiveAccessItem{}, nil
	}

	by := map[string]*repo.EffectiveAccessItem{}
	add := func(p auth.Principal, src repo.AccessSource) {
		k := string(p.Type) + ":" + p.ID
		if by[k] == nil {
			by[k] = &repo.EffectiveAccessItem{Principal: p}
		}
		by[k].EffectiveRole = repo.MaxRole(by[k].EffectiveRole, src.Role)
		by[k].Sources = append(by[k].Sources, src)
	}

	root := chain[0]
	ownerP := auth.Principal{
		Type:       auth.PrincipalType(root.OwnerType),
		ID:         root.OwnerID,
		Email:      root.OwnerEmail,
		Name:       root.OwnerName,
		PictureURL: root.OwnerPictureUrl,
	}
	add(ownerP, repo.AccessSource{ResourceType: root.AncestorType, ResourceID: root.AncestorID, ResourceTitle: root.Title, Role: repo.RoleOwner})

	ids := make([]string, 0, len(chain))
	titles := map[string]string{}
	rtypes := map[string]string{}
	for _, a := range chain {
		ids = append(ids, a.AncestorID)
		titles[a.AncestorID] = a.Title
		rtypes[a.AncestorID] = a.AncestorType
	}

	grants, err := s.q.ListGrantsForResources(ctx, ids)
	if err != nil {
		return nil, err
	}
	for _, g := range grants {
		p := auth.Principal{Type: auth.PrincipalType(g.PrincipalType), ID: g.PrincipalID, Email: g.PrincipalEmail, Name: g.PrincipalName}
		add(p, repo.AccessSource{ResourceType: rtypes[g.ResourceID], ResourceID: g.ResourceID, ResourceTitle: titles[g.ResourceID], Role: repo.Role(g.Role), GrantID: g.ID})
	}

	out := make([]repo.EffectiveAccessItem, 0, len(by))
	for _, v := range by {
		out = append(out, *v)
	}
	return out, nil
}
func (s *Store) ListPins(ctx context.Context, p auth.Principal) ([]repo.Pin, error) {
	rows, err := s.q.ListPins(ctx, dbsqlc.ListPinsParams{PrincipalType: string(p.Type), PrincipalID: p.ID})
	if err != nil {
		return nil, err
	}
	out := make([]repo.Pin, 0, len(rows))
	for _, r := range rows {
		out = append(out, repo.Pin{ResourceType: r.ResourceType, ResourceID: r.ResourceID})
	}
	return out, nil
}
func (s *Store) PutPin(ctx context.Context, p auth.Principal, rt, rid string) error {
	return s.q.PutPin(ctx, dbsqlc.PutPinParams{PrincipalType: string(p.Type), PrincipalID: p.ID, ResourceType: rt, ResourceID: rid})
}
func (s *Store) DeletePin(ctx context.Context, p auth.Principal, rt, rid string) error {
	return s.q.DeletePin(ctx, dbsqlc.DeletePinParams{PrincipalType: string(p.Type), PrincipalID: p.ID, ResourceType: rt, ResourceID: rid})
}
func (s *Store) ListHiddenFeaturedItems(ctx context.Context, p auth.Principal) ([]string, error) {
	return s.q.ListHiddenFeaturedItems(ctx, dbsqlc.ListHiddenFeaturedItemsParams{PrincipalType: string(p.Type), PrincipalID: p.ID})
}
func (s *Store) HideFeaturedItem(ctx context.Context, p auth.Principal, rid string) error {
	return s.q.HideFeaturedItem(ctx, dbsqlc.HideFeaturedItemParams{PrincipalType: string(p.Type), PrincipalID: p.ID, ResourceID: rid})
}
