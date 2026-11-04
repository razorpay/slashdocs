package server

import (
	"errors"
	"log/slog"
	"math"
	"net/http"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/books"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

const (
	maxPositionClockSkew = 5 * time.Minute
	maxPositionIDLen     = 64
	bookSearchLimit      = 50
)

var readingDevicePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)

// Chapter states in GET /v1/books/{id}/state (R17).
const (
	chapterNotStarted = "not_started"
	chapterReading    = "reading"
	chapterRead       = "read"
	chapterDone       = "done"
)

// positionAnchor is the passage at the reader's place in a chapter.
type positionAnchor struct {
	Quote       string `json:"quote"`
	Prefix      string `json:"prefix"`
	Suffix      string `json:"suffix"`
	StartOffset int    `json:"start_offset"`
	EndOffset   int    `json:"end_offset"`
}

// positionRequest is the body of PUT /v1/books/{id}/position.
type positionRequest struct {
	DeviceID    string         `json:"device_id"`
	DocumentID  string         `json:"document_id"`
	VersionID   string         `json:"version_id"`
	SectionID   string         `json:"section_id"`
	Anchor      positionAnchor `json:"anchor"`
	Progression float64        `json:"progression"`
	ClientTS    time.Time      `json:"client_ts"`
}

// valid checks the parts of a position that need no lookup (R26) and clamps
// progression to [0,1]. The handler then checks that the version belongs to
// the chapter and drops a section id that is not a heading of it (A17).
func (r *positionRequest) valid(now time.Time) bool {
	if !readingDevicePattern.MatchString(r.DeviceID) || r.DocumentID == "" || r.VersionID == "" ||
		len(r.DocumentID) > maxPositionIDLen || len(r.VersionID) > maxPositionIDLen || math.IsNaN(r.Progression) {
		return false
	}
	r.Progression = math.Min(1, math.Max(0, r.Progression))
	a := r.Anchor
	return utf8.RuneCountInString(a.Quote) <= maxPresenceQuoteRunes &&
		utf8.RuneCountInString(a.Prefix) <= maxPresenceContextLen &&
		utf8.RuneCountInString(a.Suffix) <= maxPresenceContextLen &&
		a.StartOffset >= 0 && a.EndOffset >= a.StartOffset &&
		!r.ClientTS.IsZero() && !r.ClientTS.After(now.Add(maxPositionClockSkew))
}

// positionResponse is one device's place in GET /v1/books/{id}/state.
type positionResponse struct {
	DeviceID    string         `json:"device_id"`
	DocumentID  string         `json:"document_id"`
	VersionID   string         `json:"version_id"`
	SectionID   string         `json:"section_id"`
	Anchor      positionAnchor `json:"anchor"`
	Progression float64        `json:"progression"`
	ClientTS    string         `json:"client_ts"`
}

// chapterStateResponse is one chapter's state for the caller.
type chapterStateResponse struct {
	State string `json:"state" enums:"not_started,reading,read,done"`
	// Updated is true when the chapter changed since the caller last saw it.
	Updated             bool    `json:"updated"`
	SeenVersionID       string  `json:"seen_version_id"`
	FurthestProgression float64 `json:"furthest_progression"`
}

// bookProgress is "Chapter X of N" and the word-weighted share read, counted
// over the chapters the caller can open (R21).
type bookProgress struct {
	// Chapter is the place, among the chapters the caller can open, of the
	// chapter at the newest position. 0 when there is none.
	Chapter int     `json:"chapter"`
	Of      int     `json:"of"`
	Share   float64 `json:"share"`
}

// readingStateResponse is the payload of GET /v1/books/{id}/state.
type readingStateResponse struct {
	Positions []positionResponse              `json:"positions"`
	Chapters  map[string]chapterStateResponse `json:"chapters"`
	Progress  bookProgress                    `json:"progress"`
}

// chapterVersionRequest names the version on the reader's screen. Empty means
// the chapter's current version.
type chapterVersionRequest struct {
	VersionID string `json:"version_id"`
}

// chapterProgressRequest is the body of POST …/chapters/{doc_id}/progress.
type chapterProgressRequest struct {
	Progression float64 `json:"progression"`
	ReachedEnd  bool    `json:"reached_end"`
	// VersionID is the version read; reaching its end marks it seen (A7).
	// Required when ReachedEnd is true.
	VersionID string `json:"version_id"`
}

