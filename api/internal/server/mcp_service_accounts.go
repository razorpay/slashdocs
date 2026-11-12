package server

import (
	"context"
	"net/http"

	"github.com/gin-gonic/gin"
	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"
)

func mcpServiceAccountID() mcp.ToolOption {
	return mcp.WithString("service_account_id", mcp.Required(), mcp.Description("Service account ID (sa_…)."))
}

func registerMCPServiceAccountTools(server *mcpserver.MCPServer, api mcpAPIAdapter) {
	registerMCPServiceAccountCRUDTools(server, api)
	registerMCPServiceAccountKeyTools(server, api)
	registerMCPServiceAccountTransferTools(server, api)
}

func registerMCPServiceAccountCRUDTools(server *mcpserver.MCPServer, api mcpAPIAdapter) {
	server.AddTool(mcp.NewTool("list_service_accounts", readOnlyOptions(
		mcp.WithDescription("List service accounts owned by the authenticated user."),
	)...), func(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return api.get(ctx, "/v1/service-accounts", nil, api.handlers.listServiceAccounts)
	})

	server.AddTool(mcp.NewTool("update_service_account", mutationOptions(true, true,
		mcp.WithDescription("Rename, enable, or disable a service account."),
		mcpServiceAccountID(),
		mcp.WithString("name", mcp.Description("New label, or full address ending in .bot.")),
		mcp.WithBoolean("disabled", mcp.Description("Set true to disable or false to enable.")),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, invalid := mcpRequired(request, "service_account_id")
		if invalid != nil {
			return invalid, nil
		}
		payload := map[string]any{}
		if name := request.GetString("name", ""); name != "" {
			payload["name"] = name
		}
		if _, present := request.GetArguments()["disabled"]; present {
			payload["disabled"] = request.GetBool("disabled", false)
		}
		if len(payload) == 0 {
			return mcp.NewToolResultError("pass name and/or disabled"), nil
		}
		return api.json(ctx, http.MethodPatch, "/v1/service-accounts/"+id, payload, mcpParams("id", id), api.handlers.patchServiceAccount)
	})
}

func registerMCPServiceAccountKeyTools(server *mcpserver.MCPServer, api mcpAPIAdapter) {
	server.AddTool(mcp.NewTool("list_service_account_keys", readOnlyOptions(
		mcp.WithDescription("List key metadata for a service account. Secret tokens are never returned after creation."),
		mcpServiceAccountID(),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, invalid := mcpRequired(request, "service_account_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.get(ctx, "/v1/service-accounts/"+id+"/keys", mcpParams("id", id), api.handlers.listServiceAccountKeys)
	})

	server.AddTool(mcp.NewTool("revoke_service_account_key", mutationOptions(true, true,
		mcp.WithDescription("Permanently revoke a service-account bearer key."),
		mcpServiceAccountID(),
		mcp.WithString("key_id", mcp.Required(), mcp.Description("Key ID (sak_…).")),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, invalid := mcpRequired(request, "service_account_id")
		if invalid != nil {
			return invalid, nil
		}
		key, invalid := mcpRequired(request, "key_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.delete(ctx, "/v1/service-accounts/"+id+"/keys/"+key, mcpParams("id", id, "key_id", key), api.handlers.revokeServiceAccountKey)
	})
}

func registerMCPServiceAccountTransferTools(server *mcpserver.MCPServer, api mcpAPIAdapter) {
	server.AddTool(mcp.NewTool("list_service_account_transfers", readOnlyOptions(
		mcp.WithDescription("List incoming service-account ownership transfers."),
	)...), func(ctx context.Context, _ mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		return api.get(ctx, "/v1/service-accounts/transfers", nil, api.handlers.listOwnershipTransfers)
	})

	server.AddTool(mcp.NewTool("create_service_account_transfer", mutationOptions(false, false,
		mcp.WithDescription("Request transfer of a service account to another slashdocs user."),
		mcpServiceAccountID(),
		mcp.WithString("to_user_email", mcp.Required(), mcp.Description("Recipient's slashdocs user email.")),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		id, invalid := mcpRequired(request, "service_account_id")
		if invalid != nil {
			return invalid, nil
		}
		email, invalid := mcpRequired(request, "to_user_email")
		if invalid != nil {
			return invalid, nil
		}
		return api.json(ctx, http.MethodPost, "/v1/service-accounts/"+id+"/transfer", map[string]any{"to_user_email": email}, mcpParams("id", id), api.handlers.createOwnershipTransfer)
	})

	for _, definition := range []struct {
		name, action, description string
		handler                   func(*gin.Context)
		destructive               bool
	}{
		{"accept_service_account_transfer", "accept", "Accept an incoming service-account ownership transfer.", api.handlers.acceptOwnershipTransfer, true},
		{"decline_service_account_transfer", "decline", "Decline an incoming service-account ownership transfer.", api.handlers.declineOwnershipTransfer, true},
	} {
		server.AddTool(mcp.NewTool(definition.name, mutationOptions(definition.destructive, true,
			mcp.WithDescription(definition.description),
			mcp.WithString("transfer_id", mcp.Required(), mcp.Description("Ownership transfer ID.")),
		)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			id, invalid := mcpRequired(request, "transfer_id")
			if invalid != nil {
				return invalid, nil
			}
			return api.json(ctx, http.MethodPost, "/v1/service-accounts/transfers/"+id+"/"+definition.action, map[string]any{}, mcpParams("id", id), definition.handler)
		})
	}
}
