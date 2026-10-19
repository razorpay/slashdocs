package server_test

import (
	"net/http"
	"strings"
	"testing"
)

func TestDocumentStatus(t *testing.T) {
	e := newTestEnv(t)
	path := "/v1/documents/" + e.doc.ID + "/status"
	as := func(p string) map[string]string {
		return map[string]string{"Content-Type": "application/json", "X-Test-Principal": p}
	}

	rr := do(t, e.h, http.MethodPut, path, `{"status":"in_review"}`, as(principalHeader(fixtureEditor)))
	assertStatus(t, rr, http.StatusOK)
	assertJSON(t, rr.Body.Bytes(), `{"status":"in_review"}`)

	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID, "", as(principalHeader(fixtureViewer)))
	assertStatus(t, rr, http.StatusOK)
	if got := jsonField(t, rr.Body.Bytes(), "status"); got != "in_review" {
		t.Fatalf("document status = %q, want in_review", got)
	}

	rr = do(t, e.h, http.MethodGet, "/v1/documents", "", as(principalHeader(fixtureOwner)))
	assertStatus(t, rr, http.StatusOK)
	if !strings.Contains(rr.Body.String(), `"status":"in_review"`) {
		t.Fatalf("document list is missing the status: %s", rr.Body.String())
	}

	for _, test := range []struct {
		name      string
		principal string
		body      string
		want      int
	}{
		{"viewer cannot set", principalHeader(fixtureViewer), `{"status":"approved"}`, http.StatusForbidden},
		{"commenter cannot set", principalHeader(fixtureCommenter), `{"status":"approved"}`, http.StatusForbidden},
		{"unknown status", principalHeader(fixtureOwner), `{"status":"shipped"}`, http.StatusBadRequest},
		{"missing status", principalHeader(fixtureOwner), `{}`, http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			rr := do(t, e.h, http.MethodPut, path, test.body, as(test.principal))
			assertStatus(t, rr, test.want)
		})
	}

	rr = do(t, e.h, http.MethodPut, path, `{"status":""}`, as(principalHeader(fixtureOwner)))
	assertStatus(t, rr, http.StatusOK)
	rr = do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID, "", as(principalHeader(fixtureOwner)))
	assertStatus(t, rr, http.StatusOK)
	if strings.Contains(rr.Body.String(), `"status"`) {
		t.Fatalf("cleared status is still returned: %s", rr.Body.String())
	}
}
