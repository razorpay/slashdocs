package server

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"
)

func mcpBookID() mcp.ToolOption {
	return mcp.WithString("book_id", mcp.Required(), mcp.Description("Book ID (book_…). get_folder_book finds it from a folder ID."))
}

// mcpBookEditorOnly ends the description of a tool that needs the editor
// role on the book's folder. Other callers get 404, or 403 if they can view
// the folder.
const mcpBookEditorOnly = " Requires editor access to the book's folder."

// registerMCPBookTools exposes book mode; it is called only when book mode
// is on. The tools call the same handlers as the REST routes, so the access
// checks (and the feature flag) still apply.
func registerMCPBookTools(server *mcpserver.MCPServer, api mcpAPIAdapter) {
	server.AddTool(mcp.NewTool("create_book", mutationOptions(false, false,
		mcp.WithDescription("Make a folder a book. The outline is seeded from the folder's numbered document titles; the result lists the documents placed and those not in the outline. "+
			"If the folder already is a book, the book_exists error carries its book_id in error.details. Requires editor access to the folder."),
		mcpFolderID(),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		folder, invalid := mcpRequired(request, "folder_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.json(ctx, http.MethodPost, "/v1/folders/"+folder+"/book", map[string]any{}, mcpParams("id", folder), api.handlers.createBook)
	})

	server.AddTool(mcp.NewTool("get_folder_book", readOnlyOptions(
		mcp.WithDescription("Find the book made from a folder. Returns its book_id; not_found when the folder is not a book. Requires viewer access to the folder."),
		mcpFolderID(),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		folder, invalid := mcpRequired(request, "folder_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.get(ctx, "/v1/folders/"+folder+"/book", mcpParams("id", folder), api.handlers.folderBook)
	})

	addMCPBookTool(server, api, mcp.NewTool("get_book", readOnlyOptions(
		mcp.WithDescription("Get a book's manifest as a reader sees it: metadata (identifier is the book_id), reading order and table of contents. "+
			"It lists only the chapters you can open, plus placeholders. Any reader can call it; the other book tools need editor access."),
		mcpBookID(),
	)...), http.MethodGet, "", api.handlers.getManifest)

	addMCPBookTool(server, api, mcp.NewTool("get_book_outline", readOnlyOptions(
		mcp.WithDescription("Get a book's current outline with its version_id, the folder documents not in the outline, and removed chapters. "+
			"To edit, change the outline field and send it to update_book_outline with this version_id as base_version_id."+mcpBookEditorOnly),
		mcpBookID(),
	)...), http.MethodGet, "/outline", api.handlers.getOutline)

	server.AddTool(mcp.NewTool("update_book_outline", mutationOptions(false, false,
		mcp.WithDescription("Save a new outline version; earlier versions are kept. base_version_id must be the version_id from get_book_outline. "+
			"On outline_conflict, error.details.current_version_id names the newer version: get the outline again and re-apply the change. "+
			"On invalid_outline, error.details.problems lists every problem with its path."+mcpBookEditorOnly),
		mcpBookID(),
		mcp.WithString("base_version_id", mcp.Required(), mcp.Description("The version_id (bov_…) from get_book_outline that this edit is based on.")),
		mcp.WithObject("outline", mcp.Required(), mcp.Description("The full outline: send only the outline field from get_book_outline, not not_in_outline or removed. "+
			"Shape: {title, subtitle (optional), front: [entry], parts: [{title, chapters: [entry]}], back: [entry]}. "+
			"Each entry is {\"doc\": document ID (doc_…) of a document in the book's folder} or {\"planned\": title of a placeholder chapter}. Never put a title in doc.")),
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

	addMCPBookTool(server, api, mcp.NewTool("get_book_status", readOnlyOptions(
		mcp.WithDescription("List every outline entry with its number, title, document ID and current version, marking placeholders, "+
			"then the folder documents not in the outline and the removed chapters."+mcpBookEditorOnly),
		mcpBookID(),
	)...), http.MethodGet, "/status", api.handlers.bookStatus)

	addMCPBookTool(server, api, mcp.NewTool("delete_book", mutationOptions(true, true,
		mcp.WithDescription("Permanently delete a book and all its outline versions; this cannot be undone. Readers' saved places in the book go too. "+
			"The folder, its documents and readers' chapter progress stay."+mcpBookEditorOnly),
		mcpBookID(),
	)...), http.MethodDelete, "", api.handlers.deleteBook)
}

// addMCPBookTool adds a tool whose only argument is book_id and which calls
// GET or DELETE on /v1/books/{book_id}{suffix}.
func addMCPBookTool(server *mcpserver.MCPServer, api mcpAPIAdapter, tool mcp.Tool, method, suffix string, handler gin.HandlerFunc) {
	server.AddTool(tool, func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		book, invalid := mcpRequired(request, "book_id")
		if invalid != nil {
			return invalid, nil
		}
		target, params := "/v1/books/"+book+suffix, mcpParams("id", book)
		if method == http.MethodDelete {
			return api.delete(ctx, target, params, handler)
		}
		return api.get(ctx, target, params, handler)
	})
}
