package postgres

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/razorpay/slashdocs/api/internal/auth"
	dbsqlc "github.com/razorpay/slashdocs/api/internal/db/sqlc"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

type moveDestinationCandidate struct {
	id       string
	title    string
	parentID string
	sortKey  string
}

type moveDestinationCandidatePage struct {
	parent                  string
	items                   []moveDestinationCandidate
	hasBefore, hasAfter     bool
	knownBefore, knownAfter bool
}

type moveDestinationContext struct {
	resource       repo.MoveDestinationResource
	currentFolder  string
	excluded       map[string]struct{}
	subtreeHeight  int
	includeOrgWide bool
}

type moveDestinationReader struct {
	raw dbsqlc.DBTX
	q   *dbsqlc.Queries
	s   *Store
}

func (s *Store) MoveDestinationResource(ctx context.Context, p auth.Principal, resourceType, resourceID string, includeOrgWide bool) (repo.MoveDestinationResource, error) {
	moveCtx, err := s.moveDestinationReader().context(ctx, p, resourceType, resourceID, includeOrgWide)
	if err != nil {
		return repo.MoveDestinationResource{}, err
	}
	return moveCtx.resource, nil
}

func (s *Store) BootstrapMoveDestinations(ctx context.Context, p auth.Principal, resourceType, resourceID, revealFolderID string, limit int, includeOrgWide bool) (repo.MoveDestinationBootstrap, error) { //nolint:gocyclo // Snapshot orchestration keeps authorization, anchored levels, and batched enrichment visibly ordered.
	// One repeatable-read snapshot covers resource authorization, every
	// anchored level, and enrichment. After fixed resource/path lookups this is
	// one candidate query per level plus one batched access query and one
	// batched has-children query (depth 15 is at most 23 reads for folders).
	tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return repo.MoveDestinationBootstrap{}, err
	}
	defer rollback(ctx, tx)
	if _, err := tx.Exec(ctx, `SET LOCAL jit=off`); err != nil {
		return repo.MoveDestinationBootstrap{}, err
	}
	r := moveDestinationReader{raw: tx, q: s.q.WithTx(tx), s: s}
	moveCtx, err := r.context(ctx, p, resourceType, resourceID, includeOrgWide)
	if err != nil {
		return repo.MoveDestinationBootstrap{}, err
	}
	path, restricted := moveCtx.resource.Path, moveCtx.resource.PathRestricted
	if revealFolderID != "" {
		if _, blocked := moveCtx.excluded[revealFolderID]; blocked {
			return repo.MoveDestinationBootstrap{}, repo.ErrNotFound
		}
		chain, err := r.accessChain(ctx, p, revealFolderID)
		if err != nil || !moveDestinationDiscoverable(chain, includeOrgWide) {
			if err != nil && !errors.Is(err, repo.ErrNotFound) {
				return repo.MoveDestinationBootstrap{}, err
			}
			return repo.MoveDestinationBootstrap{}, repo.ErrNotFound
		}
		path, restricted = moveDestinationSafePath(chain, includeOrgWide)
	}

	parents, anchors := []string{""}, []string{""}
	if len(path) > 0 {
		parents = make([]string, len(path))
		anchors = append([]string(nil), path...)
		for i := 1; i < len(path); i++ {
			parents[i] = path[i-1]
		}
	}
	candidatePages := make([]moveDestinationCandidatePage, len(parents))
	allCandidateIDs := make([]string, 0, len(parents)*limit)
	for i := range parents {
		page, pageErr := r.candidatePage(ctx, p, moveCtx, parents[i], nil, anchors[i], limit)
		if pageErr != nil {
			return repo.MoveDestinationBootstrap{}, pageErr
		}
		candidatePages[i] = page
		allCandidateIDs = append(allCandidateIDs, candidateIDs(page.items)...)
	}
	chains, err := r.accessChains(ctx, p, allCandidateIDs)
	if err != nil {
		return repo.MoveDestinationBootstrap{}, err
	}
	allNodes := make([]repo.MoveDestinationNode, 0, len(allCandidateIDs))
	levelStarts := make([]int, len(candidatePages)+1)
	for i, candidatePage := range candidatePages {
		levelStarts[i] = len(allNodes)
		nodes := moveDestinationNodes(candidatePage.items, chains, candidatePage.parent, moveCtx)
		if len(nodes) != len(candidatePage.items) {
			return repo.MoveDestinationBootstrap{}, repo.ErrNotFound
		}
		allNodes = append(allNodes, nodes...)
	}
	levelStarts[len(candidatePages)] = len(allNodes)
	if err := r.populateHasChildren(ctx, p, allNodes, moveCtx); err != nil {
		return repo.MoveDestinationBootstrap{}, err
	}
	levels := make([]repo.MoveDestinationLevel, len(candidatePages))
	for i, candidatePage := range candidatePages {
		levels[i] = repo.MoveDestinationLevel{
			Parent: candidatePage.parent,
			Page:   candidatePage.materialize(allNodes[levelStarts[i]:levelStarts[i+1]]),
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.MoveDestinationBootstrap{}, err
	}
	focus := ""
	if len(path) > 0 {
		focus = path[len(path)-1]
	}
	return repo.MoveDestinationBootstrap{Resource: moveCtx.resource, Path: path, PathRestricted: restricted, Levels: levels, Focus: focus}, nil
}

func (s *Store) moveDestinationReader() moveDestinationReader {
	return moveDestinationReader{raw: s.db, q: s.q, s: s}
}

