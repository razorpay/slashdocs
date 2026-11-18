package blob_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/blob"
)

// listServer is a store with the S3 API that answers ListObjectsV2. It gives
// the keys in pages, as S3 does for a prefix with more than 1000 keys, and
// in the order of keys, which the test turns around to make sure that List
// sorts.
func listServer(t *testing.T, keys []string, pageSize int) *blob.S3 {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		q := r.URL.Query()
		if r.Method != http.MethodGet || r.URL.Path != "/bucket" || q.Get("list-type") != "2" {
			t.Errorf("unexpected request %s %s", r.Method, r.URL)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		var matching []string
		for _, key := range keys {
			if strings.HasPrefix(key, q.Get("prefix")) {
				matching = append(matching, key)
			}
		}
		start := 0
		if token := q.Get("continuation-token"); token != "" {
			if _, err := fmt.Sscanf(token, "page-%d", &start); err != nil {
				t.Errorf("unexpected continuation token %q", token)
			}
		}
		end := min(start+pageSize, len(matching))
		var b strings.Builder
		b.WriteString(`<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>bucket</Name>`)
		fmt.Fprintf(&b, "<KeyCount>%d</KeyCount><IsTruncated>%t</IsTruncated>", end-start, end < len(matching))
		if end < len(matching) {
			fmt.Fprintf(&b, "<NextContinuationToken>page-%d</NextContinuationToken>", end)
		}
		for _, key := range matching[start:end] {
			fmt.Fprintf(&b, "<Contents><Key>%s</Key><Size>1</Size></Contents>", key)
		}
		b.WriteString("</ListBucketResult>")
		w.Header().Set("Content-Type", "application/xml")
		_, _ = w.Write([]byte(b.String()))
	}))
	t.Cleanup(srv.Close)
	store, err := blob.NewS3(context.Background(), blob.S3Config{
		Bucket: "bucket", Region: "us-east-1", Endpoint: srv.URL, ForcePathStyle: true,
		AccessKeyID: "test", SecretAccessKey: "test",
	})
	if err != nil {
		t.Fatal(err)
	}
	return store
}

// The purge of a deleted document lists its blobs. A document with many
// versions has more keys than one page of the listing holds, and a blob that
// List does not return stays in the bucket for ever.
func TestS3ListReadsEveryPageOfThePrefix(t *testing.T) {
	var keys, want []string
	for i := range 2500 {
		key := fmt.Sprintf("docs/doc_a/ver_%04d.html", i)
		keys, want = append(keys, key), append(want, key)
	}
	keys = append(keys, "docs/doc_a1/ver_0001.html", "docs/doc_b/ver_0001.html")
	slices.Reverse(keys)

	got, err := listServer(t, keys, 1000).List(context.Background(), "docs/doc_a/")
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, want) {
		t.Fatalf("List returned %d keys, the first %q and the last %q; want the %d keys of the prefix in order", len(got), first(got), last(got), len(want))
	}
}

func TestS3ListOfAnEmptyPrefixReturnsNoKey(t *testing.T) {
	got, err := listServer(t, []string{"docs/doc_b/ver_1.html"}, 1000).List(context.Background(), "docs/doc_a/")
	if err != nil || len(got) != 0 {
		t.Fatalf("List = %q, %v, want no key", got, err)
	}
}

// A store that refuses the listing, as one does without the permission to
// list the bucket, gives an error of the store: the purge then tries the
// document again later.
func TestS3ListReportsAStoreThatRefuses(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>`))
	}))
	t.Cleanup(srv.Close)
	store, err := blob.NewS3(context.Background(), blob.S3Config{
		Bucket: "bucket", Region: "us-east-1", Endpoint: srv.URL, ForcePathStyle: true,
		AccessKeyID: "test", SecretAccessKey: "test",
	})
	if err != nil {
		t.Fatal(err)
	}
	if keys, err := store.List(context.Background(), "docs/doc_a/"); !errors.Is(err, blob.ErrStorage) || keys != nil {
		t.Fatalf("List = %q, %v, want an error of the store and no key", keys, err)
	}
}

func first(keys []string) string {
	if len(keys) == 0 {
		return ""
	}
	return keys[0]
}

func last(keys []string) string {
	if len(keys) == 0 {
		return ""
	}
	return keys[len(keys)-1]
}

// deleteServer is a store with the S3 API that answers a DELETE of an object
// with status and an error code.
func deleteServer(t *testing.T, status int, code string) *blob.S3 {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			t.Errorf("unexpected request %s %s", r.Method, r.URL)
		}
		if code == "" {
			w.WriteHeader(status)
			return
		}
		w.Header().Set("Content-Type", "application/xml")
		w.WriteHeader(status)
		_, _ = fmt.Fprintf(w, `<?xml version="1.0" encoding="UTF-8"?><Error><Code>%s</Code><Message>%s</Message></Error>`, code, code)
	}))
	t.Cleanup(srv.Close)
	store, err := blob.NewS3(context.Background(), blob.S3Config{
		Bucket: "bucket", Region: "us-east-1", Endpoint: srv.URL, ForcePathStyle: true,
		AccessKeyID: "test", SecretAccessKey: "test",
	})
	if err != nil {
		t.Fatal(err)
	}
	return store
}

// The delete of a blob that is not there succeeds: the purge of a deleted
// document can meet a blob that a write removed a moment before. AWS S3
// answers 204 for such a key, and not every store with its API does.
func TestS3DeleteOfABlobThatIsNotThereSucceeds(t *testing.T) {
	for name, store := range map[string]*blob.S3{
		"as AWS S3 answers":         deleteServer(t, http.StatusNoContent, ""),
		"a store that says no key":  deleteServer(t, http.StatusNotFound, "NoSuchKey"),
		"a store that says missing": deleteServer(t, http.StatusNotFound, "NotFound"),
	} {
		if err := store.Delete(context.Background(), "docs/doc_a/ver_1.html"); err != nil {
			t.Errorf("%s: Delete = %v, want no error", name, err)
		}
	}
}

func TestS3DeleteReportsAStoreThatFails(t *testing.T) {
	for name, store := range map[string]*blob.S3{
		"no permission":  deleteServer(t, http.StatusForbidden, "AccessDenied"),
		"no such bucket": deleteServer(t, http.StatusNotFound, "NoSuchBucket"),
	} {
		if err := store.Delete(context.Background(), "docs/doc_a/ver_1.html"); !errors.Is(err, blob.ErrStorage) {
			t.Errorf("%s: Delete = %v, want an error of the store", name, err)
		}
	}
}
