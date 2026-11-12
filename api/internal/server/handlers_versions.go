package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/internal/render"
	"github.com/razorpay/slashdocs/internal/textedit"
)

// createVersionResponse is the payload of POST /v1/documents/{id}/versions.
type createVersionResponse struct {
	ID            string `json:"id"`
	Number        int    `json:"number"`
	SHA256        string `json:"sha256"`
	ChangeSummary string `json:"change_summary,omitempty"`
	// BaseVersionID is the version before the new version.
	BaseVersionID string `json:"base_version_id"`
	// Rebased is set when the document changed after the base of the upload,
	// so the new version also holds the changes of other writers, and is
	// not the uploaded file.
	Rebased bool `json:"rebased"`
	// Seq is the seq of the new version.
	Seq int64 `json:"seq"`
	// Unchanged is set when the content is the document as it is. No
	// version was made, and the response names the current version.
	Unchanged bool `json:"unchanged,omitempty"`
}

// versionConflictDetails names the current version and the seq of the live
// document when a write is refused for the state that it names. Text, when
// set, is the sentence that holds the text of other people that a refused
// push changes, in plain words.
type versionConflictDetails struct {
	CurrentVersionID string `json:"current_version_id"`
	Seq              int64  `json:"seq"`
	Text             string `json:"text,omitempty"`
}

// savedStatus is the status of a write that saves a version: 201, or 200
// when the write left the document as it is and saved none.
func savedStatus(onto repo.SavedOn) int {
	if onto.Unchanged {
		return http.StatusOK
	}
	return http.StatusCreated
}

// editDocumentRequest is the body of POST /v1/documents/{id}/edits.
type editDocumentRequest struct {
	ChangeSummary string          `json:"change_summary,omitempty"`
	Edits         []textedit.Edit `json:"edits"`
}

// editDocumentResponse is the payload of POST /v1/documents/{id}/edits.
type editDocumentResponse struct {
	ID            string `json:"id"`
	Number        int    `json:"number"`
	SHA256        string `json:"sha256"`
	ChangeSummary string `json:"change_summary,omitempty"`
	// BaseVersionID is the version before the new version.
	BaseVersionID string `json:"base_version_id"`
	EditsApplied  int    `json:"edits_applied"`
	// Unchanged is set when the edits left the document as it is. No version
	// was made, and the response names the current version.
	Unchanged bool `json:"unchanged,omitempty"`
}

// editFailedDetails names the edit that did not match, and the current
// version of the document.
type editFailedDetails struct {
	textedit.Error
	CurrentVersionID string `json:"current_version_id"`
}

// operationRequest is the body of POST /v1/documents/{id}/ops.
type operationRequest struct {
	// BaseSeq is the seq of the source that the replacements were made on.
	BaseSeq *int64 `json:"base_seq"`
	// ClientOpID names the operation, so that a retry applies nothing and
	// gets the answer of the first attempt.
	ClientOpID   string                 `json:"client_op_id"`
	Replacements []textedit.Replacement `json:"replacements"`
	// Summary, when set, is a line of what History shows for the version.
	// When no operation of a version has one, the server names what a reader
	// sees change.
	Summary string `json:"summary,omitempty"`
}

// maxClientOpIDBytes caps the client_op_id of an operation.
const maxClientOpIDBytes = 128

// renderTokenResponse is the payload of POST .../render-token.
type renderTokenResponse struct {
	Token string `json:"token"`
	URL   string `json:"url"`
	// Seq is the seq of the source that the URL renders.
	Seq int64 `json:"seq"`
}

