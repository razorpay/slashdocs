package server_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/mark3labs/mcp-go/mcp"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
	"github.com/razorpay/slashdocs/api/internal/server"
)

var expectedMCPTools = []string{
	"accept_service_account_transfer",
	"create_comment",
	"create_document",
	"create_folder",
	"create_service_account_transfer",
	"decline_service_account_transfer",
	"delete_comment",
	"delete_document",
	"delete_folder",
	"edit_document",
	"get_authoring_guidelines",
	"get_document",
	"get_document_html",
	"get_document_version",
	"get_folder",
	"get_server_config",
	"list_comments",
	"list_document_access",
	"list_document_versions",
	"list_documents",
	"list_folder_access",
	"list_folder_documents",
	"list_folders",
	"list_service_account_keys",
	"list_service_account_transfers",
	"list_service_accounts",
	"move_document",
	"move_document_to_folder",
	"move_document_to_root",
	"move_folder",
	"react_comment",
	"rename_document",
	"rename_folder",
	"reopen_comment",
	"reply_comment",
	"request_document_access",
	"resolve_comment",
	"revoke_document_grant",
	"revoke_folder_grant",
	"revoke_service_account_key",
	"search_folders",
	"share_document",
	"share_folder",
	"unreact_comment",
	"update_comment",
	"update_document",
	"update_document_grant",
	"update_folder_grant",
	"update_service_account",
	"whoami",
}

func TestMCPStreamableHTTPInitializeListAndCall(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	token := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)

	initialize := mcpPost(t, e, token, "", map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize",
		"params": map[string]any{
			"protocolVersion": mcp.LATEST_PROTOCOL_VERSION,
			"capabilities":    map[string]any{},
			"clientInfo":      map[string]any{"name": "slashdocs-test", "version": "1"},
		},
	})
	assertStatus(t, initialize, http.StatusOK)
	if got := initialize.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
		t.Fatalf("initialize Content-Type = %q, want application/json", got)
	}
	if got := initialize.Header().Get("Mcp-Session-Id"); got != "" {
		t.Fatalf("stateless MCP returned session id %q", got)
	}
	var initialized struct {
		Result struct {
			ProtocolVersion string `json:"protocolVersion"`
			Capabilities    struct {
				Tools any `json:"tools"`
			} `json:"capabilities"`
			ServerInfo struct {
				Name string `json:"name"`
			} `json:"serverInfo"`
			Instructions string `json:"instructions"`
		} `json:"result"`
	}
	decodeMCPResponse(t, initialize, &initialized)
	if initialized.Result.ProtocolVersion != mcp.LATEST_PROTOCOL_VERSION || initialized.Result.ServerInfo.Name != "slashdocs" || initialized.Result.Capabilities.Tools == nil || !strings.Contains(initialized.Result.Instructions, "formerly named aidocs") {
		t.Fatalf("initialize result = %#v", initialized.Result)
	}

	notification := mcpPost(t, e, token, "", map[string]any{
		"jsonrpc": "2.0", "method": "notifications/initialized",
	})
	assertStatus(t, notification, http.StatusAccepted)
	if notification.Body.Len() != 0 {
		t.Fatalf("initialized notification body = %q, want empty", notification.Body.String())
	}

	listed := mcpPost(t, e, token, "", map[string]any{
		"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": map[string]any{},
	})
	assertStatus(t, listed, http.StatusOK)
	var listResponse struct {
		Result struct {
			Tools []struct {
				Name        string         `json:"name"`
				Description string         `json:"description"`
				InputSchema map[string]any `json:"inputSchema"`
				Annotations *struct {
					ReadOnlyHint    *bool `json:"readOnlyHint"`
					DestructiveHint *bool `json:"destructiveHint"`
					IdempotentHint  *bool `json:"idempotentHint"`
					OpenWorldHint   *bool `json:"openWorldHint"`
				} `json:"annotations"`
			} `json:"tools"`
		} `json:"result"`
	}
	decodeMCPResponse(t, listed, &listResponse)
	gotNames := make([]string, 0, len(listResponse.Result.Tools))
	destructiveTools := map[string]bool{
		"accept_service_account_transfer":  true,
		"decline_service_account_transfer": true,
		"delete_comment":                   true,
		"delete_document":                  true,
		"delete_folder":                    true,
		"move_document":                    true,
		"move_document_to_folder":          true,
		"move_document_to_root":            true,
		"move_folder":                      true,
		"rename_document":                  true,
		"rename_folder":                    true,
		"reopen_comment":                   true,
		"resolve_comment":                  true,
		"revoke_document_grant":            true,
		"revoke_folder_grant":              true,
		"revoke_service_account_key":       true,
		"update_comment":                   true,
		"update_document_grant":            true,
		"update_folder_grant":              true,
		"update_service_account":           true,
	}
	for _, tool := range listResponse.Result.Tools {
		gotNames = append(gotNames, tool.Name)
		if tool.Description == "" || tool.InputSchema["type"] != "object" {
			t.Errorf("tool %q has incomplete description/schema: %#v", tool.Name, tool)
		}
		if tool.Annotations == nil || tool.Annotations.ReadOnlyHint == nil || tool.Annotations.DestructiveHint == nil ||
			tool.Annotations.IdempotentHint == nil || tool.Annotations.OpenWorldHint == nil {
			t.Errorf("tool %q does not declare all safety annotations: %#v", tool.Name, tool.Annotations)
		}
		if tool.Annotations != nil && tool.Annotations.DestructiveHint != nil {
			if got, want := *tool.Annotations.DestructiveHint, destructiveTools[tool.Name]; got != want {
				t.Errorf("tool %q destructiveHint = %t, want %t", tool.Name, got, want)
			}
		}
	}
	sort.Strings(gotNames)
	if strings.Join(gotNames, "\n") != strings.Join(expectedMCPTools, "\n") {
		t.Fatalf("tools/list mismatch\n got: %v\nwant: %v", gotNames, expectedMCPTools)
	}

	whoami := callMCPToolHTTP(t, e, token, "whoami", map[string]any{})
	if whoami.IsError || !strings.Contains(whoami.Text, fixtureUser.ID) || !strings.Contains(whoami.Text, fixtureUser.Email) {
		t.Fatalf("whoami result = %#v, want authenticated user", whoami)
	}

	invalid := callMCPToolHTTP(t, e, token, "get_document", map[string]any{})
	if !invalid.IsError || !strings.Contains(invalid.Text, "document_id") {
		t.Fatalf("invalid get_document result = %#v, want actionable tool error", invalid)
	}
}

