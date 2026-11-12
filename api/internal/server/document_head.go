package server

import (
	"bytes"
	"context"
	"errors"
	"html/template"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/notifications"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// documentHeadTemplate replaces the generic <title> of the web app shell on
// a document page. html/template escapes each value for its context.
var documentHeadTemplate = template.Must(template.New("document head").Parse(`<title>{{.Title}} · slashdocs</title>
    <meta name="description" content="{{.Description}}" />
    <meta property="og:site_name" content="slashdocs" />
    <meta property="og:type" content="article" />
    <meta property="og:title" content="{{.Title}}" />
    <meta property="og:description" content="{{.Description}}" />
{{- if .URL}}
    <meta property="og:url" content="{{.URL}}" />
{{- end}}
    <meta name="twitter:card" content="summary" />`))

type documentHeadData struct{ Title, Description, URL string }

// documentHeadTimeout bounds the lookups behind the head of a document page,
// so that a slow database or group directory delays the page by at most this
// much. The page then loads as it does for a caller who may not read the
// document.
const documentHeadTimeout = time.Second

// documentHead returns the <head> fragment of a document page, or nil to keep
// the generic shell when the caller may not read the document or a lookup
// fails. Unlike GET /v1/documents/:id, it adds nothing to the reader's
// workspace and refreshes no group memberships.
func (h handlers) documentHead(r *http.Request, documentID string) []byte {
	ctx, cancel := context.WithTimeout(r.Context(), documentHeadTimeout)
	defer cancel()
	data, err := h.documentHeadData(r.WithContext(ctx), documentID)
	if err != nil {
		slog.WarnContext(ctx, "document head lookup failed", slog.String("document_id", documentID), slog.Any("error", err))
		return nil
	}
	if data == nil {
		return nil
	}
	var b bytes.Buffer
	if err := documentHeadTemplate.Execute(&b, data); err != nil {
		slog.WarnContext(ctx, "document head render failed", slog.String("document_id", documentID), slog.Any("error", err))
		return nil
	}
	return b.Bytes()
}

// documentHeadData authorizes the caller as GET /v1/documents/:id does, except
// that Google Group memberships come only from the cache, and returns what the
// head shows. It returns nil data and no error when the caller may not read
// the document. Without fresh cached memberships, the principal has no groups,
// so access through a group gives no head but other access still does.
func (h handlers) documentHeadData(r *http.Request, documentID string) (*documentHeadData, error) {
	ctx := r.Context()
	p, err := h.deps.readerAuthenticator().Authenticate(r)
	if errors.Is(err, auth.ErrUnauthorized) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if h.deps.googleGroupResolver != nil {
		p = h.deps.googleGroupResolver.ResolveCached(ctx, p)
	}
	role, err := h.deps.repository.RoleForDocument(ctx, *p, documentID)
	if err != nil {
		return nil, err
	}
	if !atLeast(role, repo.RoleViewer) {
		return nil, nil
	}
	d, err := h.deps.repository.GetDocument(ctx, documentID)
	if err != nil {
		return nil, err
	}
	preview, err := h.deps.repository.VersionPreview(ctx, d.CurrentVersionID)
	if err != nil {
		return nil, err
	}
	data := &documentHeadData{Title: d.Title, Description: documentDescription(d, preview)}
	if h.deps.appOrigin != "" {
		data.URL = notifications.DocumentURL(h.deps.appOrigin, d.ID)
	}
	return data, nil
}

// documentDescription describes a document in a link preview: a summary of
// its text, or who owns it and when it changed if it has no indexed text yet.
func documentDescription(d repo.Document, preview repo.VersionPreview) string {
	if summary := notifications.DocumentSummary(d.Title, preview.Text); summary != "" {
		return summary
	}
	var parts []string
	if d.Owner.Name != "" {
		parts = append(parts, "By "+d.Owner.Name)
	}
	if !preview.CreatedAt.IsZero() {
		parts = append(parts, "Updated "+preview.CreatedAt.UTC().Format("2 Jan 2006"))
	}
	return strings.Join(parts, " · ")
}