// CreateVersion godoc
// @Summary Create version
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Accept multipart/form-data
// @Param id path string true "Document ID"
// @Param base_version_id formData string true "Base version ID"
// @Param change_summary formData string false "Change summary"
// @Param base_seq formData int false "Seq of the base version that the file was made from, from the X-Slashdocs-Seq header of its HTML. Necessary when that version was open."
// @Description Saves the uploaded HTML, which must be valid UTF-8, as a new version. When people changed the document after the base, the changes from the base to the upload move onto the live document, and the response has rebased set: the new version is then not the uploaded file. When the upload changes text that people changed after the base, the response is 409 version_conflict and their text stays: get the document and make the change again. details.text, when set, is the sentence that holds that text, in plain words, so that a person can find the place. When the upload is the document as it is, the response is 200 with unchanged set and the current version: no version is made. The base is the content of the base version, when the request has no base_seq or the seq of that version. With a base_seq before the seq of the base version, the base is the document at base_seq: the file was made from the version while it was open. The response is 409 stale when the base is an open version with no base_seq, or when the server no longer has the document at base_seq. It is 422 base_version_not_found when base_version_id is not a version of the document.
// @Param file formData file true "HTML file"
// @Success 201 {object} createVersionResponse
// @Success 200 {object} createVersionResponse
// @Failure 400 {object} errorEnvelope
// @Failure 409 {object} errorEnvelope
// @Failure 413 {object} errorEnvelope
// @Failure 422 {object} errorEnvelope
// @Router /v1/documents/{id}/versions [post]
func (h handlers) createVersion(c *gin.Context) {
	docID := c.Param("id")
	if !h.needDocRole(c, docID, repo.RoleEditor) {
		return
	}
	html, err := readMultipartFile(c, "file")
	if errors.Is(err, errPayloadTooLarge) {
		c.JSON(http.StatusRequestEntityTooLarge, errorResponse("payload_too_large", "HTML file exceeds 50 MiB", nil))
		return
	}
	base := c.PostForm("base_version_id")
	if err != nil || base == "" {
		badRequest(c, "file and base_version_id are required")
		return
	}
	var baseSeq *int64
	if raw, ok := c.GetPostForm("base_seq"); ok {
		seq, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			badRequest(c, "base_seq must be a seq")
			return
		}
		baseSeq = &seq
	}
	if !utf8.Valid(html) {
		badRequest(c, errHTMLNotUTF8)
		return
	}
	observeHTML("version_create", len(html))
	summary := strings.TrimSpace(c.PostForm("change_summary"))
	v, onto, err := h.deps.repository.SaveVersion(c.Request.Context(), docID, base, baseSeq, *current(c), func(old []byte) ([]byte, string, error) {
		// An upload without a change summary is named by what a reader sees
		// change from its base version, as a sitting is.
		if summary == "" {
			summary = textedit.ChangeSummary(old, html)
		}
		return html, summary, nil
	})
	if err != nil {
		h.editFailed(c, err)
		return
	}
	if !onto.Unchanged {
		incVersion("created", actorType(c))
		h.followLater(c, docID)
	}
	c.JSON(savedStatus(onto), createVersionResponse{ID: v.ID, Number: v.Number, SHA256: v.SHA256, ChangeSummary: v.ChangeSummary, BaseVersionID: onto.VersionID, Rebased: onto.Rebased, Seq: v.Seq, Unchanged: onto.Unchanged})
}

// errHTMLNotUTF8 refuses an upload: the live document is always valid UTF-8.
const errHTMLNotUTF8 = "the HTML file must be valid UTF-8"

// EditDocument godoc
// @Summary Edit document text
// @Description Applies exact find-and-replace edits to the live document on the server and saves the result as a new version. Each old_string must occur exactly once; edits apply in order and either all apply or none do. The HTML is never parsed, so everything else stays byte-for-byte the same. When the edits together leave the document as it is, the response is 200 with unchanged set and the current version.
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Accept json
// @Param id path string true "Document ID"
// @Param body body editDocumentRequest true "Edits"
// @Success 201 {object} editDocumentResponse
// @Failure 409 {object} errorEnvelope
// @Failure 422 {object} errorEnvelope
// @Router /v1/documents/{id}/edits [post]
func (h handlers) editDocument(c *gin.Context) {
	docID := c.Param("id")
	if !h.needDocRole(c, docID, repo.RoleEditor) {
		return
	}
	var in editDocumentRequest
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid edit request")
		return
	}
	if len(in.Edits) == 0 || len(in.Edits) > textedit.MaxEdits {
		badRequest(c, fmt.Sprintf("pass between 1 and %d edits", textedit.MaxEdits))
		return
	}
	summary := strings.TrimSpace(in.ChangeSummary)
	if summary == "" {
		summary = textedit.Summary(in.Edits)
	}
	v, onto, err := h.deps.repository.SaveVersion(c.Request.Context(), docID, "", nil, *current(c), func(base []byte) ([]byte, string, error) {
		edited, err := textedit.Apply(base, in.Edits)
		observeHTML("version_edit", len(edited))
		return edited, summary, err
	})
	if err != nil {
		h.editFailed(c, err)
		return
	}
	if !onto.Unchanged {
		incVersion("edited", actorType(c))
		h.followLater(c, docID)
	}
	c.JSON(savedStatus(onto), editDocumentResponse{ID: v.ID, Number: v.Number, SHA256: v.SHA256, ChangeSummary: v.ChangeSummary, BaseVersionID: onto.VersionID, EditsApplied: len(in.Edits), Unchanged: onto.Unchanged})
}

