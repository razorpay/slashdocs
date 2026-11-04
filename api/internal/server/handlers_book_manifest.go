package server

import (
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"

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
	FolderID         string `json:"folderId"`
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
	Part       int        `json:"part"`
	VersionID  string     `json:"versionId,omitempty"`
	WordCount  int        `json:"wordCount,omitempty"`
}

type manifestTOC struct {
	Title    string         `json:"title"`
	Children []manifestLink `json:"children"`
}

// bookReaderView loads the book named in the path and works out what the
// caller may read. It answers 404 (never 403) when the book is missing or the
// caller can open none of its chapters, so a book's existence never leaks.
func (h handlers) bookReaderView(c *gin.Context) (view bookView, ok bool) {
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
		Docs:       make(map[string]repo.Document, len(docs)),
		Visible:    map[string]bool{},
		FolderRole: role,
		Words:      map[string]int{},
	}
	for _, d := range docs {
		view.Docs[d.ID] = d
	}
	folderViewer := atLeast(role, repo.RoleViewer)
	var versions []string
	for _, e := range view.Entries {
		if e.Doc == "" {
			continue
		}
		if !folderViewer {
			// TODO: batch these into one query.
			dr, err := r.RoleForDocument(ctx, p, e.Doc)
			if err != nil {
				internalErr(c, err)
				return bookView{}, false
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
	if len(view.Visible) == 0 && !folderViewer {
		notFound(c)
		return bookView{}, false
	}
	log := requestLogger(c)
	if len(versions) == 0 {
		return view, true
	}
	stale, err := r.UnindexedVersions(ctx, versions)
	if err != nil {
		// Fall back to asking Ensure about every version.
		log.WarnContext(ctx, "check indexed chapters failed", slog.Any("error", err))
		stale = versions
	}
	for _, v := range stale {
		if err := r.EnsureVersionSections(ctx, v); err != nil {
			log.WarnContext(ctx, "index chapter sections failed", slog.String("version_id", v), slog.Any("error", err))
		}
	}
	words, err := r.VersionWords(ctx, versions)
	if err != nil {
		log.WarnContext(ctx, "chapter word counts failed", slog.Any("error", err))
	} else {
		view.Words = words
	}
	return view, true
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
			FolderID:         v.Book.FolderID,
			OutlineVersionID: v.Book.OutlineVersionID,
			CanEdit:          atLeast(v.FolderRole, repo.RoleEditor),
		},
		Links:        []manifestLink{{Href: "/v1/books/" + v.Book.ID, Type: "application/json", Title: "Manifest", Rel: "self"}},
		ReadingOrder: []manifestLink{},
		TOC:          []manifestTOC{},
	}
	toc := make([]manifestTOC, len(v.Book.Outline.Parts))
	for i, p := range v.Book.Outline.Parts {
		toc[i] = manifestTOC{Title: p.Title, Children: []manifestLink{}}
	}
	for _, e := range v.Entries {
		if e.Kind == books.KindChapter || e.Kind == books.KindPlanned {
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
		if len(t.Children) > 0 {
			out.TOC = append(out.TOC, t)
		}
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
// @Router /v1/books/{id} [get]
func (h handlers) getManifest(c *gin.Context) {
	if !h.booksOn(c) {
		return
	}
	view, ok := h.bookReaderView(c)
	if !ok {
		return
	}
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
	sb.WriteString("# " + oneLine(view.Book.Outline.Title) + "\n\n")
	for _, e := range view.Entries {
		if e.Kind != books.KindChapter || !view.Visible[e.Doc] {
			continue
		}
		l := view.link(e)
		sb.WriteString(fmt.Sprintf("- [%d · %s](%s)\n", e.Number, oneLine(l.Title), l.Href))
	}
	c.Header("Cache-Control", "private, no-cache")
	c.Data(http.StatusOK, "text/plain; charset=utf-8", []byte(sb.String()))
}

// oneLine folds line breaks into spaces so a title cannot start a new line.
func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
