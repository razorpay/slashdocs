package postgres_test

import (
	"context"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/blob"
	"github.com/razorpay/slashdocs/api/internal/repo"
	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/testdb"
)

func TestPostgresSearchDocumentText(t *testing.T) {
	ctx := context.Background()
	blobs := blob.NewMemory()
	store, err := pgrepo.ConnectWithBlob(ctx, testdb.New(t), blobs)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	owner := auth.Principal{Type: auth.PrincipalUser, ID: "usr_text_owner", Email: "text-owner@test.com"}
	create := func(title, body string) repo.Document {
		t.Helper()
		doc, _, err := store.CreateDocument(ctx, owner, title, []byte("<html><body>"+body+"<script>secret</script></body></html>"))
		if err != nil {
			t.Fatal(err)
		}
		return doc
	}
	incident := create("Q3 incident review", "<p>The error budget for checkout was exceeded twice.</p>")
	budget := create("Budget plan", "<p>Planning notes.</p>")
	search := func(terms, excluded []string) []repo.Document {
		t.Helper()
		results, err := store.SearchDocuments(ctx, owner, repo.DocumentSearch{Terms: terms, ExcludedTerms: excluded}, false, 25)
		if err != nil {
			t.Fatal(err)
		}
		return results
	}
	ids := func(results []repo.Document) string {
		var out []string
		for _, r := range results {
			out = append(out, r.ID)
		}
		return strings.Join(out, ",")
	}

	for _, tc := range []struct {
		name     string
		terms    []string
		excluded []string
		want     []repo.Document
	}{
		{name: "a title word ranks first", terms: []string{"budget"}, want: []repo.Document{budget, incident}},
		{name: "stems and prefixes", terms: []string{"exceed", "check"}, want: []repo.Document{incident}},
		{name: "title and text words together", terms: []string{"incident", "twice"}, want: []repo.Document{incident}},
		{name: "phrase", terms: []string{"error budget"}, want: []repo.Document{incident}},
		{name: "phrase in the wrong order", terms: []string{"budget error"}},
		{name: "exclusion", terms: []string{"budget"}, excluded: []string{"checkout"}, want: []repo.Document{budget}},
		// Without ranked words, the latest update comes first.
		{name: "stop words only", terms: []string{"the"}, want: []repo.Document{budget, incident}},
		{name: "scripts are not text", terms: []string{"secret"}},
	} {
		results := search(tc.terms, tc.excluded)
		if got, want := ids(results), ids(tc.want); got != want {
			t.Errorf("%s: results = %s, want %s", tc.name, got, want)
		}
	}

	results := search([]string{"budget"}, nil)
	if got := results[1].Snippet; !strings.Contains(got, "\x02budget\x03") {
		t.Errorf("snippet = %q, want the match marked", got)
	}
	if got := results[0].Snippet; got != "" {
		t.Errorf("title-only match snippet = %q, want empty", got)
	}

	// Versions from before content search have no text until they are indexed.
	if _, err := store.Pool().Exec(ctx, `UPDATE versions SET search_text = NULL`); err != nil {
		t.Fatal(err)
	}
	// A missing blob is indexed as empty text.
	if err := blobs.Delete(ctx, "docs/"+budget.ID+"/"+budget.CurrentVersionID+".html"); err != nil {
		t.Fatal(err)
	}
	if got := ids(search([]string{"twice"}, nil)); got != "" {
		t.Fatalf("unindexed search = %s, want no results", got)
	}
	indexed, err := store.IndexVersions(ctx)
	if err != nil || indexed != 2 {
		t.Fatalf("IndexVersions() = %d, %v, want 2 versions", indexed, err)
	}
	if got, want := ids(search([]string{"twice"}, nil)), incident.ID; got != want {
		t.Fatalf("indexed search = %s, want %s", got, want)
	}
	if indexed, err := store.IndexVersions(ctx); err != nil || indexed != 0 {
		t.Fatalf("second IndexVersions() = %d, %v, want nothing to do", indexed, err)
	}

	// Documents from before search_vector have none until they are indexed.
	if _, err := store.Pool().Exec(ctx, `UPDATE documents SET search_vector = NULL`); err != nil {
		t.Fatal(err)
	}
	if got := ids(search([]string{"twice"}, nil)); got != "" {
		t.Fatalf("unindexed document search = %s, want no results", got)
	}
	if indexed, err := store.IndexDocuments(ctx); err != nil || indexed != 2 {
		t.Fatalf("IndexDocuments() = %d, %v, want 2 documents", indexed, err)
	}
	if got, want := ids(search([]string{"incident", "twice"}, nil)), incident.ID; got != want {
		t.Fatalf("indexed document search = %s, want %s", got, want)
	}

	// A new title and a new version replace the old words.
	if _, err := store.UpdateDocument(ctx, budget.ID, "Forecast"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateVersion(ctx, incident.ID, incident.CurrentVersionID, "", []byte("<p>Rollback notes.</p>"), owner, false); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ term, want string }{
		{"forecast", budget.ID}, {"plan", ""}, {"rollback", incident.ID}, {"twice", ""},
	} {
		if got := ids(search([]string{tc.term}, nil)); got != tc.want {
			t.Errorf("search %q after changes = %s, want %s", tc.term, got, tc.want)
		}
	}
}