func TestMCPAuthenticationInfrastructureFailureIsServerError(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	token := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)
	e.store.Pool().Close()
	body := marshalMCP(t, map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize",
		"params": map[string]any{
			"protocolVersion": mcp.LATEST_PROTOCOL_VERSION,
			"capabilities":    map[string]any{},
			"clientInfo":      map[string]any{"name": "auth-failure-test", "version": "1"},
		},
	})

	rr := rawMCPRequest(t, e, http.MethodPost, token, "", body, "application/json", true)
	assertStatus(t, rr, http.StatusInternalServerError)
	if rr.Header().Get("WWW-Authenticate") != "" {
		t.Fatalf("infrastructure failure returned an authentication challenge: %q", rr.Header().Get("WWW-Authenticate"))
	}
	if !strings.Contains(rr.Body.String(), `"code":"internal"`) {
		t.Fatalf("infrastructure failure body = %s, want sanitized internal error", rr.Body.String())
	}
}

func TestMCPHTTPTransportSecurityAndMalformedInput(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	token := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)
	initializeBody := marshalMCP(t, map[string]any{
		"jsonrpc": "2.0", "id": 1, "method": "initialize",
		"params": map[string]any{
			"protocolVersion": mcp.LATEST_PROTOCOL_VERSION,
			"capabilities":    map[string]any{},
			"clientInfo":      map[string]any{"name": "security-test", "version": "1"},
		},
	})

	t.Run("missing bearer gets OAuth discovery challenge before parsing", func(t *testing.T) {
		rr := do(t, e.h, http.MethodPost, "/mcp", "not-json", map[string]string{
			"Content-Type": "application/json", "Cookie": e.cookie,
		})
		assertStatus(t, rr, http.StatusUnauthorized)
		want := `Bearer resource_metadata="https://app.example/.well-known/oauth-protected-resource/mcp"`
		if got := rr.Header().Get("WWW-Authenticate"); got != want {
			t.Fatalf("WWW-Authenticate = %q, want %q", got, want)
		}
	})

	t.Run("CLI bearer is rejected", func(t *testing.T) {
		cliToken, cliHash, err := auth.NewBearerToken("slashdocs_cli_")
		if err != nil {
			t.Fatal(err)
		}
		if _, err := e.store.CreateCLICredential(t.Context(), fixtureUser.ID, "mcp-rejection", cliHash); err != nil {
			t.Fatalf("create CLI credential: %v", err)
		}
		rr := rawMCPRequest(t, e, http.MethodPost, cliToken, "", initializeBody, "application/json", true)
		assertStatus(t, rr, http.StatusUnauthorized)
	})

	t.Run("hostile Origin is rejected", func(t *testing.T) {
		rr := rawMCPRequest(t, e, http.MethodPost, token, "https://attacker.example", initializeBody, "application/json", true)
		assertStatus(t, rr, http.StatusForbidden)
	})

	t.Run("configured Origin is accepted", func(t *testing.T) {
		rr := rawMCPRequest(t, e, http.MethodPost, token, mcpTestOrigin, initializeBody, "application/json", true)
		assertStatus(t, rr, http.StatusOK)
	})

	t.Run("invalid JSON returns JSON-RPC parse error", func(t *testing.T) {
		rr := rawMCPRequest(t, e, http.MethodPost, token, "", "not-json", "application/json", true)
		assertStatus(t, rr, http.StatusBadRequest)
		if !strings.Contains(rr.Body.String(), `"code":-32700`) {
			t.Fatalf("parse error body = %s", rr.Body.String())
		}
	})

	t.Run("wrong content type is rejected", func(t *testing.T) {
		rr := rawMCPRequest(t, e, http.MethodPost, token, "", initializeBody, "text/plain", true)
		assertStatus(t, rr, http.StatusBadRequest)
	})

	t.Run("oversized body is rejected before the MCP library", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader("{}"))
		req.ContentLength = (301 << 20) + 1
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		req.Header.Set("Mcp-Protocol-Version", mcp.LATEST_PROTOCOL_VERSION)
		rr := httptest.NewRecorder()
		e.h.ServeHTTP(rr, req)
		assertStatus(t, rr, http.StatusRequestEntityTooLarge)
	})

	t.Run("GET streaming is disabled", func(t *testing.T) {
		rr := rawMCPRequest(t, e, http.MethodGet, token, "", "", "", true)
		assertStatus(t, rr, http.StatusMethodNotAllowed)
	})

	t.Run("unsupported HTTP method is not routed as a protocol request", func(t *testing.T) {
		rr := rawMCPRequest(t, e, http.MethodPut, token, "", "", "", true)
		assertStatus(t, rr, http.StatusNotFound)
	})

	t.Run("unsupported protocol version is rejected", func(t *testing.T) {
		rr := rawMCPRequestWithProtocol(t, e, http.MethodPost, token, "", marshalMCP(t, map[string]any{
			"jsonrpc": "2.0", "id": 9, "method": "tools/list", "params": map[string]any{},
		}), "application/json", true, "1900-01-01")
		assertStatus(t, rr, http.StatusBadRequest)
	})

	t.Run("POST requires an MCP Accept header", func(t *testing.T) {
		rr := rawMCPRequest(t, e, http.MethodPost, token, "", initializeBody, "application/json", false)
		assertStatus(t, rr, http.StatusBadRequest)
	})
}