// AppendOperation godoc
// @Summary Write an operation of the browser editor
// @Description For the browser editor. Applies replacements by position in the source at base_seq to the live document. start and end count UTF-8 bytes, end is exclusive, and old_html must be the source from start to end at base_seq. Replacements are in order and do not overlap. A replacement whose old_html is its new_html changes nothing: the server drops it, and others never holds one. The operation makes no version: the first operation after a sealed version opens the next version, and the server seals it after 10 minutes with no operation, or before a write that is not typing. When the document had operations after base_seq, the replacements move over them, and others holds those operations in order, as they apply to the source that the caller made (the source at base_seq with its replacements). Text that both put in at one point stays twice, text that either takes out goes, and two replacements of the same words both stay whole, the later one first. sum is the CRC-32 (IEEE) of the UTF-8 bytes of the source at seq: a caller whose source has another sum loads the document again. A retry with the same client_op_id applies nothing and gets the answer of the first attempt. When the server no longer has that answer, the response is 409 stale with details.applied set: the document has the operation, so the caller gets the live document and does not send that text again. summary holds at most 200 characters. The response is 409 stale when the log no longer holds the operations after base_seq, or when base_seq is more than 2000 operations behind: get the live document, and send the text that is not sent yet again on its seq.
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Accept json
// @Param id path string true "Document ID"
// @Param body body operationRequest true "Operation"
// @Success 200 {object} repo.OperationResult
// @Failure 400 {object} errorEnvelope
// @Failure 404 {object} errorEnvelope
// @Failure 409 {object} errorEnvelope
// @Failure 413 {object} errorEnvelope
// @Failure 422 {object} errorEnvelope
// @Failure 429 {object} errorEnvelope
// @Router /v1/documents/{id}/ops [post]
func (h handlers) appendOperation(c *gin.Context) {
	docID := c.Param("id")
	if !h.needDocRole(c, docID, repo.RoleEditor) {
		return
	}
	var in operationRequest
	// PostgreSQL text does not hold the NUL character.
	if err := c.ShouldBindJSON(&in); err != nil || in.BaseSeq == nil || *in.BaseSeq < 0 || in.ClientOpID == "" || len(in.ClientOpID) > maxClientOpIDBytes || strings.ContainsRune(in.ClientOpID+in.Summary, 0) {
		badRequest(c, fmt.Sprintf("pass base_seq, a client_op_id of at most %d bytes, and replacements", maxClientOpIDBytes))
		return
	}
	if len(in.Replacements) == 0 || len(in.Replacements) > textedit.MaxEdits {
		badRequest(c, fmt.Sprintf("pass between 1 and %d replacements", textedit.MaxEdits))
		return
	}
	ctx := c.Request.Context()
	summary := strings.TrimSpace(in.Summary)
	if r := []rune(summary); len(r) > maxOperationSummaryRunes {
		summary = string(r[:maxOperationSummaryRunes])
	}
	out, err := h.deps.repository.AppendOperation(ctx, docID, repo.Operation{BaseSeq: *in.BaseSeq, ClientOpID: in.ClientOpID, Replacements: in.Replacements, Summary: summary}, *current(c))
	if err != nil {
		h.editFailed(c, err)
		return
	}
	h.followLater(c, docID)
	// The repository stores the event of an operation that opens a version.
	// The others are relayed and never stored, as cursor events are: a
	// viewer who misses one learns the seq from the next keep-alive. The
	// event of a retry went with the first attempt. The operation is saved,
	// so a failure here is only logged.
	if !out.Announced && !out.Repeated {
		event := repo.DocumentKVEvent{DocumentID: docID, Kind: repo.DocumentEventDocument, Data: operationEvent(out), UpdatedBy: current(c)}
		if err := h.deps.documentKVEvents.Relay(ctx, event); err != nil {
			slog.WarnContext(ctx, "document operation relay failed", slog.String("document_id", docID), slog.Any("error", err))
		}
	}
	c.JSON(http.StatusOK, out)
}

