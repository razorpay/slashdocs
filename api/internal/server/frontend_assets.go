package server

import (
	"bytes"
	"crypto/sha256"
	"embed"
	"encoding/hex"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"

	"github.com/gin-gonic/gin"
)

// frontendFS contains the Vite production build. The directory is
// populated by `make frontend` (or `npm run build` in frontend/) and is
// gitignored apart from .gitkeep placeholders, so this embed always has
// something to point at even when no build has happened yet. The
// fallback path in registerFrontendRoutes returns 404 for index.html in
// that case.
//
//go:embed all:frontend_dist
var frontendFS embed.FS

// shellTitle is the <title> of the built index.html. A document page replaces
// it with the document's head.
const shellTitle = "<title>slashdocs</title>"

// staleAssetReload is the answer to a script that the build does not have.
// Only a page of an older build asks for one, as when it loads a part of its
// code after a deploy. The page then loads again, and gets the current build.
// It does so at most once a minute, so that a build that lacks one of its own
// files does not load again and again.
const staleAssetReload = `try {
  const key = "slashdocs:stale-reload";
  if (!(Date.now() - Number(sessionStorage.getItem(key)) < 60000)) {
    sessionStorage.setItem(key, String(Date.now()));
    location.reload();
  }
} catch {}
`

// frontendBuild names the build of the frontend with the start of the hash
// of its index.html, which names the files of the build. It is empty when
// there is no build.
func frontendBuild(dist fs.FS) string {
	index, err := fs.ReadFile(dist, "index.html")
	if err != nil {
		return ""
	}
	sum := sha256.Sum256(index)
	return hex.EncodeToString(sum[:8])
}

// embeddedFrontend returns the root of the Vite build in frontendFS.
func embeddedFrontend() fs.FS {
	dist, err := fs.Sub(frontendFS, "frontend_dist")
	if err != nil {
		panic(err) // unreachable: "frontend_dist" is a valid path
	}
	return dist
}

// registerFrontendRoutes serves h.deps.frontend as a single-page app: existing
// files as they are, and index.html with the public URL and the build filled
// in for every other GET or HEAD. Document pages also get the document's head.
func registerFrontendRoutes(r *gin.Engine, h handlers) {
	dist := h.deps.frontend
	fileServer := http.FileServer(http.FS(dist))
	appOrigin := strings.TrimRight(h.deps.appOrigin, "/")

	assets := subOrEmpty(dist, "assets")
	assetServer := http.StripPrefix("/assets/", http.FileServer(http.FS(assets)))
	r.GET("/assets/*filepath", func(c *gin.Context) {
		name := strings.TrimPrefix(c.Param("filepath"), "/")
		if path.Ext(name) == ".js" && !fileExists(assets, name) {
			c.Header("Cache-Control", "no-store")
			c.Data(http.StatusOK, "text/javascript; charset=utf-8", []byte(staleAssetReload))
			return
		}
		assetServer.ServeHTTP(c.Writer, c.Request)
	})
	r.NoRoute(func(c *gin.Context) {
		if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
			c.Status(http.StatusNotFound)
			return
		}
		// The render hostname serves only tokenized renders. Its other pages go to
		// the app origin, where sign-in works and document pages get their head.
		if h.deps.isRenderHost(c.Request.Host) {
			if strings.HasPrefix(c.Request.URL.Path, "/v/") || strings.HasPrefix(c.Request.URL.Path, "/print/") {
				c.Status(http.StatusNotFound)
				return
			}
			c.Redirect(http.StatusTemporaryRedirect, appOrigin+c.Request.URL.RequestURI())
			return
		}
		urlPath := strings.TrimPrefix(path.Clean(c.Request.URL.Path), "/")
		if urlPath != "." && urlPath != "" && fileExists(dist, urlPath) {
			fileServer.ServeHTTP(c.Writer, c.Request)
			return
		}
		index, err := fs.ReadFile(dist, "index.html")
		if err != nil {
			c.Status(http.StatusNotFound)
			return
		}
		index = bytes.ReplaceAll(index, []byte("__SLASHDOCS_PUBLIC_URL_VALUE__"), []byte(appOrigin))
		index = bytes.ReplaceAll(index, []byte("__SLASHDOCS_BUILD_VALUE__"), []byte(h.deps.frontendBuild))
		if id, ok := documentPageID(urlPath); ok {
			// The head depends on who asks: no shared cache may keep the page, and
			// the browser must ask again before it reuses it.
			c.Header("Cache-Control", "private, no-cache")
			if head := h.documentHead(c.Request, id); head != nil {
				index = bytes.Replace(index, []byte(shellTitle), head, 1)
			}
		}
		c.Data(http.StatusOK, "text/html; charset=utf-8", index)
	})
}

// isRenderHost reports whether host is the render hostname and not also the app
// hostname.
func (d dependencies) isRenderHost(host string) bool {
	return d.appOrigin != "" && d.renderOrigin != "" && hostMatchesOrigin(host, d.renderOrigin) && !hostMatchesOrigin(host, d.appOrigin)
}

// documentPageID returns the document ID of a cleaned "app/d/{id}" path.
func documentPageID(urlPath string) (string, bool) {
	id, ok := strings.CutPrefix(urlPath, "app/d/")
	return id, ok && id != "" && !strings.Contains(id, "/")
}

// subOrEmpty returns a sub-filesystem rooted at dir. If dir does not exist it
// logs a warning and returns an empty FS, so missing assets 404 rather than
// exposing the parent dist (index.html etc.) under the mounted path.
func subOrEmpty(fsys fs.FS, dir string) fs.FS {
	sub, err := fs.Sub(fsys, dir)
	if err != nil {
		slog.Warn("frontend assets dir not found; serving empty FS", slog.String("dir", dir), slog.Any("error", err))
		return emptyFS{}
	}
	return sub
}

// emptyFS is an fs.FS with no files; every Open returns fs.ErrNotExist.
type emptyFS struct{}

func (emptyFS) Open(string) (fs.File, error) { return nil, fs.ErrNotExist }

func fileExists(fsys fs.FS, name string) bool {
	info, err := fs.Stat(fsys, name)
	return err == nil && !info.IsDir()
}
