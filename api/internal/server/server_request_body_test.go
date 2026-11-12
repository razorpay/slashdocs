package server_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestRequestBodyLimits(t *testing.T) {
	e := newTestEnv(t)
	for _, path := range []string{"/v1/auth/cli/exchange", "/oauth/register", "/v1/documents/" + e.doc.ID + "/comments"} {
		for _, length := range []int64{-1, 2 << 20} {
			reader := strings.NewReader(strings.Repeat(" ", 2<<20))
			req := httptest.NewRequest(http.MethodPost, path, reader)
			req.ContentLength = length
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Test-Principal", principalHeader(fixtureCommenter))
			rr := httptest.NewRecorder()
			e.h.ServeHTTP(rr, req)
			status := http.StatusRequestEntityTooLarge
			if length < 0 {
				status = http.StatusBadRequest
			}
			assertStatus(t, rr, status)
			if consumed := (2 << 20) - reader.Len(); consumed > (1<<20)+1 {
				t.Fatalf("read %d bytes beyond the request limit", consumed)
			}
		}
	}
}

func TestMultipartRequestBodyLimits(t *testing.T) {
	e := newTestEnv(t)
	body := "--boundary\r\nContent-Disposition: form-data; name=\"file\"; filename=\"doc.html\"\r\nContent-Type: text/html\r\n\r\n" + strings.Repeat("x", 52<<20) + "\r\n--boundary--\r\n"
	for _, path := range []string{"/v1/documents", "/v1/documents/" + e.doc.ID + "/versions"} {
		for _, knownLength := range []bool{true, false} {
			reader := strings.NewReader(body)
			req := httptest.NewRequest(http.MethodPost, path, reader)
			if !knownLength {
				req.ContentLength = -1
			}
			req.Header.Set("Content-Type", "multipart/form-data; boundary=boundary")
			req.Header.Set("X-Test-Principal", principalHeader(fixtureEditor))
			rr := httptest.NewRecorder()
			e.h.ServeHTTP(rr, req)
			assertStatus(t, rr, http.StatusRequestEntityTooLarge)
			if consumed := len(body) - reader.Len(); consumed > (51<<20)+1 {
				t.Fatalf("read %d bytes beyond the request limit", consumed)
			}
		}
	}
}
