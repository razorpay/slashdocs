package server

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/books"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

const manifestContext = "https://readium.org/webpub-manifest/context.jsonld"

// bookView is a book as one reader may see it. Entries hold the whole pruned
// outline, so chapter numbers are the same for every reader (R7). Visible
// names the documents this reader can open.
type bookView struct {
	Book       repo.Book
	Entries    []books.Numbered
	Docs       map[string]repo.Document
	Visible    map[string]bool
	FolderRole repo.Role
	// Words maps a version id to its word count, for visible chapters.
	Words map[string]int
}

type manifestResponse struct {
	Context      string           `json:"@context"`
	Metadata     manifestMetadata `json:"metadata"`
	Links        []manifestLink   `json:"links"`
	ReadingOrder []manifestLink   `json:"readingOrder"`
	TOC          []manifestTOC    `json:"toc"`
}

type manifestMetadata struct {
	Identifier       string `json:"identifier"`
	Title            string `json:"title"`
	Subtitle         string `json:"subtitle,omitempty"`
	NumberOfChapters int    `json:"numberOfChapters"`
	// FolderID is sent only to callers who can view the folder, as the
	// document API shows a parent folder only to them.
	FolderID         string `json:"folderId,omitempty"`
	OutlineVersionID string `json:"outlineVersionId"`
	CanEdit          bool   `json:"canEdit"`
}

type manifestLink struct {
	Href       string        `json:"href,omitempty"`
	Type       string        `json:"type,omitempty"`
	Title      string        `json:"title"`
	Rel        string        `json:"rel,omitempty"`
	Properties *chapterProps `json:"properties,omitempty"`
}

type chapterProps struct {
	DocumentID string     `json:"documentId,omitempty"`
	Kind       books.Kind `json:"kind"`
	Number     int        `json:"number,omitempty"`
	// Part is the index of the chapter's part in this reader's toc, or -1
	// for front and back matter.
	Part      int    `json:"part"`
	VersionID string `json:"versionId,omitempty"`
	WordCount int    `json:"wordCount,omitempty"`
}

type manifestTOC struct {
	Title    string         `json:"title"`
	Children []manifestLink `json:"children"`
}

// bookReaderView loads the book named in the path and works out what the
// caller may read. It answers 404 (never 403) when the book is missing or the
// caller can open none of its chapters, so a book's existence never leaks.
// While group membership is unavailable it answers 503: without the group
// grants the view would silently lose chapters.
func (h handlers) bookReaderView(c *gin.Context) (view bookView, ok bool) {
	if !requireResolvedGroupsForAggregate(c) {
		return bookView{}, false
	}
	ctx := c.Request.Context()
	r := h.deps.repository
	b, err := r.GetBook(ctx, c.Param("id"))
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return bookView{}, false
		}
		internalErr(c, err)
		return bookView{}, false
	}
	p := *current(c)
	role, err := r.RoleForFolder(ctx, p, b.FolderID)
	if err != nil {
		internalErr(c, err)
		return bookView{}, false
	}
	docs, err := r.ListFolderDocuments(ctx, p, b.FolderID)
	if err != nil {
		internalErr(c, err)
		return bookView{}, false
	}
	outline, _ := books.Prune(b.Outline, presentSet(docs))
	view = bookView{
		Book:       b,
		Entries:    books.Number(outline),
		Docs:       docsByID(docs),
		Visible:    map[string]bool{},
		FolderRole: role,
		Words:      map[string]int{},
	}
	folderViewer := atLeast(role, repo.RoleViewer)
	versions, err := h.markVisible(ctx, p, &view, folderViewer)
	if err != nil {
		internalErr(c, err)
		return bookView{}, false
	}
	if len(view.Visible) == 0 && !folderViewer {
		notFound(c)
		return bookView{}, false
	}
	if len(versions) == 0 {
		return view, true
	}
	h.ensureIndexed(c, versions)
	words, err := r.VersionWords(ctx, versions)
	if err != nil {
		requestLogger(c).WarnContext(ctx, "chapter word counts failed", slog.Any("error", err))
	} else {
		view.Words = words
	}
	return view, true
}

// markVisible fills view.Visible with the slots p may read and returns the
// current version of each visible chapter. A folder viewer may read every
// slot; anyone else needs a grant on the document.
func (h handlers) markVisible(ctx context.Context, p auth.Principal, view *bookView, folderViewer bool) ([]string, error) {
	var versions []string
	for _, e := range view.Entries {
		if e.Doc == "" {
			continue
		}
		if !folderViewer {
			// TODO: batch these into one query.
			dr, err := h.deps.repository.RoleForDocument(ctx, p, e.Doc)
			if err != nil {
				return nil, err
			}
			if !atLeast(dr, repo.RoleViewer) {
				continue
			}
		}
		view.Visible[e.Doc] = true
		if e.Kind == books.KindChapter {
			if v := view.Docs[e.Doc].CurrentVersionID; v != "" {
				versions = append(versions, v)
			}
		}
	}
	return versions, nil
}

// chapterHref is the canonical reader URL of one chapter (A11).
func chapterHref(bookID, docID string) string {
	return "/app/b/" + bookID + "/c/" + docID
}

// link builds the manifest link for a visible slot.
func (v bookView) link(e books.Numbered) manifestLink {
	d := v.Docs[e.Doc]
	return manifestLink{
		Href:  chapterHref(v.Book.ID, e.Doc),
		Type:  "text/html",
		Title: books.DisplayTitle(d.Title, e.Number),
		Properties: &chapterProps{
			DocumentID: e.Doc,
			Kind:       e.Kind,
			Number:     e.Number,
			Part:       e.Part,
			VersionID:  d.CurrentVersionID,
			WordCount:  v.Words[d.CurrentVersionID],
		},
	}
}