// maxOperationSummaryRunes caps the summary of an operation. History shows
// the summaries of a version in one entry.
const maxOperationSummaryRunes = 200

// maxRelayedOperationBytes caps the data of a relayed event that carries
// its operation. The relay goes through a PostgreSQL notification, which
// holds less than 8000 bytes with the rest of the event.
const maxRelayedOperationBytes = 4000

// relayedOperation is the data of the event of an operation that is small.
// A viewer whose source is at PrevSeq applies the replacements, and has the
// source at Seq with no request.
type relayedOperation struct {
	repo.DocumentPosition
	PrevSeq      int64                  `json:"prev_seq"`
	Replacements []textedit.Replacement `json:"replacements"`
	Sum          uint32                 `json:"sum"`
}

// operationEvent returns the event data of an operation of the browser
// editor: the operation itself when it is small, or else only where the
// document is, and the viewer asks for the changes. Both say that the
// author of the event typed.
func operationEvent(out repo.OperationResult) json.RawMessage {
	at := repo.DocumentPosition{Seq: out.Seq, VersionID: out.VersionID, Typed: true}
	data, _ := json.Marshal(relayedOperation{DocumentPosition: at, PrevSeq: out.Seq - 1, Replacements: out.Applied, Sum: out.Sum})
	if len(data) > maxRelayedOperationBytes {
		data, _ = json.Marshal(at)
	}
	return data
}

const (
	// errStale tells a caller that names a seq which the log no longer
	// reaches.
	errStale = "The document changed too much since that seq. Get the document again."
	// errPushWhileEditing tells an author who did not send the seq of the
	// content that its change was made on.
	// A new read does not help it: it must send that seq.
	errPushWhileEditing = "People are editing this document, and the push did not send base_seq, so the server does not know which state of the document it changes. Send the seq of your read as base_seq. With the slashdocs CLI, update it, then pull the document and push again."
	errVersionConflict  = "Other people changed the same text, and their text stays. Get the document again and make the change again."
	errBaseVersion      = "base_version_id is not a version of this document. Get the document again and make the change again."
)

// editFailed writes the response for a write that saved nothing.
func (h handlers) editFailed(c *gin.Context, err error) {
	var edit *textedit.Error
	var replacement *textedit.ReplacementError
	var conflict *repo.VersionConflictError
	switch {
	case errors.As(err, &edit):
		incVersion("edit_failed", actorType(c))
		// The current version is that of the answer: the write changed nothing.
		d, _ := h.deps.repository.GetDocument(c.Request.Context(), c.Param("id"))
		c.JSON(http.StatusUnprocessableEntity, errorResponse("edit_failed", err.Error(), editFailedDetails{Error: *edit, CurrentVersionID: d.CurrentVersionID}))
	case errors.As(err, &replacement):
		incVersion("edit_failed", actorType(c))
		c.JSON(http.StatusUnprocessableEntity, errorResponse("edit_failed", err.Error(), replacement))
	case errors.Is(err, repo.ErrNoSuchSeq):
		incVersion("edit_failed", actorType(c))
		c.JSON(http.StatusUnprocessableEntity, errorResponse("edit_failed", "base_seq is after the live document", nil))
	case errors.Is(err, repo.ErrNotUTF8):
		incVersion("edit_failed", actorType(c))
		c.JSON(http.StatusUnprocessableEntity, errorResponse("edit_failed", "the HTML of the document is not valid UTF-8", nil))
	case errors.Is(err, repo.ErrStale):
		c.JSON(http.StatusConflict, errorResponse("stale", errStale, nil))
	case errors.Is(err, repo.ErrApplied):
		// The sender must not put the text of the operation in a second time.
		c.JSON(http.StatusConflict, errorResponse("stale", errStale, gin.H{"applied": true}))
	case errors.Is(err, repo.ErrEditing):
		c.JSON(http.StatusConflict, errorResponse("stale", errPushWhileEditing, nil))
	case errors.As(err, &conflict):
		c.JSON(http.StatusConflict, errorResponse("version_conflict", errVersionConflict, versionConflictDetails{CurrentVersionID: conflict.LatestVersionID, Seq: conflict.Seq, Text: conflict.Text}))
	case errors.Is(err, repo.ErrBaseVersion):
		d, _ := h.deps.repository.GetDocument(c.Request.Context(), c.Param("id"))
		c.JSON(http.StatusUnprocessableEntity, errorResponse("base_version_not_found", errBaseVersion, versionConflictDetails{CurrentVersionID: d.CurrentVersionID, Seq: d.Seq}))
	case errors.Is(err, repo.ErrNotFound):
		notFound(c)
	case errors.Is(err, repo.ErrTooLarge):
		c.JSON(http.StatusRequestEntityTooLarge, errorResponse("payload_too_large", "edited HTML exceeds 50 MiB", nil))
	default:
		internalErr(c, err)
	}
}

