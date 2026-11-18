package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/server"
)

func TestLoadExpirySettings(t *testing.T) {
	for name, tc := range map[string]struct {
		interval, retention string
		want                expirySettings
	}{
		"the defaults":            {"", "", expirySettings{interval: time.Minute, blobRetention: 7 * 24 * time.Hour}},
		"other values":            {"30s", "24h", expirySettings{interval: 30 * time.Second, blobRetention: 24 * time.Hour}},
		"the sweep is off":        {"0", "", expirySettings{interval: 0, blobRetention: 7 * 24 * time.Hour}},
		"the blobs go at once":    {"", "0", expirySettings{interval: time.Minute, blobRetention: 0}},
		"a zero with a unit":      {"0s", "0h", expirySettings{}},
		"the shortest interval":   {"1s", "", expirySettings{interval: time.Second, blobRetention: 7 * 24 * time.Hour}},
		"an interval in the past": {"-1s", "", expirySettings{}},
		// An interval of a nanosecond would keep the database busy.
		"an interval that is too short": {"500ms", "", expirySettings{}},
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(expirySweepIntervalEnv, tc.interval)
			t.Setenv(deletedBlobRetentionEnv, tc.retention)
			got, err := loadExpirySettings()
			if strings.HasPrefix(name, "an interval") {
				if err == nil || !strings.Contains(err.Error(), expirySweepIntervalEnv) {
					t.Fatalf("loadExpirySettings = %+v, %v, want an error that names the variable", got, err)
				}
				return
			}
			if err != nil || got != tc.want {
				t.Fatalf("loadExpirySettings = %+v, %v, want %+v", got, err, tc.want)
			}
		})
	}
	// A day is no unit of a Go duration, so the error tells what one is.
	for _, wrong := range []string{"7d", "soon", "-1h"} {
		t.Setenv(expirySweepIntervalEnv, "")
		t.Setenv(deletedBlobRetentionEnv, wrong)
		if _, err := loadExpirySettings(); err == nil || !strings.Contains(err.Error(), deletedBlobRetentionEnv) || !strings.Contains(err.Error(), "168h") {
			t.Fatalf("the retention %q gave %v, want an error that names the variable and an example", wrong, err)
		}
	}
}

// fakeSweeper is a store that tells what the sweep asked of it.
type fakeSweeper struct {
	mu        sync.Mutex
	deletes   []int
	purges    []time.Duration
	expired   []pgrepo.ExpiredDocument
	deleteErr error
	purge     pgrepo.BlobPurge
	purgeErr  error
	backlog   pgrepo.BlobBacklog
	called    chan struct{}
}

func (f *fakeSweeper) DeleteExpiredDocuments(_ context.Context, limit int) ([]pgrepo.ExpiredDocument, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deletes = append(f.deletes, limit)
	if f.called != nil {
		select {
		case f.called <- struct{}{}:
		default:
		}
	}
	return f.expired, f.deleteErr
}

func (f *fakeSweeper) PurgeDeletedBlobs(_ context.Context, retention time.Duration, _ int) (pgrepo.BlobPurge, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.purges = append(f.purges, retention)
	return f.purge, f.purgeErr
}

func (f *fakeSweeper) BlobDeletionBacklog(context.Context) (pgrepo.BlobBacklog, error) {
	return f.backlog, nil
}

// metric reads one value from the metrics of the server.
func metric(t *testing.T, line string) float64 {
	t.Helper()
	rr := httptest.NewRecorder()
	server.MetricsHandler().ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	for _, l := range strings.Split(rr.Body.String(), "\n") {
		if rest, ok := strings.CutPrefix(l, line+" "); ok {
			v, err := strconv.ParseFloat(rest, 64)
			if err != nil {
				t.Fatal(err)
			}
			return v
		}
	}
	return 0
}

const (
	expiredMetric = `slashdocs_document_events_total{actor_type="system",event="expired"}`
	purgedMetric  = `slashdocs_blob_purge_events_total{result="purged"}`
	failedMetric  = `slashdocs_blob_purge_events_total{result="failed"}`
	errorsMetric  = `slashdocs_document_expiry_sweep_errors_total`
	pendingMetric = `slashdocs_blob_purge_pending_documents`
	oldestMetric  = `slashdocs_blob_purge_oldest_pending_seconds`
)

