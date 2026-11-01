package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/testdb"
)

func TestFrontendFallbackServesIndexWithPublicURL(t *testing.T) {
	store, err := pgrepo.Connect(context.Background(), testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	h := New(Config{Environment: "test", AppOrigin: "https://docs.example/"}, WithRepository(store), func(d *dependencies) {
		d.frontend = fstest.MapFS{"index.html": {Data: []byte(`<div id="root" data-url="__SLASHDOCS_PUBLIC_URL_VALUE__"></div>`)}}
	}).Handler()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/docs/some_doc", nil))
	if want := `<div id="root" data-url="https://docs.example"></div>`; rr.Code != http.StatusOK || rr.Body.String() != want {
		t.Fatalf("status = %d, body = %q, want 200 and %q", rr.Code, rr.Body.String(), want)
	}
}
