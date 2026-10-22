package dbsqlc

// This test lives in the generated package because it needs the text of the
// generated SearchDocuments statement, which is not exported.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/razorpay/slashdocs/api/internal/testdb"
)

// TestSearchDocumentsPlanUsesIndex checks two properties of the search plan
// that the timings depend on and that a small edit can lose without any test
// failing: the match uses the search_vector index under a generic plan, which
// PostgreSQL may choose for a cached prepared statement, and the planner does
// not see the words, so that a word in most documents does not make it plan a
// sequential scan that reads every document's vector.
func TestSearchDocumentsPlanUsesIndex(t *testing.T) {
	ctx := context.Background()
	conn, err := pgx.Connect(ctx, testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = conn.Close(ctx) })
	for _, stmt := range []string{
		`INSERT INTO documents(id, title, owner_type, owner_id) VALUES ('doc_plan_1', 'Rollout plan', 'user', 'usr_plan')`,
		`INSERT INTO documents(id, title, owner_type, owner_id) VALUES ('doc_plan_2', 'Weekly report', 'user', 'usr_plan')`,
		// A tiny table makes a sequential scan cheaper than any index. The
		// test asks whether an index path exists, not which is cheaper.
		`SET enable_seqscan = off`,
	} {
		if _, err := conn.Exec(ctx, stmt); err != nil {
			t.Fatalf("%s: %v", stmt, err)
		}
	}
	// Words and an excluded word: the plan has an index scan for each.
	args := []any{
		"'rollout':*", "'rollout':*", "'draft':*", "'rollout':*", []string{}, "user", "usr_plan", []string{}, false,
		[]string{}, []string{}, pgtype.Timestamptz{}, pgtype.Timestamptz{}, int32(25),
	}
	for _, mode := range []string{"force_custom_plan", "force_generic_plan"} {
		if _, err := conn.Exec(ctx, "SET plan_cache_mode = "+mode); err != nil {
			t.Fatal(err)
		}
		var plan string
		if err := conn.QueryRow(ctx, "EXPLAIN (FORMAT JSON) "+searchDocuments, args...).Scan(&plan); err != nil {
			t.Fatalf("%s: explain: %v", mode, err)
		}
		var nodes []map[string]any
		if err := json.Unmarshal([]byte(plan), &nodes); err != nil {
			t.Fatalf("%s: %v", mode, err)
		}
		conds := indexConds(nodes[0]["Plan"], "idx_documents_search_vector")
		if len(conds) < 2 {
			t.Fatalf("%s: the words or the excluded words do not use idx_documents_search_vector (%d index scans):\n%s", mode, len(conds), plan)
		}
		for _, cond := range conds {
			if strings.Contains(cond, "rollout") || strings.Contains(cond, "draft") {
				t.Fatalf("%s: the planner sees the words in the index condition %q; it plans a sequential scan for a common word", mode, cond)
			}
		}
	}
}

// indexConds returns the index conditions of the scans of index in plan.
func indexConds(plan any, index string) []string {
	node, ok := plan.(map[string]any)
	if !ok {
		return nil
	}
	var out []string
	if node["Index Name"] == index {
		cond, _ := node["Index Cond"].(string)
		out = append(out, cond)
	}
	if children, ok := node["Plans"].([]any); ok {
		for _, child := range children {
			out = append(out, indexConds(child, index)...)
		}
	}
	return out
}
