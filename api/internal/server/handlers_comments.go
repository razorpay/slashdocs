package server

import (
	"context"
	"errors"
	"fmt"
	"math"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

type commentMentionPrincipalType string

const (
	commentMentionPrincipalUser           commentMentionPrincipalType = "user"
	commentMentionPrincipalServiceAccount commentMentionPrincipalType = "service_account"
)

func (t commentMentionPrincipalType) authType() auth.PrincipalType {
	switch t {
	case commentMentionPrincipalUser:
		return auth.PrincipalUser
	case commentMentionPrincipalServiceAccount:
		return auth.PrincipalServiceAccount
	default:
		// Preserve an unknown wire value so repository validation rejects it.
		return auth.PrincipalType(t)
	}
}

type commentMentionPrincipalRef struct {
	Type commentMentionPrincipalType `json:"type"`
	ID   string                      `json:"id"`
}

type commentMentionRequest struct {
	Principal commentMentionPrincipalRef `json:"principal"`
	// Offset is the zero-based start in UTF-16 code units.
	Offset int64 `json:"offset"`
	// Length is the range length in UTF-16 code units.
	Length int64 `json:"length"`
}

type createCommentRequest struct {
	VersionID string                  `json:"version_id"`
	Body      string                  `json:"body"`
	Anchor    repo.Anchor             `json:"anchor"`
	Mentions  []commentMentionRequest `json:"mentions"`
}

type createCommentReplyRequest struct {
	Body     string                  `json:"body"`
	Mentions []commentMentionRequest `json:"mentions"`
}

type patchCommentRequest struct {
	Body     *string                  `json:"body"`
	Status   string                   `json:"status"`
	Mentions *[]commentMentionRequest `json:"mentions"`
	// Anchor moves a pinned comment on a canvas to a new spot.
	Anchor *repo.Anchor `json:"anchor"`
}

// pointTargetPattern is the allowed value of a data-slashdocs-target attribute.
// The limits keep targets safe to match against stored HTML as plain text.
var pointTargetPattern = regexp.MustCompile(`^[A-Za-z0-9_.:-]{1,128}$`)

// validateCommentAnchor checks the anchor of a new root comment and normalises
// point anchors in place (kind forced to "point", x and y rounded to 4
// decimals). Text anchors keep the original rule: a non-empty quote.
func validateCommentAnchor(a *repo.Anchor, pointsEnabled bool) (msg string, ok bool) {
	const invalid = "invalid comment"
	if a.Point == nil {
		if a.Quote == "" || a.Kind != "" {
			return invalid, false
		}
		return "", true
	}
	if !pointsEnabled {
		return "point comments are not enabled", false
	}
	if !pointAnchorValid(a) {
		return invalid, false
	}
	a.Kind = "point"
	a.Point.X = math.Round(a.Point.X*1e4) / 1e4
	a.Point.Y = math.Round(a.Point.Y*1e4) / 1e4
	return "", true
}

// pointAnchorValid reports whether a is a well-formed point anchor: no text
// fields, an allowed target, and x and y inside the target's box.
func pointAnchorValid(a *repo.Anchor) bool {
	if a.Quote != "" || a.Prefix != "" || a.Suffix != "" || a.DOMPath != "" ||
		a.StartOffset != 0 || a.EndOffset != 0 || (a.Kind != "" && a.Kind != "point") {
		return false
	}
	p := a.Point
	if p.Target != "" && !pointTargetPattern.MatchString(p.Target) {
		return false
	}
	return unitFraction(p.X) && unitFraction(p.Y)
}

func unitFraction(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 && v <= 1
}

// CreateComment godoc
// @Summary Create comment
// @Description Requests with non-empty mentions must use Content-Type application/vnd.slashdocs.comment-mentions+json so mixed-version deployments fail closed instead of dropping metadata.
// @Description The anchor is either a text anchor (a non-empty quote) or, when canvas comments are enabled, a point anchor: anchor.point {target, x, y} where target is a data-slashdocs-target value ("" for the board itself) and x, y are fractions of its box between 0 and 1. A point anchor must leave the text fields empty; kind is set to "point" by the server.
// @Tags comments
// @Security bearerAuth
// @Security cookieAuth
// @Accept json,application/vnd.slashdocs.comment-mentions+json
// @Param id path string true "Document ID"
// @Param comment body createCommentRequest true "Comment body, anchor, and structured mentions"
// @Success 201 {object} commentResponse
// @Router /v1/documents/{id}/comments [post]
func (h handlers) createComment(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleCommenter) {
		return
	}
	p := current(c)
	var in createCommentRequest
	if !requireCommentJSON(c) {
		return
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid comment")
		return
	}
	if len(in.Mentions) > 0 && !requireStructuredCommentMediaType(c) {
		return
	}
	normalized, message := normalizeCommentBodyInput(in.Body)
	if message != "" {
		badRequest(c, message)
		return
	}
	in.Body = normalized
	if in.VersionID == "" || blankCommentBody(in.Body) {
		badRequest(c, "invalid comment")
		return
	}
	if msg, ok := validateCommentAnchor(&in.Anchor, h.deps.canvasCommentsEnabled); !ok {
		badRequest(c, msg)
		return
	}
	cm, err := h.deps.repository.CreateComment(c.Request.Context(), c.Param("id"), in.VersionID, in.Body, in.Anchor, *p, commentMentions(in.Mentions))
	if err != nil {
		commentWriteError(c, err)
		return
	}
	incComment("created", cm.Status, actorType(c))
	h.announce(c, repo.DocumentEventComments)
	c.JSON(http.StatusCreated, commentJSON(cm, cm.VersionID, "", *p))
}

