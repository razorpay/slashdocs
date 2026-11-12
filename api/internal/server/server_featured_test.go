package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"slices"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/server"
)

func TestFeaturedSections(t *testing.T) {
	e := newTestEnv(t)
	folder, err := e.store.CreateFolder(context.Background(), fixtureOwner, "Tutorials", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.store.CreateGrant(context.Background(), "folder", folder.ID, auth.Principal{Type: auth.PrincipalAnyone}, repo.RoleViewer, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	h := server.New(server.Config{
		Environment: "test",
		Featured: []server.FeaturedSection{
			{Title: "Start here", Permanent: true, Items: []string{folder.ID}},
			{Title: "Examples", Items: []string{"doc_missing", e.doc.ID, folder.ID}},
		},
	}, server.WithRepository(e.store), server.WithAuthenticator(testPrincipalAuth{})).Handler()

	// featured returns "title: id id" for each section that the principal sees.
	featured := func(p auth.Principal) []string {
		t.Helper()
		rr := do(t, h, http.MethodGet, "/v1/featured", "", map[string]string{"X-Test-Principal": principalHeader(p)})
		assertStatus(t, rr, http.StatusOK)
		var out struct {
			Items []struct {
				Title string
				Items []repo.FolderEntry
			}
		}
		if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
			t.Fatal(err)
		}
		sections := []string{}
		for _, section := range out.Items {
			line := section.Title + ":"
			for _, item := range section.Items {
				if item.Folder != nil {
					line += " " + item.Folder.ID
				} else {
					line += " " + item.Document.ID
				}
			}
			sections = append(sections, line)
		}
		return sections
	}
	hide := func(p auth.Principal, id string) int {
		t.Helper()
		return do(t, h, http.MethodDelete, "/v1/featured/"+id, "", map[string]string{"X-Test-Principal": principalHeader(p)}).Code
	}
	assertSections := func(got []string, want ...string) {
		t.Helper()
		if !slices.Equal(got, want) {
			t.Fatalf("sections = %q, want %q", got, want)
		}
	}

	t.Run("shows only the items that the principal can view", func(t *testing.T) {
		assertSections(featured(fixtureViewer), "Start here: "+folder.ID, "Examples: "+e.doc.ID+" "+folder.ID)
		assertSections(featured(fixtureStranger), "Start here: "+folder.ID, "Examples: "+folder.ID)
	})
	t.Run("hides an item for one principal and leaves out empty sections", func(t *testing.T) {
		if code := hide(fixtureStranger, folder.ID); code != http.StatusNoContent {
			t.Fatalf("hide status = %d", code)
		}
		assertSections(featured(fixtureStranger), "Start here: "+folder.ID)
		assertSections(featured(fixtureViewer), "Start here: "+folder.ID, "Examples: "+e.doc.ID+" "+folder.ID)
	})
	t.Run("rejects items that cannot be hidden", func(t *testing.T) {
		e2 := server.New(server.Config{
			Environment: "test",
			Featured:    []server.FeaturedSection{{Title: "Start here", Permanent: true, Items: []string{folder.ID}}},
		}, server.WithRepository(e.store), server.WithAuthenticator(testPrincipalAuth{})).Handler()
		for _, id := range []string{folder.ID, "doc_other"} {
			rr := do(t, e2, http.MethodDelete, "/v1/featured/"+id, "", map[string]string{"X-Test-Principal": principalHeader(fixtureViewer)})
			assertStatus(t, rr, http.StatusNotFound)
		}
	})
}

func TestParseFeatured(t *testing.T) {
	sections, err := server.ParseFeatured(`{
		"Start here": {"description": "Read first.", "permanent": true, "items": ["fld_a", "doc_b"]},
		"Examples": {"items": ["doc_c"]}
	}`)
	if err != nil {
		t.Fatal(err)
	}
	want := []server.FeaturedSection{
		{Title: "Start here", Description: "Read first.", Permanent: true, Items: []string{"fld_a", "doc_b"}},
		{Title: "Examples", Items: []string{"doc_c"}},
	}
	if !reflect.DeepEqual(sections, want) {
		t.Fatalf("sections = %+v, want %+v", sections, want)
	}

	if sections, err := server.ParseFeatured(" "); err != nil || sections != nil {
		t.Fatalf("empty config = %+v, %v", sections, err)
	}
	for name, raw := range map[string]string{
		"not an object":  `["doc_a"]`,
		"unknown field":  `{"A": {"items": ["doc_a"], "pinned": true}}`,
		"no items":       `{"A": {"items": []}}`,
		"empty title":    `{" ": {"items": ["doc_a"]}}`,
		"unknown prefix": `{"A": {"items": ["ver_a"]}}`,
		"broken JSON":    `{"A": {"items": ["doc_a"]}`,
	} {
		if _, err := server.ParseFeatured(raw); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}
