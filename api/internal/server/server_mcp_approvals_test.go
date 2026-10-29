package server_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/razorpay/slashdocs/api/internal/auth"
	"github.com/razorpay/slashdocs/api/internal/repo"
)

// approvalsListed reads list_document_approvals into the fields the tests look at.
func approvalsListed(t *testing.T, e *mcpOAuthTestEnv, token, docID string) (status string, decisions map[string]string) {
	t.Helper()
	result := callMCPToolHTTP(t, e, token, "list_document_approvals", map[string]any{"document_id": docID})
	var list struct {
		Status string `json:"status"`
		Items  []struct {
			Approver struct {
				Email string `json:"email"`
			} `json:"approver"`
			Decision *string `json:"decision"`
		} `json:"items"`
	}
	if result.IsError {
		t.Fatalf("list_document_approvals failed: %s", result.Text)
	}
	if err := json.Unmarshal([]byte(result.Text), &list); err != nil {
		t.Fatalf("list_document_approvals is not the approvals list: %v; text=%s", err, result.Text)
	}
	decisions = map[string]string{}
	for _, item := range list.Items {
		decision := "pending"
		if item.Decision != nil {
			decision = *item.Decision
		}
		decisions[item.Approver.Email] = decision
	}
	return list.Status, decisions
}

func TestMCPApprovalToolsAskFollowUpAndTakeBack(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	ownerToken := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)
	approverToken := auth.NewMCPAccessToken(fixtureOwner.ID, e.resource, oauthTestSigningMaterial, time.Minute)

	created := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, ownerToken, "create_document", map[string]any{
		"title": "MCP approvals", "html": "<html><body>first version</body></html>",
	}), "current_version_id"))
	docID := requiredMCPString(t, created, "id")

	// The approver needs viewer access first, as over the API.
	assertMCPToolOK(t, callMCPToolHTTP(t, e, ownerToken, "share_document", map[string]any{
		"document_id": docID, "address": fixtureOwner.Email, "role": "viewer",
	}), fixtureOwner.Email)

	requested := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, ownerToken, "request_document_approval", map[string]any{
		"document_id": docID, "address": fixtureOwner.Email,
	}), fixtureOwner.Email))
	requestID := requiredMCPString(t, requested, "id")

	// The approval-request ID comes from the approvers list (the approvals list carries decision IDs, not these).
	assertMCPToolOK(t, callMCPToolHTTP(t, e, ownerToken, "list_document_approvers", map[string]any{"document_id": docID}), requestID)
	status, decisions := approvalsListed(t, e, ownerToken, docID)
	if status != repo.StatusPending || decisions[fixtureOwner.Email] != repo.StatusPending {
		t.Fatalf("after asking: status = %q, decisions = %v; want everything pending", status, decisions)
	}

	t.Run("the rules of the REST route apply unchanged", func(t *testing.T) {
		assertMCPToolError(t, callMCPToolHTTP(t, e, ownerToken, "request_document_approval", map[string]any{
			"document_id": docID, "address": fixtureOwner.Email,
		}), "already an approver")
		// the owner published the document, so they cannot be its approver
		assertMCPToolError(t, callMCPToolHTTP(t, e, ownerToken, "request_document_approval", map[string]any{
			"document_id": docID, "address": fixtureUser.Email,
		}), "created a version")
		// only the owner asks and removes
		assertMCPToolError(t, callMCPToolHTTP(t, e, approverToken, "request_document_approval", map[string]any{
			"document_id": docID, "address": fixtureUser.Email,
		}), "forbidden")
		assertMCPToolError(t, callMCPToolHTTP(t, e, approverToken, "remove_document_approver", map[string]any{
			"document_id": docID, "approver_id": requestID,
		}), "forbidden")
	})

	assertMCPToolOK(t, callMCPToolHTTP(t, e, ownerToken, "remove_document_approver", map[string]any{
		"document_id": docID, "approver_id": requestID,
	}), "ok")
	if _, decisions := approvalsListed(t, e, ownerToken, docID); len(decisions) != 0 {
		t.Fatalf("after removing the approver, decisions = %v; want none", decisions)
	}
}

func TestMCPUpdateDocumentCanKeepApprovals(t *testing.T) {
	e := newMCPOAuthTestEnv(t)
	ownerToken := auth.NewMCPAccessToken(fixtureUser.ID, e.resource, oauthTestSigningMaterial, time.Minute)

	created := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, ownerToken, "create_document", map[string]any{
		"title": "MCP keep approvals", "html": "<html><body>one</body></html>",
	}), "current_version_id"))
	docID := requiredMCPString(t, created, "id")
	versionID := requiredMCPString(t, created, "current_version_id")
	assertMCPToolOK(t, callMCPToolHTTP(t, e, ownerToken, "share_document", map[string]any{
		"document_id": docID, "address": fixtureOwner.Email, "role": "viewer",
	}), fixtureOwner.Email)
	assertMCPToolOK(t, callMCPToolHTTP(t, e, ownerToken, "request_document_approval", map[string]any{
		"document_id": docID, "address": fixtureOwner.Email,
	}), fixtureOwner.Email)

	// An agent cannot approve through MCP (by design), so the approver's decision is recorded directly.
	if _, _, err := e.store.CreateOrUpdateApproval(context.Background(), docID, versionID, repo.DecisionApproved, "", fixtureOwner); err != nil {
		t.Fatalf("record the approval: %v", err)
	}
	if status, _ := approvalsListed(t, e, ownerToken, docID); status != repo.DecisionApproved {
		t.Fatalf("status = %q, want approved", status)
	}

	kept := mustMCPObject(t, assertMCPToolOK(t, callMCPToolHTTP(t, e, ownerToken, "update_document", map[string]any{
		"document_id": docID, "base_version_id": versionID, "html": "<html><body>two</body></html>",
		"change_summary": "kept", "keep_approvals": true,
	}), "kept"))
	if status, decisions := approvalsListed(t, e, ownerToken, docID); status != repo.DecisionApproved || decisions[fixtureOwner.Email] != repo.DecisionApproved {
		t.Fatalf("with keep_approvals: status = %q, decisions = %v; want the approval carried forward", status, decisions)
	}

	assertMCPToolOK(t, callMCPToolHTTP(t, e, ownerToken, "update_document", map[string]any{
		"document_id": docID, "base_version_id": requiredMCPString(t, kept, "id"), "html": "<html><body>three</body></html>",
		"change_summary": "reset",
	}), "reset")
	if status, decisions := approvalsListed(t, e, ownerToken, docID); status != repo.StatusPending || decisions[fixtureOwner.Email] != repo.StatusPending {
		t.Fatalf("without keep_approvals: status = %q, decisions = %v; want every approval reset", status, decisions)
	}
}