// chapterDoneRequest is the body of PUT …/chapters/{doc_id}/done.
type chapterDoneRequest struct {
	Done *bool `json:"done"`
}

// chapterChangesResponse is the payload of GET …/chapters/{doc_id}/changes.
type chapterChangesResponse struct {
	SinceVersionID  string                 `json:"since_version_id"`
	Versions        []chapterVersionNote   `json:"versions"`
	ChangedSections []books.ChangedSection `json:"changed_sections"`
}

// chapterVersionNote is one version published since the seen version.
type chapterVersionNote struct {
	ID            string `json:"id"`
	Number        int    `json:"number"`
	ChangeSummary string `json:"change_summary"`
	CreatedAt     string `json:"created_at"`
}

// readingUser answers 403 reading_state_users_only for anyone but a person:
// reading state is stored for users only (D5).
func readingUser(c *gin.Context) bool {
	if current(c).Type != auth.PrincipalUser {
		c.JSON(http.StatusForbidden, errorResponse("reading_state_users_only",
			"Reading state is saved for people only. Sign in as yourself to keep your place.", nil))
		return false
	}
	return true
}

// bookChapterAccess loads the book in the path and one of its chapters. It
// makes three lookups and never scans the book (A5). A document outside the
// book's folder, one the outline does not place, or one the caller cannot
// open, is not found (R24).
func (h handlers) bookChapterAccess(c *gin.Context, docID string) (repo.Book, repo.Document, bool) {
	ctx := c.Request.Context()
	r := h.deps.repository
	b, err := r.GetBook(ctx, c.Param("id"))
	if err != nil {
		lookupFailed(c, err)
		return repo.Book{}, repo.Document{}, false
	}
	if docID == "" {
		notFound(c)
		return repo.Book{}, repo.Document{}, false
	}
	d, err := r.GetDocument(ctx, docID)
	if err != nil {
		lookupFailed(c, err)
		return repo.Book{}, repo.Document{}, false
	}
	if d.ParentFolderID != b.FolderID || !inOutline(b.Outline, d.ID) {
		notFound(c)
		return repo.Book{}, repo.Document{}, false
	}
	role, err := r.RoleForDocument(ctx, *current(c), d.ID)
	if err != nil {
		internalErr(c, err)
		return repo.Book{}, repo.Document{}, false
	}
	if !atLeast(role, repo.RoleViewer) {
		if groupMembershipUnavailable(current(c)) {
			// A group grant may be the one that opens this chapter.
			groupMembershipUnavailableResponse(c)
		} else {
			notFound(c)
		}
		return repo.Book{}, repo.Document{}, false
	}
	return b, d, true
}

// lookupFailed answers 404 for repo.ErrNotFound and 500 otherwise.
func lookupFailed(c *gin.Context, err error) {
	if errors.Is(err, repo.ErrNotFound) {
		notFound(c)
		return
	}
	internalErr(c, err)
}

// bindReadingJSON decodes the request body into dst. With optional set, an
// empty body leaves dst as it is. A bad body answers 400 with code.
func bindReadingJSON(c *gin.Context, dst any, code string, optional bool) bool {
	if optional && c.Request.ContentLength == 0 {
		return true
	}
	if !requireJSON(c) {
		return false
	}
	if err := c.ShouldBindJSON(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			c.JSON(http.StatusRequestEntityTooLarge, errorResponse("payload_too_large", "request body is too large", nil))
			return false
		}
		c.JSON(http.StatusBadRequest, errorResponse(code, "The request body is not valid JSON for this endpoint.", nil))
		return false
	}
	return true
}

// chapterVersion returns versionID when it is a version of d, or d's current
// version when versionID is empty. Otherwise it answers 400 with code: the
// seen guard compares version numbers only, so a version of another document
// must never reach it.
func (h handlers) chapterVersion(c *gin.Context, d repo.Document, versionID, code string) (string, bool) {
	if versionID == "" {
		return d.CurrentVersionID, true
	}
	v, err := h.deps.repository.GetVersion(c.Request.Context(), versionID)
	if err != nil && !errors.Is(err, repo.ErrNotFound) {
		internalErr(c, err)
		return "", false
	}
	if err != nil || v.DocumentID != d.ID {
		c.JSON(http.StatusBadRequest, errorResponse(code, "version_id is not a version of this chapter.", nil))
		return "", false
	}
	return v.ID, true
}

