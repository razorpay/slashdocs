package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func movedTestEngine() *gin.Engine {
	r := gin.New()
	r.Use(movedOriginMiddleware("https://new.example", []string{"https://old.example"}))
	r.GET("/readyz", func(c *gin.Context) { c.String(http.StatusOK, "ok") })
	return r
}

func serveMoved(method, target, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	rr := httptest.NewRecorder()
	movedTestEngine().ServeHTTP(rr, req)
	return rr
}

func TestMovedOriginRedirectsToTheSamePathOnTheAppOrigin(t *testing.T) {
	rr := serveMoved(http.MethodPost, "https://old.example/v1/documents?x=1", "{}")
	if rr.Code != http.StatusPermanentRedirect || rr.Header().Get("Location") != "https://new.example/v1/documents?x=1" {
		t.Fatalf("status=%d location=%q", rr.Code, rr.Header().Get("Location"))
	}
	if rr := serveMoved(http.MethodGet, "https://new.example/readyz", ""); rr.Code != http.StatusOK {
		t.Fatalf("app origin request status = %d, want 200", rr.Code)
	}
}

func TestMovedOriginMCPTellsTheAgentTheNewURL(t *testing.T) {
	for name, body := range map[string]string{
		"initialize": `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}`,
		"tools/list": `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`,
		"tools/call": `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"server_moved","arguments":{}}}`,
	} {
		rr := serveMoved(http.MethodPost, "https://old.example/mcp", body)
		if rr.Code != http.StatusOK || !strings.Contains(rr.Body.String(), "moved to https://new.example/mcp") {
			t.Errorf("%s: status=%d body=%s", name, rr.Code, rr.Body.String())
		}
	}
	if rr := serveMoved(http.MethodGet, "https://old.example/mcp", ""); rr.Code != http.StatusGone || !strings.Contains(rr.Body.String(), "https://new.example/mcp") {
		t.Fatalf("GET status=%d body=%s", rr.Code, rr.Body.String())
	}
}