func TestMCPDocumentAndFolderToolParity(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	token := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)

	for _, call := range []struct {
		name string
		args map[string]any
		want string
	}{
		{"whoami", map[string]any{}, fixtureUser.Email},
		{"get_server_config", map[string]any{}, "deployment"},
		{"get_authoring_guidelines", map[string]any{}, "single-file HTML contract"},
		{"list_documents", map[string]any{}, "items"},
		{"list_folders", map[string]any{}, "items"},
	} {
		assertMCPToolOK(t, callMCPToolHTTP(t, e, token, call.name, call.args), call.want)
	}

	created := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "create_document", map[string]any{
		"title": "MCP parity document", "html": "<html><body>first version</body></html>",
	}), "current_version_id"))
	docID := requiredMCPString(t, created, "id")
	versionID := requiredMCPString(t, created, "current_version_id")

	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "get_document", map[string]any{"document_id": docID}), docID)
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "rename_document", map[string]any{
		"document_id": docID, "title": "Renamed through MCP",
	}), "Renamed through MCP")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "list_document_versions", map[string]any{"document_id": docID}), versionID)
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "get_document_version", map[string]any{
		"document_id": docID, "version_id": versionID,
	}), versionID)
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "get_document_html", map[string]any{"document_id": docID}), "first version")

	updated := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "update_document", map[string]any{
		"document_id": docID, "base_version_id": versionID,
		"html": "<html><body>second version</body></html>", "change_summary": "MCP parity update",
	}), "MCP parity update"))
	versionID = requiredMCPString(t, updated, "id")

	edited := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "edit_document", map[string]any{
		"document_id": docID,
		"edits":       []map[string]any{{"old_string": "second version", "new_string": "second version, edited"}},
	}), "edits_applied"))
	if got := edited["base_version_id"]; got != versionID {
		t.Fatalf("edit_document base_version_id = %v, want %s", got, versionID)
	}
	versionID = requiredMCPString(t, edited, "id")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "get_document_html", map[string]any{"document_id": docID}), "second version, edited")
	assertMCPToolError(t, callMCPToolHTTP(t, e, token, "edit_document", map[string]any{
		"document_id": docID,
		"edits":       []map[string]any{{"old_string": "no such text", "new_string": "x"}},
	}), "old_string was not found")
	assertMCPToolError(t, callMCPToolHTTP(t, e, token, "edit_document", map[string]any{
		"document_id": docID, "edits": "second version",
	}), "edits must be a list")

	comment := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "create_comment", map[string]any{
		"document_id": docID, "version_id": versionID, "body": "Please check this",
		"quote": "second version", "prefix": "", "suffix": "",
	}), "Please check this"))
	commentID := requiredMCPString(t, comment, "id")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "list_comments", map[string]any{
		"document_id": docID, "status": "open", "version_id": versionID,
	}), commentID)
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "reply_comment", map[string]any{
		"document_id": docID, "comment_id": commentID, "body": "Reply through MCP",
	}), "Reply through MCP")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "update_comment", map[string]any{
		"document_id": docID, "comment_id": commentID, "body": "Updated through MCP",
	}), "Updated through MCP")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "resolve_comment", map[string]any{
		"document_id": docID, "comment_id": commentID,
	}), "resolved")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "reopen_comment", map[string]any{
		"document_id": docID, "comment_id": commentID,
	}), "open")

	documentGrant := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "share_document", map[string]any{
		"document_id": docID, "address": fixtureOwner.Email, "role": "viewer",
	}), fixtureOwner.Email))
	documentGrantID := requiredMCPString(t, documentGrant, "id")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "list_document_access", map[string]any{"document_id": docID}), fixtureOwner.Email)
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "update_document_grant", map[string]any{
		"document_id": docID, "grant_id": documentGrantID, "role": "commenter",
	}), "commenter")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "revoke_document_grant", map[string]any{
		"document_id": docID, "grant_id": documentGrantID,
	}), "ok")

	rootFolder := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "create_folder", map[string]any{
		"title": "MCP parity root",
	}), "MCP parity root"))
	rootFolderID := requiredMCPString(t, rootFolder, "id")
	childFolder := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "create_folder", map[string]any{
		"title": "MCP parity child", "parent_folder_id": rootFolderID,
	}), "MCP parity child"))
	childFolderID := requiredMCPString(t, childFolder, "id")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "get_folder", map[string]any{"folder_id": childFolderID}), childFolderID)
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "search_folders", map[string]any{"query": "parity child"}), childFolderID)
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "rename_folder", map[string]any{
		"folder_id": childFolderID, "title": "MCP renamed child",
	}), "MCP renamed child")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "move_folder", map[string]any{"folder_id": childFolderID}), childFolderID)

	folderGrant := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "share_folder", map[string]any{
		"folder_id": rootFolderID, "address": fixtureOwner.Email, "role": "viewer",
	}), fixtureOwner.Email))
	folderGrantID := requiredMCPString(t, folderGrant, "id")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "list_folder_access", map[string]any{"folder_id": rootFolderID}), fixtureOwner.Email)
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "update_folder_grant", map[string]any{
		"folder_id": rootFolderID, "grant_id": folderGrantID, "role": "editor",
	}), "editor")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "revoke_folder_grant", map[string]any{
		"folder_id": rootFolderID, "grant_id": folderGrantID,
	}), "ok")

	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "move_document", map[string]any{
		"document_id": docID, "folder_id": rootFolderID,
	}), rootFolderID)
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "move_document", map[string]any{
		"document_id": docID, "to_root": true,
	}), "ok")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "move_document_to_folder", map[string]any{
		"document_id": docID, "folder_id": rootFolderID,
	}), rootFolderID)
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "list_folder_documents", map[string]any{"folder_id": rootFolderID}), docID)
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "move_document_to_root", map[string]any{
		"document_id": docID, "folder_id": rootFolderID,
	}), "ok")

	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "delete_comment", map[string]any{
		"document_id": docID, "comment_id": commentID,
	}), "ok")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "delete_document", map[string]any{"document_id": docID}), "ok")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "delete_folder", map[string]any{"folder_id": childFolderID}), "ok")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "delete_folder", map[string]any{"folder_id": rootFolderID}), "ok")
}

