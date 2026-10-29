package server

import (
	"context"
	"net/http"
	"net/url"

	"github.com/mark3labs/mcp-go/mcp"
	mcpserver "github.com/mark3labs/mcp-go/server"
)

// registerMCPApprovalTools adds the owner's side of approvals: ask someone to approve a document, see who was asked
// and where it stands, and take a request back. Deciding (approve, reject, revoke) is deliberately not here: an approval vouches
// for a version, so it is made by the approver through the UI, the CLI or the API, not by an agent on their behalf.
// Each tool calls the same handler as the REST route, so every rule (owner only, viewer access, creators cannot be
// approvers) applies unchanged.
func registerMCPApprovalTools(server *mcpserver.MCPServer, api mcpAPIAdapter) {
	server.AddTool(mcp.NewTool("list_document_approvals", readOnlyOptions(
		mcp.WithDescription("List who was asked to approve a document and what each has decided on a version (the current one by default), with the derived status and each approver's open and total comment threads."),
		mcpDocumentID(),
		mcp.WithString("version_id", mcp.Description("Optional version to read the decisions of; defaults to the current version.")),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		doc, invalid := mcpRequired(request, "document_id")
		if invalid != nil {
			return invalid, nil
		}
		target := "/v1/documents/" + doc + "/approvals"
		if version := request.GetString("version_id", ""); version != "" {
			target += "?" + url.Values{"version": {version}}.Encode()
		}
		return api.get(ctx, target, mcpParams("id", doc), api.handlers.listApprovals)
	})

	server.AddTool(mcp.NewTool("list_document_approvers", readOnlyOptions(
		mcp.WithDescription("List the people and bots asked to approve a document, with each approval-request ID (apr_…) that remove_document_approver takes. For what they decided, use list_document_approvals."),
		mcpDocumentID(),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		doc, invalid := mcpRequired(request, "document_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.get(ctx, "/v1/documents/"+doc+"/approvers", mcpParams("id", doc), api.handlers.listApprovers)
	})

	server.AddTool(mcp.NewTool("request_document_approval", mutationOptions(false, false,
		mcp.WithDescription("Ask a person or bot to approve a document. Owner only. The approver needs at least viewer access (use share_document first) and must not have created a version of the document. Nothing notifies them: tell them yourself."),
		mcpDocumentID(),
		mcp.WithString("address", mcp.Required(), mcp.Description("User email or bot address.")),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		doc, invalid := mcpRequired(request, "document_id")
		if invalid != nil {
			return invalid, nil
		}
		address, invalid := mcpRequired(request, "address")
		if invalid != nil {
			return invalid, nil
		}
		return api.json(ctx, http.MethodPost, "/v1/documents/"+doc+"/approvers", map[string]any{"address": address}, mcpParams("id", doc), api.handlers.createApprover)
	})

	server.AddTool(mcp.NewTool("remove_document_approver", mutationOptions(true, true,
		mcp.WithDescription("Take an approval request back. Owner only. This also revokes every decision that approver made on the document."),
		mcpDocumentID(),
		mcp.WithString("approver_id", mcp.Required(), mcp.Description("Approval request ID (apr_…), from list_document_approvers or request_document_approval.")),
	)...), func(ctx context.Context, request mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		doc, invalid := mcpRequired(request, "document_id")
		if invalid != nil {
			return invalid, nil
		}
		approver, invalid := mcpRequired(request, "approver_id")
		if invalid != nil {
			return invalid, nil
		}
		return api.delete(ctx, "/v1/documents/"+doc+"/approvers/"+approver, mcpParams("id", doc, "approver_id", approver), api.handlers.deleteApprover)
	})
}
