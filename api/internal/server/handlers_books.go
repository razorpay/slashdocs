package server

import (
	"errors"
	"net/http"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/books"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

const maxOutlineNoteRunes = 500

// booksOn answers 404 feature_disabled and returns false when book mode is off.
func (h handlers) booksOn(c *gin.Context) bool {
	if !h.deps.booksEnabled {
		featureDisabled(c, "Books are not enabled on this server")
		return false
	}
	return true
}

// loadBook reads the book named in the path and checks the caller's role on
// its folder. A missing book, and one whose folder the caller cannot view,
// are both 404, so that the answer never confirms a book id. Only a folder
// viewer or commenter who needs more is told 403.
func (h handlers) loadBook(c *gin.Context, need repo.Role) (repo.Book, bool) {
	ctx := c.Request.Context()
	b, err := h.deps.repository.GetBook(ctx, c.Param("id"))
	if err != nil {
		lookupFailed(c, err)
		return repo.Book{}, false
	}
	role, err := h.deps.repository.RoleForFolder(ctx, *current(c), b.FolderID)
	if err != nil {
		internalErr(c, err)
		return repo.Book{}, false
	}
	switch {
	case atLeast(role, need):
		return b, true
	case groupMembershipUnavailable(current(c)):
		groupMembershipUnavailableResponse(c)
	case atLeast(role, repo.RoleViewer):
		forbidden(c, string(need)+" role required")
	default:
		notFound(c)
	}
	return repo.Book{}, false
}

// bookDoc names a document that the outline does not place.
type bookDoc struct {
	ID    string `json:"id"`
	Title string `json:"title"`
}

// createBookResponse is the payload of POST /v1/folders/{id}/book.
type createBookResponse struct {
	BookID           string    `json:"book_id"`
	OutlineVersionID string    `json:"outline_version_id"`
	Placed           []string  `json:"placed"`
	NotInOutline     []bookDoc `json:"not_in_outline"`
}

// folderBookResponse is the payload of GET /v1/folders/{id}/book.
type folderBookResponse struct {
	BookID string `json:"book_id"`
}

// outlineResponse is the payload of GET /v1/books/{id}/outline.
type outlineResponse struct {
	VersionID    string        `json:"version_id"`
	Number       int           `json:"number"`
	Outline      books.Outline `json:"outline"`
	NotInOutline []bookDoc     `json:"not_in_outline"`
	Removed      []string      `json:"removed"`
}

// putOutlineRequest is the body of PUT /v1/books/{id}/outline.
type putOutlineRequest struct {
	BaseVersionID string        `json:"base_version_id"`
	Outline       books.Outline `json:"outline"`
	Note          string        `json:"note"`
}

// putOutlineResponse is the payload of PUT /v1/books/{id}/outline.
type putOutlineResponse struct {
	VersionID string `json:"version_id"`
	Number    int    `json:"number"`
}

// outlineConflictDetails names the current outline version when a push hits a
// stale base_version_id.
type outlineConflictDetails struct {
	CurrentVersionID string `json:"current_version_id"`
}

// invalidOutlineDetails lists every problem found in a pushed outline.
type invalidOutlineDetails struct {
	Problems []books.Problem `json:"problems"`
}

// outlineVersionResponse is one item of GET /v1/books/{id}/outline/versions.
type outlineVersionResponse struct {
	ID         string         `json:"id"`
	Number     int            `json:"number"`
	ChangeNote string         `json:"change_note"`
	CreatedBy  auth.Principal `json:"created_by"`
	CreatedAt  string         `json:"created_at"`
}

// bookStatusEntry is one outline slot in GET /v1/books/{id}/status.
type bookStatusEntry struct {
	Kind             string `json:"kind"`
	Number           int    `json:"number"`
	DocumentID       string `json:"document_id,omitempty"`
	Title            string `json:"title"`
	CurrentVersionID string `json:"current_version_id,omitempty"`
	Planned          bool   `json:"planned"`
}

// bookStatusResponse is the payload of GET /v1/books/{id}/status.
type bookStatusResponse struct {
	Entries      []bookStatusEntry `json:"entries"`
	NotInOutline []bookDoc         `json:"not_in_outline"`
	Removed      []string          `json:"removed"`
}

// folderDocs lists the documents in the book's folder. Callers must already
// hold the editor role on the folder, so the list is complete.
func (h handlers) folderDocs(c *gin.Context, folderID string) ([]repo.Document, bool) {
	docs, err := h.deps.repository.ListFolderDocuments(c.Request.Context(), *current(c), folderID)
	if err != nil {
		internalErr(c, err)
		return nil, false
	}
	return docs, true
}

// outlineDocSet is the set of documents that outline places.
func outlineDocSet(o books.Outline) map[string]bool {
	ids := books.DocIDs(o)
	m := make(map[string]bool, len(ids))
	for _, id := range ids {
		m[id] = true
	}
	return m
}

// docsByID indexes docs by id.
func docsByID(docs []repo.Document) map[string]repo.Document {
	m := make(map[string]repo.Document, len(docs))
	for _, d := range docs {
		m[d.ID] = d
	}
	return m
}

// notInOutline returns the documents that outline does not place.
func notInOutline(o books.Outline, docs []repo.Document) []bookDoc {
	placed := outlineDocSet(o)
	out := []bookDoc{}
	for _, d := range docs {
		if !placed[d.ID] {
			out = append(out, bookDoc{ID: d.ID, Title: d.Title})
		}
	}
	return out
}

func presentSet(docs []repo.Document) map[string]bool {
	m := make(map[string]bool, len(docs))
	for _, d := range docs {
		m[d.ID] = true
	}
	return m
}

// normalizeOutline replaces nil slices with empty ones so they encode as [].
func normalizeOutline(o books.Outline) books.Outline {
	if o.Front == nil {
		o.Front = []books.Entry{}
	}
	if o.Back == nil {
		o.Back = []books.Entry{}
	}
	if o.Parts == nil {
		o.Parts = []books.Part{}
	}
	for i := range o.Parts {
		if o.Parts[i].Chapters == nil {
			o.Parts[i].Chapters = []books.Entry{}
		}
	}
	return o
}

// CreateBook godoc
// @Summary Make a folder a book
// @Description Seeds the outline from the folder's numbered document titles.
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Folder ID"
// @Success 201 {object} createBookResponse
// @Failure 403 {object} errorEnvelope
// @Failure 409 {object} errorEnvelope "book_exists"
// @Router /v1/folders/{id}/book [post]
func (h handlers) createBook(c *gin.Context) {
	if !h.booksOn(c) {
		return
	}
	folderID := c.Param("id")
	if !h.needFolderRole(c, folderID, repo.RoleEditor) {
		return
	}
	ctx := c.Request.Context()
	folder, err := h.deps.repository.GetFolder(ctx, folderID)
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	docs, ok := h.folderDocs(c, folderID)
	if !ok {
		return
	}
	titles := make([]books.DocTitle, 0, len(docs))
	for _, d := range docs {
		titles = append(titles, books.DocTitle{ID: d.ID, Title: d.Title})
	}
	outline, unplaced := books.Seed(folder.Title, titles)
	b, err := h.deps.repository.CreateBook(ctx, folderID, outline, *current(c))
	if err != nil {
		switch {
		case errors.Is(err, repo.ErrConflict):
			c.JSON(http.StatusConflict, errorResponse("book_exists", "This folder is already a book.", nil))
		case errors.Is(err, repo.ErrNotFound):
			notFound(c)
		default:
			internalErr(c, err)
		}
		return
	}
	incBook("created")
	byID := docsByID(docs)
	rest := make([]bookDoc, 0, len(unplaced))
	for _, id := range unplaced {
		rest = append(rest, bookDoc{ID: id, Title: byID[id].Title})
	}
	c.JSON(http.StatusCreated, createBookResponse{
		BookID:           b.ID,
		OutlineVersionID: b.OutlineVersionID,
		Placed:           books.DocIDs(b.Outline),
		NotInOutline:     rest,
	})
}

// FolderBook godoc
// @Summary Get a folder's book
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Folder ID"
// @Success 200 {object} folderBookResponse
// @Failure 404 {object} errorEnvelope
// @Router /v1/folders/{id}/book [get]
func (h handlers) folderBook(c *gin.Context) {
	if !h.booksOn(c) {
		return
	}
	if !h.needFolderRole(c, c.Param("id"), repo.RoleViewer) {
		return
	}
	id, err := h.deps.repository.GetBookIDByFolder(c.Request.Context(), c.Param("id"))
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, folderBookResponse{BookID: id})
}