func TestMCPServiceAccountToolParity(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	ownerToken := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)
	recipientToken := auth.NewMCPAccessToken(fixtureOwner.ID, e.resource, oauthTestSigningMaterial, time.Minute)

	serviceAccount, err := e.store.CreateServiceAccount(context.Background(), fixtureUser, "mcp-parity-bot@example.bot")
	if err != nil {
		t.Fatalf("seed service account: %v", err)
	}
	_, firstKeyHash, err := auth.NewBearerToken(auth.ServiceAccountPrefix)
	if err != nil {
		t.Fatal(err)
	}
	firstKeyID, err := e.store.CreateServiceAccountKey(context.Background(), serviceAccount.ID, "default", firstKeyHash)
	if err != nil {
		t.Fatalf("seed service-account key: %v", err)
	}
	serviceAccountID := serviceAccount.ID
	assertMCPToolOK(t, callMCPToolHTTP(t, e, ownerToken, "list_service_accounts", map[string]any{}), serviceAccountID)
	assertMCPToolOK(t, callMCPToolHTTP(t, e, ownerToken, "update_service_account", map[string]any{
		"service_account_id": serviceAccountID, "name": "renamed-parity-bot@example.bot", "disabled": false,
	}), "renamed-parity-bot@example.bot")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, ownerToken, "list_service_account_keys", map[string]any{
		"service_account_id": serviceAccountID,
	}), firstKeyID)
	assertMCPToolOK(t, callMCPToolHTTP(t, e, ownerToken, "revoke_service_account_key", map[string]any{
		"service_account_id": serviceAccountID, "key_id": firstKeyID,
	}), "ok")

	transfer := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, ownerToken, "create_service_account_transfer", map[string]any{
		"service_account_id": serviceAccountID, "to_user_email": fixtureOwner.Email,
	}), fixtureOwner.ID))
	transferID := requiredMCPString(t, transfer, "id")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, recipientToken, "list_service_account_transfers", map[string]any{}), transferID)
	assertMCPToolOK(t, callMCPToolHTTP(t, e, recipientToken, "accept_service_account_transfer", map[string]any{
		"transfer_id": transferID,
	}), "accepted")

	declinedAccount, err := e.store.CreateServiceAccount(context.Background(), fixtureUser, "mcp-decline-bot@example.bot")
	if err != nil {
		t.Fatalf("seed service account for declined transfer: %v", err)
	}
	declinedTransfer := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, ownerToken, "create_service_account_transfer", map[string]any{
		"service_account_id": declinedAccount.ID, "to_user_email": fixtureOwner.Email,
	}), fixtureOwner.ID))
	declinedTransferID := requiredMCPString(t, declinedTransfer, "id")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, recipientToken, "decline_service_account_transfer", map[string]any{
		"transfer_id": declinedTransferID,
	}), "ok")
}

