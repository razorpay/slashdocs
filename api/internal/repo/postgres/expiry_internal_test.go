package postgres

import (
	"testing"
	"time"
)

// A document whose blobs the store did not delete waits longer after each
// attempt. The count of attempts comes from the database, so a value that
// cannot be must not stop the server.
func TestBlobRetryAfterGrowsToItsLimit(t *testing.T) {
	for attempts, want := range map[int32]time.Duration{
		-5:   time.Minute,
		0:    time.Minute,
		1:    2 * time.Minute,
		2:    4 * time.Minute,
		8:    256 * time.Minute,
		9:    blobRetryMax,
		1000: blobRetryMax,
	} {
		if got := blobRetryAfter(attempts); got != want {
			t.Errorf("blobRetryAfter(%d) = %v, want %v", attempts, got, want)
		}
	}
}