// ListComments godoc
// @Summary List comments
// @Tags comments
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param status query string false "Thread filter: open, resolved, orphaned or all. Empty means all."
// @Param version_id query string false "Version ID"
// @Success 200 {object} listResponse[commentResponse]
// @Router /v1/documents/{id}/comments [get]
func (h handlers) listComments(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleViewer) {
		return
	}
	status := c.Query("status")
	if !validCommentListStatus(status) {
		badRequest(c, "status must be open, resolved, orphaned or all")
		return
	}
	versionID := c.Query("version_id")
	// Status is a property of a thread, and orphaned is only known after
	// placement, so the query reads every row and the filter runs on threads.
	items, err := h.deps.repository.ListComments(c.Request.Context(), c.Param("id"), "", versionID)
	if err != nil {
		internalErr(c, err)
		return
	}
	placementVersionID := versionID
	if placementVersionID == "" {
		d, err := h.deps.repository.GetDocument(c.Request.Context(), c.Param("id"))
		if err == nil {
			placementVersionID = d.CurrentVersionID
		}
	}
	var placementHTML []byte
	if placementVersionID != "" {
		placementHTML, _ = h.deps.repository.GetVersionHTML(c.Request.Context(), placementVersionID)
	}
	threads := filterCommentThreads(commentsJSON(items, placementVersionID, placementHTML, *current(c)), status)
	c.JSON(http.StatusOK, listResponse[commentResponse]{Items: threads})
}

// validCommentListStatus reports whether status is a value listComments accepts.
func validCommentListStatus(status string) bool {
	switch status {
	case "", "all", commentStatusOpen, commentStatusResolved, placementOrphaned:
		return true
	}
	return false
}

// filterCommentThreads keeps the threads that match status. Replies travel
// with their thread: a reply is never filtered on its own status.
func filterCommentThreads(threads []commentResponse, status string) []commentResponse {
	if status == "" || status == "all" {
		return threads
	}
	out := make([]commentResponse, 0, len(threads))
	for _, th := range threads {
		if status == placementOrphaned {
			if th.CurrentPlacement != nil && th.CurrentPlacement.Status == placementOrphaned {
				out = append(out, th)
			}
			continue
		}
		if th.Status == status {
			out = append(out, th)
		}
	}
	return out
}

// CreateCommentReply godoc
// @Summary Create comment reply
// @Description Requests with non-empty mentions must use Content-Type application/vnd.slashdocs.comment-mentions+json so mixed-version deployments fail closed instead of dropping metadata.
// @Tags comments
// @Security bearerAuth
// @Security cookieAuth
// @Accept json,application/vnd.slashdocs.comment-mentions+json
// @Param id path string true "Document ID"
// @Param comment_id path string true "Parent Comment ID"
// @Param reply body createCommentReplyRequest true "Reply body and structured mentions"
// @Success 201 {object} commentResponse
// @Router /v1/documents/{id}/comments/{comment_id}/replies [post]
func (h handlers) createCommentReply(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleCommenter) {
		return
	}
	var in createCommentReplyRequest
	if !requireCommentJSON(c) {
		return
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid reply")
		return
	}
	if len(in.Mentions) > 0 && !requireStructuredCommentMediaType(c) {
		return
	}
	normalized, message := normalizeCommentBodyInput(in.Body)
	if message != "" {
		badRequest(c, message)
		return
	}
	in.Body = normalized
	if blankCommentBody(in.Body) {
		badRequest(c, "invalid reply")
		return
	}
	cm, err := h.deps.repository.CreateCommentReply(c.Request.Context(), c.Param("id"), c.Param("comment_id"), in.Body, *current(c), commentMentions(in.Mentions))
	if err != nil {
		commentWriteError(c, err)
		return
	}
	incComment("created", cm.Status, actorType(c))
	h.announce(c, repo.DocumentEventComments)
	c.JSON(http.StatusCreated, commentJSON(cm, "", "", *current(c)))
}