func TestMCPToolPermissionsAndConcurrentVersionConflict(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	for _, p := range []auth.Principal{fixtureEditor, fixtureCommenter, fixtureViewer, fixtureStranger} {
		if _, err := e.store.UpsertGoogleUser(context.Background(), p.ID, p.Email, p.Name, "sub-"+p.ID, ""); err != nil {
			t.Fatalf("seed user %s: %v", p.ID, err)
		}
	}
	document, version, err := e.store.CreateDocument(context.Background(), fixtureOwner, "MCP permissions", []byte("<html><body>permission text</body></html>"))
	if err != nil {
		t.Fatalf("create permission document: %v", err)
	}
	for _, grant := range []struct {
		principal auth.Principal
		role      repo.Role
	}{{fixtureEditor, repo.RoleEditor}, {fixtureCommenter, repo.RoleCommenter}, {fixtureViewer, repo.RoleViewer}} {
		if _, err := e.store.CreateGrant(context.Background(), "document", document.ID, grant.principal, grant.role, fixtureOwner); err != nil {
			t.Fatalf("create %s grant: %v", grant.role, err)
		}
	}

	tokenFor := func(p auth.Principal) string {
		return auth.NewMCPAccessToken(p.ID, e.resource, oauthTestSigningMaterial, time.Minute)
	}
	assertMCPToolOK(t, callMCPToolHTTP(t, e, tokenFor(fixtureViewer), "get_document", map[string]any{"document_id": document.ID}), document.ID)
	assertMCPToolError(t, callMCPToolHTTP(t, e, tokenFor(fixtureViewer), "create_comment", map[string]any{
		"document_id": document.ID, "version_id": version.ID, "body": "viewer comment", "quote": "permission text",
	}), "commenter role required")
	assertMCPToolError(t, callMCPToolHTTP(t, e, tokenFor(fixtureCommenter), "update_document", map[string]any{
		"document_id": document.ID, "base_version_id": version.ID, "html": "<html><body>not allowed</body></html>",
	}), "editor role required")
	assertMCPToolError(t, callMCPToolHTTP(t, e, tokenFor(fixtureStranger), "get_document", map[string]any{"document_id": document.ID}), "viewer role required")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, tokenFor(fixtureCommenter), "create_comment", map[string]any{
		"document_id": document.ID, "version_id": version.ID, "body": "commenter works", "quote": "permission text",
	}), "commenter works")

	results := make([]mcpToolHTTPResult, 2)
	winnerLabels := []string{"A", "B"}
	var wg sync.WaitGroup
	for i := range results {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = callMCPToolHTTP(t, e, tokenFor(fixtureEditor), "update_document", map[string]any{
				"document_id": document.ID, "base_version_id": version.ID,
				"html":           "<html><body>concurrent winner " + winnerLabels[i] + "</body></html>",
				"change_summary": "concurrent MCP update",
			})
		}()
	}
	wg.Wait()

	successes, conflicts := 0, 0
	for _, result := range results {
		if !result.IsError {
			successes++
			continue
		}
		if strings.Contains(result.Text, "version_conflict") {
			conflicts++
		}
	}
	if successes != 1 || conflicts != 1 {
		t.Fatalf("concurrent version results = %#v, want one success and one version_conflict", results)
	}
}

