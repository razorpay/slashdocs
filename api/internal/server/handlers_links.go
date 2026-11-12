package server

import (
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/notifications"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/internal/render"
)

type headingResponse struct {
	ID    string `json:"id"`
	Text  string `json:"text"`
	Level int    `json:"level"`
	URL   string `json:"url"`
}
type documentLinkResponse struct {
	URL string `json:"url"`
}

// documentHeadings godoc
// @Summary List document headings and shareable links
// @Description Lists headings in stored HTML. Explicit HTML IDs are preserved. JavaScript-only headings appear in the viewer when created.
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param version query string false "Version ID (pins links to this version)"
// @Success 200 {object} listResponse[headingResponse]
// @Router /v1/documents/{id}/headings [get]
func (h handlers) documentHeadings(c *gin.Context) {
	id := c.Param("id")
	if !h.needDocRole(c, id, repo.RoleViewer) {
		return
	}
	d, err := h.deps.repository.GetDocument(c.Request.Context(), id)
	if err != nil {
		internalErr(c, err)
		return
	}
	version := c.Query("version")
	if version == "" {
		version = d.CurrentVersionID
	}
	v, err := h.deps.repository.GetVersion(c.Request.Context(), version)
	if errors.Is(err, repo.ErrNotFound) || (err == nil && v.DocumentID != id) {
		notFound(c)
		return
	}
	if err != nil {
		internalErr(c, err)
		return
	}
	raw, err := h.deps.repository.GetVersionHTML(c.Request.Context(), version)
	if err != nil {
		internalErr(c, err)
		return
	}
	headings, err := render.Headings(raw)
	if err != nil {
		internalErr(c, err)
		return
	}
	items := make([]headingResponse, len(headings))
	for i, hd := range headings {
		items[i] = headingResponse{ID: hd.ID, Text: hd.Text, Level: hd.Level, URL: h.headingURL(id, hd.ID, c.Query("version"))}
	}
	c.JSON(http.StatusOK, listResponse[headingResponse]{Items: items})
}

func (h handlers) headingURL(docID, heading, version string) string {
	u := url.URL{Path: "/app/d/" + docID, Fragment: heading}
	if version != "" {
		u.RawQuery = url.Values{"version": {version}}.Encode()
	}
	return strings.TrimRight(h.deps.appOrigin, "/") + u.String()
}

// documentLink godoc
// @Summary Get a shareable link to a document, comment, or heading
// @Tags documents
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param comment query string false "Comment or reply ID"
// @Param heading query string false "Heading ID, including an ID created by document JavaScript"
// @Param version query string false "Version ID for a heading or document link"
// @Success 200 {object} documentLinkResponse
// @Router /v1/documents/{id}/link [get]
func (h handlers) documentLink(c *gin.Context) {
	id := c.Param("id")
	if !h.needDocRole(c, id, repo.RoleViewer) {
		return
	}
	comment, heading, version := c.Query("comment"), c.Query("heading"), c.Query("version")
	if len(heading) > 1024 || (comment != "" && (heading != "" || version != "")) {
		badRequest(c, "choose a comment, or a heading and optional version")
		return
	}
	link := h.headingURL(id, heading, version)
	if !h.linkVersionAllowed(c, id, version) {
		return
	}
	if comment != "" {
		cm, err := h.deps.repository.GetComment(c.Request.Context(), comment)
		if errors.Is(err, repo.ErrNotFound) || (err == nil && cm.DocumentID != id) {
			notFound(c)
			return
		}
		if err != nil {
			internalErr(c, err)
			return
		}
		link = notifications.CommentURL(h.deps.appOrigin, id, comment)
	}
	c.JSON(http.StatusOK, documentLinkResponse{URL: link})
}

func (h handlers) linkVersionAllowed(c *gin.Context, documentID, versionID string) bool {
	if versionID == "" {
		return true
	}
	v, err := h.deps.repository.GetVersion(c.Request.Context(), versionID)
	if errors.Is(err, repo.ErrNotFound) || (err == nil && v.DocumentID != documentID) {
		notFound(c)
		return false
	}
	if err != nil {
		internalErr(c, err)
		return false
	}
	return true
}