// DeleteBook godoc
// @Summary Delete a book
// @Description Removes the book and its outline history. The folder and its documents stay.
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Book ID"
// @Success 204
// @Failure 403 {object} errorEnvelope "folder viewer without the editor role"
// @Failure 404 {object} errorEnvelope "missing book, or no role on its folder"
// @Failure 503 {object} errorEnvelope "group_membership_unavailable"
// @Router /v1/books/{id} [delete]
func (h handlers) deleteBook(c *gin.Context) {
	if !h.booksOn(c) {
		return
	}
	b, ok := h.loadBook(c, repo.RoleEditor)
	if !ok {
		return
	}
	if err := h.deps.repository.DeleteBook(c.Request.Context(), b.ID); err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			notFound(c)
			return
		}
		internalErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// GetOutline godoc
// @Summary Get a book's outline
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Book ID"
// @Success 200 {object} outlineResponse
// @Failure 403 {object} errorEnvelope "folder viewer without the editor role"
// @Failure 404 {object} errorEnvelope "missing book, or no role on its folder"
// @Failure 503 {object} errorEnvelope "group_membership_unavailable"
// @Router /v1/books/{id}/outline [get]
func (h handlers) getOutline(c *gin.Context) {
	if !h.booksOn(c) {
		return
	}
	b, ok := h.loadBook(c, repo.RoleEditor)
	if !ok {
		return
	}
	docs, ok := h.folderDocs(c, b.FolderID)
	if !ok {
		return
	}
	// The store writes a new outline version when a chapter leaves, so Prune
	// is only a defensive filter and removed is normally empty.
	outline, removed := books.Prune(b.Outline, presentSet(docs))
	if removed == nil {
		removed = []string{}
	}
	c.JSON(http.StatusOK, outlineResponse{
		VersionID:    b.OutlineVersionID,
		Number:       b.OutlineNumber,
		Outline:      normalizeOutline(outline),
		NotInOutline: notInOutline(outline, docs),
		Removed:      removed,
	})
}