// PatchComment godoc
// @Summary Update comment
// @Description Any request containing the mentions key, including an empty array, must use Content-Type application/vnd.slashdocs.comment-mentions+json so mixed-version deployments fail closed. An anchor with kind "point" moves a pinned canvas comment to a new spot; text comments cannot move.
// @Tags comments
// @Security bearerAuth
// @Security cookieAuth
// @Accept json,application/vnd.slashdocs.comment-mentions+json
// @Param id path string true "Document ID"
// @Param comment_id path string true "Comment ID"
// @Param update body patchCommentRequest true "Fields to update; omitted mentions are preserved unless the body changes"
// @Success 200 {object} commentResponse
// @Router /v1/documents/{id}/comments/{comment_id} [patch]
func (h handlers) patchComment(c *gin.Context) {
	if !h.canMutateComment(c, c.Param("id"), c.Param("comment_id")) {
		return
	}
	var in patchCommentRequest
	if !requireCommentJSON(c) {
		return
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		badRequest(c, "invalid body")
		return
	}
	if in.Mentions != nil && !requireStructuredCommentMediaType(c) {
		return
	}
	if message := normalizePatchCommentRequest(&in); message != "" {
		badRequest(c, message)
		return
	}
	if in.Anchor != nil && !h.validCommentMove(c, in.Anchor) {
		return
	}
	var mentions *[]repo.CommentMention
	if in.Mentions != nil {
		converted := commentMentions(*in.Mentions)
		mentions = &converted
	}
	cm, err := h.deps.repository.UpdateComment(c.Request.Context(), c.Param("comment_id"), repo.CommentUpdate{Body: in.Body, Status: in.Status, Mentions: mentions, Anchor: in.Anchor})
	if err != nil {
		commentWriteError(c, err)
		return
	}
	event := "updated"
	if in.Anchor != nil {
		event = "moved"
	}
	switch in.Status {
	case commentStatusResolved:
		event = "resolved"
	case commentStatusOpen:
		event = "reopened"
	}
	incComment(event, cm.Status, actorType(c))
	h.announce(c, repo.DocumentEventComments)
	c.JSON(http.StatusOK, commentJSON(cm, cm.VersionID, "", *current(c)))
}

func normalizePatchCommentRequest(in *patchCommentRequest) string {
	if in.Body != nil {
		normalized, message := normalizeCommentBodyInput(*in.Body)
		if message != "" {
			return message
		}
		in.Body = &normalized
	}
	// Older CLI versions sent body:"" alongside a status change. The previous
	// handler treated that as omitted, so retain the behavior across upgrades.
	if in.Body != nil && *in.Body == "" && in.Status != "" && in.Mentions == nil {
		in.Body = nil
	}
	switch {
	case in.Body != nil && blankCommentBody(*in.Body):
		return "comment body cannot be empty"
	case in.Status != "" && in.Status != commentStatusOpen && in.Status != commentStatusResolved:
		return "invalid comment status"
	case patchIsEmpty(in):
		return "nothing to update"
	default:
		return ""
	}
}

func normalizeCommentBodyInput(body string) (string, string) {
	normalized := repo.NormalizeCommentBody(body)
	if normalized != body {
		return "", "legacy mention markers are not supported; reload the client and try again"
	}
	if utf8.RuneCountInString(normalized) > maxCommentBodyRunes {
		return "", fmt.Sprintf("comment is too long (at most %d characters)", maxCommentBodyRunes)
	}
	return normalized, ""
}

// maxCommentBodyRunes bounds a comment or reply body. Longer ones are pastes
// by mistake, and they stretch the comments panel without end.
const maxCommentBodyRunes = 20000