// restoreVersionRequest is the optional body of POST
// /v1/documents/{id}/versions/{version_id}/restore.
type restoreVersionRequest struct {
	ChangeSummary string `json:"change_summary,omitempty"`
}

// RestoreVersion godoc
// @Summary Restore version
// @Description Saves the content of an earlier version as the newest version, as an edit by the caller. History keeps every version, so a restore can itself be undone by restoring again. When the document has that content now, the response is 200 with unchanged set and the current version.
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Accept json
// @Param id path string true "Document ID"
// @Param version_id path string true "Version ID to restore"
// @Param body body restoreVersionRequest false "Change summary"
// @Success 201 {object} createVersionResponse
// @Failure 400 {object} errorEnvelope
// @Failure 409 {object} errorEnvelope
// @Router /v1/documents/{id}/versions/{version_id}/restore [post]
func (h handlers) restoreVersion(c *gin.Context) {
	old, ok := h.loadVersion(c, repo.RoleEditor)
	if !ok {
		return
	}
	var in restoreVersionRequest
	if err := c.ShouldBindJSON(&in); err != nil && !errors.Is(err, io.EOF) {
		badRequest(c, "invalid restore request")
		return
	}
	ctx := c.Request.Context()
	d, err := h.deps.repository.GetDocument(ctx, old.DocumentID)
	if err != nil {
		internalErr(c, err)
		return
	}
	if d.CurrentVersionID == old.ID {
		badRequest(c, "that version is already the current version")
		return
	}
	html, err := h.deps.repository.GetVersionHTML(ctx, old.ID)
	if err != nil {
		internalErr(c, err)
		return
	}
	summary := strings.TrimSpace(in.ChangeSummary)
	if summary == "" {
		summary = restoredSummary(old)
	}
	// The restore is made on the current version, so the new version holds
	// exactly the content of the old one.
	v, onto, err := h.deps.repository.RestoreVersion(ctx, old.DocumentID, html, summary, *current(c))
	if err != nil {
		h.editFailed(c, err)
		return
	}
	if !onto.Unchanged {
		incVersion("restored", actorType(c))
		h.followLater(c, old.DocumentID)
	}
	c.JSON(savedStatus(onto), createVersionResponse{ID: v.ID, Number: v.Number, SHA256: v.SHA256, ChangeSummary: v.ChangeSummary, BaseVersionID: onto.VersionID, Seq: v.Seq, Unchanged: onto.Unchanged})
}

// restoredSummary names a restore by the entry it brings back, with the
// words that History shows for that entry. A time would show in one time
// zone here and in the reader's own zone in the list. The entry follows a
// colon, not quotes, because its words can have quotes of their own.
func restoredSummary(old repo.Version) string {
	name, _, _ := strings.Cut(strings.TrimSpace(old.ChangeSummary), "\n")
	name = strings.TrimSpace(strings.TrimLeft(name, "-*• "))
	switch {
	case name != "":
	case old.Number == 1:
		name = "Created"
	default:
		name = "Edited"
	}
	return "Restored: " + name
}

