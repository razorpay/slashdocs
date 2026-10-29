package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/razorpay/slashdocs/api/internal/auth"
	dbsqlc "github.com/razorpay/slashdocs/api/internal/db/sqlc"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// folderTreeLockID keys the advisory lock that serializes folder-structure
// mutations. Cycle and depth invariants are check-then-write and cannot be
// expressed as database constraints, so every transaction that reshapes the
// tree takes this transaction-scoped lock first (see AcquireFolderTreeLock in
// queries/folders.sql).
const folderTreeLockID int64 = 0x6169646f63735f66 // "slashdocs_f"

// folderMaxDepth is the deepest folder nesting the product allows.
const folderMaxDepth = 15

// grantRankRole maps the numeric role rank computed by ListFolderAccessChain
// (owner=4, editor=3, commenter=2, viewer=1, none=0) back to a repo.Role.
func grantRankRole(rank int32) repo.Role {
	switch rank {
	case 4:
		return repo.RoleOwner
	case 3:
		return repo.RoleEditor
	case 2:
		return repo.RoleCommenter
	case 1:
		return repo.RoleViewer
	default:
		return repo.RoleNone
	}
}

// FolderAccessChain returns the folder's ancestor chain (root first, the
// folder itself last) together with the principal's effective role at each
// level, resolved in a single query. It returns repo.ErrNotFound when the
// folder does not exist; a chain entry's role is repo.RoleNone when the
// principal has no access at that level.
func (s *Store) FolderAccessChain(ctx context.Context, p auth.Principal, folderID string) ([]repo.FolderAccess, error) {
	rows, err := s.q.ListFolderAccessChain(ctx, dbsqlc.ListFolderAccessChainParams{
		FolderID:       folderID,
		PrincipalType:  string(p.Type),
		PrincipalID:    p.ID,
		GoogleGroupIds: p.GoogleGroupIDs,
	})
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, repo.ErrNotFound
	}
	out := make([]repo.FolderAccess, 0, len(rows))
	for _, r := range rows {
		role := grantRankRole(r.GrantRank)
		if r.IsOwner {
			role = repo.MaxRole(role, repo.RoleOwner)
		}
		out = append(out, repo.FolderAccess{ID: r.ID, Title: r.Title, Role: role})
	}
	return out, nil
}

func (s *Store) RoleForFolder(ctx context.Context, p auth.Principal, folderID string) (repo.Role, error) {
	chain, err := s.FolderAccessChain(ctx, p, folderID)
	if errors.Is(err, repo.ErrNotFound) {
		// A missing folder and an unshared one are the same permission
		// verdict (RoleNone), not an error; errors are reserved for lookup
		// faults so callers can map them to a 500 rather than a 403.
		return repo.RoleNone, nil
	}
	if err != nil {
		return "", err
	}
	return chain[len(chain)-1].Role, nil
}

func (s *Store) CreateFolder(ctx context.Context, owner auth.Principal, title, parent string) (repo.Folder, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.Folder{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if parent != "" {
		// The depth check below is check-then-insert; serialize with other
		// tree mutations so a concurrent re-parent cannot invalidate it.
		if err := q.AcquireFolderTreeLock(ctx, folderTreeLockID); err != nil {
			return repo.Folder{}, err
		}
		depth, err := q.GetFolderDepth(ctx, parent)
		if err != nil {
			return repo.Folder{}, err
		}
		if int(depth)+1 > folderMaxDepth {
			return repo.Folder{}, repo.ErrConflict
		}
	}
	id := newID("fld")
	if err := q.InsertFolder(ctx, dbsqlc.InsertFolderParams{ID: id, Title: title, OwnerType: string(owner.Type), OwnerID: owner.ID, ParentFolderID: parent}); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) {
			switch pgErr.Code {
			case "23505": // sibling title uniqueness
				return repo.Folder{}, repo.ErrConflict
			case "23503": // parent folder does not exist
				return repo.Folder{}, repo.ErrNotFound
			}
		}
		return repo.Folder{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.Folder{}, err
	}
	return repo.Folder{ID: id, Title: title, Owner: owner, ParentFolderID: parent}, nil
}

func (s *Store) GetFolder(ctx context.Context, id string) (repo.Folder, error) {
	return s.getFolder(ctx, s.q, id)
}

