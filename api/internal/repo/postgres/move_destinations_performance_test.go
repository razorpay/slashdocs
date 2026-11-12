package postgres

import (
	"context"
	"os"
	"sort"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/testdb"
)

// This is an evidence harness, not a CI timing assertion. Run it explicitly
// on the supported PostgreSQL image when changing move-tree query shapes.
func TestMoveDestinationPerformanceEvidence(t *testing.T) {
	if os.Getenv("SLASHDOCS_MOVE_PERF") != "1" {
		t.Skip("set SLASHDOCS_MOVE_PERF=1 to seed the 50k-folder evidence dataset")
	}
	ctx := context.Background()
	store, err := Connect(ctx, testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	principal := auth.Principal{Type: auth.PrincipalUser, ID: "usr_perf"}
	ordinary := auth.Principal{Type: auth.PrincipalUser, ID: "usr_ordinary"}

	seedStarted := time.Now()
	if _, err := store.db.Exec(ctx, `INSERT INTO folders(id,title,owner_type,owner_id)
		SELECT 'perf_top_'||g::text,'Perf folder '||lpad(g::text,6,'0'),'user',
		CASE WHEN g<=10000 THEN $1 ELSE 'usr_'||(g%2000)::text END
		FROM generate_series(1,45000) g`, principal.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(ctx, `INSERT INTO folders(id,title,owner_type,owner_id) VALUES
		('perf_wide','Wide parent','user',$1),
		('perf_ordinary_root','Ordinary root','user',$2)`, principal.ID, ordinary.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(ctx, `INSERT INTO folders(id,title,owner_type,owner_id,parent_folder_id)
		SELECT 'perf_child_'||g::text,'Wide child '||lpad(g::text,5,'0'),'user',$1,'perf_wide'
		FROM generate_series(1,5000) g`, principal.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(ctx, `INSERT INTO resource_grants(id,resource_type,resource_id,principal_type,principal_id,role,granted_by_type,granted_by_user_id)
		SELECT 'perf_grant_'||g::text,'folder','perf_top_'||(10000+g)::text,'anyone','anyone','viewer','user',$1
		FROM generate_series(1,5000) g`, principal.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec(ctx, `INSERT INTO documents(id,title,owner_id,owner_type) VALUES
		('perf_doc_heavy','Heavy bootstrap',$1,'user'),
		('perf_doc_ordinary','Ordinary bootstrap',$2,'user')`, principal.ID, ordinary.ID); err != nil {
		t.Fatal(err)
	}
	t.Logf("dataset folders=50002 org-wide-grants=5000 seed=%s postgres=17-alpine", time.Since(seedStarted))

	r := store.moveDestinationReader()
	moveCtx := moveDestinationContext{
		resource: repo.MoveDestinationResource{Type: "document", ID: "perf", CanMove: true},
		excluded: map[string]struct{}{}, includeOrgWide: true, subtreeHeight: 1,
	}
	measure := func(name string, fn func() error) {
		t.Helper()
		if err := fn(); err != nil {
			t.Fatalf("%s warmup: %v", name, err)
		}
		const sampleCount = 100
		samples := make([]time.Duration, 0, sampleCount)
		for i := 0; i < sampleCount; i++ {
			started := time.Now()
			if err := fn(); err != nil {
				t.Fatalf("%s: %v", name, err)
			}
			samples = append(samples, time.Since(started))
		}
		sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
		t.Logf("%s samples=%d p50=%s p90=%s p95=%s max=%s", name, sampleCount, samples[49], samples[89], samples[94], samples[99])
	}
	measure("root-heavy", func() error {
		_, err := r.page(ctx, principal, moveCtx, "", nil, "", 50)
		return err
	})
	measure("bootstrap-heavy", func() error {
		_, err := store.BootstrapMoveDestinations(ctx, principal, "document", "perf_doc_heavy", "", 50, true)
		return err
	})
	measure("bootstrap-ordinary", func() error {
		_, err := store.BootstrapMoveDestinations(ctx, ordinary, "document", "perf_doc_ordinary", "", 50, true)
		return err
	})
	measure("children-page-1", func() error {
		_, err := r.page(ctx, principal, moveCtx, "perf_wide", nil, "", 50)
		return err
	})
	measure("anchor-near-end", func() error {
		_, err := r.page(ctx, principal, moveCtx, "perf_wide", nil, "perf_child_4990", 50)
		return err
	})
	measure("search-ab", func() error {
		_, _, err := r.searchCandidates(ctx, "12", 200, nil)
		return err
	})

	var plan string
	if err := store.db.QueryRow(ctx, `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
		SELECT id FROM folders WHERE parent_folder_id='perf_wide'
		ORDER BY lower(title) COLLATE "C",id LIMIT 51`).Scan(&plan); err != nil {
		t.Fatal(err)
	}
	t.Logf("child-plan=%s", plan)

	if err := store.db.QueryRow(ctx, `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
		WITH RECURSIVE eligible AS MATERIALIZED (
		  SELECT DISTINCT f.id,f.title,f.parent_folder_id,lower(f.title) COLLATE "C" AS sort_key
		  FROM folders f
		  WHERE (f.owner_type=$1::text AND f.owner_id=$2::text) OR EXISTS (
		    SELECT 1 FROM resource_grants g WHERE g.resource_type='folder' AND g.resource_id=f.id AND g.revoked_at IS NULL
		      AND ((g.principal_type=$1::text AND g.principal_id=$2::text)
		        OR (g.principal_type='google_group' AND g.principal_id=ANY($3::text[]))
		        OR ($4::boolean AND g.principal_type='anyone')))
		), ancestry(entry_id,id,parent_folder_id,depth) AS (
		  SELECT e.id,e.id,e.parent_folder_id,0 FROM eligible e WHERE e.parent_folder_id IS NOT NULL
		  UNION ALL
		  SELECT a.entry_id,f.id,f.parent_folder_id,a.depth+1
		  FROM ancestry a JOIN folders f ON f.id=a.parent_folder_id WHERE a.depth < $5::int
		), roots AS (
		  SELECT e.* FROM eligible e WHERE e.parent_folder_id IS NULL
		  UNION ALL
		  SELECT e.* FROM eligible e WHERE e.parent_folder_id IS NOT NULL AND NOT EXISTS (
		    SELECT 1 FROM ancestry a JOIN eligible ancestor ON ancestor.id=a.id
		    WHERE a.entry_id=e.id AND a.depth>0)
		)
		SELECT r.id FROM roots r ORDER BY r.sort_key,r.id LIMIT 50`,
		string(principal.Type), principal.ID, principal.GoogleGroupIDs, true, folderMaxDepth).Scan(&plan); err != nil {
		t.Fatal(err)
	}
	t.Logf("root-plan=%s", plan)
}
