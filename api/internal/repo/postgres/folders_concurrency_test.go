package postgres_test

import (
	"context"
	"errors"
	"fmt"
	"math/rand"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// TestPostgresConcurrentFolderRenameAndReparentPreserveBothFields uses a row
// lock as a deterministic barrier: both UpdateFolder transactions must reach
// their blocked write before the lock is released. A read-modify-write query
// that writes both columns will then lose either the rename or the re-parent,
// depending on which waiter PostgreSQL runs last.
func TestPostgresConcurrentFolderRenameAndReparentPreserveBothFields(t *testing.T) {
	store := newStore(t)
	ctx := context.Background()
	owner := auth.Principal{Type: auth.PrincipalUser, ID: "usr_conc_patch_owner", Email: "conc-patch-owner@example.com", Name: "Owner"}

	folder, err := store.CreateFolder(ctx, owner, "Original", "")
	if err != nil {
		t.Fatal(err)
	}
	destination, err := store.CreateFolder(ctx, owner, "Destination", "")
	if err != nil {
		t.Fatal(err)
	}

	blocker, err := store.Pool().Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = blocker.Rollback(ctx) }()
	var lockedID string
	if err := blocker.QueryRow(ctx, `SELECT id FROM folders WHERE id=$1 FOR UPDATE`, folder.ID).Scan(&lockedID); err != nil {
		t.Fatal(err)
	}

	type updateResult struct {
		operation string
		err       error
	}
	results := make(chan updateResult, 2)
	go func() {
		_, err := store.UpdateFolder(ctx, folder.ID, "Renamed", nil)
		results <- updateResult{operation: "rename", err: err}
	}()
	go func() {
		_, err := store.UpdateFolder(ctx, folder.ID, "", &destination.ID)
		results <- updateResult{operation: "re-parent", err: err}
	}()

	waitCtx, cancelWait := context.WithTimeout(ctx, 5*time.Second)
	waitErr := waitForLockWaiters(waitCtx, store.Pool(), 2)
	cancelWait()
	commitErr := blocker.Commit(ctx)

	updateErrs := make([]updateResult, 0, 2)
	resultCtx, cancelResults := context.WithTimeout(ctx, 5*time.Second)
	defer cancelResults()
	for range 2 {
		select {
		case result := <-results:
			updateErrs = append(updateErrs, result)
		case <-resultCtx.Done():
			t.Fatalf("folder updates did not finish after releasing row lock: %v", resultCtx.Err())
		}
	}
	if waitErr != nil {
		t.Fatalf("folder updates did not reach the row-lock barrier: %v; results: %+v", waitErr, updateErrs)
	}
	if commitErr != nil {
		t.Fatalf("release row-lock barrier: %v", commitErr)
	}
	for _, result := range updateErrs {
		if result.err != nil {
			t.Fatalf("%s folder: %v", result.operation, result.err)
		}
	}

	got, err := store.GetFolder(ctx, folder.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Renamed" || got.ParentFolderID != destination.ID {
		t.Fatalf("folder after concurrent PATCHes = {title:%q parent:%q}, want {title:%q parent:%q}", got.Title, got.ParentFolderID, "Renamed", destination.ID)
	}
}

func waitForLockWaiters(ctx context.Context, pool *pgxpool.Pool, want int) error {
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	last := 0
	for {
		if err := pool.QueryRow(ctx, `
			SELECT count(*)
			FROM pg_stat_activity
			WHERE datname = current_database()
			  AND pid <> pg_backend_pid()
			  AND wait_event_type = 'Lock'
		`).Scan(&last); err != nil {
			return err
		}
		if last >= want {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("saw %d lock waiters, want %d: %w", last, want, ctx.Err())
		case <-ticker.C:
		}
	}
}

// TestPostgresConcurrentFolderMoves hammers UpdateFolder from many goroutines
// and asserts the structural invariants hold afterwards: no parent cycle and
// no chain deeper than the depth limit. Before folder mutations were wrapped
// in a transaction holding the folder-tree advisory lock, two concurrent
// moves could each pass the cycle check and then both commit, leaving A under
// B and B under A.
func TestPostgresConcurrentFolderMoves(t *testing.T) {
	store := newStore(t)
	ctx := context.Background()
	owner := auth.Principal{Type: auth.PrincipalUser, ID: "usr_conc_owner", Email: "conc-owner@example.com", Name: "Owner"}

	const folders = 6
	ids := make([]string, folders)
	for i := range ids {
		f, err := store.CreateFolder(ctx, owner, fmt.Sprintf("conc-%d", i), "")
		if err != nil {
			t.Fatal(err)
		}
		ids[i] = f.ID
	}

	const workers = 8
	const movesPerWorker = 30
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(seed int64) {
			defer wg.Done()
			r := rand.New(rand.NewSource(seed)) //nolint:gosec // Reproducible scheduling is intentional; no security-sensitive values are generated.
			for i := 0; i < movesPerWorker; i++ {
				child := ids[r.Intn(folders)]
				parent := ids[r.Intn(folders)]
				dest := parent
				if r.Intn(8) == 0 {
					dest = "" // occasionally move back to the root
				}
				_, err := store.UpdateFolder(ctx, child, "", &dest)
				// Rejected moves (would-be cycles, depth overflows, duplicate
				// sibling titles) are expected under contention.
				if err != nil && !errors.Is(err, repo.ErrConflict) && !errors.Is(err, repo.ErrNotFound) {
					t.Errorf("UpdateFolder(%s -> %q): %v", child, dest, err)
					return
				}
			}
		}(int64(w + 1))
	}
	wg.Wait()
	if t.Failed() {
		return
	}

	// Walk every folder's parent chain: it must terminate at a root without
	// revisiting a folder, within the depth limit.
	const maxDepth = 15
	for _, id := range ids {
		seen := map[string]bool{}
		for cur := id; cur != ""; {
			if seen[cur] {
				t.Fatalf("cycle detected in folder parent chain starting at %s", id)
			}
			seen[cur] = true
			if len(seen) > maxDepth {
				t.Fatalf("folder chain starting at %s exceeds depth limit %d", id, maxDepth)
			}
			f, err := store.GetFolder(ctx, cur)
			if err != nil {
				t.Fatalf("GetFolder(%s): %v", cur, err)
			}
			cur = f.ParentFolderID
		}
	}
}