// CreateRenderToken godoc
// @Summary Create render token
// @Description Gives a URL that renders the version, and the seq of the source that the URL renders. For an open version that is the seq of the live document now.
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param version_id path string true "Version ID"
// @Success 200 {object} renderTokenResponse
// @Router /v1/documents/{id}/versions/{version_id}/render-token [post]
func (h handlers) createRenderToken(c *gin.Context) {
	v, ok := h.loadVersionForViewer(c)
	if !ok {
		return
	}
	subject := renderAudiencePrefix + v.DocumentID + "/" + v.ID
	token := (auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}).SignForAudience(subject, "render", 5*time.Minute)
	renderPath := "/v/" + v.DocumentID + "/" + v.ID
	// The content of an open version moves, so the URL names the seq.
	path := renderPath + "?seq=" + strconv.FormatInt(v.Seq, 10)
	if h.deps.renderOrigin == "" || sameHTTPOrigin(h.deps.appOrigin, h.deps.renderOrigin) {
		//nolint:gosec // G124: Secure is conditional so explicit local HTTP development remains usable.
		http.SetCookie(c.Writer, &http.Cookie{
			Name:     "slashdocs_render_token",
			Value:    token,
			Path:     renderPath,
			HttpOnly: true,
			SameSite: http.SameSiteLaxMode,
			Secure:   secureRenderCookie(c, h.deps.appOrigin),
			MaxAge:   300,
		})
	} else {
		path += "&token=" + url.QueryEscape(token)
	}
	if h.deps.renderOrigin != "" {
		path = strings.TrimRight(h.deps.renderOrigin, "/") + path
	}
	incRender("token_created", "success")
	c.JSON(http.StatusOK, renderTokenResponse{Token: token, URL: path, Seq: v.Seq})
}

func (h handlers) createPrintToken(c *gin.Context) {
	v, ok := h.loadVersionForViewer(c)
	if !ok {
		return
	}
	subject := renderAudiencePrefix + v.DocumentID + "/" + v.ID
	token := (auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}).SignForAudience(subject, "print", 2*time.Minute)
	path := "/print/" + v.DocumentID + "/" + v.ID + "?token=" + url.QueryEscape(token)
	if h.deps.renderOrigin != "" {
		path = strings.TrimRight(h.deps.renderOrigin, "/") + path
	}
	c.JSON(http.StatusOK, renderTokenResponse{Token: token, URL: path, Seq: v.Seq})
}

func (h handlers) renderPrintVersion(c *gin.Context) {
	if h.deps.renderOrigin != "" && !hostMatchesOrigin(c.Request.Host, h.deps.renderOrigin) {
		notFound(c)
		return
	}
	docID, vid := c.Param("id"), c.Param("version_id")
	uid, ok := (auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}).VerifyAudience(c.Query("token"), "print")
	if !ok || uid != renderAudiencePrefix+docID+"/"+vid {
		c.JSON(http.StatusUnauthorized, errorResponse("unauthorized", "invalid print token", nil))
		return
	}
	b, err := h.deps.repository.GetVersionHTML(c.Request.Context(), vid)
	if errors.Is(err, repo.ErrNotFound) {
		notFound(c)
		return
	}
	if err != nil {
		internalErr(c, err)
		return
	}
	c.Header("Content-Security-Policy", "default-src 'none'; img-src * data: blob:; media-src * data: blob:; font-src * data: blob:; style-src * 'unsafe-inline'; script-src 'unsafe-inline'; connect-src *; frame-ancestors 'none'; object-src 'none'")
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Data(http.StatusOK, "text/html; charset=utf-8", printableHTML(b))
}