// getFolder loads a folder with its ancestor breadcrumbs via q, which may be
// transaction-scoped.
func (s *Store) getFolder(ctx context.Context, q *dbsqlc.Queries, id string) (repo.Folder, error) {
	r, err := q.GetFolder(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.Folder{}, repo.ErrNotFound
	}
	if err != nil {
		return repo.Folder{}, err
	}
	f := repo.Folder{
		ID:             r.ID,
		Title:          r.Title,
		ParentFolderID: r.ParentFolderID,
		Owner:          auth.Principal{Type: auth.PrincipalType(r.OwnerType), ID: r.OwnerID, Name: r.OwnerName, Email: r.OwnerEmail},
	}
	if f.ParentFolderID != "" {
		anc, err := q.ListFolderAncestors(ctx, dbsqlc.ListFolderAncestorsParams{
			FolderID: f.ParentFolderID,
			MaxDepth: folderMaxDepth,
		})
		if err != nil {
			return repo.Folder{}, err
		}
		f.Ancestors = make([]repo.FolderBreadcrumb, 0, len(anc))
		for _, a := range anc {
			f.Ancestors = append(f.Ancestors, repo.FolderBreadcrumb{ID: a.ID, Title: a.Title})
		}
	}
	return f, nil
}

func (s *Store) UpdateFolder(ctx context.Context, id, title string, parent *string) (repo.Folder, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.Folder{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if parent != nil {
		// Re-parenting validates the cycle and depth invariants before
		// writing; serialize with other tree mutations so concurrent moves
		// cannot interleave between check and write.
		if err := q.AcquireFolderTreeLock(ctx, folderTreeLockID); err != nil {
			return repo.Folder{}, err
		}
	}
	f, err := s.getFolder(ctx, q, id)
	if err != nil {
		return f, err
	}
	var updateErr error
	switch {
	case title != "" && parent != nil:
		if err := s.validateFolderParent(ctx, q, id, *parent); err != nil {
			return repo.Folder{}, err
		}
		updateErr = q.UpdateFolderTitleAndParent(ctx, dbsqlc.UpdateFolderTitleAndParentParams{
			ID: id, Title: title, ParentFolderID: *parent,
		})
	case title != "":
		updateErr = q.UpdateFolderTitle(ctx, dbsqlc.UpdateFolderTitleParams{ID: id, Title: title})
	case parent != nil:
		if err := s.validateFolderParent(ctx, q, id, *parent); err != nil {
			return repo.Folder{}, err
		}
		updateErr = q.UpdateFolderParent(ctx, dbsqlc.UpdateFolderParentParams{ID: id, ParentFolderID: *parent})
	}
	if updateErr != nil {
		var pgErr *pgconn.PgError
		if errors.As(updateErr, &pgErr) && pgErr.Code == "23505" {
			return repo.Folder{}, repo.ErrConflict
		}
		return repo.Folder{}, updateErr
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.Folder{}, err
	}
	return s.GetFolder(ctx, id)
}

func (s *Store) validateFolderParent(ctx context.Context, q *dbsqlc.Queries, id, destination string) error {
	if destination == id {
		return repo.ErrConflict
	}
	if destination == "" {
		return nil
	}
	if _, err := s.getFolder(ctx, q, destination); err != nil {
		return err
	}
	isCycle, err := q.IsFolderAncestorOf(ctx, dbsqlc.IsFolderAncestorOfParams{StartID: destination, FolderID: id})
	if err != nil {
		return err
	}
	if isCycle {
		return repo.ErrConflict
	}
	parentDepth, err := q.GetFolderDepth(ctx, destination)
	if err != nil {
		return err
	}
	subtreeHeight, err := q.GetFolderSubtreeHeight(ctx, id)
	if err != nil {
		return err
	}
	if int(parentDepth)+int(subtreeHeight) > folderMaxDepth {
		return repo.ErrConflict
	}
	return nil
}

func (s *Store) DeleteFolder(ctx context.Context, id string, p auth.Principal) error {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	// Deleting a subtree reshapes the tree; serialize with concurrent moves so
	// a folder cannot be re-parented into the subtree while it is deleted.
	if err := q.AcquireFolderTreeLock(ctx, folderTreeLockID); err != nil {
		return err
	}
	own, err := q.GetFolderOwnership(ctx, dbsqlc.GetFolderOwnershipParams{FolderID: id, OwnerType: string(p.Type), OwnerID: p.ID})
	if err != nil {
		return err
	}
	if !own.FolderExists {
		return repo.ErrNotFound
	}
	if !own.IsOwner {
		return repo.ErrForbidden
	}
	orphans, err := q.ListFolderSubtreeOrphans(ctx, dbsqlc.ListFolderSubtreeOrphansParams{FolderID: id, OwnerType: string(p.Type), OwnerID: p.ID})
	if err != nil {
		return err
	}
	for _, o := range orphans {
		if err := moveOrphanToRoot(ctx, q, o); err != nil {
			return err
		}
	}
	deleted, err := q.DeleteFolderSubtree(ctx, dbsqlc.DeleteFolderSubtreeParams{FolderID: id, OwnerType: string(p.Type), OwnerID: p.ID})
	if err != nil {
		return err
	}
	if deleted == 0 {
		return repo.ErrNotFound
	}
	return tx.Commit(ctx)
}

// moveOrphanToRoot moves a folder that a folder delete keeps to its owner's
// root. Root titles are unique for each owner, so it adds " (2)", " (3)", and
// so on to the title when the owner already has a root folder with that title.
func moveOrphanToRoot(ctx context.Context, q *dbsqlc.Queries, o dbsqlc.ListFolderSubtreeOrphansRow) error {
	title := o.Title
	for n := 2; ; n++ {
		taken, err := q.RootFolderTitleTaken(ctx, dbsqlc.RootFolderTitleTakenParams{OwnerType: o.OwnerType, OwnerID: o.OwnerID, Title: title})
		if err != nil {
			return err
		}
		if !taken {
			return q.UpdateFolderTitleAndParent(ctx, dbsqlc.UpdateFolderTitleAndParentParams{ID: o.ID, Title: title})
		}
		title = fmt.Sprintf("%s (%d)", o.Title, n)
	}
}

func (s *Store) ListFolder(ctx context.Context, p auth.Principal, folderID, path string) ([]repo.FolderEntry, bool, *repo.Folder, error) {
	parent, err := s.resolveFolderPath(ctx, p, folderID, path)
	if err != nil {
		return nil, false, nil, err
	}

	out := []repo.FolderEntry{}
	isRoot := parent == ""
	if isRoot {
		rows, err := s.q.ListRootFolderEntries(ctx, dbsqlc.ListRootFolderEntriesParams{PrincipalType: string(p.Type), PrincipalID: p.ID, GoogleGroupIds: p.GoogleGroupIDs})
		if err != nil {
			return nil, false, nil, err
		}
		for _, r := range rows {
			if len(out) == 50 {
				break
			}
			f := repo.Folder{ID: r.ID, Title: r.Title, ParentFolderID: r.ParentFolderID, Owner: auth.Principal{Type: auth.PrincipalType(r.OwnerType), ID: r.OwnerID, Name: r.OwnerName, Email: r.OwnerEmail}}
			out = append(out, repo.FolderEntry{Type: "folder", Folder: &f, LastActive: r.LastActive.Time.Format(time.RFC3339)})
		}
	} else {
		rows, err := s.q.ListChildFolders(ctx, parent)
		if err != nil {
			return nil, false, nil, err
		}
		for _, r := range rows {
			if len(out) == 50 {
				break
			}
			f := repo.Folder{ID: r.ID, Title: r.Title, ParentFolderID: r.ParentFolderID, Owner: auth.Principal{Type: auth.PrincipalType(r.OwnerType), ID: r.OwnerID, Name: r.OwnerName, Email: r.OwnerEmail}}
			out = append(out, repo.FolderEntry{Type: "folder", Folder: &f})
		}
	}
	hasMore := len(out) == 50

	var cur *repo.Folder
	if parent != "" {
		docs, err := s.q.ListFolderDocuments(ctx, parent)
		if err != nil {
			return nil, false, nil, err
		}
		for _, r := range docs {
			d := folderDocEntryFromRow(r)
			out = append(out, repo.FolderEntry{Type: "document", Document: &d})
		}
		f, err := s.GetFolder(ctx, parent)
		if err != nil {
			return nil, false, nil, err
		}
		cur = &f
	}
	return out, hasMore, cur, nil
}

// resolveFolderPath turns an optional slash-separated title path into a folder
// id, starting from folderID (or the principal's root when empty).
func (s *Store) resolveFolderPath(ctx context.Context, p auth.Principal, folderID, path string) (string, error) {
	parent := folderID
	if path == "" || path == "/" {
		return parent, nil
	}
	for i, part := range strings.Split(strings.Trim(path, "/"), "/") {
		if i == 0 && parent == "" {
			rows, err := s.q.FindRootFoldersByTitle(ctx, dbsqlc.FindRootFoldersByTitleParams{Title: part, PrincipalType: string(p.Type), PrincipalID: p.ID, GoogleGroupIds: p.GoogleGroupIDs})
			if err != nil {
				return "", err
			}
			if len(rows) == 0 {
				return "", repo.ErrNotFound
			}
			if len(rows) > 1 {
				candidates := make([]repo.Folder, 0, len(rows))
				for _, r := range rows {
					candidates = append(candidates, repo.Folder{ID: r.ID, Title: r.Title, Owner: auth.Principal{Type: auth.PrincipalType(r.OwnerType), ID: r.OwnerID, Name: r.OwnerName, Email: r.OwnerEmail}})
				}
				return "", &repo.AmbiguousPathError{Segment: part, Candidates: candidates}
			}
			parent = rows[0].ID
			continue
		}
		id, err := s.q.FindChildFolderIDByTitle(ctx, dbsqlc.FindChildFolderIDByTitleParams{ParentFolderID: parent, Title: part})
		if errors.Is(err, pgx.ErrNoRows) {
			return "", repo.ErrNotFound
		}
		if err != nil {
			return "", err
		}
		parent = id
	}
	return parent, nil
}

func (s *Store) SearchFoldersByTitle(ctx context.Context, p auth.Principal, query string, includeOrgWide bool, limit int32) ([]repo.Folder, error) {
	rows, err := s.q.SearchFoldersByTitle(ctx, dbsqlc.SearchFoldersByTitleParams{
		PrincipalType:  string(p.Type),
		PrincipalID:    p.ID,
		GoogleGroupIds: p.GoogleGroupIDs,
		IncludeOrgWide: includeOrgWide,
		Query:          query,
		RowLimit:       limit,
	})
	if err != nil {
		return nil, err
	}
	var out []repo.Folder
	for _, r := range rows {
		out = append(out, repo.Folder{ID: r.ID, Title: r.Title, ParentFolderID: r.ParentFolderID, Owner: auth.Principal{Type: auth.PrincipalType(r.OwnerType), ID: r.OwnerID, Name: r.OwnerName, Email: r.OwnerEmail}})
	}
	return out, nil
}

func (s *Store) FolderHasGrants(ctx context.Context, folderID string) (bool, error) {
	return s.q.FolderOrAncestorsHaveGrants(ctx, folderID)
}

func (s *Store) RecordFolderOpened(ctx context.Context, folderID string, p auth.Principal) error {
	return s.q.RecordFolderWorkspaceEntry(ctx, dbsqlc.RecordFolderWorkspaceEntryParams{FolderID: folderID, PrincipalType: string(p.Type), PrincipalID: p.ID})
}

func (s *Store) MoveDocumentToFolder(ctx context.Context, _ auth.Principal, folderID, docID string) (bool, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	// The may-broaden-access warning must describe the tree the document
	// actually landed in; serialize with tree mutations so the move and the
	// grant lookup observe the same ancestry.
	if err := q.AcquireFolderTreeLock(ctx, folderTreeLockID); err != nil {
		return false, err
	}
	moved, err := q.MoveDocumentToFolder(ctx, dbsqlc.MoveDocumentToFolderParams{FolderID: folderID, DocumentID: docID})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" { // destination folder does not exist
			return false, repo.ErrNotFound
		}
		return false, err
	}
	if moved == 0 {
		return false, repo.ErrNotFound
	}
	hasGrants, err := q.FolderOrAncestorsHaveGrants(ctx, folderID)
	if err != nil {
		return false, err
	}
	return hasGrants, tx.Commit(ctx)
}