func TestMCPCommentAuthorNeedsCurrentDocumentAccess(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	ctx := context.Background()
	doc, version, err := e.store.CreateDocument(ctx, fixtureOwner, "private", []byte("<p>test</p>"))
	if err != nil {
		t.Fatal(err)
	}
	grant, err := e.store.CreateGrant(ctx, "document", doc.ID, fixtureUser, repo.RoleCommenter, fixtureOwner)
	if err != nil {
		t.Fatal(err)
	}
	comment, err := e.store.CreateComment(ctx, doc.ID, version.ID, "original", repo.Anchor{Quote: "test"}, fixtureUser, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := e.store.DeleteGrant(ctx, doc.ID, grant.ID, fixtureOwner); err != nil {
		t.Fatal(err)
	}
	token := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)
	for _, tool := range []string{"update_comment", "delete_comment", "resolve_comment", "reopen_comment", "reply_comment"} {
		assertMCPToolError(t, callMCPToolHTTP(t, e, token, tool, map[string]any{
			"document_id": doc.ID, "comment_id": comment.ID, "body": "changed",
		}), "forbidden")
	}
}

type mcpToolHTTPResult struct {
	IsError bool
	Text    string
}

func assertMCPToolOK(t *testing.T, result mcpToolHTTPResult, want string) mcpToolHTTPResult {
	t.Helper()
	if result.IsError || !strings.Contains(result.Text, want) {
		t.Fatalf("MCP tool result = %#v, want success containing %q", result, want)
	}
	return result
}