// RenderVersion godoc
// @Summary Render version wrapper
// @Tags render
// @Param id path string true "Document ID"
// @Param version_id path string true "Version ID"
// @Param token query string true "Render token"
// @Param seq query int false "Seq of the source to render. Without it, or when the server no longer has that seq, the content of the version."
// @Produce html
// @Success 200 {string} string
// @Router /v/{id}/{version_id} [get]
func (h handlers) renderVersion(c *gin.Context) {
	if h.deps.renderOrigin != "" && !hostMatchesOrigin(c.Request.Host, h.deps.renderOrigin) {
		notFound(c)
		return
	}
	docID, vid := c.Param("id"), c.Param("version_id")
	token := c.Query("token")
	if token == "" {
		if cookie, err := c.Request.Cookie("slashdocs_render_token"); err == nil {
			token = cookie.Value
		}
	}
	uid, ok := (auth.SessionCodec{Secret: []byte(h.deps.sessionSecret)}).VerifyAudience(token, "render")
	if !ok || uid != renderAudiencePrefix+docID+"/"+vid {
		c.JSON(http.StatusUnauthorized, errorResponse("unauthorized", "invalid render token", nil))
		return
	}
	b, _, err := h.versionSource(c, vid)
	// The server no longer has that seq. The frame shows the version as it
	// is now, and the app, whose seq is then behind, loads it again.
	if errors.Is(err, repo.ErrStale) {
		b, _, err = h.deps.repository.GetVersionHTMLAt(c.Request.Context(), vid, repo.LiveSeq)
	}
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			incRender("rendered", "not_found")
			notFound(c)
			return
		}
		incRender("rendered", "error")
		internalErr(c, err)
		return
	}
	appOrigin := h.deps.appOrigin
	if appOrigin == "" {
		appOrigin = "'self'"
	}
	c.Header("Content-Security-Policy", render.CSP(appOrigin))
	c.Header("Referrer-Policy", "no-referrer")
	c.Header("X-Content-Type-Options", "nosniff")
	observeHTML("render", len(b))
	incRender("rendered", "success")
	c.Data(http.StatusOK, "text/html; charset=utf-8", render.Wrap(b, appOrigin))
}

func secureRenderCookie(c *gin.Context, appOrigin string) bool {
	if u, err := url.Parse(appOrigin); err == nil && strings.EqualFold(u.Scheme, "https") {
		return true
	}
	if c.Request.TLS != nil {
		return true
	}
	return strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https")
}

// versionSource returns the source of the version id at the seq of the
// query, or the content of the version without one, and the seq of what it
// returns. A seq that is not a number is stale, as one that is too old is.
func (h handlers) versionSource(c *gin.Context, id string) ([]byte, int64, error) {
	seq := repo.LiveSeq
	if raw, ok := c.GetQuery("seq"); ok {
		var err error
		if seq, err = strconv.ParseInt(raw, 10, 64); err != nil || seq < 0 {
			return nil, 0, repo.ErrStale
		}
	}
	return h.deps.repository.GetVersionHTMLAt(c.Request.Context(), id, seq)
}

// ListVersions godoc
// @Summary List versions
// @Description A version is a checkpoint: a burst of editing in the browser, a push, an edit or a restore. The newest version is open while people type in it: its change_summary then says what changed up to now, and it is not in the list while its content is that of the version before. edited_at is the time of the last operation of a version, or created_at when the server holds none. authors are its creator and the people whose operations it holds.
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Success 200 {object} listResponse[repo.Version]
// @Router /v1/documents/{id}/versions [get]
func (h handlers) listVersions(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleViewer) {
		return
	}
	items, err := h.deps.repository.ListVersions(c.Request.Context(), c.Param("id"))
	if err != nil {
		internalErr(c, err)
		return
	}
	c.JSON(http.StatusOK, listResponse[repo.Version]{Items: items})
}

// DocumentChanges godoc
// @Summary Get the operations after a seq
// @Description For the browser, which follows the document while other people edit it. ops are the operations after the seq after, in order. Each one is a list of replacements on the source before it: start and end count UTF-8 bytes, and end is exclusive. The caller applies them in order to the source at after, and then has the source at seq, the live document. sum is the CRC-32 (IEEE) of the UTF-8 bytes of that source. typed is true when the browser editor made every one of the operations. authors made them, and the author of the newest comes first. The response is 409 stale when the log no longer holds every operation after the seq: load the document again.
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param after query int true "Seq of the source that the caller has"
// @Success 200 {object} repo.DocumentChanges
// @Failure 404 {object} errorEnvelope
// @Failure 409 {object} errorEnvelope
// @Failure 422 {object} errorEnvelope
// @Failure 429 {object} errorEnvelope
// @Router /v1/documents/{id}/changes [get]
func (h handlers) documentChanges(c *gin.Context) {
	docID := c.Param("id")
	if !h.needDocRole(c, docID, repo.RoleViewer) {
		return
	}
	after, err := strconv.ParseInt(c.Query("after"), 10, 64)
	if err != nil {
		badRequest(c, "after must be a seq")
		return
	}
	out, err := h.deps.repository.ChangesAfter(c.Request.Context(), docID, after)
	switch {
	case errors.Is(err, repo.ErrNoSuchSeq):
		c.JSON(http.StatusUnprocessableEntity, errorResponse("no_such_seq", "after is not a seq of the document", nil))
	case errors.Is(err, repo.ErrStale):
		c.JSON(http.StatusConflict, errorResponse("stale", errStale, nil))
	case errors.Is(err, repo.ErrNotFound):
		notFound(c)
	case err != nil:
		internalErr(c, err)
	default:
		c.JSON(http.StatusOK, out)
	}
}

