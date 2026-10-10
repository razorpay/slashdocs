package server

import (
	"context"
	"net/http"
	"net/url"

	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"
)

func mcpFolderID() mcp.ToolOption {
	return mcp.WithString("folder_id", mcp.Required(), mcp.Description("Folder ID (fld_…)."))
}

func registerMCPFolderTools(server *mcpserver.MCPServer, api mcpAPIAdapter) {
	registerMCPFolderCRUDTools(server, api)
	registerMCPFolderAccessTools(server, api)
	registerMCPFolderMembershipTools(server, api)
}

func registerMCPFolderCRUDTools(server *mcpserver.MCPServer, api mcpAPIAdapter) {
	server.AddTool(mcp.NewTool("list_folders", readOnlyOptions(
		mcp.WithDescription("Browse the workspace root or a folder's contents by ID or path."),
		mcp.WithString("folder_id", mcp.Description("Folder whose contents should be listed.")),
		mcp.WithString("path", mcp.Description("Folder path, for example /Team/Reports.")),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		values := url.Values{}
		if folder := request.GetString("folder_id", ""); folder != "" {
			values.Set("folder_id", folder)
		}
		if path := request.GetString("path", ""); path != "" {
			values.Set("path", path)
		}
		target := "/v1/folders"
		if len(values) > 0 {
			target += "?" + values.Encode()
		}
		return api.get(ctx, target, nil, api.handlers.listFolders)
	})

	server.AddTool(mcp.NewTool("search_folders", readOnlyOptions(
		mcp.WithDescription("Search visible folders by title."),
		mcp.WithString("query", mcp.Required(), mcp.Description("Folder title search text.")),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		query, invalid := mcpRequired(request, "query")
		if invalid != nil {
			return invalid, nil
		}
		return api.get(ctx, "/v1/folders?q="+url.QueryEscape(query), nil, api.handlers.listFolders)
	})

	server.AddTool(mcp.NewTool("get_folder", readOnlyOptions(
		mcp.WithDescription("Get folder metadata and its visible ancestor breadcrumbs."), mcpFolderID(),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		folder, invalid := mcpRequired(request, "folder_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.get(ctx, "/v1/folders/"+folder, mcpParams("id", folder), api.handlers.getFolder)
	})

	server.AddTool(mcp.NewTool("create_folder", mutationOptions(false, false,
		mcp.WithDescription("Create a folder at the workspace root or below a parent folder."),
		mcp.WithString("title", mcp.Required(), mcp.Description("Folder title.")),
		mcp.WithString("parent_folder_id", mcp.Description("Optional parent folder ID.")),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		title, invalid := mcpRequired(request, "title")
		if invalid != nil {
			return invalid, nil
		}
		payload := map[string]any{"title": title}
		if parent := request.GetString("parent_folder_id", ""); parent != "" {
			payload["parent_folder_id"] = parent
		}
		return api.json(ctx, http.MethodPost, "/v1/folders", payload, nil, api.handlers.createFolder)
	})

	server.AddTool(mcp.NewTool("rename_folder", mutationOptions(true, true,
		mcp.WithDescription("Rename a folder without changing its contents or grants."),
		mcpFolderID(), mcp.WithString("title", mcp.Required(), mcp.Description("New folder title.")),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		folder, invalid := mcpRequired(request, "folder_id")
		if invalid != nil {
			return invalid, nil
		}
		title, invalid := mcpRequired(request, "title")
		if invalid != nil {
			return invalid, nil
		}
		return api.json(ctx, http.MethodPatch, "/v1/folders/"+folder, map[string]any{"title": title}, mcpParams("id", folder), api.handlers.patchFolder)
	})

	server.AddTool(mcp.NewTool("move_folder", mutationOptions(true, true,
		mcp.WithDescription("Move a folder under a new parent, or to the workspace root by omitting parent_folder_id."),
		mcpFolderID(), mcp.WithString("parent_folder_id", mcp.Description("New parent folder ID; omit for root.")),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		folder, invalid := mcpRequired(request, "folder_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.json(ctx, http.MethodPatch, "/v1/folders/"+folder, map[string]any{"parent_folder_id": request.GetString("parent_folder_id", "")}, mcpParams("id", folder), api.handlers.patchFolder)
	})

	server.AddTool(mcp.NewTool("delete_folder", mutationOptions(true, true,
		mcp.WithDescription("Permanently delete a folder and its subfolders."), mcpFolderID(),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		folder, invalid := mcpRequired(request, "folder_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.delete(ctx, "/v1/folders/"+folder, mcpParams("id", folder), api.handlers.deleteFolder)
	})
}

func registerMCPFolderAccessTools(server *mcpserver.MCPServer, api mcpAPIAdapter) {
	server.AddTool(mcp.NewTool("list_folder_access", readOnlyOptions(
		mcp.WithDescription("List effective access to a folder and the grants that provide it."), mcpFolderID(),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		folder, invalid := mcpRequired(request, "folder_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.get(ctx, "/v1/folders/"+folder+"/access", mcpParams("id", folder), api.handlers.folderAccess)
	})

	server.AddTool(mcp.NewTool("share_folder", mutationOptions(false, false,
		mcp.WithDescription("Grant folder access to an email/bot address or to everyone. Requires the owner role. Pass exactly one of address or everyone=true."),
		mcpFolderID(),
		mcp.WithString("address", mcp.Description("User email or bot address.")),
		mcp.WithBoolean("everyone", mcp.Description("Grant access to everyone who can reach the server.")),
		mcp.WithString("role", mcp.Description("Role to grant."), mcp.Enum("viewer", "commenter", "editor"), mcp.DefaultString("viewer")),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		folder, invalid := mcpRequired(request, "folder_id")
		if invalid != nil {
			return invalid, nil
		}
		payload, invalid := mcpGrantPayload(request)
		if invalid != nil {
			return invalid, nil
		}
		return api.json(ctx, http.MethodPost, "/v1/folders/"+folder+"/grants", payload, mcpParams("id", folder), api.handlers.createFolderGrant)
	})

	server.AddTool(mcp.NewTool("update_folder_grant", mutationOptions(true, true,
		mcp.WithDescription("Change an existing folder grant's role. Requires the owner role."),
		mcpFolderID(),
		mcp.WithString("grant_id", mcp.Required(), mcp.Description("Grant ID.")),
		mcp.WithString("role", mcp.Required(), mcp.Enum("viewer", "commenter", "editor")),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		folder, invalid := mcpRequired(request, "folder_id")
		if invalid != nil {
			return invalid, nil
		}
		grant, invalid := mcpRequired(request, "grant_id")
		if invalid != nil {
			return invalid, nil
		}
		role, invalid := mcpRequired(request, "role")
		if invalid != nil {
			return invalid, nil
		}
		return api.json(ctx, http.MethodPatch, "/v1/folders/"+folder+"/grants/"+grant, map[string]any{"role": role}, mcpParams("id", folder, "grant_id", grant), api.handlers.patchFolderGrant)
	})

	server.AddTool(mcp.NewTool("revoke_folder_grant", mutationOptions(true, true,
		mcp.WithDescription("Revoke an existing folder grant. Requires the owner role, except for the caller's own grant, which they may always revoke to leave the folder."),
		mcpFolderID(), mcp.WithString("grant_id", mcp.Required(), mcp.Description("Grant ID.")),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		folder, invalid := mcpRequired(request, "folder_id")
		if invalid != nil {
			return invalid, nil
		}
		grant, invalid := mcpRequired(request, "grant_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.delete(ctx, "/v1/folders/"+folder+"/grants/"+grant, mcpParams("id", folder, "grant_id", grant), api.handlers.deleteFolderGrant)
	})
}

func registerMCPFolderMembershipTools(server *mcpserver.MCPServer, api mcpAPIAdapter) {
	server.AddTool(mcp.NewTool("list_folder_documents", readOnlyOptions(
		mcp.WithDescription("List documents directly contained in a folder."), mcpFolderID(),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		folder, invalid := mcpRequired(request, "folder_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.get(ctx, "/v1/folders/"+folder+"/documents", mcpParams("id", folder), api.handlers.listFolderDocs)
	})

	server.AddTool(mcp.NewTool("move_document_to_folder", mutationOptions(true, true,
		mcp.WithDescription("Move a document into a folder."), mcpFolderID(), mcpDocumentID(),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		folder, invalid := mcpRequired(request, "folder_id")
		if invalid != nil {
			return invalid, nil
		}
		document, invalid := mcpRequired(request, "document_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.json(ctx, http.MethodPost, "/v1/folders/"+folder+"/documents", map[string]any{"document_id": document}, mcpParams("id", folder), api.handlers.moveDocToFolder)
	})

	server.AddTool(mcp.NewTool("move_document_to_root", mutationOptions(true, true,
		mcp.WithDescription("Move a document out of its current folder to the workspace root."), mcpFolderID(), mcpDocumentID(),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		folder, invalid := mcpRequired(request, "folder_id")
		if invalid != nil {
			return invalid, nil
		}
		document, invalid := mcpRequired(request, "document_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.delete(ctx, "/v1/folders/"+folder+"/documents/"+document, mcpParams("id", folder, "doc_id", document), api.handlers.moveDocToRoot)
	})
}
