package blob_test

import (
	"context"
	"errors"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/blob"
)

// TestMemoryStoreContract exercises the Store contract against the in-memory
// implementation. Any future backend can reuse testStoreContract to prove the
// same behaviour.
func TestMemoryStoreContract(t *testing.T) {
	testStoreContract(t, blob.NewMemory())
}

func testStoreContract(t *testing.T, s blob.Store) {
	t.Helper()
	ctx := context.Background()

	if _, _, err := s.Get(ctx, "missing"); !errors.Is(err, blob.ErrNotFound) {
		t.Fatalf("Get(missing) err = %v, want ErrNotFound", err)
	}

	if err := s.Put(ctx, "k", "text/html", []byte("<p>hi</p>")); err != nil {
		t.Fatalf("Put: %v", err)
	}
	body, ct, err := s.Get(ctx, "k")
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if string(body) != "<p>hi</p>" || ct != "text/html" {
		t.Fatalf("Get = (%q, %q), want (%q, %q)", body, ct, "<p>hi</p>", "text/html")
	}

	// Overwriting a key replaces both body and content type.
	if err := s.Put(ctx, "k", "application/json", []byte(`{}`)); err != nil {
		t.Fatalf("Put(overwrite): %v", err)
	}
	body, ct, err = s.Get(ctx, "k")
	if err != nil {
		t.Fatalf("Get after overwrite: %v", err)
	}
	if string(body) != `{}` || ct != "application/json" {
		t.Fatalf("Get after overwrite = (%q, %q)", body, ct)
	}

	// Delete is idempotent and removes the object.
	if err := s.Delete(ctx, "k"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if err := s.Delete(ctx, "k"); err != nil {
		t.Fatalf("Delete(again): %v", err)
	}
	if _, _, err := s.Get(ctx, "k"); !errors.Is(err, blob.ErrNotFound) {
		t.Fatalf("Get after delete err = %v, want ErrNotFound", err)
	}
}

func TestMemoryCopiesBuffers(t *testing.T) {
	ctx := context.Background()
	m := blob.NewMemory()

	in := []byte("original")
	if err := m.Put(ctx, "k", "text/plain", in); err != nil {
		t.Fatal(err)
	}
	in[0] = 'X' // mutating the caller's buffer must not affect the store
	got, _, err := m.Get(ctx, "k")
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "original" {
		t.Fatalf("stored body mutated via caller buffer: %q", got)
	}

	got[0] = 'Y' // mutating a returned buffer must not affect the store
	again, _, err := m.Get(ctx, "k")
	if err != nil {
		t.Fatal(err)
	}
	if string(again) != "original" {
		t.Fatalf("stored body mutated via returned buffer: %q", again)
	}
}
