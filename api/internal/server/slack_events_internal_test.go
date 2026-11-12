package server

import "testing"

func TestParseSlashDocsLink(t *testing.T) {
	h := handlers{deps: dependencies{appOrigin: "https://slashdocs.example", previousOrigins: []string{"https://aidocs.example/"}}}
	cases := []struct {
		url, doc, version string
		ok                bool
	}{
		{url: "https://slashdocs.example/app/d/doc_abc123", doc: "doc_abc123", ok: true},
		{url: "https://SLASHDOCS.example/app/d/doc_abc123/", doc: "doc_abc123", ok: true},
		{url: "http://slashdocs.example/app/d/doc_abc123", doc: "doc_abc123", ok: true},
		{url: "https://slashdocs.example/app/d/doc_abc123?version=ver_9&comment=cmt_1#h-intro", doc: "doc_abc123", version: "ver_9", ok: true},
		{url: "https://aidocs.example/documents/doc_abc123", doc: "doc_abc123", ok: true},
		{url: "https://aidocs.example/app/d/doc_abc123", doc: "doc_abc123", ok: true},
		// Hosts match the way movedOriginMiddleware matches them, so the port must too.
		{url: "https://slashdocs.example:8443/app/d/doc_abc123"},
		{url: "https://slashdocs.example/app/folders/fld_1"},
		{url: "https://slashdocs.example/v/doc_abc123/ver_1?token=x"},
		{url: "https://slashdocs.example/app/d/doc_abc123/extra"},
		{url: "https://slashdocs.example/app/d/not-a-doc"},
		{url: "https://evil.example/app/d/doc_abc123"},
		{url: "https://slashdocs.example.evil.example/app/d/doc_abc123"},
		{url: "ftp://slashdocs.example/app/d/doc_abc123"},
		{url: "not a url"},
	}
	for _, tc := range cases {
		doc, version, ok := h.parseSlashDocsLink(tc.url)
		if ok != tc.ok || doc != tc.doc || version != tc.version {
			t.Errorf("%s: got (%q, %q, %v), want (%q, %q, %v)", tc.url, doc, version, ok, tc.doc, tc.version, tc.ok)
		}
	}
}
