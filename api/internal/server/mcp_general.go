package server

import (
	"context"
	"fmt"
	"strings"

	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"

	"github.com/razorpay/slashdocs/internal/guidelines"
)

func registerMCPGeneralTools(server *mcpserver.MCPServer, api mcpAPIAdapter) {
	server.AddTool(mcp.NewTool(
		"whoami",
		readOnlyOptions(mcp.WithDescription("Return the authenticated slashdocs principal used by this MCP connection."))...,
	), func(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return api.get(ctx, "/v1/me", nil, api.handlers.me)
	})

	server.AddTool(mcp.NewTool(
		"get_server_config",
		readOnlyOptions(mcp.WithDescription("Return this slashdocs server's deployment mode, organisation label, and public configuration."))...,
	), func(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return api.get(ctx, "/v1/config", nil, api.handlers.config)
	})

	server.AddTool(mcp.NewTool(
		"get_authoring_guidelines",
		readOnlyOptions(
			mcp.WithDescription("Return the slashdocs single-file HTML authoring and publishing guidelines. Call without arguments for the section index, then fetch the sections relevant to your task; read at least the core section before creating or updating a document."),
			mcp.WithString("section", mcp.Description("Guidelines section path from the index, e.g. \"core\", \"rendering theme\", or \"all\" for every section. Omit for the index.")),
		)...,
	), func(_ context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return mcpGuidelineResult(request.GetString("section", "")), nil
	})
}

// mcpGuidelineResult mirrors the CLI's `slashdocs guidelines` progressive
// disclosure over the shared guidelines source: an index by default, one page
// per section path, and "all" for the full dump. Pages reference sibling
// sections as CLI commands, so each one carries a translation footer.
func mcpGuidelineResult(section string) *mcp.CallToolResult {
	path := guidelines.NormalizePath(strings.Fields(section))
	if len(path) == 0 {
		return mcp.NewToolResultText(mcpGuidelineIndex())
	}
	if len(path) == 1 && path[0] == "all" {
		var b strings.Builder
		b.WriteString(mcpGuidelineIndex())
		for _, p := range guidelines.Pages {
			b.WriteString("\n---\n\n")
			b.WriteString(p.Body)
		}
		return mcp.NewToolResultText(b.String())
	}
	if p, ok := guidelines.Find(path); ok {
		return mcp.NewToolResultText(p.Body + mcpGuidelineFooter)
	}
	return mcp.NewToolResultError(fmt.Sprintf("unknown guidelines section %q; available sections:\n%s", section, mcpGuidelineSectionList()))
}

const mcpGuidelineFooter = "\nAny `slashdocs guidelines <path>` reference above is a section of this tool: call get_authoring_guidelines with section=\"<path>\".\n"

func mcpGuidelineIndex() string {
	var b strings.Builder
	b.WriteString("slashdocs document authoring guidelines\n\n")
	b.WriteString("Fetch a section for details by calling get_authoring_guidelines with its path:\n")
	for _, p := range guidelines.Pages {
		fmt.Fprintf(&b, "  section=%-22q %s\n", strings.Join(p.Path, " "), p.Summary)
	}
	b.WriteString("\nsection=\"all\" returns every section at once.\n")
	return b.String()
}

func mcpGuidelineSectionList() string {
	lines := make([]string, 0, len(guidelines.Pages)+1)
	for _, p := range guidelines.Pages {
		lines = append(lines, "  "+strings.Join(p.Path, " "))
	}
	lines = append(lines, "  all")
	return strings.Join(lines, "\n")
}
