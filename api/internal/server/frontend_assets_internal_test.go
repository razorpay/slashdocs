package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/gin-gonic/gin"

	pgrepo "github.com/razorpay/slashdocs/api/internal/repo/postgres"
	"github.com/razorpay/slashdocs/api/internal/testdb"
)

func TestFrontendFallbackServesIndexWithPublicURL(t *testing.T) {
	store, err := pgrepo.Connect(context.Background(), testdb.New(t))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(store.Close)
	h := New(Config{Environment: "test", AppOrigin: "https://docs.example/"}, WithRepository(store),
		WithFrontend(fstest.MapFS{"index.html": {Data: []byte(`<div id="root" data-url="__SLASHDOCS_PUBLIC_URL_VALUE__"></div>`)}})).Handler()
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, httptest.NewRequest(http.MethodGet, "/docs/some_doc", nil))
	if want := `<div id="root" data-url="https://docs.example"></div>`; rr.Code != http.StatusOK || rr.Body.String() != want {
		t.Fatalf("status = %d, body = %q, want 200 and %q", rr.Code, rr.Body.String(), want)
	}
}

func TestFrontendRoutesRedirectRenderHost(t *testing.T) {
	r := gin.New()
	r.GET("/v/:id/:version_id", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.GET("/print/:id/:version_id", func(c *gin.Context) { c.Status(http.StatusOK) })
	registerFrontendRoutes(r, handlers{deps: dependencies{
		appOrigin:    "https://app.example",
		renderOrigin: "https://render.example",
		frontend:     fstest.MapFS{"index.html": {Data: []byte(shellTitle)}},
	}})

	for _, tc := range []struct {
		method, target, location string
		status                   int
	}{
		{http.MethodGet, "https://render.example/", "https://app.example/", http.StatusTemporaryRedirect},
		{http.MethodHead, "https://render.example/login", "https://app.example/login", http.StatusTemporaryRedirect},
		{http.MethodGet, "https://render.example/app/d/doc_1", "https://app.example/app/d/doc_1", http.StatusTemporaryRedirect},
		{http.MethodGet, "https://RENDER.EXAMPLE.:443/app/documents?sort=updated", "https://app.example/app/documents?sort=updated", http.StatusTemporaryRedirect},
		{http.MethodPost, "https://render.example/login", "", http.StatusNotFound},
		{http.MethodGet, "https://render.example/v/doc_1/ver_1", "", http.StatusOK},
		{http.MethodGet, "https://render.example/print/doc_1/ver_1", "", http.StatusOK},
		{http.MethodGet, "https://render.example/v/doc_1?token=secret", "", http.StatusNotFound},
	} {
		req := httptest.NewRequest(tc.method, tc.target, nil)
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, req)
		if rr.Code != tc.status || rr.Header().Get("Location") != tc.location {
			t.Errorf("%s %s: status=%d location=%q, want status=%d location=%q", tc.method, tc.target, rr.Code, rr.Header().Get("Location"), tc.status, tc.location)
		}
	}

	req := httptest.NewRequest(http.MethodGet, "https://app.example/login", nil)
	rr := httptest.NewRecorder()
	r.ServeHTTP(rr, req)
	if rr.Code == http.StatusTemporaryRedirect {
		t.Fatalf("app hostname unexpectedly redirected to %q", rr.Header().Get("Location"))
	}
}
