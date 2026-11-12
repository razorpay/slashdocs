package postgres

import (
	"context"
	"fmt"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/testdb"
)

func TestEscapeMoveDestinationSearchTreatsWildcardsLiterally(t *testing.T) {
	if got, want := escapeMoveDestinationSearch(`a%b_c\d`), `a\%b\_c\\d`; got != want {
		t.Fatalf("escaped=%q want=%q", got, want)
	}
}

func TestMoveDestinationSafePathHidesPrefix(t *testing.T) {
	chain := &folderSearchAccessChain{
		items: []repo.FolderAccess{
			{ID: "hidden", Title: "Hidden", Role: repo.RoleNone},
			{ID: "visible", Title: "Visible", Role: repo.RoleViewer},
			{ID: "child", Title: "Child", Role: repo.RoleEditor},
		},
		privateItems: []bool{false, true, true},
		orgWideItems: []bool{false, false, false},
	}
	path, restricted := moveDestinationSafePath(chain, false)
	if got := fmt.Sprint(path); got != "[visible child]" || !restricted {
		t.Fatalf("path=%s restricted=%t", got, restricted)
	}
	breadcrumbs, truncated := moveDestinationSafeBreadcrumbs(chain, false)
	if len(breadcrumbs) != 1 || breadcrumbs[0].ID != "visible" || !truncated {
		t.Fatalf("breadcrumbs=%+v truncated=%t", breadcrumbs, truncated)
	}
}

func TestMoveDestinationSafePathDoesNotPromotePublicLinkOnlyAncestor(t *testing.T) {
	chain := &folderSearchAccessChain{
		items: []repo.FolderAccess{
			{ID: "link-only", Title: "Link only", Role: repo.RoleViewer},
			{ID: "private-child", Title: "Private child", Role: repo.RoleEditor},
		},
		privateItems: []bool{false, true},
		orgWideItems: []bool{true, true},
	}
	publicPath, restricted := moveDestinationSafePath(chain, false)
	if got := fmt.Sprint(publicPath); got != "[private-child]" || !restricted {
		t.Fatalf("public path=%s restricted=%t", got, restricted)
	}
	orgPath, restricted := moveDestinationSafePath(chain, true)
	if got := fmt.Sprint(orgPath); got != "[link-only private-child]" || restricted {
		t.Fatalf("org path=%s restricted=%t", got, restricted)
	}
}

func TestMoveDestinationHasChildrenIsPerParentBeyondFiveHundredRows(t *testing.T) {
	ctx := context.Background()
	store, err := Connect(ctx, testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	principal := auth.Principal{Type: auth.PrincipalUser, ID: "usr_fanout"}
	if _, err := store.db.Exec(ctx, `INSERT INTO folders(id,title,owner_type,owner_id) VALUES
		('fld_a','A','user',$1),('fld_z','Z','user',$1)`, principal.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(ctx, `INSERT INTO folders(id,title,owner_type,owner_id,parent_folder_id)
		SELECT 'fld_a_child_'||g::text,'A child '||g::text,'user',$1,'fld_a' FROM generate_series(1,501) g`, principal.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(ctx, `INSERT INTO folders(id,title,owner_type,owner_id,parent_folder_id)
		VALUES('fld_z_child','Z child','user',$1,'fld_z')`, principal.ID); err != nil {
		t.Fatal(err)
	}
	nodes := []repo.MoveDestinationNode{{ID: "fld_a"}, {ID: "fld_z"}}
	moveCtx := moveDestinationContext{resource: repo.MoveDestinationResource{CanMove: true}, excluded: map[string]struct{}{}, includeOrgWide: false}
	if err := store.moveDestinationReader().populateHasChildren(ctx, principal, nodes, moveCtx); err != nil {
		t.Fatal(err)
	}
	if !nodes[0].HasChildren || !nodes[1].HasChildren {
		t.Fatalf("has_children must be correct per parent: %+v", nodes)
	}
}

func containsMoveDestination(nodes []repo.MoveDestinationNode, id string) bool {
	for _, node := range nodes {
		if node.ID == id {
			return true
		}
	}
	return false
}
