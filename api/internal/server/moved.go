package server

import (
	"context"
	"net/http"
	"slices"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"
)

// movedOriginMiddleware serves requests that arrive on a previous app origin
// of this deployment. Browsers, the CLI, and scripts get a permanent redirect
// to the same path on the app origin. MCP clients do not send their
// credentials across a redirect and do not save a new URL, so /mcp serves a
// small MCP server that tells the agent the new URL instead.
func movedOriginMiddleware(appOrigin string, previousOrigins []string) gin.HandlerFunc {
	appOrigin = strings.TrimRight(appOrigin, "/")
	movedMCP := newMovedMCPHandler(appOrigin + "/mcp")
	return func(c *gin.Context) {
		if !slices.ContainsFunc(previousOrigins, func(origin string) bool { return hostMatchesOrigin(c.Request.Host, origin) }) {
			return
		}
		if c.Request.URL.Path == "/mcp" {
			movedMCP.ServeHTTP(c.Writer, c.Request)
		} else {
			c.Redirect(http.StatusPermanentRedirect, appOrigin+c.Request.URL.RequestURI())
		}
		c.Abort()
	}
}

// newMovedMCPHandler is an unauthenticated MCP server with one tool. Its
// instructions and the tool tell the agent where the server moved.
func newMovedMCPHandler(mcpURL string) http.Handler {
	notice := "This slashdocs MCP server moved to " + mcpURL + ". This URL no longer serves documents. " +
		"Tell the user to change the MCP server URL to " + mcpURL + " in their MCP client settings and sign in again."
	protocol := mcpserver.NewMCPServer("slashdocs", BuildVersion,
		mcpserver.WithToolCapabilities(false),
		mcpserver.WithInstructions(notice),
	)
	protocol.AddTool(
		mcp.NewTool("server_moved", readOnlyOptions(mcp.WithDescription(notice))...),
		func(context.Context, mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			return mcp.NewToolResultText(notice), nil
		},
	)
	transport := mcpserver.NewStreamableHTTPServer(protocol, mcpserver.WithStateLess(true), mcpserver.WithDisableStreaming(true))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			transport.ServeHTTP(w, r)
			return
		}
		// An agent that inspects the URL with curl or a browser reads this.
		http.Error(w, notice, http.StatusGone)
	})
}