func (r moveDestinationReader) context(ctx context.Context, p auth.Principal, resourceType, resourceID string, includeOrgWide bool) (moveDestinationContext, error) {
	out := moveDestinationContext{includeOrgWide: includeOrgWide, excluded: map[string]struct{}{}, subtreeHeight: 1}
	var err error
	switch resourceType {
	case "document":
		out, err = r.documentContext(ctx, p, resourceID, includeOrgWide)
	case "folder":
		out, err = r.folderContext(ctx, p, resourceID, includeOrgWide)
	default:
		return out, repo.ErrNotFound
	}
	if err != nil {
		return out, err
	}

	if out.currentFolder == "" {
		out.resource.SourceVisible = true
		return out, nil
	}
	chain, err := r.accessChain(ctx, p, out.currentFolder)
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			out.resource.PathRestricted = true
			return out, nil
		}
		return out, err
	}
	if !moveDestinationDiscoverable(chain, includeOrgWide) {
		out.resource.PathRestricted = true
		return out, nil
	}
	out.resource.SourceVisible = true
	out.resource.Path, out.resource.PathRestricted = moveDestinationSafePath(chain, includeOrgWide)
	return out, nil
}

func (r moveDestinationReader) documentContext(ctx context.Context, p auth.Principal, resourceID string, includeOrgWide bool) (moveDestinationContext, error) {
	out := moveDestinationContext{includeOrgWide: includeOrgWide, excluded: map[string]struct{}{}, subtreeHeight: 1}
	docRow, err := r.q.GetDocument(ctx, resourceID)
	if errors.Is(err, pgx.ErrNoRows) {
		return out, repo.ErrNotFound
	}
	if err != nil {
		return out, err
	}
	doc := docFromGet(docRow)
	docRole, err := roleForDocumentQ(ctx, r.q, p, resourceID)
	if err != nil {
		return out, err
	}
	if !roleAtLeast(docRole, repo.RoleViewer) {
		return out, repo.ErrNotFound
	}
	out.resource = repo.MoveDestinationResource{Type: "document", ID: resourceID, Title: doc.Title, Source: repo.MoveSource{Kind: "root"}}
	out.currentFolder = doc.ParentFolderID
	if doc.ParentFolderID != "" {
		out.resource.Source = repo.MoveSource{Kind: "folder", FolderID: doc.ParentFolderID}
	}
	out.resource.CanMove = roleAtLeast(docRole, repo.RoleEditor)
	if !out.resource.CanMove {
		out.resource.CannotMoveReason = "editor_required"
		return out, nil
	}
	directRole, err := directRoleForDocumentQ(ctx, r.q, p, resourceID)
	if err != nil {
		return out, err
	}
	out.resource.WouldLoseAccess = out.currentFolder != "" && !roleAtLeast(directRole, repo.RoleEditor)
	if out.currentFolder == "" || docRole == repo.RoleOwner {
		return out, nil
	}
	sourceRole, err := roleForFolderQ(ctx, r.q, p, out.currentFolder)
	if err != nil {
		return out, err
	}
	if !roleAtLeast(sourceRole, repo.RoleEditor) {
		out.resource.CanMove = false
		out.resource.CannotMoveReason = "source_editor_required"
	}
	return out, nil
}

func (r moveDestinationReader) folderContext(ctx context.Context, p auth.Principal, resourceID string, includeOrgWide bool) (moveDestinationContext, error) {
	out := moveDestinationContext{includeOrgWide: includeOrgWide, excluded: map[string]struct{}{}, subtreeHeight: 1}
	folder, err := r.s.getFolder(ctx, r.q, resourceID)
	if err != nil {
		return out, err
	}
	role, err := roleForFolderQ(ctx, r.q, p, resourceID)
	if err != nil {
		return out, err
	}
	if !roleAtLeast(role, repo.RoleViewer) {
		return out, repo.ErrNotFound
	}
	out.resource = repo.MoveDestinationResource{Type: "folder", ID: resourceID, Title: folder.Title, Source: repo.MoveSource{Kind: "root"}}
	out.currentFolder = folder.ParentFolderID
	if folder.ParentFolderID != "" {
		out.resource.Source = repo.MoveSource{Kind: "folder", FolderID: folder.ParentFolderID}
	}
	out.resource.CanMove = role == repo.RoleOwner
	if !out.resource.CanMove {
		out.resource.CannotMoveReason = "owner_required"
	}
	height, err := r.q.GetFolderSubtreeHeight(ctx, resourceID)
	if err != nil {
		return out, err
	}
	out.subtreeHeight = int(height)
	out.excluded, err = folderSubtreeIDs(ctx, r.raw, resourceID)
	return out, err
}

func (s *Store) MoveDestinationPath(ctx context.Context, p auth.Principal, resourceType, resourceID, targetFolderID string, includeOrgWide bool) ([]string, bool, error) {
	r := s.moveDestinationReader()
	moveCtx, err := r.context(ctx, p, resourceType, resourceID, includeOrgWide)
	if err != nil {
		return nil, false, err
	}
	if _, excluded := moveCtx.excluded[targetFolderID]; excluded {
		return nil, false, repo.ErrNotFound
	}
	chain, err := r.accessChain(ctx, p, targetFolderID)
	if err != nil {
		return nil, false, err
	}
	if !moveDestinationDiscoverable(chain, includeOrgWide) {
		return nil, false, repo.ErrNotFound
	}
	path, restricted := moveDestinationSafePath(chain, includeOrgWide)
	return path, restricted, nil
}