func assertMCPToolError(t *testing.T, result mcpToolHTTPResult, want string) {
	t.Helper()
	if !result.IsError || !strings.Contains(result.Text, want) {
		t.Fatalf("MCP tool result = %#v, want error containing %q", result, want)
	}
}

func mustMCPObject(t *testing.T, result mcpToolHTTPResult) map[string]any {
	t.Helper()
	var object map[string]any
	if err := json.Unmarshal([]byte(result.Text), &object); err != nil {
		t.Fatalf("MCP result is not a JSON object: %v; text=%s", err, result.Text)
	}
	return object
}

func requiredMCPString(t *testing.T, object map[string]any, field string) string {
	t.Helper()
	value, ok := object[field].(string)
	if !ok || value == "" {
		t.Fatalf("MCP object field %q = %#v, want non-empty string; object=%#v", field, object[field], object)
	}
	return value
}

func callMCPToolHTTP(t *testing.T, e *mcpOAuthTestEnv, token, name string, arguments map[string]any) mcpToolHTTPResult {
	t.Helper()
	rr := mcpPost(t, e, token, "", map[string]any{
		"jsonrpc": "2.0", "id": 100, "method": "tools/call",
		"params": map[string]any{"name": name, "arguments": arguments},
	})
	assertStatus(t, rr, http.StatusOK)
	var response struct {
		Result struct {
			IsError bool `json:"isError"`
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"result"`
		Error any `json:"error"`
	}
	decodeMCPResponse(t, rr, &response)
	if response.Error != nil {
		t.Fatalf("tools/call %s protocol error: %#v", name, response.Error)
	}
	texts := make([]string, 0, len(response.Result.Content))
	for _, content := range response.Result.Content {
		texts = append(texts, content.Text)
	}
	return mcpToolHTTPResult{IsError: response.Result.IsError, Text: strings.Join(texts, "\n")}
}

func mcpPost(t *testing.T, e *mcpOAuthTestEnv, token, origin string, value any) *httptest.ResponseRecorder {
	t.Helper()
	return rawMCPRequest(t, e, http.MethodPost, token, origin, marshalMCP(t, value), "application/json", true)
}

func rawMCPRequest(t *testing.T, e *mcpOAuthTestEnv, method, token, origin, body, contentType string, accept bool) *httptest.ResponseRecorder {
	t.Helper()
	return rawMCPRequestWithProtocol(t, e, method, token, origin, body, contentType, accept, mcp.LATEST_PROTOCOL_VERSION)
}

func rawMCPRequestWithProtocol(t *testing.T, e *mcpOAuthTestEnv, method, token, origin, body, contentType string, accept bool, protocolVersion string) *httptest.ResponseRecorder {
	t.Helper()
	headers := map[string]string{}
	if token != "" {
		headers["Authorization"] = "Bearer " + token
	}
	if origin != "" {
		headers["Origin"] = origin
	}
	if contentType != "" {
		headers["Content-Type"] = contentType
	}
	if accept {
		headers["Accept"] = "application/json, text/event-stream"
	}
	if protocolVersion != "" {
		headers["Mcp-Protocol-Version"] = protocolVersion
	}
	return do(t, e.h, method, "/mcp", body, headers)
}

func marshalMCP(t *testing.T, value any) string {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal MCP message: %v", err)
	}
	return string(b)
}

func decodeMCPResponse(t *testing.T, rr *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(rr.Body.Bytes(), target); err != nil {
		t.Fatalf("decode MCP response: %v; body=%s", err, rr.Body.String())
	}
}

// The server applies its configured default sharing at create; the MCP result
// passes default_grant through and derives a role-aware warning from it,
// including the persisted grant id in the revoke recipe.
func TestMCPCreateDocumentPassesThroughDefaultGrant(t *testing.T) {
	e := newMCPOAuthTestEnvConfig(t, func(cfg *server.Config) {
		cfg.Deployment = server.DeploymentOrg
		cfg.OrgName = "Acme"
		cfg.DefaultDocPermission = repo.RoleViewer
	})
	token := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)

	created := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "create_document", map[string]any{
		"title": "Shared by default", "html": "<html><body>shared</body></html>",
	}), `"default_grant"`))
	docID := requiredMCPString(t, created, "id")
	grant, _ := created["default_grant"].(map[string]any)
	if grant == nil {
		t.Fatalf("create result missing default_grant object: %v", created)
	}
	grantID, _ := grant["grant_id"].(string)
	if !strings.HasPrefix(grantID, "gr_") {
		t.Fatalf("default_grant.grant_id = %q, want gr_ prefix", grantID)
	}
	if role, _ := grant["role"].(string); role != "viewer" {
		t.Fatalf("default_grant.role = %q, want viewer", role)
	}
	warning, _ := created["warning"].(string)
	if !strings.Contains(warning, "anyone at Acme can read it") {
		t.Fatalf("warning missing role verb for viewer, got %q", warning)
	}
	if !strings.Contains(warning, "revoke_document_grant with grant_id "+grantID) {
		t.Fatalf("warning missing revoke recipe with the persisted grant id, got %q", warning)
	}

	access := assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "list_document_access", map[string]any{
		"document_id": docID,
	}), `"anyone"`)
	if !strings.Contains(access.Text, grantID) {
		t.Fatalf("listed grants do not include the default grant %s: %s", grantID, access.Text)
	}
	if !strings.Contains(access.Text, `"viewer"`) {
		t.Fatalf("default grant is not viewer role: %s", access.Text)
	}
}

// A server with no configured default (private) applies no grant: the MCP
// result carries neither default_grant nor warning.
func TestMCPCreateDocumentPrivateDefaultServer(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	token := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)

	created := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "create_document", map[string]any{
		"title": "Private by default", "html": "<html><body>private</body></html>",
	}), `"current_version_id"`))
	docID := requiredMCPString(t, created, "id")
	if grant, ok := created["default_grant"]; ok {
		t.Fatalf("private-by-default create should not carry default_grant, got %v", grant)
	}
	if warning, ok := created["warning"]; ok {
		t.Fatalf("private-by-default create should not carry a warning, got %v", warning)
	}

	access := assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "list_document_access", map[string]any{
		"document_id": docID,
	}), "items")
	if strings.Contains(access.Text, `"anyone"`) {
		t.Fatalf("private-by-default server granted org-wide access: %s", access.Text)
	}
}

// The guidelines tool mirrors the CLI's sectioned progressive disclosure from
// the same shared source: index -> section -> all, with aliases.
func TestMCPGuidelinesProgressiveDisclosure(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	token := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)

	index := assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "get_authoring_guidelines", map[string]any{}), "single-file HTML contract")
	for _, want := range []string{`section="core"`, `section="rendering theme"`, `section="interactivity github"`, `section="all"`} {
		if !strings.Contains(index.Text, want) {
			t.Errorf("guidelines index missing %q: %s", want, index.Text)
		}
	}

	theme := assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "get_authoring_guidelines", map[string]any{
		"section": "rendering theme",
	}), "slashdocs guidelines: rendering theme")
	if !strings.Contains(theme.Text, "get_authoring_guidelines") {
		t.Errorf("section page is missing the tool-call translation footer: %s", theme.Text)
	}

	// Aliases from the CLI resolve identically.
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "get_authoring_guidelines", map[string]any{
		"section": "theme",
	}), "slashdocs guidelines: rendering theme")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "get_authoring_guidelines", map[string]any{
		"section": "github",
	}), "window.slashdocs.github.getRawContent")

	all := assertMCPToolOK(t, callMCPToolHTTP(t, e, token, "get_authoring_guidelines", map[string]any{
		"section": "all",
	}), "slashdocs guidelines: core")
	for _, want := range []string{"slashdocs guidelines: rendering theme", "slashdocs guidelines: interactivity github", "slashdocs guidelines: review"} {
		if !strings.Contains(all.Text, want) {
			t.Errorf("guidelines all is missing %q", want)
		}
	}

	assertMCPToolError(t, callMCPToolHTTP(t, e, token, "get_authoring_guidelines", map[string]any{
		"section": "no such section",
	}), "unknown guidelines section")
}
