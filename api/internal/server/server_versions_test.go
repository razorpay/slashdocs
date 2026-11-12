package server_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/server"
)

func TestViewerCannotUploadVersion(t *testing.T) {
	e := newTestEnv(t)
	body, contentType := multipartBody(t, map[string]string{
		"base_version_id": e.ver.ID,
	}, "file", "review.html", "<html><body>Updated</body></html>")

	rr := doRaw(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/versions", body, map[string]string{
		"Content-Type":     contentType,
		"X-Test-Principal": principalHeader(fixtureViewer),
	})

	assertStatus(t, rr, http.StatusForbidden)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "forbidden", "message": "editor role required" }
	}`)
}

func TestVersionConflict(t *testing.T) {
	e := newTestEnv(t)
	body, contentType := multipartBody(t, map[string]string{
		"base_version_id": "ver_old",
		"change_summary":  "addressed comments",
	}, "file", "review.html", "<html><body>Updated</body></html>")

	rr := doRaw(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/versions", body, map[string]string{
		"Content-Type":     contentType,
		"X-Test-Principal": principalHeader(fixtureEditor),
	})

	assertStatus(t, rr, http.StatusConflict)
	assertJSON(t, rr.Body.Bytes(), fmt.Sprintf(`{
	  "error": {
	    "code": "version_conflict",
	    "message": "base_version_id is stale",
	    "details": { "current_version_id": %q }
	  }
	}`, e.ver.ID))
}

func TestRenderCSPAllowsConfiguredAppOrigin(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", AppOrigin: "https://app.example", SessionSecret: "test-secret"})
	docID, verID := e.createDocument("Doc", "<html><body>x</body></html>", fixtureOwner)

	tokRR := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/versions/"+verID+"/render-token", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, tokRR, http.StatusOK)
	var tok struct {
		Token string `json:"token"`
		URL   string `json:"url"`
	}
	if err := json.Unmarshal(tokRR.Body.Bytes(), &tok); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(tok.URL, "token=") {
		t.Fatalf("same-origin render URL leaked token in query: %q", tok.URL)
	}
	if cookies := tokRR.Result().Cookies(); len(cookies) == 0 {
		t.Fatalf("render token response did not set a cookie")
	} else if cookies[0].Name != "slashdocs_render_token" || !cookies[0].HttpOnly {
		t.Fatalf("render token cookie = %#v, want HttpOnly slashdocs_render_token", cookies[0])
	}

	rr := doRaw(t, e.h, http.MethodGet, tok.URL, nil, map[string]string{
		"Cookie": tokRR.Result().Cookies()[0].String(),
	})
	assertStatus(t, rr, http.StatusOK)
	csp := rr.Header().Get("Content-Security-Policy")
	for _, want := range []string{
		"img-src * data: blob:",
		"media-src * data: blob:",
		"font-src * data: blob:",
		"style-src * 'unsafe-inline'",
		"script-src * 'unsafe-inline' 'unsafe-eval'",
		"connect-src *",
		"frame-src *",
		"worker-src * blob:",
		"object-src 'none'",
		"frame-ancestors https://app.example",
	} {
		if !strings.Contains(csp, want) {
			t.Fatalf("CSP = %q, want %q", csp, want)
		}
	}
	if got := rr.Header().Get("Referrer-Policy"); got != "no-referrer" {
		t.Fatalf("Referrer-Policy = %q, want no-referrer", got)
	}
}

func TestRenderRouteRequiresRenderHostWhenConfigured(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", AppOrigin: "https://app.example", RenderOrigin: "https://doc.example", SessionSecret: "test-secret"})
	token := (auth.SessionCodec{Secret: []byte("test-secret")}).SignForAudience("render:"+e.doc.ID+"/"+e.ver.ID, "render", 5*time.Minute)
	req := httptest.NewRequest(http.MethodGet, "/v/"+e.doc.ID+"/"+e.ver.ID+"?token="+token, nil)
	req.Host = "app.example"
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)
	assertStatus(t, rr, http.StatusNotFound)
}

func TestRenderRouteAcceptsEquivalentCanonicalHost(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", AppOrigin: "https://app.example", RenderOrigin: "https://render.example.:443", SessionSecret: "test-secret"})
	token := (auth.SessionCodec{Secret: []byte("test-secret")}).SignForAudience("render:"+e.doc.ID+"/"+e.ver.ID, "render", 5*time.Minute)
	req := httptest.NewRequest(http.MethodGet, "/v/"+e.doc.ID+"/"+e.ver.ID+"?token="+token, nil)
	req.Host = "RENDER.EXAMPLE"
	rr := httptest.NewRecorder()

	e.h.ServeHTTP(rr, req)

	assertStatus(t, rr, http.StatusOK)
}

func TestRenderRouteReturnsWrapperNotRawHTML(t *testing.T) {
	e := newConfiguredTestEnv(t, server.Config{Environment: "test", AppOrigin: "https://app.example", SessionSecret: "test-secret"})
	docID, verID := e.createDocument("Doc", "<html><body>x</body></html>", fixtureOwner)
	tokRR := do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/versions/"+verID+"/render-token", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	var tok struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(tokRR.Body.Bytes(), &tok); err != nil {
		t.Fatal(err)
	}

	rr := do(t, e.h, http.MethodGet, "/v/"+docID+"/"+verID+"?token="+tok.Token, "", nil)
	assertStatus(t, rr, http.StatusOK)
	wrapperBody := rr.Body.String()
	if !strings.Contains(wrapperBody, `<iframe id="slashdocs-doc"`) ||
		!strings.Contains(wrapperBody, "slashdocs-bootstrap") ||
		!strings.Contains(wrapperBody, "&lt;html&gt;") ||
		!strings.Contains(wrapperBody, "&lt;/html&gt;") {
		t.Fatalf("body = %q, want render wrapper with escaped srcdoc", rr.Body.String())
	}
}

func TestRawHTMLDownloadIsServedInert(t *testing.T) {
	e := newTestEnv(t)
	docID, verID := e.createDocument("Doc", `<html><script>fetch('/v1/me')</script></html>`, fixtureOwner)

	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+docID+"/versions/"+verID+"/html", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, rr, http.StatusOK)
	if got := rr.Header().Get("Content-Security-Policy"); got != "sandbox; default-src 'none'" {
		t.Fatalf("Content-Security-Policy = %q", got)
	}
	if got := rr.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("X-Content-Type-Options = %q", got)
	}
	if got := rr.Header().Get("Content-Disposition"); !strings.Contains(got, "attachment") || !strings.Contains(got, verID+".html") {
		t.Fatalf("Content-Disposition = %q", got)
	}
}

func TestRawHTMLBrowserRequestRedirectsToLoginWhenUnauthenticated(t *testing.T) {
	e := newTestEnv(t)
	path := "/v1/documents/" + e.doc.ID + "/versions/" + e.ver.ID + "/html"
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	rr := httptest.NewRecorder()
	e.h.ServeHTTP(rr, req)

	assertStatus(t, rr, http.StatusFound)
	loc := rr.Header().Get("Location")
	wantRedirect := "redirect=" + strings.ReplaceAll(strings.ReplaceAll(path, "/", "%2F"), ":", "%3A")
	if !strings.HasPrefix(loc, "/v1/auth/google/start?mode=web&") || !strings.Contains(loc, wantRedirect) {
		t.Fatalf("Location = %q, want %q", loc, wantRedirect)
	}
}