// blankCommentBody reports whether body has nothing but white space, which
// shows as an empty comment.
func blankCommentBody(body string) bool {
	return strings.TrimSpace(body) == ""
}

func commentMentions(items []commentMentionRequest) []repo.CommentMention {
	out := make([]repo.CommentMention, 0, len(items))
	for _, item := range items {
		out = append(out, repo.CommentMention{
			Principal:   auth.Principal{Type: item.Principal.Type.authType(), ID: item.Principal.ID},
			OffsetUTF16: item.Offset,
			LengthUTF16: item.Length,
		})
	}
	return out
}

func commentWriteError(c *gin.Context, err error) {
	switch {
	case errors.Is(err, repo.ErrInvalidCommentBody):
		badRequest(c, "comment body cannot be empty")
	case errors.Is(err, repo.ErrInvalidCommentMention):
		badRequest(c, "invalid comment mention")
	case errors.Is(err, repo.ErrNotFound):
		notFound(c)
	default:
		internalErr(c, err)
	}
}

// DeleteComment godoc
// @Summary Delete comment
// @Tags comments
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param comment_id path string true "Comment ID"
// @Success 204
// @Router /v1/documents/{id}/comments/{comment_id} [delete]
func (h handlers) deleteComment(c *gin.Context) {
	if !h.canDeleteComment(c, c.Param("id"), c.Param("comment_id")) {
		return
	}
	if err := h.deps.repository.DeleteComment(c.Request.Context(), c.Param("comment_id")); err != nil {
		internalErr(c, err)
		return
	}
	incComment("deleted", labelUnknown, actorType(c))
	h.announce(c, repo.DocumentEventComments)
	c.Status(http.StatusNoContent)
}

// allowedCommentReactions is the closed set of reaction slugs. Values are
// stable ASCII identifiers rather than literal emoji so they survive URLs,
// logs, and font differences, and each client picks its own glyph.
//
// This check is load-bearing rather than cosmetic: the MCP adapter passes tool
// arguments straight to c.Param without a router match, so nothing else stands
// between an agent-supplied value and the database.
var allowedCommentReactions = map[string]bool{
	"+1": true, "-1": true, "laugh": true, "hooray": true,
	"confused": true, "heart": true, "rocket": true, "eyes": true,
	"plus": true,
}

// commentInDocument loads a comment and confirms it belongs to docID. Callers
// must check the document role first; a missing comment and a comment in
// another document deliberately share one 404 so the response cannot be used
// to probe for comment IDs outside the document the caller named.
func (h handlers) commentInDocument(c *gin.Context, docID, commentID string) bool {
	cm, err := h.deps.repository.GetComment(c.Request.Context(), commentID)
	if err != nil && !errors.Is(err, repo.ErrNotFound) {
		internalErr(c, err)
		return false
	}
	if err != nil || cm.DocumentID != docID {
		c.JSON(http.StatusNotFound, errorResponse("not_found", "comment not found in document", nil))
		return false
	}
	return true
}

// PutCommentReaction godoc
// @Summary Add comment reaction
// @Description Adds the caller's reaction to a comment or reply. Repeating the same reaction is a no-op.
// @Tags comments
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param comment_id path string true "Comment ID"
// @Param emoji path string true "Reaction slug" Enums(+1, -1, laugh, hooray, confused, heart, rocket, eyes, plus)
// @Success 204
// @Router /v1/documents/{id}/comments/{comment_id}/reactions/{emoji} [put]
func (h handlers) putCommentReaction(c *gin.Context) {
	h.writeCommentReaction(c, h.deps.repository.PutCommentReaction)
}

// DeleteCommentReaction godoc
// @Summary Remove comment reaction
// @Description Removes the caller's reaction from a comment or reply. Removing an absent reaction is a no-op.
// @Tags comments
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param comment_id path string true "Comment ID"
// @Param emoji path string true "Reaction slug" Enums(+1, -1, laugh, hooray, confused, heart, rocket, eyes, plus)
// @Success 204
// @Router /v1/documents/{id}/comments/{comment_id}/reactions/{emoji} [delete]
func (h handlers) deleteCommentReaction(c *gin.Context) {
	h.writeCommentReaction(c, h.deps.repository.DeleteCommentReaction)
}

// reactionWrite is the shape both reaction mutations share, so each handler
// names the repository method it means instead of passing a flag for the
// helper to branch on.
type reactionWrite func(ctx context.Context, commentID string, principal auth.Principal, emoji string) error