func (s *Store) ListMoveDestinations(ctx context.Context, p auth.Principal, resourceType, resourceID, parentFolderID string, after *repo.MoveDestinationKey, anchorFolderID, anchorDirection string, limit int, includeOrgWide bool) (repo.MoveDestinationPage, error) {
	if parentFolderID == "" {
		tx, err := s.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
		if err != nil {
			return repo.MoveDestinationPage{}, err
		}
		defer rollback(ctx, tx)
		if _, err := tx.Exec(ctx, `SET LOCAL jit=off`); err != nil {
			return repo.MoveDestinationPage{}, err
		}
		r := moveDestinationReader{raw: tx, q: s.q.WithTx(tx), s: s}
		moveCtx, err := r.context(ctx, p, resourceType, resourceID, includeOrgWide)
		if err != nil {
			return repo.MoveDestinationPage{}, err
		}
		page, err := r.list(ctx, p, moveCtx, parentFolderID, after, anchorFolderID, anchorDirection, limit)
		if err != nil {
			return repo.MoveDestinationPage{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return repo.MoveDestinationPage{}, err
		}
		return page, nil
	}
	r := s.moveDestinationReader()
	moveCtx, err := r.context(ctx, p, resourceType, resourceID, includeOrgWide)
	if err != nil {
		return repo.MoveDestinationPage{}, err
	}
	return r.list(ctx, p, moveCtx, parentFolderID, after, anchorFolderID, anchorDirection, limit)
}

func (r moveDestinationReader) list(ctx context.Context, p auth.Principal, moveCtx moveDestinationContext, parentFolderID string, after *repo.MoveDestinationKey, anchorFolderID, anchorDirection string, limit int) (repo.MoveDestinationPage, error) {
	if err := r.authorizeParent(ctx, p, parentFolderID, moveCtx.includeOrgWide, moveCtx.excluded); err != nil {
		return repo.MoveDestinationPage{}, err
	}

	if anchorFolderID != "" && anchorDirection != "" {
		anchorRows, err := r.levelCandidates(ctx, p, parentFolderID, nil, anchorFolderID, 1, moveCtx)
		if err != nil {
			return repo.MoveDestinationPage{}, err
		}
		if len(anchorRows) != 1 {
			return repo.MoveDestinationPage{}, repo.ErrNotFound
		}
		after = &repo.MoveDestinationKey{Title: anchorRows[0].sortKey, ID: anchorRows[0].id, Before: anchorDirection == "before"}
		anchorFolderID = ""
	}
	return r.page(ctx, p, moveCtx, parentFolderID, after, anchorFolderID, limit)
}

func (r moveDestinationReader) authorizeParent(ctx context.Context, p auth.Principal, parentFolderID string, includeOrgWide bool, excluded map[string]struct{}) error {
	if parentFolderID == "" {
		return nil
	}
	if _, blocked := excluded[parentFolderID]; blocked {
		return repo.ErrNotFound
	}
	chain, err := r.accessChain(ctx, p, parentFolderID)
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			return repo.ErrNotFound
		}
		return err
	}
	if !moveDestinationDiscoverable(chain, includeOrgWide) {
		return repo.ErrNotFound
	}
	return nil
}

func moveDestinationNodes(candidates []moveDestinationCandidate, chains map[string]*folderSearchAccessChain, parentFolderID string, moveCtx moveDestinationContext) []repo.MoveDestinationNode {
	nodes := make([]repo.MoveDestinationNode, 0, len(candidates))
	for _, candidate := range candidates {
		chain := chains[candidate.id]
		if !moveDestinationDiscoverable(chain, moveCtx.includeOrgWide) {
			continue
		}
		// A nested direct share is shown as a virtual root only when its real
		// parent is not discoverable. Visible children belong in that parent's
		// expansion and must not be duplicated at the root.
		if parentFolderID == "" && candidate.parentID != "" && len(chain.items) > 1 && moveDestinationChainItemDiscoverable(chain, len(chain.items)-2, moveCtx.includeOrgWide) {
			continue
		}
		nodes = append(nodes, moveDestinationNode(candidate, chain, moveCtx))
	}
	return nodes
}

func (s *Store) SearchMoveDestinations(ctx context.Context, p auth.Principal, resourceType, resourceID, query string, limit int, includeOrgWide bool) (repo.MoveDestinationSearchResult, error) {
	r := s.moveDestinationReader()
	moveCtx, err := r.context(ctx, p, resourceType, resourceID, includeOrgWide)
	if err != nil {
		return repo.MoveDestinationSearchResult{}, err
	}
	rows, err := r.q.SearchMoveDestinationFoldersByTitle(ctx, dbsqlc.SearchMoveDestinationFoldersByTitleParams{
		PrincipalType:     string(p.Type),
		PrincipalID:       p.ID,
		GoogleGroupIds:    p.GoogleGroupIDs,
		IncludeOrgWide:    includeOrgWide,
		Query:             escapeMoveDestinationSearch(query),
		ExcludedFolderIds: moveDestinationExcludedIDs(moveCtx.excluded),
		RowLimit:          int32(limit + 1), //nolint:gosec // HTTP and MCP callers cap move-search limits at 50.
	})
	if err != nil {
		return repo.MoveDestinationSearchResult{}, err
	}
	candidates := make([]moveDestinationCandidate, 0, len(rows))
	for _, row := range rows {
		candidates = append(candidates, moveDestinationCandidate{
			id: row.ID, title: row.Title, parentID: row.ParentFolderID,
			sortKey: strings.ToLower(row.Title),
		})
	}
	hasMore := len(candidates) > limit
	if hasMore {
		candidates = candidates[:limit]
	}
	chains, err := r.accessChains(ctx, p, candidateIDs(candidates))
	if err != nil {
		return repo.MoveDestinationSearchResult{}, err
	}
	items := make([]repo.MoveDestinationNode, 0, len(candidates))
	for _, candidate := range candidates {
		chain := chains[candidate.id]
		if !moveDestinationDiscoverable(chain, includeOrgWide) {
			continue
		}
		node := moveDestinationNode(candidate, chain, moveCtx)
		node.Ancestors, node.AncestorsTruncated = moveDestinationSafeBreadcrumbs(chain, includeOrgWide)
		items = append(items, node)
	}
	if err := r.populateHasChildren(ctx, p, items, moveCtx); err != nil {
		return repo.MoveDestinationSearchResult{}, err
	}
	return repo.MoveDestinationSearchResult{Items: items, HasMore: hasMore}, nil
}

