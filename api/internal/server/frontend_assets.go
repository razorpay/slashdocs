package server

import (
	"bytes"
	"embed"
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

func registerFrontendRoutes(r *gin.Engine, appOrigin, renderOrigin string) {
	dist, err := fs.Sub(frontendFS, "frontend_dist")
	if err != nil {
		return
	}
	fileServer := http.FileServer(http.FS(dist))
	appOrigin = strings.TrimRight(appOrigin, "/")

	r.GET("/assets/*filepath", gin.WrapH(http.StripPrefix("/assets/", http.FileServer(http.FS(subOrEmpty(dist, "assets"))))))
	r.NoRoute(func(c *gin.Context) {
		if c.Request.Method != http.MethodGet && c.Request.Method != http.MethodHead {
			c.Status(http.StatusNotFound)
			return
		}
		if appOrigin != "" && renderOrigin != "" && hostMatchesOrigin(c.Request.Host, renderOrigin) && !hostMatchesOrigin(c.Request.Host, appOrigin) {
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
		c.Data(http.StatusOK, "text/html; charset=utf-8", index)
	})
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
