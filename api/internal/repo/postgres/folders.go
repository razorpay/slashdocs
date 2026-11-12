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
	return folderAccessChain(ctx, s.q, p, folderID)
}

func folderAccessChain(ctx context.Context, q *dbsqlc.Queries, p auth.Principal, folderID string) ([]repo.FolderAccess, error) {
	rows, err := q.ListFolderAccessChain(ctx, dbsqlc.ListFolderAccessChainParams{
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
	chain, err := folderAccessChain(ctx, s.q, p, folderID)
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
	if f.Ancestors, err = ancestors(ctx, q, f.ParentFolderID); err != nil {
		return repo.Folder{}, err
	}
	return f, nil
}

// ancestors gives the breadcrumbs of a folder in the folder parent, root
// first. A folder at the top level has none.
func ancestors(ctx context.Context, q *dbsqlc.Queries, parent string) ([]repo.FolderBreadcrumb, error) {
	if parent == "" {
		return nil, nil
	}
	anc, err := q.ListFolderAncestors(ctx, dbsqlc.ListFolderAncestorsParams{
		FolderID: parent,
		MaxDepth: folderMaxDepth,
	})
	if err != nil {
		return nil, err
	}
	out := make([]repo.FolderBreadcrumb, 0, len(anc))
	for _, a := range anc {
		out = append(out, repo.FolderBreadcrumb{ID: a.ID, Title: a.Title})
	}
	return out, nil
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
			out = append(out, repo.FolderEntry{Type: "folder", Folder: &f, LastActive: r.UpdatedAt.Time.Format(time.RFC3339)})
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
			d := docFromFolderListing(r)
			out = append(out, repo.FolderEntry{Type: "document", Document: &d, LastActive: d.UpdatedAt})
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

func (s *Store) SearchFoldersByTitle(ctx context.Context, p auth.Principal, query string, includeOrgWide bool, minRole repo.Role, limit int32) ([]repo.Folder, error) {
	rows, err := s.q.SearchFoldersByTitle(ctx, dbsqlc.SearchFoldersByTitleParams{
		PrincipalType:  string(p.Type),
		PrincipalID:    p.ID,
		GoogleGroupIds: p.GoogleGroupIDs,
		IncludeOrgWide: includeOrgWide,
		Query:          query,
		MinRole:        string(minRole),
		RowLimit:       limit,
	})
	if err != nil {
		return nil, err
	}
	chains, err := s.folderSearchAccessChains(ctx, p, rows)
	if err != nil {
		return nil, err
	}
	return eligibleFolderSearchResults(rows, chains, includeOrgWide, minRole), nil
}

type folderSearchAccessChain struct {
	items            []repo.FolderAccess
	privateItems     []bool
	orgWideItems     []bool
	private          bool
	orgWide          bool
	inherited        repo.Role
	inheritedPrivate bool
	inheritedOrgWide bool
}

func (s *Store) folderSearchAccessChains(ctx context.Context, p auth.Principal, rows []dbsqlc.SearchFoldersByTitleRow) (map[string]*folderSearchAccessChain, error) {
	chains := make(map[string]*folderSearchAccessChain, len(rows))
	if len(rows) == 0 {
		return chains, nil
	}
	folderIDs := make([]string, 0, len(rows))
	for _, r := range rows {
		folderIDs = append(folderIDs, r.ID)
	}
	accessRows, err := s.q.ListFolderAccessChains(ctx, dbsqlc.ListFolderAccessChainsParams{
		PrincipalType:  string(p.Type),
		PrincipalID:    p.ID,
		GoogleGroupIds: p.GoogleGroupIDs,
		FolderIds:      folderIDs,
	})
	if err != nil {
		return nil, err
	}
	for _, r := range accessRows {
		chain := chains[r.CandidateID]
		if chain == nil {
			chain = &folderSearchAccessChain{}
			chains[r.CandidateID] = chain
		}
		grant := grantRankRole(r.GrantRank)
		effective := repo.MaxRole(chain.inherited, grant)
		if r.IsOwner {
			effective = repo.MaxRole(effective, repo.RoleOwner)
		}
		chain.inherited = repo.MaxRole(chain.inherited, grant)
		if r.IsOwner {
			// A resource has one canonical owner. Ownership of an ancestor
			// propagates to descendants as editor, never as owner.
			chain.inherited = repo.MaxRole(chain.inherited, repo.RoleEditor)
		}
		chain.private = chain.private || r.HasPrivateAccess
		chain.orgWide = chain.orgWide || r.HasAnyoneAccess
		chain.inheritedPrivate = chain.inheritedPrivate || r.HasPrivateAccess
		chain.inheritedOrgWide = chain.inheritedOrgWide || r.HasAnyoneAccess
		chain.items = append(chain.items, repo.FolderAccess{ID: r.ID, Title: r.Title, Role: effective})
		chain.privateItems = append(chain.privateItems, chain.inheritedPrivate)
		chain.orgWideItems = append(chain.orgWideItems, chain.inheritedOrgWide)
	}
	return chains, nil
}

func eligibleFolderSearchResults(rows []dbsqlc.SearchFoldersByTitleRow, chains map[string]*folderSearchAccessChain, includeOrgWide bool, minRole repo.Role) []repo.Folder {
	var out []repo.Folder
	for _, r := range rows {
		f := repo.Folder{ID: r.ID, Title: r.Title, ParentFolderID: r.ParentFolderID, Owner: auth.Principal{Type: auth.PrincipalType(r.OwnerType), ID: r.OwnerID, Name: r.OwnerName, Email: r.OwnerEmail}}
		chain := chains[f.ID]
		// The set-wise query establishes the candidate cap, while this
		// one batch query supplies safe breadcrumbs and rechecks current
		// eligibility without an N+1 lookup. Deleted or newly inaccessible
		// candidates are omitted.
		if chain == nil || len(chain.items) == 0 || !roleAtLeast(chain.items[len(chain.items)-1].Role, minRole) {
			continue
		}
		if !chain.private && (!includeOrgWide || !chain.orgWide) {
			continue
		}
		f.Ancestors, f.AncestorsTruncated = safeAncestorBreadcrumbs(chain.items)
		if r.ParentFolderID != "" && len(f.Ancestors) == 0 {
			// A direct grant can make a nested folder visible while its parent
			// remains hidden. Do not leak that parent's id through the legacy
			// parent_folder_id field when no safe breadcrumb is available.
			f.ParentFolderID = ""
		}
		out = append(out, f)
	}
	return out
}

func roleAtLeast(got, need repo.Role) bool {
	return repo.MaxRole(got, need) == got
}

// safeAncestorBreadcrumbs returns only the contiguous viewer-visible suffix
// of a root-first access chain. Hidden prefixes are represented by the bool;
// their ids and titles never enter the response.
func safeAncestorBreadcrumbs(chain []repo.FolderAccess) ([]repo.FolderBreadcrumb, bool) {
	if len(chain) <= 1 {
		return nil, false
	}
	visible := make([]repo.FolderBreadcrumb, 0, len(chain)-1)
	truncated := false
	for i := len(chain) - 2; i >= 0; i-- {
		if !roleAtLeast(chain[i].Role, repo.RoleViewer) {
			truncated = true
			break
		}
		visible = append(visible, repo.FolderBreadcrumb{ID: chain[i].ID, Title: chain[i].Title})
	}
	for i, j := 0, len(visible)-1; i < j; i, j = i+1, j-1 {
		visible[i], visible[j] = visible[j], visible[i]
	}
	if len(visible) < len(chain)-1 {
		truncated = true
	}
	return visible, truncated
}

func sameMoveSource(expected, actual repo.MoveSource) bool {
	if expected.Kind != actual.Kind {
		return false
	}
	if expected.Kind == "root" {
		return expected.FolderID == ""
	}
	return expected.Kind == "folder" && expected.FolderID != "" && expected.FolderID == actual.FolderID
}

func expectedMoveSourceMatches(expected []*repo.MoveSource, actual repo.MoveSource) bool {
	return len(expected) == 0 || expected[0] == nil || sameMoveSource(*expected[0], actual)
}

func lockDocumentForMove(ctx context.Context, q *dbsqlc.Queries, documentID string) (dbsqlc.LockDocumentForMoveRow, repo.MoveSource, error) {
	doc, err := q.LockDocumentForMove(ctx, documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return dbsqlc.LockDocumentForMoveRow{}, repo.MoveSource{}, repo.ErrNotFound
	}
	if err != nil {
		return dbsqlc.LockDocumentForMoveRow{}, repo.MoveSource{}, err
	}
	source := repo.MoveSource{Kind: "root"}
	if doc.ParentFolderID != "" {
		source = repo.MoveSource{Kind: "folder", FolderID: doc.ParentFolderID}
	}
	return doc, source, nil
}

func roleForFolderQ(ctx context.Context, q *dbsqlc.Queries, p auth.Principal, folderID string) (repo.Role, error) {
	chain, err := folderAccessChain(ctx, q, p, folderID)
	if errors.Is(err, repo.ErrNotFound) {
		// Authorization must not disclose whether a destination exists. A
		// missing folder has no effective role, just like an existing folder
		// that is not shared with this principal; callers should therefore see
		// the same forbidden result in both cases.
		return repo.RoleNone, nil
	}
	if err != nil {
		return repo.RoleNone, err
	}
	if len(chain) == 0 {
		// Keep this helper defensive if the access-chain query ever returns an
		// empty result without the repository sentinel.
		return repo.RoleNone, nil
	}
	return chain[len(chain)-1].Role, nil
}

func roleForDocumentQ(ctx context.Context, q *dbsqlc.Queries, p auth.Principal, documentID string) (repo.Role, error) {
	owner, err := q.GetDocumentOwner(ctx, documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.RoleNone, repo.ErrNotFound
	}
	if err != nil {
		return repo.RoleNone, err
	}
	best := repo.RoleNone
	if string(p.Type) == owner.OwnerType && p.ID == owner.OwnerID {
		best = repo.RoleOwner
	}
	grants, err := q.ListDocumentInheritedRoles(ctx, documentID)
	if err != nil {
		return repo.RoleNone, err
	}
	for _, g := range grants {
		if principalHasGrant(p, g.PrincipalType, g.PrincipalID) {
			best = repo.MaxRole(best, repo.Role(g.Role))
		}
	}
	return best, nil
}

// directRoleForDocumentQ intentionally excludes folder inheritance. It is the
// role the principal will retain after a document is moved to Documents.
func directRoleForDocumentQ(ctx context.Context, q *dbsqlc.Queries, p auth.Principal, documentID string) (repo.Role, error) {
	owner, err := q.GetDocumentOwner(ctx, documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		return repo.RoleNone, repo.ErrNotFound
	}
	if err != nil {
		return repo.RoleNone, err
	}
	best := repo.RoleNone
	if string(p.Type) == owner.OwnerType && p.ID == owner.OwnerID {
		best = repo.RoleOwner
	}
	grants, err := q.ListDocumentInheritedRoles(ctx, documentID)
	if err != nil {
		return repo.RoleNone, err
	}
	for _, grant := range grants {
		if grant.ResourceID == documentID && principalHasGrant(p, grant.PrincipalType, grant.PrincipalID) {
			best = repo.MaxRole(best, repo.Role(grant.Role))
		}
	}
	return best, nil
}

func authorizeDocumentMove(ctx context.Context, q *dbsqlc.Queries, p auth.Principal, doc dbsqlc.LockDocumentForMoveRow, source repo.MoveSource, destination string) error {
	docRole, err := roleForDocumentQ(ctx, q, p, doc.ID)
	if err != nil {
		return err
	}
	// Missing documents and documents the principal cannot view are the same
	// authorization verdict. Keep that boundary ahead of source-token checks.
	if !roleAtLeast(docRole, repo.RoleViewer) {
		return repo.ErrNotFound
	}
	if !roleAtLeast(docRole, repo.RoleEditor) {
		return repo.ErrForbidden
	}
	// Canonical owners can always rescue their document from a folder they
	// cannot edit. Otherwise an editor could move it somewhere that traps the
	// owner permanently.
	if source.Kind == "folder" && docRole != repo.RoleOwner {
		sourceRole, err := roleForFolderQ(ctx, q, p, source.FolderID)
		if err != nil {
			return err
		}
		if !roleAtLeast(sourceRole, repo.RoleEditor) {
			return repo.ErrForbidden
		}
	}
	if destination != "" {
		destinationRole, err := roleForFolderQ(ctx, q, p, destination)
		if err != nil {
			return err
		}
		if !roleAtLeast(destinationRole, repo.RoleEditor) {
			return repo.ErrForbidden
		}
	}
	return nil
}

func (s *Store) FolderMayBroadenAccess(ctx context.Context, folderID string, owner auth.Principal) (bool, error) {
	return s.q.FolderMayBroadenAccess(ctx, dbsqlc.FolderMayBroadenAccessParams{FolderID: folderID, OwnerType: string(owner.Type), OwnerID: owner.ID})
}

func (s *Store) RecordFolderOpened(ctx context.Context, folderID string, p auth.Principal) error {
	return s.q.RecordFolderWorkspaceEntry(ctx, dbsqlc.RecordFolderWorkspaceEntryParams{FolderID: folderID, PrincipalType: string(p.Type), PrincipalID: p.ID})
}

func moveDocumentIntoFolder(ctx context.Context, q *dbsqlc.Queries, folderID, documentID string) (repo.MoveResult, error) {
	movedDoc, err := q.MoveDocumentToFolder(ctx, dbsqlc.MoveDocumentToFolderParams{FolderID: folderID, DocumentID: documentID})
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.Is(err, pgx.ErrNoRows) || errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return repo.MoveResult{}, repo.ErrNotFound
		}
		return repo.MoveResult{}, err
	}
	mayBroaden, err := q.FolderMayBroadenAccess(ctx, dbsqlc.FolderMayBroadenAccessParams{
		FolderID:  folderID,
		OwnerType: movedDoc.OwnerType,
		OwnerID:   movedDoc.OwnerID,
	})
	if err != nil {
		return repo.MoveResult{}, err
	}
	return repo.MoveResult{Moved: true, PermissionWarning: mayBroaden}, nil
}

func (s *Store) MoveDocumentToFolder(ctx context.Context, p auth.Principal, folderID, docID string, expectedSource ...*repo.MoveSource) (repo.MoveResult, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.MoveResult{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	// The may-broaden-access warning must describe the tree the document
	// actually landed in; serialize with tree mutations so the move and the
	// grant lookup observe the same ancestry.
	if err := q.AcquireFolderTreeLock(ctx, folderTreeLockID); err != nil {
		return repo.MoveResult{}, err
	}
	doc, actualSource, err := lockDocumentForMove(ctx, q, docID)
	if err != nil {
		return repo.MoveResult{}, err
	}
	if err := authorizeDocumentMove(ctx, q, p, doc, actualSource, folderID); err != nil {
		return repo.MoveResult{}, err
	}
	if !expectedMoveSourceMatches(expectedSource, actualSource) {
		return repo.MoveResult{}, repo.ErrSourceChanged
	}
	result := repo.MoveResult{Moved: false}
	if actualSource.Kind != "folder" || actualSource.FolderID != folderID {
		if result, err = moveDocumentIntoFolder(ctx, q, folderID, docID); err != nil {
			return repo.MoveResult{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.MoveResult{}, err
	}
	return result, nil
}

func (s *Store) MoveDocumentToRoot(ctx context.Context, p auth.Principal, folderID, docID string, acknowledgeAccessLoss bool) (repo.MoveResult, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.MoveResult{}, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if err := q.AcquireFolderTreeLock(ctx, folderTreeLockID); err != nil {
		return repo.MoveResult{}, err
	}
	doc, actualSource, err := lockDocumentForMove(ctx, q, docID)
	if err != nil {
		return repo.MoveResult{}, err
	}
	if err := authorizeDocumentMove(ctx, q, p, doc, actualSource, ""); err != nil {
		return repo.MoveResult{}, err
	}
	if actualSource.Kind != "folder" || actualSource.FolderID != folderID {
		return repo.MoveResult{}, repo.ErrSourceChanged
	}
	if _, err := q.GetFolder(ctx, folderID); errors.Is(err, pgx.ErrNoRows) {
		return repo.MoveResult{}, repo.ErrNotFound
	} else if err != nil {
		return repo.MoveResult{}, err
	}
	directRole, err := directRoleForDocumentQ(ctx, q, p, docID)
	if err != nil {
		return repo.MoveResult{}, err
	}
	accessLost := !roleAtLeast(directRole, repo.RoleEditor)
	if accessLost && !acknowledgeAccessLoss {
		return repo.MoveResult{}, repo.ErrAccessLossConfirmationRequired
	}
	moved, err := q.MoveDocumentToRoot(ctx, dbsqlc.MoveDocumentToRootParams{DocumentID: docID, FolderID: folderID})
	if err != nil {
		return repo.MoveResult{}, err
	}
	if moved == 0 {
		return repo.MoveResult{}, repo.ErrSourceChanged
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.MoveResult{}, err
	}
	return repo.MoveResult{Moved: true, AccessLost: accessLost}, nil
}

func (s *Store) ListFolderDocuments(ctx context.Context, _ auth.Principal, folderID string) ([]repo.Document, error) {
	rows, err := s.q.ListFolderDocuments(ctx, folderID)
	if err != nil {
		return nil, err
	}
	out := make([]repo.Document, 0, len(rows))
	for _, r := range rows {
		out = append(out, docFromFolderListing(r))
	}
	return out, nil
}

func docFromFolderListing(r dbsqlc.ListFolderDocumentsRow) repo.Document {
	return repo.Document{
		ID:               r.ID,
		Title:            r.Title,
		CurrentVersionID: r.CurrentVersionID,
		ParentFolderID:   r.ParentFolderID,
		Owner:            auth.Principal{Type: auth.PrincipalType(r.OwnerType), ID: r.OwnerID, Name: r.OwnerName, Email: r.OwnerEmail},
		UpdatedAt:        r.UpdatedAt.Time.Format(time.RFC3339),
	}
}