// writeCommentReaction backs both reaction verbs. Both are idempotent, so both
// answer 204 whether or not the row already existed.
func (h handlers) writeCommentReaction(c *gin.Context, write reactionWrite) {
	docID, commentID := c.Param("id"), c.Param("comment_id")
	emoji := c.Param("emoji")
	if !allowedCommentReactions[emoji] {
		badRequest(c, "unsupported reaction")
		return
	}
	// Role before comment lookup: needDocRole authorizes the document in the
	// URL but says nothing about which document the comment belongs to, so the
	// membership check below is what actually confines the write.
	if !h.needDocRole(c, docID, repo.RoleCommenter) {
		return
	}
	if !h.commentInDocument(c, docID, commentID) {
		return
	}
	if err := write(c.Request.Context(), commentID, *current(c), emoji); err != nil {
		internalErr(c, err)
		return
	}
	h.announce(c, repo.DocumentEventComments)
	c.Status(http.StatusNoContent)
}

// loadCommentInDocument fetches a comment and confirms it belongs to docID,
// answering the client on every failure path.
//
// Distinct from commentInDocument above, which the reaction handlers use: this
// one runs before any document-role check, so it reports a missing comment as
// 403 and a cross-document one as 404. That split is only safe because the
// caller has not yet established the caller's access, and it is why the two
// helpers are not merged.
func (h handlers) loadCommentInDocument(c *gin.Context, docID, commentID string) (repo.Comment, bool) {
	cm, err := h.deps.repository.GetComment(c.Request.Context(), commentID)
	if err != nil {
		if errors.Is(err, repo.ErrNotFound) {
			forbidden(c, "comment access required")
			return repo.Comment{}, false
		}
		internalErr(c, err)
		return repo.Comment{}, false
	}
	if cm.DocumentID != docID {
		c.JSON(http.StatusNotFound, errorResponse("not_found", "comment not found in document", nil))
		return repo.Comment{}, false
	}
	return cm, true
}

// authoredBy reports whether the principal wrote the comment. Principal ids are
// only unique within a type, so both fields must match.
func authoredBy(cm repo.Comment, p auth.Principal) bool {
	return cm.Author.Type == p.Type && cm.Author.ID == p.ID
}

func (h handlers) canDeleteComment(c *gin.Context, docID, commentID string) bool {
	cm, ok := h.loadCommentInDocument(c, docID, commentID)
	if !ok || !h.needDocRole(c, docID, repo.RoleCommenter) {
		return false
	}
	if authoredBy(cm, *current(c)) {
		return true
	}
	forbidden(c, "only the comment author can delete this comment")
	return false
}

func (h handlers) canMutateComment(c *gin.Context, docID, commentID string) bool {
	cm, ok := h.loadCommentInDocument(c, docID, commentID)
	if !ok || !h.needDocRole(c, docID, repo.RoleCommenter) {
		return false
	}
	p := current(c)
	if authoredBy(cm, *p) {
		return true
	}
	role, err := h.deps.repository.RoleForDocument(c.Request.Context(), *p, cm.DocumentID)
	if err != nil {
		internalErr(c, err)
		return false
	}
	if role == repo.RoleOwner || role == repo.RoleEditor {
		return true
	}
	if groupMembershipUnavailable(p) {
		groupMembershipUnavailableResponse(c)
		return false
	}
	forbidden(c, "comment access required")
	return false
}

// validCommentMove checks a new spot for a pinned comment: only a pinned
// thread moves, and only to another valid point. Text comments keep their
// anchor for life.
func (h handlers) validCommentMove(c *gin.Context, a *repo.Anchor) bool {
	if a.Point == nil {
		badRequest(c, "only a pinned comment can move")
		return false
	}
	if msg, ok := validateCommentAnchor(a, h.deps.canvasCommentsEnabled); !ok {
		badRequest(c, msg)
		return false
	}
	cm, err := h.deps.repository.GetComment(c.Request.Context(), c.Param("comment_id"))
	if err != nil {
		commentWriteError(c, err)
		return false
	}
	if cm.Anchor.Point == nil || cm.ParentCommentID != "" {
		badRequest(c, "only a pinned comment can move")
		return false
	}
	return true
}

// patchIsEmpty tells that a comment patch changes nothing.
func patchIsEmpty(in *patchCommentRequest) bool {
	return in.Body == nil && in.Status == "" && in.Mentions == nil && in.Anchor == nil
}
