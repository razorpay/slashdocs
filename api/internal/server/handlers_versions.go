package server

import (
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/internal/render"
)

// createVersionResponse is the payload of POST /v1/documents/{id}/versions.
type createVersionResponse struct {
	ID            string `json:"id"`
	Number        int    `json:"number"`
	SHA256        string `json:"sha256"`
	ChangeSummary string `json:"change_summary,omitempty"`
}

// versionConflictDetails names the latest version when a create hits a stale
// base_version_id.
type versionConflictDetails struct {
	CurrentVersionID string `json:"current_version_id"`
}

// renderTokenResponse is the payload of POST .../render-token.
type renderTokenResponse struct {
	Token string `json:"token"`
	URL   string `json:"url"`
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
// @Param file formData file true "HTML file"
// @Success 201 {object} createVersionResponse
// @Router /v1/documents/{id}/versions [post]
func (h handlers) createVersion(c *gin.Context) {
	if !h.needDocRole(c, c.Param("id"), repo.RoleEditor) {
		return
	}
	p := current(c)
	html, err := readMultipartFile(c, "file")
	if errors.Is(err, errPayloadTooLarge) {
		c.JSON(http.StatusRequestEntityTooLarge, errorResponse("payload_too_large", "HTML file exceeds 50 MiB", nil))
		return
	}
	if err != nil {
		badRequest(c, "file is required")
		return
	}
	observeHTML("version_create", len(html))
	v, err := h.deps.repository.CreateVersion(c.Request.Context(), c.Param("id"), c.PostForm("base_version_id"), c.PostForm("change_summary"), html, *p)
	if err != nil {
		// A conflict means the base version was stale; report the current one.
		if errors.Is(err, repo.ErrVersionConflict) {
			var latestID string
			var vce *repo.VersionConflictError
			if errors.As(err, &vce) {
				latestID = vce.LatestVersionID
			}
			c.JSON(http.StatusConflict, errorResponse("version_conflict", "base_version_id is stale", versionConflictDetails{CurrentVersionID: latestID}))
			return
		}
		internalErr(c, err)
		return
	}
	incVersion("created", actorType(c))
	h.announce(c, repo.DocumentEventDocument)
	c.JSON(http.StatusCreated, createVersionResponse{ID: v.ID, Number: v.Number, SHA256: v.SHA256, ChangeSummary: v.ChangeSummary})
}

// CreateRenderToken godoc
// @Summary Create render token
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
	path := renderPath
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
		path += "?token=" + url.QueryEscape(token)
	}
	if h.deps.renderOrigin != "" {
		path = strings.TrimRight(h.deps.renderOrigin, "/") + path
	}
	incRender("token_created", "success")
	c.JSON(http.StatusOK, renderTokenResponse{Token: token, URL: path})
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
	c.JSON(http.StatusOK, renderTokenResponse{Token: token, URL: path})
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
	b, err := h.deps.repository.GetVersionHTML(c.Request.Context(), vid)
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

// ListVersions godoc
// @Summary List versions
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

// GetVersion godoc
// @Summary Get version metadata
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
	c.JSON(http.StatusOK, v)
}

// loadVersionForViewer fetches the version named by the :version_id param,
// scoped to the document named by :id, and verifies the caller has at least
// viewer access to that document. It writes the appropriate error response
// and returns ok=false when any check fails.
func (h handlers) loadVersionForViewer(c *gin.Context) (repo.Version, bool) {
	docID := c.Param("id")
	if !h.needDocRole(c, docID, repo.RoleViewer) {
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
// @Tags versions
// @Security bearerAuth
// @Security cookieAuth
// @Param id path string true "Document ID"
// @Param version_id path string true "Version ID"
// @Produce html
// @Success 200 {string} string
// @Router /v1/documents/{id}/versions/{version_id}/html [get]
func (h handlers) getVersionHTML(c *gin.Context) {
	v, ok := h.loadVersionForViewer(c)
	if !ok {
		return
	}
	b, err := h.deps.repository.GetVersionHTML(c.Request.Context(), v.ID)
	if err != nil {
		internalErr(c, err)
		return
	}
	observeHTML("version_download", len(b))
	incVersion("html_downloaded", actorType(c))
	c.Header("Content-Security-Policy", "sandbox; default-src 'none'")
	c.Header("X-Content-Type-Options", "nosniff")
	c.Header("Content-Disposition", `attachment; filename="slashdocs-`+v.ID+`.html"`)
	c.Data(http.StatusOK, "text/html; charset=utf-8", b)
}