// PutOutline godoc
// @Summary Save a book's outline
// @Description Saves a new outline version. base_version_id must be the current version.
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Accept json
// @Param id path string true "Book ID"
// @Param body body putOutlineRequest true "Outline"
// @Success 200 {object} putOutlineResponse
// @Failure 400 {object} errorEnvelope "bad_request"
// @Failure 403 {object} errorEnvelope "folder viewer without the editor role"
// @Failure 404 {object} errorEnvelope "missing book, or no role on its folder"
// @Failure 409 {object} errorEnvelope "outline_conflict"
// @Failure 422 {object} errorEnvelope "invalid_outline"
// @Failure 413 {object} errorEnvelope "payload_too_large"
// @Failure 415 {object} errorEnvelope
// @Failure 503 {object} errorEnvelope "group_membership_unavailable"
// @Router /v1/books/{id}/outline [put]
func (h handlers) putOutline(c *gin.Context) {
	if !h.booksOn(c) {
		return
	}
	b, ok := h.loadBook(c, repo.RoleEditor)
	if !ok {
		return
	}
	var in putOutlineRequest
	if !bindJSON(c, &in, "bad_request", false) {
		return
	}
	if in.BaseVersionID == "" {
		badRequest(c, "base_version_id is required")
		return
	}
	if utf8.RuneCountInString(in.Note) > maxOutlineNoteRunes {
		badRequest(c, "note must be 500 characters or fewer")
		return
	}
	docs, ok := h.folderDocs(c, b.FolderID)
	if !ok {
		return
	}
	outline := normalizeOutline(in.Outline)
	if problems := books.Validate(outline, presentSet(docs)); len(problems) > 0 {
		c.JSON(http.StatusUnprocessableEntity, errorResponse("invalid_outline", "The outline has problems. Fix them and save again.", invalidOutlineDetails{Problems: problems}))
		return
	}
	saved, err := h.deps.repository.PushOutline(c.Request.Context(), b.ID, in.BaseVersionID, outline, in.Note, *current(c))
	if err != nil {
		var oce *repo.OutlineConflictError
		switch {
		case errors.As(err, &oce):
			incBook("outline_conflict")
			c.JSON(http.StatusConflict, errorResponse("outline_conflict", "Someone saved a newer outline. Reload it and apply your changes again.", outlineConflictDetails{CurrentVersionID: oce.CurrentVersionID}))
		case errors.Is(err, repo.ErrNotFound):
			notFound(c)
		default:
			internalErr(c, err)
		}
		return
	}
	incBook("outline_pushed")
	c.JSON(http.StatusOK, putOutlineResponse{VersionID: saved.OutlineVersionID, Number: saved.OutlineNumber})
}

