package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestFrontendRoutesRedirectRenderHost(t *testing.T) {
	r := gin.New()
	r.GET("/v/:id/:version_id", func(c *gin.Context) { c.Status(http.StatusOK) })
	r.GET("/print/:id/:version_id", func(c *gin.Context) { c.Status(http.StatusOK) })
	registerFrontendRoutes(r, "https://app.example", "https://render.example")

	for _, tc := range []struct {
		method, target, location string
		status                   int
	}{
		{http.MethodGet, "https://render.example/", "https://app.example/", http.StatusTemporaryRedirect},
		{http.MethodHead, "https://render.example/login", "https://app.example/login", http.StatusTemporaryRedirect},
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