func (s *Store) MoveDocument(ctx context.Context, p auth.Principal, documentID, destinationFolderID string, acknowledgeAccessLoss bool, verify repo.MoveSourceVerifier) (repo.MoveResult, repo.MoveSource, bool, error) { //nolint:gocyclo // The lock-authorize-token-mutate order is security-sensitive and intentionally linear.
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return repo.MoveResult{}, repo.MoveSource{}, false, err
	}
	defer rollback(ctx, tx)
	q := s.q.WithTx(tx)
	if err := q.AcquireFolderTreeLock(ctx, folderTreeLockID); err != nil {
		return repo.MoveResult{}, repo.MoveSource{}, false, err
	}
	doc, source, err := lockDocumentForMove(ctx, q, documentID)
	if err != nil {
		return repo.MoveResult{}, repo.MoveSource{}, false, err
	}
	// Keep the source token oracle behind all resource authorization checks.
	if err := authorizeDocumentMove(ctx, q, p, doc, source, destinationFolderID); err != nil {
		return repo.MoveResult{}, repo.MoveSource{}, false, err
	}
	if verify == nil || !verify(source) {
		return repo.MoveResult{}, repo.MoveSource{}, false, repo.ErrSourceChanged
	}
	accessLost := false
	if destinationFolderID == "" {
		directRole, err := directRoleForDocumentQ(ctx, q, p, documentID)
		if err != nil {
			return repo.MoveResult{}, repo.MoveSource{}, false, err
		}
		accessLost = !roleAtLeast(directRole, repo.RoleEditor)
		if accessLost && !acknowledgeAccessLoss {
			return repo.MoveResult{}, repo.MoveSource{}, false, repo.ErrAccessLossConfirmationRequired
		}
	}

	undoAllowed := source.Kind == "root"
	if source.Kind == "folder" {
		role, err := roleForFolderQ(ctx, q, p, source.FolderID)
		if err != nil {
			return repo.MoveResult{}, repo.MoveSource{}, false, err
		}
		undoAllowed = roleAtLeast(role, repo.RoleEditor)
	}
	if accessLost {
		undoAllowed = false
	}
	if (source.Kind == "root" && destinationFolderID == "") || (source.Kind == "folder" && source.FolderID == destinationFolderID) {
		if err := tx.Commit(ctx); err != nil {
			return repo.MoveResult{}, repo.MoveSource{}, false, err
		}
		return repo.MoveResult{}, source, false, nil
	}

	var result repo.MoveResult
	if destinationFolderID == "" {
		moved, err := q.MoveDocumentToRoot(ctx, dbsqlc.MoveDocumentToRootParams{DocumentID: documentID, FolderID: source.FolderID})
		if err != nil {
			return repo.MoveResult{}, repo.MoveSource{}, false, err
		}
		if moved == 0 {
			return repo.MoveResult{}, repo.MoveSource{}, false, repo.ErrSourceChanged
		}
		result.Moved = true
		result.AccessLost = accessLost
	} else {
		result, err = moveDocumentIntoFolder(ctx, q, destinationFolderID, documentID)
		if err != nil {
			return repo.MoveResult{}, repo.MoveSource{}, false, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return repo.MoveResult{}, repo.MoveSource{}, false, err
	}
	return result, source, undoAllowed, nil
}

func (r moveDestinationReader) page(ctx context.Context, p auth.Principal, moveCtx moveDestinationContext, parent string, key *repo.MoveDestinationKey, anchorID string, limit int) (repo.MoveDestinationPage, error) {
	candidatePage, err := r.candidatePage(ctx, p, moveCtx, parent, key, anchorID, limit)
	if err != nil {
		return repo.MoveDestinationPage{}, err
	}
	return r.materializePage(ctx, p, moveCtx, candidatePage)
}

func (r moveDestinationReader) candidatePage(ctx context.Context, p auth.Principal, moveCtx moveDestinationContext, parent string, key *repo.MoveDestinationKey, anchorID string, limit int) (moveDestinationCandidatePage, error) {
	page := moveDestinationCandidatePage{parent: parent}
	if limit <= 0 {
		return page, nil
	}
	if anchorID == "" {
		candidates, err := r.levelCandidates(ctx, p, parent, key, "", limit+1, moveCtx)
		if err != nil {
			return page, err
		}
		before := key != nil && key.Before
		hasExtra := len(candidates) > limit
		if hasExtra {
			candidates = candidates[:limit]
		}
		if before {
			reverseMoveDestinationCandidates(candidates)
		}
		page.items = candidates
		page.hasBefore, page.hasAfter = before && hasExtra, !before && hasExtra
		page.knownBefore, page.knownAfter = key != nil && !before, key != nil && before
		return page, nil
	}
	anchor, beforeRows, afterRows, err := r.anchoredCandidateWindow(ctx, p, parent, anchorID, limit+1, moveCtx)
	if err != nil {
		return page, err
	}
	beforeTake := minInt(limit/2, len(beforeRows))
	afterTake := minInt(limit-1-beforeTake, len(afterRows))
	if missing := limit - 1 - beforeTake - afterTake; missing > 0 {
		beforeTake = minInt(len(beforeRows), beforeTake+missing)
	}
	selectedBefore := append([]moveDestinationCandidate(nil), beforeRows[:beforeTake]...)
	reverseMoveDestinationCandidates(selectedBefore)
	candidates := make([]moveDestinationCandidate, 0, limit)
	candidates = append(candidates, selectedBefore...)
	candidates = append(candidates, anchor)
	candidates = append(candidates, afterRows[:afterTake]...)
	page.items = candidates
	page.hasBefore, page.hasAfter = len(beforeRows) > beforeTake, len(afterRows) > afterTake
	return page, nil
}