// ListOutlineVersions godoc
// @Summary List a book's outline versions
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Book ID"
// @Success 200 {object} listResponse[outlineVersionResponse]
// @Failure 403 {object} errorEnvelope "folder viewer without the editor role"
// @Failure 404 {object} errorEnvelope "missing book, or no role on its folder"
// @Failure 503 {object} errorEnvelope "group_membership_unavailable"
// @Router /v1/books/{id}/outline/versions [get]
func (h handlers) listOutlineVersions(c *gin.Context) {
	if !h.booksOn(c) {
		return
	}
	b, ok := h.loadBook(c, repo.RoleEditor)
	if !ok {
		return
	}
	versions, err := h.deps.repository.ListOutlineVersions(c.Request.Context(), b.ID)
	if err != nil {
		internalErr(c, err)
		return
	}
	items := make([]outlineVersionResponse, 0, len(versions))
	for _, v := range versions {
		items = append(items, outlineVersionResponse{ID: v.ID, Number: v.Number, ChangeNote: v.ChangeNote, CreatedBy: v.CreatedBy, CreatedAt: v.CreatedAt})
	}
	c.JSON(http.StatusOK, listResponse[outlineVersionResponse]{Items: items})
}

// BookStatus godoc
// @Summary Get a book's chapter status
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Book ID"
// @Success 200 {object} bookStatusResponse
// @Failure 403 {object} errorEnvelope "folder viewer without the editor role"
// @Failure 404 {object} errorEnvelope "missing book, or no role on its folder"
// @Failure 503 {object} errorEnvelope "group_membership_unavailable"
// @Router /v1/books/{id}/status [get]
func (h handlers) bookStatus(c *gin.Context) {
	if !h.booksOn(c) {
		return
	}
	b, ok := h.loadBook(c, repo.RoleEditor)
	if !ok {
		return
	}
	docs, ok := h.folderDocs(c, b.FolderID)
	if !ok {
		return
	}
	byID := docsByID(docs)
	outline, removed := books.Prune(b.Outline, presentSet(docs))
	if removed == nil {
		removed = []string{}
	}
	entries := []bookStatusEntry{}
	for _, n := range books.Number(outline) {
		e := bookStatusEntry{Kind: string(n.Kind), Number: n.Number, Planned: n.Kind == books.KindPlanned}
		if n.Doc != "" {
			d := byID[n.Doc]
			e.DocumentID = d.ID
			e.CurrentVersionID = d.CurrentVersionID
			e.Title = d.Title
			if n.Kind == books.KindChapter {
				e.Title = books.DisplayTitle(d.Title, n.Number)
			}
		} else {
			e.Title = n.Planned
		}
		entries = append(entries, e)
	}
	c.JSON(http.StatusOK, bookStatusResponse{Entries: entries, NotInOutline: notInOutline(outline, docs), Removed: removed})
}