func (s *Store) MoveDocumentToRoot(ctx context.Context, folderID, docID string) error {
	return s.q.MoveDocumentToRoot(ctx, dbsqlc.MoveDocumentToRootParams{DocumentID: docID, FolderID: folderID})
}

func (s *Store) ListFolderDocuments(ctx context.Context, p auth.Principal, folderID string) ([]repo.FolderDocumentEntry, error) {
	rows, err := s.q.ListFolderDocuments(ctx, folderID)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return []repo.FolderDocumentEntry{}, nil
	}

	// Bulk-resolve the caller's effective role for every document in one pass.
	docIDs := make([]string, len(rows))
	ownerByDoc := make(map[string]struct{ ownerType, ownerID string }, len(rows))
	for i, r := range rows {
		docIDs[i] = r.ID
		ownerByDoc[r.ID] = struct{ ownerType, ownerID string }{r.OwnerType, r.OwnerID}
	}

	grantRows, err := s.listGrantsForDocuments(ctx, docIDs)
	if err != nil {
		return nil, err
	}

	roleByDoc := make(map[string]repo.Role, len(rows))
	for _, docID := range docIDs {
		own := ownerByDoc[docID]
		if string(p.Type) == own.ownerType && p.ID == own.ownerID {
			roleByDoc[docID] = repo.RoleOwner
		}
	}
	for _, g := range grantRows {
		if principalHasGrant(p, g.PrincipalType, g.PrincipalID) {
			roleByDoc[g.DocumentID] = repo.MaxRole(roleByDoc[g.DocumentID], repo.Role(g.Role))
		}
	}

	out := make([]repo.FolderDocumentEntry, 0, len(rows))
	for _, r := range rows {
		d := folderDocEntryFromRow(r)
		d.CallerRole = roleByDoc[r.ID]
		out = append(out, d)
	}
	return out, nil
}