func (r moveDestinationReader) materializePage(ctx context.Context, p auth.Principal, moveCtx moveDestinationContext, candidatePage moveDestinationCandidatePage) (repo.MoveDestinationPage, error) {
	chains, err := r.accessChains(ctx, p, candidateIDs(candidatePage.items))
	if err != nil {
		return repo.MoveDestinationPage{}, err
	}
	nodes := moveDestinationNodes(candidatePage.items, chains, candidatePage.parent, moveCtx)
	if len(nodes) != len(candidatePage.items) {
		return repo.MoveDestinationPage{}, repo.ErrNotFound
	}
	if err := r.populateHasChildren(ctx, p, nodes, moveCtx); err != nil {
		return repo.MoveDestinationPage{}, err
	}
	return candidatePage.materialize(nodes), nil
}

func (candidatePage moveDestinationCandidatePage) materialize(nodes []repo.MoveDestinationNode) repo.MoveDestinationPage {
	page := repo.MoveDestinationPage{Items: nodes}
	byID := make(map[string]moveDestinationCandidate, len(candidatePage.items))
	for _, candidate := range candidatePage.items {
		byID[candidate.id] = candidate
	}
	if len(nodes) > 0 && (candidatePage.hasBefore || candidatePage.knownBefore) {
		first := byID[nodes[0].ID]
		page.Before = &repo.MoveDestinationKey{Title: first.sortKey, ID: first.id, Before: true}
	}
	if len(nodes) > 0 && (candidatePage.hasAfter || candidatePage.knownAfter) {
		last := byID[nodes[len(nodes)-1].ID]
		page.After = &repo.MoveDestinationKey{Title: last.sortKey, ID: last.id}
	}
	return page
}

func (r moveDestinationReader) levelCandidates(ctx context.Context, p auth.Principal, parent string, key *repo.MoveDestinationKey, anchorID string, limit int, moveCtx moveDestinationContext) ([]moveDestinationCandidate, error) {
	if parent == "" {
		return r.rootCandidates(ctx, p, key, anchorID, limit, moveCtx)
	}
	return r.childCandidates(ctx, parent, key, anchorID, limit, moveCtx.excluded)
}

func (r moveDestinationReader) anchoredCandidateWindow(ctx context.Context, p auth.Principal, parent, anchorID string, limit int, moveCtx moveDestinationContext) (moveDestinationCandidate, []moveDestinationCandidate, []moveDestinationCandidate, error) {
	if parent == "" {
		return r.rootAnchoredCandidateWindow(ctx, p, anchorID, limit, moveCtx)
	}
	return r.childAnchoredCandidateWindow(ctx, parent, anchorID, limit, moveCtx.excluded)
}

func (r moveDestinationReader) childAnchoredCandidateWindow(ctx context.Context, parent, anchorID string, limit int, excluded map[string]struct{}) (moveDestinationCandidate, []moveDestinationCandidate, []moveDestinationCandidate, error) {
	rows, err := r.raw.Query(ctx, `WITH base AS MATERIALIZED (
		SELECT f.id,f.title,COALESCE(f.parent_folder_id,'') AS parent_folder_id,
		       lower(f.title) COLLATE "C" AS sort_key
		FROM folders f
		WHERE f.parent_folder_id=$1::text AND NOT (f.id=ANY($2::text[]))
	), anchor AS (
		SELECT * FROM base WHERE id=$3::text
	), before_rows AS (
		SELECT b.*,-1 AS side FROM base b CROSS JOIN anchor a
		WHERE (b.sort_key,b.id) < (a.sort_key,a.id)
		ORDER BY b.sort_key DESC,b.id DESC LIMIT $4
	), after_rows AS (
		SELECT b.*,1 AS side FROM base b CROSS JOIN anchor a
		WHERE (b.sort_key,b.id) > (a.sort_key,a.id)
		ORDER BY b.sort_key,b.id LIMIT $4
	)
	SELECT id,title,parent_folder_id,sort_key,side FROM before_rows
	UNION ALL SELECT id,title,parent_folder_id,sort_key,0 FROM anchor
	UNION ALL SELECT id,title,parent_folder_id,sort_key,side FROM after_rows`, parent, moveDestinationExcludedIDs(excluded), anchorID, limit)
	if err != nil {
		return moveDestinationCandidate{}, nil, nil, err
	}
	defer rows.Close()
	return scanAnchoredCandidateWindow(rows)
}