func TestARoundDeletesExpiredDocumentsAndRemovesBlobs(t *testing.T) {
	store := &fakeSweeper{
		expired: []pgrepo.ExpiredDocument{{ID: "doc_1", ExpiresAt: time.Now()}, {ID: "doc_2", ExpiresAt: time.Now()}},
		purge:   pgrepo.BlobPurge{Purged: 3, Failed: 1, Err: errors.New("the store is down")},
		backlog: pgrepo.BlobBacklog{Documents: 5, Oldest: 90 * time.Minute},
	}
	expired, purged, failed, failures := metric(t, expiredMetric), metric(t, purgedMetric), metric(t, failedMetric), metric(t, errorsMetric)
	sweepOnce(context.Background(), store, 24*time.Hour)
	if len(store.deletes) != 1 || store.deletes[0] != expirySweepBatch {
		t.Fatalf("the round asked for the deletes %v, want one of %d", store.deletes, expirySweepBatch)
	}
	if len(store.purges) != 1 || store.purges[0] != 24*time.Hour {
		t.Fatalf("the round asked for the purges %v, want one with the retention", store.purges)
	}
	if got := metric(t, expiredMetric) - expired; got != 2 {
		t.Errorf("the expired counter went up by %v, want 2", got)
	}
	if got := metric(t, purgedMetric) - purged; got != 3 {
		t.Errorf("the purged counter went up by %v, want 3", got)
	}
	if got := metric(t, failedMetric) - failed; got != 1 {
		t.Errorf("the failed counter went up by %v, want 1", got)
	}
	// A blob that the store did not remove waits for a later round. It is
	// no failure of the round.
	if got := metric(t, errorsMetric) - failures; got != 0 {
		t.Errorf("the error counter went up by %v, want 0", got)
	}
	if pending, oldest := metric(t, pendingMetric), metric(t, oldestMetric); pending != 5 || oldest != 5400 {
		t.Errorf("the backlog is %v documents and %v seconds, want 5 and 5400", pending, oldest)
	}
}

// The blobs of the documents that were deleted before still go when the
// delete of the expired documents fails.
func TestARoundRemovesBlobsAfterTheDeleteFailed(t *testing.T) {
	store := &fakeSweeper{deleteErr: errors.New("the database is down"), purgeErr: errors.New("the database is down")}
	failures := metric(t, errorsMetric)
	sweepOnce(context.Background(), store, 0)
	if len(store.purges) != 1 {
		t.Fatalf("the round asked for %d purges after a failed delete, want 1", len(store.purges))
	}
	if got := metric(t, errorsMetric) - failures; got != 2 {
		t.Fatalf("the error counter went up by %v, want 2", got)
	}
}

// A deploy stops the server in the middle of a round. That is no failure of
// the blob store or of the sweep, so no counter goes up.
func TestARoundThatTheShutdownStopsCountsNoFailure(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	store := &fakeSweeper{
		deleteErr: context.Canceled,
		purge:     pgrepo.BlobPurge{Failed: 1, Err: context.Canceled},
		purgeErr:  context.Canceled,
	}
	failed, failures := metric(t, failedMetric), metric(t, errorsMetric)
	sweepOnce(ctx, store, 0)
	if got := metric(t, failedMetric) - failed; got != 0 {
		t.Errorf("the failed counter went up by %v, want 0", got)
	}
	if got := metric(t, errorsMetric) - failures; got != 0 {
		t.Errorf("the error counter went up by %v, want 0", got)
	}
}

func TestTheSweepRunsARoundAtOnceAndEndsWithItsContext(t *testing.T) {
	store := &fakeSweeper{called: make(chan struct{}, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		defer close(done)
		sweepExpiredDocuments(ctx, store, expirySettings{interval: time.Hour})
	}()
	select {
	case <-store.called:
	case <-time.After(5 * time.Second):
		t.Fatal("the sweep waited for its interval before the first round")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the sweep did not end with its context")
	}
}

func TestTheSweepRunsARoundAtEachInterval(t *testing.T) {
	store := &fakeSweeper{called: make(chan struct{}, 1)}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go sweepExpiredDocuments(ctx, store, expirySettings{interval: 10 * time.Millisecond})
	for round := range 3 {
		select {
		case <-store.called:
		case <-time.After(5 * time.Second):
			t.Fatalf("the sweep ran %d rounds, want 3", round)
		}
	}
}
