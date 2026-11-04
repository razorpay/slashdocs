package server

import (
	"context"
	"net/http"

	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"
)

func mcpBookID() mcp.ToolOption {
	return mcp.WithString("book_id", mcp.Required(), mcp.Description("Book ID (book_…)."))
}

// registerMCPBookTools exposes book mode. The tools call the same handlers as
// the REST routes, so the books feature flag and access checks still apply.
func registerMCPBookTools(server *mcpserver.MCPServer, api mcpAPIAdapter) {
	server.AddTool(mcp.NewTool("create_book", mutationOptions(false, false,
		mcp.WithDescription("Make a folder a book. The outline is seeded from the folder's numbered document titles."),
		mcpFolderID(),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		folder, invalid := mcpRequired(request, "folder_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.json(ctx, http.MethodPost, "/v1/folders/"+folder+"/book", map[string]any{}, mcpParams("id", folder), api.handlers.createBook)
	})

	server.AddTool(mcp.NewTool("get_book", readOnlyOptions(
		mcp.WithDescription("Get a book's manifest: metadata, reading order and table of contents."), mcpBookID(),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		book, invalid := mcpRequired(request, "book_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.get(ctx, "/v1/books/"+book, mcpParams("id", book), api.handlers.getManifest)
	})

	server.AddTool(mcp.NewTool("get_book_outline", readOnlyOptions(
		mcp.WithDescription("Get a book's current outline and its version_id. Pass that version_id as base_version_id to update_book_outline."), mcpBookID(),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		book, invalid := mcpRequired(request, "book_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.get(ctx, "/v1/books/"+book+"/outline", mcpParams("id", book), api.handlers.getOutline)
	})

	server.AddTool(mcp.NewTool("update_book_outline", mutationOptions(false, false,
		mcp.WithDescription("Save a new outline version. base_version_id must be the current version from get_book_outline; on outline_conflict, fetch the outline again and re-apply the change."),
		mcpBookID(),
		mcp.WithString("base_version_id", mcp.Required(), mcp.Description("Outline version this edit is based on.")),
		mcp.WithObject("outline", mcp.Required(), mcp.Description("The full outline object: title, front, parts[{title, chapters[{doc|planned}]}], back.")),
		mcp.WithString("note", mcp.Description("Short note describing the change (500 characters or fewer).")),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		book, invalid := mcpRequired(request, "book_id")
		if invalid != nil {
			return invalid, nil
		}
		base, invalid := mcpRequired(request, "base_version_id")
		if invalid != nil {
			return invalid, nil
		}
		outline, ok := request.GetArguments()["outline"].(map[string]any)
		if !ok {
			return mcp.NewToolResultError("outline is required and must be an object"), nil
		}
		payload := map[string]any{"base_version_id": base, "outline": outline, "note": request.GetString("note", "")}
		return api.json(ctx, http.MethodPut, "/v1/books/"+book+"/outline", payload, mcpParams("id", book), api.handlers.putOutline)
	})

	server.AddTool(mcp.NewTool("get_book_status", readOnlyOptions(
		mcp.WithDescription("Show which chapters are missing, removed or not yet in the outline."), mcpBookID(),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		book, invalid := mcpRequired(request, "book_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.get(ctx, "/v1/books/"+book+"/status", mcpParams("id", book), api.handlers.bookStatus)
	})

	server.AddTool(mcp.NewTool("delete_book", mutationOptions(true, true,
		mcp.WithDescription("Delete a book's outline and reading state. The documents and folder stay."), mcpBookID(),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		book, invalid := mcpRequired(request, "book_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.delete(ctx, "/v1/books/"+book, mcpParams("id", book), api.handlers.deleteBook)
	})
}