func (r moveDestinationReader) rootAnchoredCandidateWindow(ctx context.Context, p auth.Principal, anchorID string, limit int, moveCtx moveDestinationContext) (moveDestinationCandidate, []moveDestinationCandidate, []moveDestinationCandidate, error) {
	rows, err := r.raw.Query(ctx, `WITH RECURSIVE eligible AS MATERIALIZED (
		SELECT f.id,f.title,f.parent_folder_id,lower(f.title) COLLATE "C" AS sort_key
		FROM folders f
		WHERE f.owner_type=$1::text AND f.owner_id=$2::text
		  AND NOT (f.id=ANY($5::text[]))
		UNION
		SELECT f.id,f.title,f.parent_folder_id,lower(f.title) COLLATE "C" AS sort_key
		FROM resource_grants g
		JOIN folders f ON f.id=g.resource_id
		WHERE g.resource_type='folder' AND g.revoked_at IS NULL
		  AND NOT (f.id=ANY($5::text[]))
		  AND ((g.principal_type=$1::text AND g.principal_id=$2::text)
		    OR (g.principal_type='google_group' AND g.principal_id=ANY($3::text[]))
		    OR ($4::boolean AND g.principal_type='anyone'))
	), ancestry(entry_id,id,parent_folder_id,depth) AS (
		SELECT e.id,e.id,e.parent_folder_id,0 FROM eligible e WHERE e.parent_folder_id IS NOT NULL
		UNION ALL
		SELECT a.entry_id,f.id,f.parent_folder_id,a.depth+1
		FROM ancestry a JOIN folders f ON f.id=a.parent_folder_id
		WHERE a.depth < $8::int
	), roots AS (
		SELECT e.* FROM eligible e WHERE e.parent_folder_id IS NULL
		UNION ALL
		SELECT e.* FROM eligible e WHERE e.parent_folder_id IS NOT NULL AND NOT EXISTS (
		  SELECT 1 FROM ancestry a JOIN eligible ancestor ON ancestor.id=a.id
		  WHERE a.entry_id=e.id AND a.depth>0)
	), numbered AS MATERIALIZED (
		SELECT r.*,row_number() OVER (ORDER BY r.sort_key,r.id) AS position
		FROM roots r
	), anchor AS MATERIALIZED (
		SELECT position FROM numbered WHERE id=$6::text
	)
	SELECT n.id,n.title,COALESCE(n.parent_folder_id,''),n.sort_key,
	       CASE WHEN n.position<a.position THEN -1 WHEN n.position>a.position THEN 1 ELSE 0 END AS side
	FROM numbered n CROSS JOIN anchor a
	WHERE n.position BETWEEN GREATEST(1,a.position-$7::int) AND a.position+$7::int
	ORDER BY n.position`, string(p.Type), p.ID, p.GoogleGroupIDs, moveCtx.includeOrgWide, moveDestinationExcludedIDs(moveCtx.excluded), anchorID, limit, folderMaxDepth)
	if err != nil {
		return moveDestinationCandidate{}, nil, nil, err
	}
	defer rows.Close()
	anchor, before, after, err := scanAnchoredCandidateWindow(rows)
	reverseMoveDestinationCandidates(before)
	return anchor, before, after, err
}

func scanAnchoredCandidateWindow(rows pgx.Rows) (moveDestinationCandidate, []moveDestinationCandidate, []moveDestinationCandidate, error) {
	var anchor moveDestinationCandidate
	before, after := []moveDestinationCandidate{}, []moveDestinationCandidate{}
	anchorCount := 0
	for rows.Next() {
		var candidate moveDestinationCandidate
		var side int
		if err := rows.Scan(&candidate.id, &candidate.title, &candidate.parentID, &candidate.sortKey, &side); err != nil {
			return moveDestinationCandidate{}, nil, nil, err
		}
		switch side {
		case -1:
			before = append(before, candidate)
		case 0:
			anchor, anchorCount = candidate, anchorCount+1
		case 1:
			after = append(after, candidate)
		}
	}
	if err := rows.Err(); err != nil {
		return moveDestinationCandidate{}, nil, nil, err
	}
	if anchorCount != 1 {
		return moveDestinationCandidate{}, nil, nil, repo.ErrNotFound
	}
	return anchor, before, after, nil
}