func folderDocEntryFromRow(r dbsqlc.ListFolderDocumentsRow) repo.FolderDocumentEntry {
	return repo.FolderDocumentEntry{
		ID:               r.ID,
		Title:            r.Title,
		CurrentVersionID: r.CurrentVersionID,
		ParentFolderID:   r.ParentFolderID,
		Owner:            auth.Principal{Type: auth.PrincipalType(r.OwnerType), ID: r.OwnerID, Name: r.OwnerName, Email: r.OwnerEmail},
	}
}

// folderDocGrantRow is one row from the bulk grant lookup for a set of
// folder-document IDs.
type folderDocGrantRow struct {
	DocumentID    string
	PrincipalType string
	PrincipalID   string
	Role          string
}

// listGrantsForDocuments returns all active grants on the given documents
// (and on their parent folders) in one query, so the caller can compute the
// effective role for a principal without issuing one query per document.
func (s *Store) listGrantsForDocuments(ctx context.Context, docIDs []string) ([]folderDocGrantRow, error) {
	if len(docIDs) == 0 {
		return nil, nil
	}
	// Build $1,$2,... placeholders for the IN clause.
	args := make([]any, len(docIDs))
	placeholders := make([]string, len(docIDs))
	for i, id := range docIDs {
		args[i] = id
		placeholders[i] = fmt.Sprintf("$%d", i+1)
	}
	query := `
WITH RECURSIVE ancestors(doc_id, rid, rtype, depth) AS (
  SELECT d.id, d.id, 'document'::text, 0
  FROM documents d
  WHERE d.id = ANY(ARRAY[` + strings.Join(placeholders, ",") + `]::text[])
  UNION ALL
  SELECT a.doc_id,
         CASE WHEN a.rtype='document' THEN (SELECT parent_folder_id FROM documents WHERE id=a.rid)
              ELSE (SELECT parent_folder_id FROM folders WHERE id=a.rid) END,
         'folder'::text,
         a.depth+1
  FROM ancestors a
  WHERE a.depth < 64
    AND (CASE WHEN a.rtype='document' THEN (SELECT parent_folder_id FROM documents WHERE id=a.rid)
              ELSE (SELECT parent_folder_id FROM folders WHERE id=a.rid) END) IS NOT NULL
)
SELECT a.doc_id, g.principal_type, g.principal_id, g.role
FROM ancestors a
JOIN resource_grants g ON g.resource_type=a.rtype AND g.resource_id=a.rid AND g.revoked_at IS NULL`

	rows, err := s.db.Query(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []folderDocGrantRow
	for rows.Next() {
		var r folderDocGrantRow
		if err := rows.Scan(&r.DocumentID, &r.PrincipalType, &r.PrincipalID, &r.Role); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}