func (v bookView) manifest() manifestResponse {
	out := manifestResponse{
		Context: manifestContext,
		Metadata: manifestMetadata{
			Identifier:       v.Book.ID,
			Title:            v.Book.Outline.Title,
			Subtitle:         v.Book.Outline.Subtitle,
			OutlineVersionID: v.Book.OutlineVersionID,
			CanEdit:          atLeast(v.FolderRole, repo.RoleEditor),
		},
		Links:        []manifestLink{{Href: "/v1/books/" + v.Book.ID, Type: "application/json", Title: "Manifest", Rel: "self"}},
		ReadingOrder: []manifestLink{},
		TOC:          []manifestTOC{},
	}
	if atLeast(v.FolderRole, repo.RoleViewer) {
		out.Metadata.FolderID = v.Book.FolderID
	}
	toc := make([]manifestTOC, len(v.Book.Outline.Parts))
	for i, p := range v.Book.Outline.Parts {
		toc[i] = manifestTOC{Title: p.Title, Children: []manifestLink{}}
	}
	for _, e := range v.Entries {
		// Count what this reader can see, so that the total does not reveal
		// hidden chapters after the last visible one. Placeholders are shown
		// to every reader.
		if e.Kind == books.KindPlanned || (e.Kind == books.KindChapter && v.Visible[e.Doc]) {
			out.Metadata.NumberOfChapters++
		}
		if e.Kind == books.KindPlanned {
			toc[e.Part].Children = append(toc[e.Part].Children, manifestLink{
				Title:      e.Planned,
				Properties: &chapterProps{Kind: books.KindPlanned, Number: e.Number, Part: e.Part},
			})
			continue
		}
		if !v.Visible[e.Doc] {
			continue
		}
		l := v.link(e)
		out.ReadingOrder = append(out.ReadingOrder, l)
		if e.Kind == books.KindChapter {
			toc[e.Part].Children = append(toc[e.Part].Children, l)
		}
	}
	for _, t := range toc {
		if len(t.Children) == 0 {
			continue
		}
		// Number parts by their place in this reader's toc, so that the
		// outline index does not count the parts the reader cannot see. The
		// readingOrder link shares these properties.
		for _, l := range t.Children {
			l.Properties.Part = len(out.TOC)
		}
		out.TOC = append(out.TOC, t)
	}
	return out
}

// GetManifest godoc
// @Summary Get a book's manifest
// @Description A Readium-style manifest of the chapters this caller can open. Numbering is the same for every reader. Answers 404 when the caller can open no chapter.
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Produce json
// @Param id path string true "Book ID"
// @Success 200 {object} manifestResponse
// @Failure 404 {object} errorEnvelope
// @Failure 429 {object} errorEnvelope "rate_limited"
// @Failure 503 {object} errorEnvelope "group_membership_unavailable"
// @Router /v1/books/{id} [get]
func (h handlers) getManifest(c *gin.Context) {
	if !h.booksOn(c) {
		return
	}
	view, ok := h.bookReaderView(c)
	if !ok {
		return
	}
	incBook("manifest_view")
	c.Header("Cache-Control", "private, no-cache")
	c.JSON(http.StatusOK, view.manifest())
}

// GetBookLLMs godoc
// @Summary Get a book's llms.txt
// @Description A plain-text index of the chapters this caller can open.
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Produce plain
// @Param id path string true "Book ID"
// @Success 200 {string} string
// @Failure 404 {object} errorEnvelope
// @Failure 429 {object} errorEnvelope "rate_limited"
// @Failure 503 {object} errorEnvelope "group_membership_unavailable"
// @Router /v1/books/{id}/llms.txt [get]
func (h handlers) getBookLLMs(c *gin.Context) {
	if !h.booksOn(c) {
		return
	}
	view, ok := h.bookReaderView(c)
	if !ok {
		return
	}
	var sb strings.Builder
	sb.WriteString("# " + llmsText(view.Book.Outline.Title) + "\n\n")
	for _, e := range view.Entries {
		if e.Kind != books.KindChapter || !view.Visible[e.Doc] {
			continue
		}
		l := view.link(e)
		fmt.Fprintf(&sb, "- [%d · %s](%s)\n", e.Number, llmsText(l.Title), l.Href)
	}
	c.Header("Cache-Control", "private, no-cache")
	c.Data(http.StatusOK, "text/plain; charset=utf-8", []byte(sb.String()))
}

// llmsMarkdownEscaper escapes the characters that would let a title close
// its link text, start a link of its own, or open a CommonMark autolink
// (<https://…>).
var llmsMarkdownEscaper = strings.NewReplacer(`\`, `\\`, `[`, `\[`, `]`, `\]`, `(`, `\(`, `)`, `\)`, `<`, `\<`, `>`, `\>`)

// llmsBareWWW finds a "www." that a GFM renderer would autolink.
var llmsBareWWW = regexp.MustCompile(`(?i)\b(www)\.`)

// llmsText makes a title safe for one line of llms.txt: line breaks fold
// into spaces, so it cannot start a new line, and Markdown link syntax is
// escaped, so it cannot add a link that agents would follow. A bare URL
// would still be autolinked by GFM renderers, so the ":" of "://" and the
// "." of "www." are escaped too; they read the same once rendered.
func llmsText(s string) string {
	s = llmsMarkdownEscaper.Replace(strings.Join(strings.Fields(s), " "))
	s = strings.ReplaceAll(s, "://", `\://`)
	return llmsBareWWW.ReplaceAllString(s, `${1}\.`)
}