func (r moveDestinationReader) childCandidates(ctx context.Context, parent string, key *repo.MoveDestinationKey, anchorID string, limit int, excluded map[string]struct{}) ([]moveDestinationCandidate, error) {
	comparison, order := ">", "ASC"
	keyTitle, keyID := "", ""
	if key != nil {
		keyTitle, keyID = key.Title, key.ID
		if key.Before {
			comparison, order = "<", "DESC"
		}
	}
	query := fmt.Sprintf(`SELECT f.id,f.title,COALESCE(f.parent_folder_id,''),lower(f.title) COLLATE "C"
		FROM folders f
		WHERE f.parent_folder_id=$1::text AND NOT (f.id=ANY($2::text[]))
		  AND ($3::text='' OR ((lower(f.title) COLLATE "C"),f.id) %s (($3::text COLLATE "C"),$4::text))
		  AND ($6::text='' OR f.id=$6::text)
		ORDER BY lower(f.title) COLLATE "C" %s,f.id %s LIMIT $5`, comparison, order, order)
	rows, err := r.raw.Query(ctx, query, parent, moveDestinationExcludedIDs(excluded), keyTitle, keyID, limit, anchorID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMoveDestinationCandidates(rows)
}

func (r moveDestinationReader) rootCandidates(ctx context.Context, p auth.Principal, key *repo.MoveDestinationKey, anchorID string, limit int, moveCtx moveDestinationContext) ([]moveDestinationCandidate, error) {
	comparison, order := ">", "ASC"
	keyTitle, keyID := "", ""
	if key != nil {
		keyTitle, keyID = key.Title, key.ID
		if key.Before {
			comparison, order = "<", "DESC"
		}
	}
	query := fmt.Sprintf(`WITH RECURSIVE eligible AS MATERIALIZED (
		SELECT f.id,f.title,f.parent_folder_id,lower(f.title) COLLATE "C" AS sort_key
		FROM folders f
		WHERE f.owner_type=$1::text AND f.owner_id=$2::text
		  AND NOT (f.id=ANY($5::text[]))
		UNION
		SELECT f.id,f.title,f.parent_folder_id,lower(f.title) COLLATE "C" AS sort_key
		FROM resource_grants g
		JOIN folders f ON f.id=g.resource_id
		WHERE g.resource_type='folder' AND g.revoked_at IS NULL
		  AND NOT (f.id=ANY($5::text[]))
		  AND ((g.principal_type=$1::text AND g.principal_id=$2::text)
		    OR (g.principal_type='google_group' AND g.principal_id=ANY($3::text[]))
		    OR ($4::boolean AND g.principal_type='anyone'))
	), ancestry(entry_id,id,parent_folder_id,depth) AS (
		SELECT e.id,e.id,e.parent_folder_id,0 FROM eligible e WHERE e.parent_folder_id IS NOT NULL
		UNION ALL
		SELECT a.entry_id,f.id,f.parent_folder_id,a.depth+1
		FROM ancestry a JOIN folders f ON f.id=a.parent_folder_id
		WHERE a.depth < $10::int
	), roots AS (
		SELECT e.* FROM eligible e WHERE e.parent_folder_id IS NULL
		UNION ALL
		SELECT e.* FROM eligible e WHERE e.parent_folder_id IS NOT NULL AND NOT EXISTS (
		  SELECT 1 FROM ancestry a JOIN eligible ancestor ON ancestor.id=a.id
		  WHERE a.entry_id=e.id AND a.depth>0)
	)
	SELECT r.id,r.title,COALESCE(r.parent_folder_id,''),r.sort_key
	FROM roots r
	WHERE ($6::text='' OR (r.sort_key,r.id) %s (($6::text COLLATE "C"),$7::text))
	  AND ($9::text='' OR r.id=$9::text)
	ORDER BY r.sort_key %s,r.id %s LIMIT $8`, comparison, order, order)
	rows, err := r.raw.Query(ctx, query, string(p.Type), p.ID, p.GoogleGroupIDs, moveCtx.includeOrgWide, moveDestinationExcludedIDs(moveCtx.excluded), keyTitle, keyID, limit, anchorID, folderMaxDepth)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMoveDestinationCandidates(rows)
}

func moveDestinationExcludedIDs(excluded map[string]struct{}) []string {
	ids := make([]string, 0, len(excluded))
	for id := range excluded {
		ids = append(ids, id)
	}
	return ids
}

func reverseMoveDestinationCandidates(items []moveDestinationCandidate) {
	for left, right := 0, len(items)-1; left < right; left, right = left+1, right-1 {
		items[left], items[right] = items[right], items[left]
	}
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func escapeMoveDestinationSearch(value string) string {
	value = strings.ReplaceAll(value, `\`, `\\`)
	value = strings.ReplaceAll(value, `%`, `\%`)
	return strings.ReplaceAll(value, `_`, `\_`)
}

func scanMoveDestinationCandidates(rows pgx.Rows) ([]moveDestinationCandidate, error) {
	out := make([]moveDestinationCandidate, 0)
	for rows.Next() {
		var candidate moveDestinationCandidate
		if err := rows.Scan(&candidate.id, &candidate.title, &candidate.parentID, &candidate.sortKey); err != nil {
			return nil, err
		}
		out = append(out, candidate)
	}
	return out, rows.Err()
}

func candidateIDs(candidates []moveDestinationCandidate) []string {
	ids := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		ids = append(ids, candidate.id)
	}
	return ids
}

func (r moveDestinationReader) accessChain(ctx context.Context, p auth.Principal, folderID string) (*folderSearchAccessChain, error) {
	chains, err := r.accessChains(ctx, p, []string{folderID})
	if err != nil {
		return nil, err
	}
	chain := chains[folderID]
	if chain == nil || len(chain.items) == 0 {
		return nil, repo.ErrNotFound
	}
	return chain, nil
}

func (r moveDestinationReader) accessChains(ctx context.Context, p auth.Principal, folderIDs []string) (map[string]*folderSearchAccessChain, error) {
	chains := make(map[string]*folderSearchAccessChain, len(folderIDs))
	if len(folderIDs) == 0 {
		return chains, nil
	}
	rows, err := r.q.ListFolderAccessChains(ctx, dbsqlc.ListFolderAccessChainsParams{
		PrincipalType: string(p.Type), PrincipalID: p.ID, GoogleGroupIds: p.GoogleGroupIDs, FolderIds: folderIDs,
	})
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		chain := chains[row.CandidateID]
		if chain == nil {
			chain = &folderSearchAccessChain{}
			chains[row.CandidateID] = chain
		}
		grant := grantRankRole(row.GrantRank)
		effective := repo.MaxRole(chain.inherited, grant)
		if row.IsOwner {
			effective = repo.MaxRole(effective, repo.RoleOwner)
		}
		chain.inherited = repo.MaxRole(chain.inherited, grant)
		if row.IsOwner {
			chain.inherited = repo.MaxRole(chain.inherited, repo.RoleEditor)
		}
		chain.private = chain.private || row.HasPrivateAccess
		chain.orgWide = chain.orgWide || row.HasAnyoneAccess
		chain.inheritedPrivate = chain.inheritedPrivate || row.HasPrivateAccess
		chain.inheritedOrgWide = chain.inheritedOrgWide || row.HasAnyoneAccess
		chain.items = append(chain.items, repo.FolderAccess{ID: row.ID, Title: row.Title, Role: effective})
		chain.privateItems = append(chain.privateItems, chain.inheritedPrivate)
		chain.orgWideItems = append(chain.orgWideItems, chain.inheritedOrgWide)
	}
	return chains, nil
}

func moveDestinationDiscoverable(chain *folderSearchAccessChain, includeOrgWide bool) bool {
	return chain != nil && len(chain.items) > 0 && roleAtLeast(chain.items[len(chain.items)-1].Role, repo.RoleViewer) && (chain.private || includeOrgWide && chain.orgWide)
}

func moveDestinationChainItemDiscoverable(chain *folderSearchAccessChain, index int, includeOrgWide bool) bool {
	if chain == nil || index < 0 || index >= len(chain.items) || !roleAtLeast(chain.items[index].Role, repo.RoleViewer) {
		return false
	}
	return chain.privateItems[index] || includeOrgWide && chain.orgWideItems[index]
}

func moveDestinationSafePath(chain *folderSearchAccessChain, includeOrgWide bool) ([]string, bool) {
	if chain == nil {
		return nil, false
	}
	start := len(chain.items)
	for i := len(chain.items) - 1; i >= 0; i-- {
		if !moveDestinationChainItemDiscoverable(chain, i, includeOrgWide) {
			break
		}
		start = i
	}
	path := make([]string, 0, len(chain.items)-start)
	for _, item := range chain.items[start:] {
		path = append(path, item.ID)
	}
	return path, start > 0
}

func moveDestinationSafeBreadcrumbs(chain *folderSearchAccessChain, includeOrgWide bool) ([]repo.FolderBreadcrumb, bool) {
	path, restricted := moveDestinationSafePath(chain, includeOrgWide)
	if len(path) <= 1 {
		return nil, restricted
	}
	titles := make(map[string]string, len(chain.items))
	for _, item := range chain.items {
		titles[item.ID] = item.Title
	}
	out := make([]repo.FolderBreadcrumb, 0, len(path)-1)
	for _, id := range path[:len(path)-1] {
		out = append(out, repo.FolderBreadcrumb{ID: id, Title: titles[id]})
	}
	return out, restricted
}

func moveDestinationNode(candidate moveDestinationCandidate, chain *folderSearchAccessChain, moveCtx moveDestinationContext) repo.MoveDestinationNode {
	role := chain.items[len(chain.items)-1].Role
	parentVisible := candidate.parentID == ""
	if candidate.parentID != "" && len(chain.items) > 1 {
		parentVisible = moveDestinationChainItemDiscoverable(chain, len(chain.items)-2, moveCtx.includeOrgWide)
	}
	var parentID *string
	if candidate.parentID != "" && parentVisible {
		parent := candidate.parentID
		parentID = &parent
	}
	access := "view"
	if roleAtLeast(role, repo.RoleEditor) {
		access = "edit"
	}
	node := repo.MoveDestinationNode{
		ID: candidate.id, Title: candidate.title, ParentID: parentID, Access: access,
		Selectable: moveCtx.resource.CanMove && access == "edit", Current: candidate.id == moveCtx.currentFolder,
		CanCreateChild:   access == "edit" && len(chain.items) < folderMaxDepth,
		RestrictedParent: candidate.parentID != "" && !parentVisible,
	}
	switch {
	case access != "edit":
		node.Selectable = false
		node.Reason = "view_only"
	case node.Current:
		node.Selectable = false
		node.Reason = "current"
	case moveCtx.resource.Type == "folder" && len(chain.items)+moveCtx.subtreeHeight > folderMaxDepth:
		node.Selectable = false
		node.Reason = "too_deep"
	}
	return node
}

func (r moveDestinationReader) populateHasChildren(ctx context.Context, _ auth.Principal, nodes []repo.MoveDestinationNode, moveCtx moveDestinationContext) error {
	if len(nodes) == 0 {
		return nil
	}
	parentIDs := make([]string, 0, len(nodes))
	for _, node := range nodes {
		parentIDs = append(parentIDs, node.ID)
	}
	rows, err := r.raw.Query(ctx, `SELECT DISTINCT f.parent_folder_id
		FROM folders f
		WHERE f.parent_folder_id=ANY($1::text[]) AND NOT (f.id=ANY($2::text[]))`,
		parentIDs, moveDestinationExcludedIDs(moveCtx.excluded))
	if err != nil {
		return err
	}
	visibleParents := make(map[string]struct{}, len(nodes))
	for rows.Next() {
		var parentID string
		if err := rows.Scan(&parentID); err != nil {
			rows.Close()
			return err
		}
		visibleParents[parentID] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for i := range nodes {
		_, nodes[i].HasChildren = visibleParents[nodes[i].ID]
	}
	return nil
}

func folderSubtreeIDs(ctx context.Context, raw dbsqlc.DBTX, folderID string) (map[string]struct{}, error) {
	rows, err := raw.Query(ctx, `WITH RECURSIVE subtree(id,depth) AS (
		SELECT id,1 FROM folders WHERE id=$1
		UNION ALL SELECT f.id,subtree.depth+1 FROM folders f JOIN subtree ON f.parent_folder_id=subtree.id WHERE subtree.depth < $2
	) SELECT id FROM subtree`, folderID, folderMaxDepth)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[string]struct{})
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = struct{}{}
	}
	return out, rows.Err()
}