// GetVersion godoc
// @Summary Get version metadata
// @Description The change_summary of the open version says what changed up to now.
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param version_id path string true "Version ID"
// @Success 200 {object} repo.Version
// @Router /v1/documents/{id}/versions/{version_id} [get]
func (h handlers) getVersion(c *gin.Context) {
	v, ok := h.loadVersionForViewer(c)
	if !ok {
		return
	}
	// The open version is a sitting, which shows as what it changed up to
	// now.
	if v.Open {
		open, summary, err := h.deps.repository.LiveChangeSummary(c.Request.Context(), v.DocumentID)
		if err != nil {
			internalErr(c, err)
			return
		}
		if open == v.ID {
			v.ChangeSummary = summary
		}
	}
	c.JSON(http.StatusOK, v)
}

// loadVersionForViewer fetches the version named by the :version_id param,
// scoped to the document named by :id, and verifies the caller has at least
// viewer access to that document. It writes the appropriate error response
// and returns ok=false when any check fails.
func (h handlers) loadVersionForViewer(c *gin.Context) (repo.Version, bool) {
	return h.loadVersion(c, repo.RoleViewer)
}

// loadVersion is loadVersionForViewer for callers that need the given role.
func (h handlers) loadVersion(c *gin.Context, role repo.Role) (repo.Version, bool) {
	docID := c.Param("id")
	if !h.needDocRole(c, docID, role) {
		return repo.Version{}, false
	}
	v, err := h.deps.repository.GetVersion(c.Request.Context(), c.Param("version_id"))
	if err != nil && !errors.Is(err, repo.ErrNotFound) {
		internalErr(c, err)
		return repo.Version{}, false
	}
	if err != nil || v.DocumentID != docID {
		notFound(c)
		return repo.Version{}, false
	}
	return v, true
}

// GetVersionHTML godoc
// @Summary Get version HTML
// @Description Gives the content of the version. For the open version that is the live document, and no read seals a version. The header X-Slashdocs-Seq has the seq of the HTML: send it as base_seq with a push that was made from this HTML. With seq, gives the source at that seq. The response is 409 stale for a seq that the version can no longer give.
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param version_id path string true "Version ID"
// @Param seq query int false "Seq of the source"
// @Produce html
// @Success 200 {string} string
// @Header 200 {integer} X-Slashdocs-Seq "Seq of the HTML"
// @Failure 404 {object} errorEnvelope
// @Failure 409 {object} errorEnvelope
// @Failure 429 {object} errorEnvelope
// @Router /v1/documents/{id}/versions/{version_id}/html [get]
func (h handlers) getVersionHTML(c *gin.Context) {
	v, ok := h.loadVersionForViewer(c)
	if !ok {
		return
	}
	b, seq, err := h.versionSource(c, v.ID)
	switch {
	case errors.Is(err, repo.ErrStale):
		c.JSON(http.StatusConflict, errorResponse("stale", errStale, nil))
		return
	case errors.Is(err, repo.ErrNotFound):
		notFound(c)
		return
	case err != nil:
		internalErr(c, err)
		return
	}
	observeHTML("version_download", len(b))
	incVersion("html_downloaded", actorType(c))
	c.Header("X-Slashdocs-Seq", strconv.FormatInt(seq, 10))
	c.Header("Content-Security-Policy", "sandbox; default-src 'none'")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Disposition", `attachment; filename="slashdocs-`+v.ID+`.html"`)
	c.Data(http.StatusOK, "text/html; charset=utf-8", b)
}
