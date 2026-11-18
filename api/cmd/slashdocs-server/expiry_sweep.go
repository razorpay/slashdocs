package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"time"

	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/server"
)

const (
	expirySweepIntervalEnv  = "SLASHDOCS_DOCUMENT_EXPIRY_SWEEP_INTERVAL"
	deletedBlobRetentionEnv = "SLASHDOCS_DELETED_BLOB_RETENTION"

	defaultExpirySweepInterval  = time.Minute
	defaultDeletedBlobRetention = 7 * 24 * time.Hour

	// minExpirySweepInterval is the shortest interval of the sweep. A
	// shorter one is a mistake, and it would keep the database busy.
	minExpirySweepInterval = time.Second

	// expirySweepBatch is the most documents that a round deletes, and the
	// most documents whose blobs it removes. The rest wait for the next
	// round, so that a large number of expired documents does not take the
	// database from the requests.
	expirySweepBatch = 100
)

// expirySettings are the settings of the sweep of expired documents.
type expirySettings struct {
	// interval is how often a server runs a round. With 0 the sweep is off:
	// the server deletes no expired document and removes no blob.
	interval time.Duration
	// blobRetention is how long the blobs of a deleted document stay in the
	// blob store. In that time an operator can get the HTML back, and a
	// restore of a backup of the database finds its blobs.
	blobRetention time.Duration
}

func loadExpirySettings() (expirySettings, error) {
	interval, err := durationEnv(expirySweepIntervalEnv, defaultExpirySweepInterval)
	if err != nil {
		return expirySettings{}, err
	}
	if interval != 0 && interval < minExpirySweepInterval {
		return expirySettings{}, fmt.Errorf("%s must be 0, which turns the sweep off, or %s or more", expirySweepIntervalEnv, minExpirySweepInterval)
	}
	retention, err := durationEnv(deletedBlobRetentionEnv, defaultDeletedBlobRetention)
	if err != nil {
		return expirySettings{}, err
	}
	return expirySettings{interval: interval, blobRetention: retention}, nil
}

// durationEnv reads a Go duration that is zero or more.
func durationEnv(name string, fallback time.Duration) (time.Duration, error) {
	raw := os.Getenv(name)
	if raw == "" {
		return fallback, nil
	}
	duration, err := time.ParseDuration(raw)
	if err != nil || duration < 0 {
		return 0, fmt.Errorf("%s must be a Go duration that is 0 or more, such as 1m or 168h", name)
	}
	return duration, nil
}

// expirySweeper is what the sweep needs of the store.
type expirySweeper interface {
	DeleteExpiredDocuments(ctx context.Context, limit int) ([]pgrepo.ExpiredDocument, error)
	PurgeDeletedBlobs(ctx context.Context, retention time.Duration, limit int) (pgrepo.BlobPurge, error)
	BlobDeletionBacklog(ctx context.Context) (pgrepo.BlobBacklog, error)
}

// sweepExpiredDocuments runs a round at once, and then one at each interval,
// until ctx ends. Every server runs it: the store gives each expired
// document, and the blobs of each deleted document, to one server.
func sweepExpiredDocuments(ctx context.Context, store expirySweeper, settings expirySettings) {
	sweepOnce(ctx, store, settings.blobRetention)
	ticker := time.NewTicker(settings.interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sweepOnce(ctx, store, settings.blobRetention)
		}
	}
}

// sweepOnce runs one round: it deletes the documents whose expiry time
// passed, and then removes the blobs of the documents that were deleted
// more than retention ago. The second step does not need the first: the
// list holds the documents of earlier rounds and of deletes by hand.
func sweepOnce(ctx context.Context, store expirySweeper, retention time.Duration) {
	deleted, err := store.DeleteExpiredDocuments(ctx, expirySweepBatch)
	for _, doc := range deleted {
		// The row is gone, so the line tells whose document it was. It
		// holds IDs only: no title and no name.
		slog.InfoContext(ctx, "document expired",
			slog.String("document_id", doc.ID),
			slog.String("owner_type", doc.OwnerType),
			slog.String("owner_id", doc.OwnerID),
			slog.Time("expires_at", doc.ExpiresAt))
	}
	server.ObserveDocumentsExpired(len(deleted))
	if err != nil && ctx.Err() == nil {
		server.ObserveExpirySweepError()
		slog.ErrorContext(ctx, "deleting expired documents failed", slog.Int("deleted", len(deleted)), slog.Any("error", err))
	}

	purge, err := store.PurgeDeletedBlobs(ctx, retention, expirySweepBatch)
	// A server that stops in the middle of a round is no failure.
	if ctx.Err() != nil {
		return
	}
	server.ObserveBlobPurge(purge.Purged, purge.Failed)
	switch {
	case err != nil:
		server.ObserveExpirySweepError()
		slog.ErrorContext(ctx, "removing the blobs of deleted documents failed", slog.Int("purged", purge.Purged), slog.Any("error", err))
	case purge.Failed > 0:
		// One line for the round. The documents wait, and a later round
		// tries them again.
		slog.WarnContext(ctx, "the blob store did not remove the blobs of deleted documents", slog.Int("failed", purge.Failed), slog.Int("purged", purge.Purged), slog.Any("error", purge.Err))
	}

	backlog, err := store.BlobDeletionBacklog(ctx)
	if err != nil {
		if ctx.Err() == nil {
			slog.ErrorContext(ctx, "reading the list of blob deletions failed", slog.Any("error", err))
		}
		return
	}
	server.ObserveBlobBacklog(backlog.Documents, backlog.Oldest)
}
