package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/gin-gonic/gin"
)

func TestFrontendFallbackServesIndexWithPublicURL(t *testing.T) {
	r := gin.New()
	serveFrontend(r, fstest.MapFS{
		"index.html": {Data: []byte(`<div id="root" data-url="__SLASHDOCS_PUBLIC_URL_VALUE__"></div>`)},
	}, "https://docs.example/")
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/docs/some_doc", nil))
	if want := `<div id="root" data-url="https://docs.example"></div>`; rr.Code != http.StatusOK || rr.Body.String() != want {
		t.Fatalf("status = %d, body = %q, want 200 and %q", rr.Code, rr.Body.String(), want)
	}
}