// ensureIndexed indexes those versions that have no sections yet (A1). The
// lock-free UnindexedVersions check keeps indexed versions off the locking
// path. Failures are logged: a chapter without sections still reads.
func (h handlers) ensureIndexed(c *gin.Context, versions []string) {
	if len(versions) == 0 {
		return
	}
	ctx := c.Request.Context()
	r := h.deps.repository
	log := requestLogger(c)
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
}

// versionSections returns a version's sections, indexing it first if needed.
func (h handlers) versionSections(c *gin.Context, versionID string) ([]repo.SectionInfo, error) {
	h.ensureIndexed(c, []string{versionID})
	return h.deps.repository.ListVersionSections(c.Request.Context(), versionID)
}

// visibleDocs lists the outline documents the reader can open, in reading
// order.
func (v bookView) visibleDocs() []string {
	out := []string{}
	for _, e := range v.Entries {
		if e.Doc != "" && v.Visible[e.Doc] {
			out = append(out, e.Doc)
		}
	}
	return out
}

func chapterState(r repo.ChapterRead, opened bool) string {
	switch {
	case !opened:
		return chapterNotStarted
	case r.Done:
		return chapterDone
	case r.ReachedEnd:
		return chapterRead
	}
	return chapterReading
}

// GetReadingState godoc
// @Summary Get your reading state in a book
// @Description Your positions on every device (newest first), the state of each chapter you can open, and your progress. Reading state is never returned to anyone but its owner. Users only.
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Produce json
// @Param id path string true "Book ID"
// @Success 200 {object} readingStateResponse
// @Failure 403 {object} errorEnvelope "reading_state_users_only"
// @Failure 404 {object} errorEnvelope
// @Failure 429 {object} errorEnvelope "rate_limited"
// @Failure 503 {object} errorEnvelope "group_membership_unavailable"
// @Router /v1/books/{id}/state [get]
func (h handlers) getReadingState(c *gin.Context) {
	if !h.booksOn(c) || !readingUser(c) {
		return
	}
	view, ok := h.bookReaderView(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	userID := current(c).ID
	docIDs := view.visibleDocs()
	reads, err := h.deps.repository.GetChapterReads(ctx, userID, docIDs)
	if err != nil {
		internalErr(c, err)
		return
	}
	stored, err := h.deps.repository.ListReadingPositions(ctx, userID, view.Book.ID)
	if err != nil {
		internalErr(c, err)
		return
	}
	out := readingStateResponse{Positions: []positionResponse{}, Chapters: make(map[string]chapterStateResponse, len(docIDs))}
	for _, p := range stored {
		// A position in a chapter the reader can no longer open is kept but
		// not shown.
		if !view.Visible[p.DocumentID] {
			continue
		}
		out.Positions = append(out.Positions, positionResponse{
			DeviceID: p.DeviceID, DocumentID: p.DocumentID, VersionID: p.VersionID, SectionID: p.SectionID,
			Anchor: positionAnchor{Quote: p.Anchor.Quote, Prefix: p.Anchor.Prefix, Suffix: p.Anchor.Suffix,
				StartOffset: p.Anchor.StartOffset, EndOffset: p.Anchor.EndOffset},
			Progression: p.Progression,
			ClientTS:    p.ClientTS.UTC().Format(time.RFC3339Nano),
		})
	}
	for _, id := range docIDs {
		r, opened := reads[id]
		cur := view.Docs[id].CurrentVersionID
		out.Chapters[id] = chapterStateResponse{
			State:               chapterState(r, opened),
			Updated:             opened && cur != "" && cur != r.SeenVersionID,
			SeenVersionID:       r.SeenVersionID,
			FurthestProgression: r.FurthestProgression,
		}
	}
	newest := ""
	if len(out.Positions) > 0 {
		newest = out.Positions[0].DocumentID
	}
	var progress []books.ChapterProgress
	for _, e := range view.Entries {
		if e.Kind != books.KindChapter || !view.Visible[e.Doc] {
			continue
		}
		out.Progress.Of++
		if e.Doc == newest {
			out.Progress.Chapter = out.Progress.Of
		}
		st := out.Chapters[e.Doc]
		progress = append(progress, books.ChapterProgress{
			Words:       view.Words[view.Docs[e.Doc].CurrentVersionID],
			Read:        st.State == chapterRead || st.State == chapterDone,
			Progression: st.FurthestProgression,
		})
	}
	out.Progress.Share = books.Progress(progress)
	c.Header("Cache-Control", "private, no-store")
	c.JSON(http.StatusOK, out)
}

// PutReadingPosition godoc
// @Summary Save your reading position
// @Description Saves this device's place in the book. A position older than the stored one is ignored and answered with X-Position-Stale: 1. An unknown section_id is stored as "". Users only.
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Accept json
// @Param id path string true "Book ID"
// @Param body body positionRequest true "Position"
// @Success 204
// @Header 204 {string} X-Position-Stale "1 when the position was older than the stored one"
// @Failure 400 {object} errorEnvelope "invalid_position"
// @Failure 403 {object} errorEnvelope "reading_state_users_only"
// @Failure 404 {object} errorEnvelope
// @Failure 429 {object} errorEnvelope "rate_limited"
// @Failure 503 {object} errorEnvelope "group_membership_unavailable"
// @Router /v1/books/{id}/position [put]
func (h handlers) putReadingPosition(c *gin.Context) {
	if !h.booksOn(c) || !readingUser(c) {
		return
	}
	var in positionRequest
	if !bindReadingJSON(c, &in, "invalid_position", false) {
		return
	}
	if !in.valid(time.Now()) {
		invalidPosition(c)
		return
	}
	b, d, ok := h.bookChapterAccess(c, in.DocumentID)
	if !ok {
		return
	}
	v, ok := h.chapterVersion(c, d, in.VersionID, "invalid_position")
	if !ok {
		return
	}
	if in.SectionID != "" {
		secs, err := h.versionSections(c, v)
		if err != nil {
			internalErr(c, err)
			return
		}
		known := false
		for _, s := range secs {
			if s.ID == in.SectionID {
				known = true
				break
			}
		}
		if !known {
			// A heading made by script in the frame: the quote and the
			// progression still restore the place (A17).
			in.SectionID = ""
		}
	}
	a := in.Anchor
	saved, err := h.deps.repository.SaveReadingPosition(c.Request.Context(), current(c).ID, b.ID, repo.ReadingPosition{
		DeviceID: in.DeviceID, DocumentID: d.ID, VersionID: v, SectionID: in.SectionID,
		Anchor:      repo.Anchor{Quote: a.Quote, Prefix: a.Prefix, Suffix: a.Suffix, StartOffset: a.StartOffset, EndOffset: a.EndOffset},
		Progression: in.Progression,
		ClientTS:    in.ClientTS,
	})
	if err != nil {
		internalErr(c, err)
		return
	}
	if !saved {
		c.Header("X-Position-Stale", "1")
	}
	c.Status(http.StatusNoContent)
}

func invalidPosition(c *gin.Context) {
	c.JSON(http.StatusBadRequest, errorResponse("invalid_position",
		"The position is not valid. Send a device_id of 8 to 64 letters, digits, - or _, a version of this chapter, a quote of at most 512 characters and a client_ts no more than 5 minutes ahead.", nil))
}

// OpenChapter godoc
// @Summary Record that you opened a chapter
// @Description The first open marks the version seen and last read. Later opens move only the last read version, so an update stays flagged until it is seen (R18). Users only.
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Accept json
// @Param id path string true "Book ID"
// @Param doc_id path string true "Chapter document ID"
// @Param body body chapterVersionRequest false "Version on screen; defaults to the current version"
// @Success 204
// @Failure 400 {object} errorEnvelope "invalid_request"
// @Failure 403 {object} errorEnvelope "reading_state_users_only"
// @Failure 404 {object} errorEnvelope
// @Failure 429 {object} errorEnvelope "rate_limited"
// @Failure 503 {object} errorEnvelope "group_membership_unavailable"
// @Router /v1/books/{id}/chapters/{doc_id}/open [post]
func (h handlers) openChapter(c *gin.Context) {
	if !h.booksOn(c) || !readingUser(c) {
		return
	}
	_, d, ok := h.bookChapterAccess(c, c.Param("doc_id"))
	if !ok {
		return
	}
	var in chapterVersionRequest
	if !bindReadingJSON(c, &in, "invalid_request", true) {
		return
	}
	v, ok := h.chapterVersion(c, d, in.VersionID, "invalid_request")
	if !ok {
		return
	}
	if err := h.deps.repository.OpenChapter(c.Request.Context(), current(c).ID, d.ID, v); err != nil {
		internalErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// ChapterProgress godoc
// @Summary Record how far you read a chapter
// @Description Raises the furthest progression. reached_end marks the chapter read and the given version seen, so version_id is required with it; seen never moves backwards (A7). Does nothing for a chapter never opened. Users only.
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Accept json
// @Param id path string true "Book ID"
// @Param doc_id path string true "Chapter document ID"
// @Param body body chapterProgressRequest true "Progress"
// @Success 204
// @Failure 400 {object} errorEnvelope "invalid_request"
// @Failure 403 {object} errorEnvelope "reading_state_users_only"
// @Failure 404 {object} errorEnvelope
// @Failure 429 {object} errorEnvelope "rate_limited"
// @Failure 503 {object} errorEnvelope "group_membership_unavailable"
// @Router /v1/books/{id}/chapters/{doc_id}/progress [post]
func (h handlers) chapterProgress(c *gin.Context) {
	if !h.booksOn(c) || !readingUser(c) {
		return
	}
	_, d, ok := h.bookChapterAccess(c, c.Param("doc_id"))
	if !ok {
		return
	}
	var in chapterProgressRequest
	if !bindReadingJSON(c, &in, "invalid_request", false) {
		return
	}
	if in.ReachedEnd && in.VersionID == "" {
		// Defaulting to the current version would clear an update the
		// reader has not seen (A7).
		c.JSON(http.StatusBadRequest, errorResponse("invalid_request", "Send the version_id you read when reached_end is true.", nil))
		return
	}
	v, ok := h.chapterVersion(c, d, in.VersionID, "invalid_request")
	if !ok {
		return
	}
	ctx := c.Request.Context()
	userID := current(c).ID
	// The store clamps progression to [0,1].
	if err := h.deps.repository.UpdateChapterProgress(ctx, userID, d.ID, in.Progression, in.ReachedEnd); err != nil {
		internalErr(c, err)
		return
	}
	if in.ReachedEnd {
		if err := h.deps.repository.MarkChapterSeen(ctx, userID, d.ID, v); err != nil {
			internalErr(c, err)
			return
		}
	}
	c.Status(http.StatusNoContent)
}

// SetChapterDone godoc
// @Summary Mark a chapter done, or not
// @Description Done is reversible: clearing it returns the chapter to read or reading. Does nothing for a chapter never opened. Users only.
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Accept json
// @Param id path string true "Book ID"
// @Param doc_id path string true "Chapter document ID"
// @Param body body chapterDoneRequest true "Done"
// @Success 204
// @Failure 400 {object} errorEnvelope "invalid_request"
// @Failure 403 {object} errorEnvelope "reading_state_users_only"
// @Failure 404 {object} errorEnvelope
// @Failure 429 {object} errorEnvelope "rate_limited"
// @Failure 503 {object} errorEnvelope "group_membership_unavailable"
// @Router /v1/books/{id}/chapters/{doc_id}/done [put]
func (h handlers) setChapterDone(c *gin.Context) {
	if !h.booksOn(c) || !readingUser(c) {
		return
	}
	_, d, ok := h.bookChapterAccess(c, c.Param("doc_id"))
	if !ok {
		return
	}
	var in chapterDoneRequest
	if !bindReadingJSON(c, &in, "invalid_request", false) {
		return
	}
	if in.Done == nil {
		c.JSON(http.StatusBadRequest, errorResponse("invalid_request", "Send done as true or false.", nil))
		return
	}
	if err := h.deps.repository.SetChapterDone(c.Request.Context(), current(c).ID, d.ID, *in.Done); err != nil {
		internalErr(c, err)
		return
	}
	c.Status(http.StatusNoContent)
}

// MarkChapterSeen godoc
// @Summary Mark a chapter's update seen
// @Description Moves the seen version forward to the given version, or the current version when none is given. Seen never moves backwards (A7). Users only.
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Accept json
// @Param id path string true "Book ID"
// @Param doc_id path string true "Chapter document ID"
// @Param body body chapterVersionRequest false "Version seen; defaults to the current version"
// @Success 204
// @Failure 400 {object} errorEnvelope "invalid_request"
// @Failure 403 {object} errorEnvelope "reading_state_users_only"
// @Failure 404 {object} errorEnvelope
// @Failure 429 {object} errorEnvelope "rate_limited"
// @Failure 503 {object} errorEnvelope "group_membership_unavailable"
// @Router /v1/books/{id}/chapters/{doc_id}/seen [post]
func (h handlers) markChapterSeen(c *gin.Context) {
	if !h.booksOn(c) || !readingUser(c) {
		return
	}
	_, d, ok := h.bookChapterAccess(c, c.Param("doc_id"))
	if !ok {
		return
	}
	var in chapterVersionRequest
	if !bindReadingJSON(c, &in, "invalid_request", true) {
		return
	}
	v, ok := h.chapterVersion(c, d, in.VersionID, "invalid_request")
	if !ok {
		return
	}
	if v != "" {
		if err := h.deps.repository.MarkChapterSeen(c.Request.Context(), current(c).ID, d.ID, v); err != nil {
			internalErr(c, err)
			return
		}
	}
	c.Status(http.StatusNoContent)
}

// MarkBookSeen godoc
// @Summary Mark every update in a book seen
// @Description Every chapter you can open and have opened gets its current version marked seen. Users only.
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Book ID"
// @Success 204
// @Failure 403 {object} errorEnvelope "reading_state_users_only"
// @Failure 404 {object} errorEnvelope
// @Failure 429 {object} errorEnvelope "rate_limited"
// @Failure 503 {object} errorEnvelope "group_membership_unavailable"
// @Router /v1/books/{id}/seen [post]
func (h handlers) markBookSeen(c *gin.Context) {
	if !h.booksOn(c) || !readingUser(c) {
		return
	}
	view, ok := h.bookReaderView(c)
	if !ok {
		return
	}
	ctx := c.Request.Context()
	userID := current(c).ID
	reads, err := h.deps.repository.GetChapterReads(ctx, userID, view.visibleDocs())
	if err != nil {
		internalErr(c, err)
		return
	}
	for id, r := range reads {
		cur := view.Docs[id].CurrentVersionID
		if cur == "" || cur == r.SeenVersionID {
			continue
		}
		if err := h.deps.repository.MarkChapterSeen(ctx, userID, id, cur); err != nil {
			internalErr(c, err)
			return
		}
	}
	c.Status(http.StatusNoContent)
}

// ChapterChanges godoc
// @Summary List what changed in a chapter since you saw it
// @Description Every version note since your seen version, and the sections whose text changed between it and the current version (R19, R20). Empty when you have seen the current version or never opened the chapter. Users only.
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Produce json
// @Param id path string true "Book ID"
// @Param doc_id path string true "Chapter document ID"
// @Success 200 {object} chapterChangesResponse
// @Failure 403 {object} errorEnvelope "reading_state_users_only"
// @Failure 404 {object} errorEnvelope
// @Failure 429 {object} errorEnvelope "rate_limited"
// @Failure 503 {object} errorEnvelope "group_membership_unavailable"
// @Router /v1/books/{id}/chapters/{doc_id}/changes [get]
func (h handlers) chapterChanges(c *gin.Context) {
	if !h.booksOn(c) || !readingUser(c) {
		return
	}
	_, d, ok := h.bookChapterAccess(c, c.Param("doc_id"))
	if !ok {
		return
	}
	ctx := c.Request.Context()
	reads, err := h.deps.repository.GetChapterReads(ctx, current(c).ID, []string{d.ID})
	if err != nil {
		internalErr(c, err)
		return
	}
	r, opened := reads[d.ID]
	out := chapterChangesResponse{SinceVersionID: r.SeenVersionID, Versions: []chapterVersionNote{}, ChangedSections: []books.ChangedSection{}}
	c.Header("Cache-Control", "private, no-store")
	if !opened || d.CurrentVersionID == "" || r.SeenVersionID == d.CurrentVersionID {
		c.JSON(http.StatusOK, out)
		return
	}
	notes, err := h.deps.repository.ListVersionsAfter(ctx, d.ID, r.SeenVersionID)
	if err != nil {
		internalErr(c, err)
		return
	}
	for _, n := range notes {
		out.Versions = append(out.Versions, chapterVersionNote{ID: n.ID, Number: n.Number, ChangeSummary: n.ChangeSummary, CreatedAt: n.CreatedAt})
	}
	// The seen version is empty when it was deleted; then every section is new.
	var old, cur []repo.SectionInfo
	if r.SeenVersionID != "" {
		if old, err = h.versionSections(c, r.SeenVersionID); err != nil {
			internalErr(c, err)
			return
		}
	}
	if cur, err = h.versionSections(c, d.CurrentVersionID); err != nil {
		internalErr(c, err)
		return
	}
	out.ChangedSections = books.ChangedSections(sectionHashes(old), sectionHashes(cur))
	c.JSON(http.StatusOK, out)
}

func sectionHashes(secs []repo.SectionInfo) []books.SectionHash {
	out := make([]books.SectionHash, 0, len(secs))
	for _, s := range secs {
		out = append(out, books.SectionHash{ID: s.ID, Title: s.Title, Hash: s.Hash, Words: s.Words})
	}
	return out
}

// SearchBook godoc
// @Summary Search a book
// @Description Full-text search of the chapters you can open, in the same query language as document search. The book's folder replaces any in: filter. document_id narrows the search to one chapter. At most 50 results.
// @Tags books
// @Security bearerAuth
// @Security cookieAuth
// @Produce json
// @Param id path string true "Book ID"
// @Param q query string true "Search query"
// @Param document_id query string false "Search only this chapter"
// @Param tz query string false "IANA time zone for date modifiers; defaults to UTC"
// @Success 200 {object} listResponse[repo.Document]
// @Failure 400 {object} errorEnvelope
// @Failure 404 {object} errorEnvelope
// @Failure 429 {object} errorEnvelope "rate_limited"
// @Failure 503 {object} errorEnvelope "group_membership_unavailable"
// @Router /v1/books/{id}/search [get]
func (h handlers) searchBook(c *gin.Context) {
	if !h.booksOn(c) || !requireResolvedGroupsForAggregate(c) {
		return
	}
	q := strings.TrimSpace(c.Query("q"))
	if q == "" {
		badRequest(c, "Type something to search for.")
		return
	}
	zone, err := time.LoadLocation(c.Query("tz"))
	if err != nil {
		badRequest(c, "invalid tz")
		return
	}
	search, err := parseDocumentSearch(q, *current(c), time.Now().In(zone))
	if err != nil {
		badRequest(c, err.Error())
		return
	}
	var book repo.Book
	if docID := c.Query("document_id"); docID != "" {
		b, d, ok := h.bookChapterAccess(c, docID)
		if !ok {
			return
		}
		book, search.DocumentIDs = b, []string{d.ID}
	} else {
		view, ok := h.bookReaderView(c)
		if !ok {
			return
		}
		book, search.DocumentIDs = view.Book, view.visibleDocs()
	}
	if len(search.DocumentIDs) == 0 {
		// An empty filter would search every document.
		c.JSON(http.StatusOK, listResponse[repo.Document]{Items: []repo.Document{}})
		return
	}
	search.Folders = []string{book.FolderID}
	search.IncludeLabels = h.deps.labelsEnabled
	includeOrgWide := h.deps.deployment == DeploymentOrg
	items, err := h.deps.repository.SearchDocuments(c.Request.Context(), *current(c), search, includeOrgWide, bookSearchLimit)
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, listResponse[repo.Document]{Items: items})
}

func inOutline(o books.Outline, docID string) bool {
	for _, id := range books.DocIDs(o) {
		if id == docID {
			return true
		}
	}
	return false
}
