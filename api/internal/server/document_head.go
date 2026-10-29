package server

import (
	"bytes"
	"context"
	"errors"
	"html/template"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	"github.com/razorpay/slashdocs/api/internal/auth"
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
// the document.
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
	if groupMembershipUnavailable(p) {
		return nil, nil
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
	preview, err := h.deps.repository.DocumentPreview(ctx, documentID)
	if err != nil {
		return nil, err
	}
	data := &documentHeadData{Title: d.Title, Description: documentDescription(d, preview)}
	if origin := strings.TrimRight(h.deps.appOrigin, "/"); origin != "" {
		data.URL = origin + "/app/d/" + url.PathEscape(d.ID)
	}
	return data, nil
}

// maxDescriptionRunes caps a link preview description, ellipsis included.
const maxDescriptionRunes = 200

// documentExcerpt returns the start of a document's text for a link preview:
// whitespace collapsed, leading copies of the title removed (documents often
// repeat it in <title> and <h1>), and cut at a word boundary to at most limit
// characters, ellipsis included.
func documentExcerpt(title, text string, limit int) string {
	r := []rune(strings.Join(strings.Fields(text), " "))
	if t := []rune(strings.Join(strings.Fields(title), " ")); len(t) > 0 {
		for len(r) >= len(t) && strings.EqualFold(string(r[:len(t)]), string(t)) &&
			(len(r) == len(t) || !unicode.IsLetter(r[len(t)]) && !unicode.IsDigit(r[len(t)])) {
			r = []rune(strings.TrimLeft(string(r[len(t):]), " -–—|:·"))
		}
	}
	if len(r) <= limit {
		return string(r)
	}
	cut := r[:limit-1]
	if r[limit-1] != ' ' {
		if i := lastSpace(cut); i > 0 {
			cut = cut[:i]
		}
	}
	return strings.TrimRight(string(cut), " ,;:-–—") + "…"
}

func lastSpace(r []rune) int {
	for i := len(r) - 1; i >= 0; i-- {
		if r[i] == ' ' {
			return i
		}
	}
	return -1
}

// documentDescription describes a document in a link preview: an excerpt of
// its text, or who owns it and when it changed if it has no indexed text yet.
func documentDescription(d repo.Document, preview repo.DocumentPreview) string {
	if excerpt := documentExcerpt(d.Title, preview.Text, maxDescriptionRunes); excerpt != "" {
		return excerpt
	}
	var parts []string
	if d.Owner.Name != "" {
		parts = append(parts, "By "+d.Owner.Name)
	}
	if !preview.UpdatedAt.IsZero() {
		parts = append(parts, "Updated "+preview.UpdatedAt.UTC().Format("2 Jan 2006"))
	}
	return strings.Join(parts, " · ")
}
