package server_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/razorpay/slashdocs/api/internal/auth"
)

// assignApprover posts an approver assignment as the given principal and
// returns the recorder without asserting, so tests can check error paths.
func assignApprover(t *testing.T, e *testEnv, docID, body string, as auth.Principal) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/approvers", body, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(as),
	})
}

// mustAssignApprover assigns a user approver by email and returns the
// approval-request id.
func mustAssignApprover(t *testing.T, e *testEnv, docID, email string, as auth.Principal) string {
	t.Helper()
	rr := assignApprover(t, e, docID, fmt.Sprintf(`{"principal": {"type": "user", "email": %q}}`, email), as)
	assertStatus(t, rr, http.StatusCreated)
	return jsonField(t, rr.Body.Bytes(), "id")
}

// submitApproval posts a decision as the given principal. Requesting changes
// requires a note, so a default one is supplied; use submitApprovalWithNote to
// control it (including sending none).
func submitApproval(t *testing.T, e *testEnv, docID, versionID, decision string, as auth.Principal) *httptest.ResponseRecorder {
	t.Helper()
	note := ""
	if decision == "changes_requested" {
		note = "please tighten the rollout section"
	}
	return submitApprovalWithNote(t, e, docID, versionID, decision, note, as)
}

// submitApprovalWithNote posts a decision with an explicit note body.
func submitApprovalWithNote(t *testing.T, e *testEnv, docID, versionID, decision, note string, as auth.Principal) *httptest.ResponseRecorder {
	t.Helper()
	return do(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/approvals",
		fmt.Sprintf(`{"version_id": %q, "decision": %q, "note": %q}`, versionID, decision, note), map[string]string{
			"Content-Type":     "application/json",
			"X-Test-Principal": principalHeader(as),
		})
}

// pushApprovalTestVersion uploads a new version and returns its id.
func pushApprovalTestVersion(t *testing.T, e *testEnv, docID, baseVersionID string, keepApprovals bool, as auth.Principal) string {
	t.Helper()
	return pushApprovalTestVersionHTML(t, e, docID, baseVersionID, "<html><body>updated</body></html>", keepApprovals, as)
}

// pushApprovalTestVersionHTML uploads a new version with the given content.
func pushApprovalTestVersionHTML(t *testing.T, e *testEnv, docID, baseVersionID, html string, keepApprovals bool, as auth.Principal) string {
	t.Helper()
	fields := map[string]string{"base_version_id": baseVersionID, "change_summary": "update"}
	if keepApprovals {
		fields["keep_approvals"] = "true"
	}
	body, contentType := multipartBody(t, fields, "file", "doc.html", html)
	rr := doRaw(t, e.h, http.MethodPost, "/v1/documents/"+docID+"/versions", body, map[string]string{
		"Content-Type":     contentType,
		"X-Test-Principal": principalHeader(as),
	})
	assertStatus(t, rr, http.StatusCreated)
	return jsonField(t, rr.Body.Bytes(), "id")
}

type approvalItem struct {
	ID       string `json:"id"`
	Approver struct {
		Type  string `json:"type"`
		ID    string `json:"id"`
		Email string `json:"email"`
		Name  string `json:"name"`
	} `json:"approver"`
	Decision                 *string `json:"decision"`
	Note                     string  `json:"note"`
	DecidedAt                string  `json:"decided_at"`
	CarriedFromVersionID     string  `json:"carried_from_version_id"`
	CarriedFromVersionNumber int     `json:"carried_from_version_number"`
	CreatedVersion           bool    `json:"created_version"`
	CommentsOpen             int     `json:"comments_open"`
	CommentsTotal            int     `json:"comments_total"`
}

type approvalsListResponse struct {
	VersionID     string `json:"version_id"`
	VersionNumber int    `json:"version_number"`
	VersionSHA256 string `json:"version_sha256"`
	Status        string `json:"status"`
	Summary       struct {
		Total            int `json:"total"`
		Approved         int `json:"approved"`
		ChangesRequested int `json:"changes_requested"`
		Pending          int `json:"pending"`
	} `json:"summary"`
	Items []approvalItem `json:"items"`
}

// listApprovals fetches decisions for a document (current version unless a
// version query is given).
func listApprovals(t *testing.T, e *testEnv, docID, version string, as auth.Principal) approvalsListResponse {
	t.Helper()
	path := "/v1/documents/" + docID + "/approvals"
	if version != "" {
		path += "?version=" + version
	}
	rr := do(t, e.h, http.MethodGet, path, "", map[string]string{"X-Test-Principal": principalHeader(as)})
	assertStatus(t, rr, http.StatusOK)
	var out approvalsListResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad approvals list response: %v; body=%s", err, rr.Body.String())
	}
	return out
}

type documentApprovalFields struct {
	ApprovalStatus  string `json:"approval_status"`
	ApprovalSummary *struct {
		Total            int `json:"total"`
		Approved         int `json:"approved"`
		ChangesRequested int `json:"changes_requested"`
		Pending          int `json:"pending"`
	} `json:"approval_summary"`
}

func getDocumentApprovalFields(t *testing.T, e *testEnv, docID string, as auth.Principal) documentApprovalFields {
	t.Helper()
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+docID, "", map[string]string{"X-Test-Principal": principalHeader(as)})
	assertStatus(t, rr, http.StatusOK)
	var out documentApprovalFields
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad document response: %v; body=%s", err, rr.Body.String())
	}
	return out
}

// ---------------------------------------------------------------------------
// Approver assignment
// ---------------------------------------------------------------------------

func TestAssignApproverAsOwner(t *testing.T) {
	e := newTestEnv(t)
	before := scrapeMetric(t, "slashdocs_approval_events_total", map[string]string{"event": "approver_assigned"})

	rr := assignApprover(t, e, e.doc.ID, `{"principal": {"type": "user", "email": "viewer@example.com"}}`, fixtureOwner)

	assertStatus(t, rr, http.StatusCreated)
	requestID := jsonField(t, rr.Body.Bytes(), "id")
	assertJSON(t, rr.Body.Bytes(), fmt.Sprintf(`{
	  "id": %q,
	  "document_id": %q,
	  "approver": { "type": "user", "id": "viewer_1", "email": "viewer@example.com", "name": "Viewer" },
	  "requested_by": { "id": "owner_1", "email": "owner@example.com" }
	}`, requestID, e.doc.ID))

	after := scrapeMetric(t, "slashdocs_approval_events_total", map[string]string{"event": "approver_assigned"})
	if after != before+1 {
		t.Fatalf("approver_assigned metric = %v, want %v", after, before+1)
	}
}

func TestAssignApproverRequiresOwner(t *testing.T) {
	e := newTestEnv(t)
	rr := assignApprover(t, e, e.doc.ID, `{"principal": {"type": "user", "email": "viewer@example.com"}}`, fixtureEditor)
	assertStatus(t, rr, http.StatusForbidden)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "forbidden", "message": "owner role required" }
	}`)
}

func TestAssignApproverRequiresViewerAccess(t *testing.T) {
	e := newTestEnv(t)
	rr := assignApprover(t, e, e.doc.ID, `{"principal": {"type": "user", "email": "stranger@example.com"}}`, fixtureOwner)
	assertStatus(t, rr, http.StatusBadRequest)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "bad_request", "message": "approver must have at least viewer access on this document" }
	}`)
}

func TestAssignApproverUnknownEmail(t *testing.T) {
	e := newTestEnv(t)
	rr := assignApprover(t, e, e.doc.ID, `{"principal": {"type": "user", "email": "reviewer@nowhere.example"}}`, fixtureOwner)
	assertStatus(t, rr, http.StatusBadRequest)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "bad_request", "message": "No slashdocs user exists for that email. Ask them to sign in once, then try again." }
	}`)
}

func TestAssignApproverDuplicate(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	rr := assignApprover(t, e, e.doc.ID, `{"principal": {"type": "user", "email": "viewer@example.com"}}`, fixtureOwner)
	assertStatus(t, rr, http.StatusConflict)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "conflict", "message": "already an approver on this document" }
	}`)
}

func TestListApproversAsViewer(t *testing.T) {
	e := newTestEnv(t)
	firstID := mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	secondID := mustAssignApprover(t, e, e.doc.ID, "commenter@example.com", fixtureOwner)

	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/approvers", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, rr, http.StatusOK)
	assertJSON(t, rr.Body.Bytes(), fmt.Sprintf(`{
	  "items": [
	    {
	      "id": %q,
	      "document_id": %q,
	      "approver": { "type": "user", "id": "viewer_1", "email": "viewer@example.com", "name": "Viewer" },
	      "requested_by": { "id": "owner_1", "email": "owner@example.com" }
	    },
	    {
	      "id": %q,
	      "document_id": %q,
	      "approver": { "type": "user", "id": "commenter_1", "email": "commenter@example.com", "name": "Commenter" },
	      "requested_by": { "id": "owner_1", "email": "owner@example.com" }
	    }
	  ]
	}`, firstID, e.doc.ID, secondID, e.doc.ID))
}

func TestListApproversRequiresAccess(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/approvers", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureStranger),
	})
	assertStatus(t, rr, http.StatusForbidden)
}

func TestRemoveApproverRevokesTheirDecisions(t *testing.T) {
	e := newTestEnv(t)
	viewerReq := mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	mustAssignApprover(t, e, e.doc.ID, "commenter@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)

	rr := do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/approvers/"+viewerReq, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, rr, http.StatusNoContent)

	list := listApprovals(t, e, e.doc.ID, "", fixtureOwner)
	if list.Summary.Total != 1 || list.Summary.Approved != 0 || list.Summary.Pending != 1 {
		t.Fatalf("summary after removal = %+v, want 1 total / 0 approved / 1 pending", list.Summary)
	}
	if len(list.Items) != 1 || list.Items[0].Approver.ID != "commenter_1" {
		t.Fatalf("items after removal = %+v, want only commenter_1", list.Items)
	}

	// The removed approver can no longer submit decisions.
	rr = submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer)
	assertStatus(t, rr, http.StatusForbidden)
}

func TestRemoveApproverUnknownID(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/approvers/apr_missing", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, rr, http.StatusNotFound)
}

func TestRemoveApproverRequiresOwner(t *testing.T) {
	e := newTestEnv(t)
	requestID := mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	rr := do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/approvers/"+requestID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureEditor),
	})
	assertStatus(t, rr, http.StatusForbidden)
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

func TestApproveAsAssignedApprover(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	before := scrapeMetric(t, "slashdocs_approval_events_total", map[string]string{"event": "decided", "decision": "approved"})

	rr := submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer)

	assertStatus(t, rr, http.StatusCreated)
	var out approvalItem
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad approval response: %v; body=%s", err, rr.Body.String())
	}
	if out.ID == "" || out.Decision == nil || *out.Decision != "approved" || out.Approver.ID != "viewer_1" {
		t.Fatalf("approval response = %s", rr.Body.String())
	}
	if out.DecidedAt == "" {
		t.Fatalf("expected decided_at to be set: %s", rr.Body.String())
	}
	if out.CarriedFromVersionID != "" {
		t.Fatalf("fresh decision must not carry provenance: %s", rr.Body.String())
	}

	after := scrapeMetric(t, "slashdocs_approval_events_total", map[string]string{"event": "decided", "decision": "approved"})
	if after != before+1 {
		t.Fatalf("decided metric = %v, want %v", after, before+1)
	}
}

func TestServiceAccountApprover(t *testing.T) {
	e := newTestEnv(t)
	// Give the fixture service account access, then assign it as an approver.
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", fmt.Sprintf(`{
	  "principal": { "type": "service_account", "id": %q },
	  "role": "viewer"
	}`, e.sa.ID), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, rr, http.StatusCreated)

	rr = assignApprover(t, e, e.doc.ID, fmt.Sprintf(`{"principal": {"type": "service_account", "id": %q}}`, e.sa.ID), fixtureOwner)
	assertStatus(t, rr, http.StatusCreated)

	saPrincipal := auth.Principal{Type: auth.PrincipalServiceAccount, ID: e.sa.ID}
	rr = submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", saPrincipal)
	assertStatus(t, rr, http.StatusCreated)

	doc := getDocumentApprovalFields(t, e, e.doc.ID, fixtureOwner)
	if doc.ApprovalStatus != "approved" {
		t.Fatalf("approval_status = %q, want approved", doc.ApprovalStatus)
	}
}

func TestRequestChanges(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)

	rr := submitApproval(t, e, e.doc.ID, e.ver.ID, "changes_requested", fixtureViewer)
	assertStatus(t, rr, http.StatusCreated)

	doc := getDocumentApprovalFields(t, e, e.doc.ID, fixtureOwner)
	if doc.ApprovalStatus != "changes_requested" {
		t.Fatalf("approval_status = %q, want changes_requested", doc.ApprovalStatus)
	}
}

func TestChangeDecisionUpserts(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)

	rr := submitApproval(t, e, e.doc.ID, e.ver.ID, "changes_requested", fixtureViewer)
	assertStatus(t, rr, http.StatusOK)

	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if len(list.Items) != 1 {
		t.Fatalf("items = %+v, want exactly one", list.Items)
	}
	if list.Items[0].Decision == nil || *list.Items[0].Decision != "changes_requested" {
		t.Fatalf("decision = %v, want changes_requested", list.Items[0].Decision)
	}
	if list.Status != "changes_requested" {
		t.Fatalf("status = %q, want changes_requested", list.Status)
	}
}

func TestApproveRequiresAssignment(t *testing.T) {
	e := newTestEnv(t)
	rr := submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer)
	assertStatus(t, rr, http.StatusForbidden)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "forbidden", "message": "not an assigned approver on this document" }
	}`)
}

func TestApproveInvalidDecision(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	rr := submitApproval(t, e, e.doc.ID, e.ver.ID, "maybe", fixtureViewer)
	assertStatus(t, rr, http.StatusBadRequest)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "bad_request", "message": "decision must be \"approved\" or \"changes_requested\"" }
	}`)
}

func TestApproveMissingVersionID(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/approvals", `{"decision": "approved"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, rr, http.StatusBadRequest)
}

func TestApproveVersionFromAnotherDocument(t *testing.T) {
	e := newTestEnv(t)
	_, otherVersion := e.createDocument("other", "<html><body>other</body></html>", fixtureOwner)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	rr := submitApproval(t, e, e.doc.ID, otherVersion, "approved", fixtureViewer)
	assertStatus(t, rr, http.StatusNotFound)
}

// ---------------------------------------------------------------------------
// Listing + document enrichment
// ---------------------------------------------------------------------------

func TestListApprovalsMergesPendingApprovers(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	mustAssignApprover(t, e, e.doc.ID, "commenter@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)

	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if list.VersionID != e.ver.ID {
		t.Fatalf("version_id = %q, want %q", list.VersionID, e.ver.ID)
	}
	if list.Status != "pending" {
		t.Fatalf("status = %q, want pending", list.Status)
	}
	if list.Summary.Total != 2 || list.Summary.Approved != 1 || list.Summary.Pending != 1 || list.Summary.ChangesRequested != 0 {
		t.Fatalf("summary = %+v", list.Summary)
	}
	if len(list.Items) != 2 {
		t.Fatalf("items = %+v, want 2", list.Items)
	}
	byApprover := map[string]approvalItem{}
	for _, item := range list.Items {
		byApprover[item.Approver.ID] = item
	}
	if got := byApprover["viewer_1"]; got.Decision == nil || *got.Decision != "approved" {
		t.Fatalf("viewer item = %+v, want approved", got)
	}
	if got := byApprover["commenter_1"]; got.Decision != nil {
		t.Fatalf("commenter item = %+v, want pending (null decision)", got)
	}
}

func TestListApprovalsHistoricalVersion(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "changes_requested", fixtureViewer), http.StatusCreated)
	pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, false, fixtureEditor)

	historical := listApprovals(t, e, e.doc.ID, e.ver.ID, fixtureViewer)
	if historical.VersionID != e.ver.ID || historical.Status != "changes_requested" {
		t.Fatalf("historical = %+v, want changes_requested on %s", historical, e.ver.ID)
	}

	current := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if current.Status != "pending" {
		t.Fatalf("current status = %q, want pending", current.Status)
	}
}

func TestGetDocumentIncludesApprovalFields(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	mustAssignApprover(t, e, e.doc.ID, "commenter@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)

	doc := getDocumentApprovalFields(t, e, e.doc.ID, fixtureViewer)
	if doc.ApprovalStatus != "pending" {
		t.Fatalf("approval_status = %q, want pending", doc.ApprovalStatus)
	}
	if doc.ApprovalSummary == nil {
		t.Fatalf("approval_summary missing")
	}
	if doc.ApprovalSummary.Total != 2 || doc.ApprovalSummary.Approved != 1 || doc.ApprovalSummary.Pending != 1 {
		t.Fatalf("approval_summary = %+v", doc.ApprovalSummary)
	}
}

func TestGetDocumentOmitsApprovalFieldsWithoutApprovers(t *testing.T) {
	e := newTestEnv(t)
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, rr, http.StatusOK)
	var raw map[string]any
	if err := json.Unmarshal(rr.Body.Bytes(), &raw); err != nil {
		t.Fatalf("bad document response: %v", err)
	}
	if _, ok := raw["approval_status"]; ok {
		t.Fatalf("approval_status must be omitted without approvers: %s", rr.Body.String())
	}
	if _, ok := raw["approval_summary"]; ok {
		t.Fatalf("approval_summary must be omitted without approvers: %s", rr.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Carry-forward on new versions
// ---------------------------------------------------------------------------

func TestNewVersionCarriesApprovals(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)

	newVersion := pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, true, fixtureEditor)

	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if list.VersionID != newVersion {
		t.Fatalf("version_id = %q, want %q", list.VersionID, newVersion)
	}
	if list.Status != "approved" {
		t.Fatalf("status = %q, want approved (carried)", list.Status)
	}
	if len(list.Items) != 1 || list.Items[0].Decision == nil || *list.Items[0].Decision != "approved" {
		t.Fatalf("items = %+v, want carried approval", list.Items)
	}
	if list.Items[0].CarriedFromVersionID != e.ver.ID {
		t.Fatalf("carried_from_version_id = %q, want %q", list.Items[0].CarriedFromVersionID, e.ver.ID)
	}

	doc := getDocumentApprovalFields(t, e, e.doc.ID, fixtureViewer)
	if doc.ApprovalStatus != "approved" {
		t.Fatalf("approval_status = %q, want approved", doc.ApprovalStatus)
	}
}

func TestNewVersionDoesNotCarryChangesRequested(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "changes_requested", fixtureViewer), http.StatusCreated)

	pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, true, fixtureEditor)

	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if list.Status != "pending" {
		t.Fatalf("status = %q, want pending", list.Status)
	}
	if len(list.Items) != 1 || list.Items[0].Decision != nil {
		t.Fatalf("items = %+v, want single pending approver", list.Items)
	}
}

func TestNewVersionResetsApprovalsByDefault(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)

	pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, false, fixtureEditor)

	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if list.Status != "pending" {
		t.Fatalf("status = %q, want pending after a change of content", list.Status)
	}
	if len(list.Items) != 1 || list.Items[0].Decision != nil {
		t.Fatalf("items = %+v, want pending approver after reset", list.Items)
	}
}

func TestCarriedFromPropagatesOrigin(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)

	second := pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, true, fixtureEditor)
	pushApprovalTestVersion(t, e, e.doc.ID, second, true, fixtureEditor)

	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if len(list.Items) != 1 || list.Items[0].CarriedFromVersionID != e.ver.ID {
		t.Fatalf("items = %+v, want carried_from %s (the original explicit approval)", list.Items, e.ver.ID)
	}
}

func TestExplicitReapprovalClearsProvenance(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)
	newVersion := pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, true, fixtureEditor)

	// Re-approving the carried decision makes it an explicit review of the
	// current version.
	rr := submitApproval(t, e, e.doc.ID, newVersion, "approved", fixtureViewer)
	assertStatus(t, rr, http.StatusOK)

	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if len(list.Items) != 1 || list.Items[0].CarriedFromVersionID != "" {
		t.Fatalf("items = %+v, want cleared provenance after explicit re-approval", list.Items)
	}
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

func TestRevokeOwnDecision(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	rr := submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer)
	assertStatus(t, rr, http.StatusCreated)
	approvalID := jsonField(t, rr.Body.Bytes(), "id")

	doc := getDocumentApprovalFields(t, e, e.doc.ID, fixtureViewer)
	if doc.ApprovalStatus != "approved" {
		t.Fatalf("approval_status = %q, want approved before revoke", doc.ApprovalStatus)
	}

	rr = do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/approvals/"+approvalID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, rr, http.StatusNoContent)

	doc = getDocumentApprovalFields(t, e, e.doc.ID, fixtureViewer)
	if doc.ApprovalStatus != "pending" {
		t.Fatalf("approval_status = %q, want pending after revoke", doc.ApprovalStatus)
	}

	// Revoking does not unassign: the approver can decide again.
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)
}

func TestRevokeOthersDecision(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	mustAssignApprover(t, e, e.doc.ID, "commenter@example.com", fixtureOwner)
	rr := submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer)
	assertStatus(t, rr, http.StatusCreated)
	approvalID := jsonField(t, rr.Body.Bytes(), "id")

	rr = do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/approvals/"+approvalID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusForbidden)
	assertJSON(t, rr.Body.Bytes(), `{
	  "error": { "code": "forbidden", "message": "you can only revoke your own decision" }
	}`)
}

func TestRevokeUnknownDecision(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	rr := do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/approvals/apv_missing", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, rr, http.StatusNotFound)
}

// ---------------------------------------------------------------------------
// Decision notes
// ---------------------------------------------------------------------------

// A reviewer with no comments of their own must still say what to change.
func TestRequestChangesRequiresNote(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)

	rr := submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "changes_requested", "", fixtureViewer)
	assertStatus(t, rr, http.StatusBadRequest)

	// Whitespace is not an explanation either.
	rr = submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "changes_requested", "   ", fixtureViewer)
	assertStatus(t, rr, http.StatusBadRequest)

	// The rejected decision must not have been recorded.
	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if list.Status != "pending" {
		t.Fatalf("status = %q, want pending after rejected decision", list.Status)
	}
}

// The commenter fixture already has one open comment thread on the document
// (e.cmt), so a request for changes needs no summary from them.
func TestRequestChangesNeedsNoSummaryWhenTheReviewerHasOpenComments(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "commenter@example.com", fixtureOwner)

	rr := submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "changes_requested", "", fixtureCommenter)
	assertStatus(t, rr, http.StatusCreated)

	list := listApprovals(t, e, e.doc.ID, "", fixtureOwner)
	if len(list.Items) != 1 || list.Items[0].CommentsOpen != 1 || list.Items[0].CommentsTotal != 1 {
		t.Fatalf("items = %+v, want 1 open of 1 comment for the reviewer", list.Items)
	}
}

func TestRequestChangesNeedsASummaryOnceTheReviewersCommentsAreResolved(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "commenter@example.com", fixtureOwner)
	rr := do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/comments/"+e.cmt.ID, `{"status":"resolved"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusOK)

	rr = submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "changes_requested", "", fixtureCommenter)
	assertStatus(t, rr, http.StatusBadRequest)
	if !strings.Contains(rr.Body.String(), "Add a comment on the document or a summary") {
		t.Fatalf("body = %s, want the add-a-comment-or-summary message", rr.Body.String())
	}
	// A summary is still enough on its own.
	rr = submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "changes_requested", "still needs a rollback plan", fixtureCommenter)
	assertStatus(t, rr, http.StatusCreated)

	list := listApprovals(t, e, e.doc.ID, "", fixtureOwner)
	if list.Items[0].CommentsOpen != 0 || list.Items[0].CommentsTotal != 1 {
		t.Fatalf("items = %+v, want 0 open of 1 comment after resolving", list.Items)
	}
}

func TestOnlyTheReviewersOwnCommentsCount(t *testing.T) {
	e := newTestEnv(t)
	// The only open comment on the document is the commenter's. A viewer who
	// is an approver has none of their own, so they still need to say why.
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	rr := submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "changes_requested", "", fixtureViewer)
	assertStatus(t, rr, http.StatusBadRequest)
}

func TestRequestChangesStoresNote(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)

	rr := submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "changes_requested", "  needs a rollback plan  ", fixtureViewer)
	assertStatus(t, rr, http.StatusCreated)
	if got := jsonField(t, rr.Body.Bytes(), "note"); got != "needs a rollback plan" {
		t.Fatalf("note = %q, want trimmed note", got)
	}

	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if len(list.Items) != 1 || list.Items[0].Note != "needs a rollback plan" {
		t.Fatalf("items = %+v, want the note on the decision", list.Items)
	}
}

func TestApproveAcceptsOptionalNote(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)

	// No note is fine when approving.
	assertStatus(t, submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "approved", "", fixtureViewer), http.StatusCreated)

	// And a note is kept when given.
	assertStatus(t, submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "approved", "ship it", fixtureViewer), http.StatusOK)
	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if len(list.Items) != 1 || list.Items[0].Note != "ship it" {
		t.Fatalf("items = %+v, want note on the approval", list.Items)
	}
}

func TestApprovalNoteTooLong(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)

	long := strings.Repeat("x", 2001)
	assertStatus(t, submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "changes_requested", long, fixtureViewer), http.StatusBadRequest)
}

// ---------------------------------------------------------------------------
// Version scoping
// ---------------------------------------------------------------------------

func TestListApprovalsUnknownVersionIsNotFound(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)

	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/approvals?version=ver_doesnotexist", "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, rr, http.StatusNotFound)
}

func TestListApprovalsForeignVersionIsNotFound(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)

	// A real version that belongs to a different document must not be
	// reported as an all-pending state on this one.
	_, otherVersion, err := e.store.CreateDocument(context.Background(), fixtureOwner, "other doc", []byte("<html><body>other</body></html>"))
	if err != nil {
		t.Fatalf("create second document: %v", err)
	}
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/approvals?version="+otherVersion.ID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, rr, http.StatusNotFound)
}

func TestCarriedApprovalReportsSourceVersionNumber(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)

	pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, true, fixtureEditor)

	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if len(list.Items) != 1 {
		t.Fatalf("items = %+v, want one", list.Items)
	}
	item := list.Items[0]
	if item.CarriedFromVersionID != e.ver.ID {
		t.Fatalf("carried_from_version_id = %q, want %q", item.CarriedFromVersionID, e.ver.ID)
	}
	if item.CarriedFromVersionNumber != 1 {
		t.Fatalf("carried_from_version_number = %d, want 1", item.CarriedFromVersionNumber)
	}
}

func TestSearchResultsIncludeApprovalSummary(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)

	// The same document must not lose its approval status just because it was
	// reached through a search query instead of the plain listing.
	rr := do(t, e.h, http.MethodGet, "/v1/documents?q="+url.QueryEscape(e.doc.Title), "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, rr, http.StatusOK)
	var out struct {
		Items []documentApprovalFields `json:"items"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &out); err != nil {
		t.Fatalf("bad search response: %v; body=%s", err, rr.Body.String())
	}
	if len(out.Items) == 0 {
		t.Fatalf("search returned no documents; body=%s", rr.Body.String())
	}
	if out.Items[0].ApprovalStatus != "approved" {
		t.Fatalf("approval_status = %q, want approved in search results", out.Items[0].ApprovalStatus)
	}
}

// ---------------------------------------------------------------------------
// Who may approve, and what a new version does to approvals
// ---------------------------------------------------------------------------

func TestCreatorOfTheFirstVersionCannotBeAssignedAsApprover(t *testing.T) {
	e := newTestEnv(t)
	// The owner uploaded version 1, so they wrote what is under review.
	rr := assignApprover(t, e, e.doc.ID, `{"principal": {"type": "user", "email": "owner@example.com"}}`, fixtureOwner)
	assertStatus(t, rr, http.StatusBadRequest)
	if !strings.Contains(rr.Body.String(), "created a version of this document") {
		t.Fatalf("body = %s, want the created-a-version message", rr.Body.String())
	}
}

func TestEditorWhoPushedAVersionCannotBeAssignedAsApprover(t *testing.T) {
	e := newTestEnv(t)
	pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, false, fixtureEditor)

	rr := assignApprover(t, e, e.doc.ID, `{"principal": {"type": "user", "email": "editor@example.com"}}`, fixtureOwner)
	assertStatus(t, rr, http.StatusBadRequest)
	if list := listApprovals(t, e, e.doc.ID, "", fixtureOwner); len(list.Items) != 0 {
		t.Fatalf("items = %+v, want no approver assigned", list.Items)
	}
}

func TestApproverWhoThenCreatesAVersionCannotDecide(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "editor@example.com", fixtureOwner)
	second := pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, false, fixtureEditor)

	for _, decision := range []string{"approved", "changes_requested"} {
		rr := submitApproval(t, e, e.doc.ID, second, decision, fixtureEditor)
		assertStatus(t, rr, http.StatusForbidden)
	}
	list := listApprovals(t, e, e.doc.ID, "", fixtureOwner)
	if len(list.Items) != 1 || list.Items[0].Decision != nil || !list.Items[0].CreatedVersion {
		t.Fatalf("items = %+v, want a pending approver flagged created_version", list.Items)
	}
}

func TestDecisionIsNotCarriedOntoAVersionItsApproverCreated(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "editor@example.com", fixtureOwner)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	// The editor has not created a version yet, so they may approve version 1.
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureEditor), http.StatusCreated)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)

	pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, true, fixtureEditor)

	decided := map[string]bool{}
	for _, item := range listApprovals(t, e, e.doc.ID, "", fixtureOwner).Items {
		decided[item.Approver.Email] = item.Decision != nil
	}
	if decided["editor@example.com"] {
		t.Fatalf("the editor's approval was carried onto the version they created: %+v", decided)
	}
	if !decided["viewer@example.com"] {
		t.Fatalf("the viewer's approval was not carried with keep_approvals: %+v", decided)
	}
}

func TestIdenticalContentKeepsApprovals(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	const html = "<html><body>final</body></html>"
	second := pushApprovalTestVersionHTML(t, e, e.doc.ID, e.ver.ID, html, false, fixtureEditor)
	assertStatus(t, submitApproval(t, e, e.doc.ID, second, "approved", fixtureViewer), http.StatusCreated)

	// Nothing changed, so there is nothing new to approve.
	third := pushApprovalTestVersionHTML(t, e, e.doc.ID, second, html, false, fixtureEditor)

	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if list.VersionID != third || list.Status != "approved" {
		t.Fatalf("list = %+v, want approved on %s", list, third)
	}
	if list.Items[0].CarriedFromVersionID != second {
		t.Fatalf("carried_from_version_id = %q, want %q", list.Items[0].CarriedFromVersionID, second)
	}
}

func TestChangedContentResetsApprovalsUnlessKept(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)

	second := pushApprovalTestVersionHTML(t, e, e.doc.ID, e.ver.ID, "<html><body>two</body></html>", false, fixtureEditor)
	if list := listApprovals(t, e, e.doc.ID, "", fixtureViewer); list.Status != "pending" {
		t.Fatalf("status = %q on %s, want pending after a change", list.Status, second)
	}
}

func TestDecisionOnASupersededVersionIsRefused(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	second := pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, false, fixtureEditor)

	// The approver was reading version 1 when version 2 was pushed.
	rr := submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer)
	assertStatus(t, rr, http.StatusConflict)
	var body struct {
		Error struct {
			Code    string `json:"code"`
			Details struct {
				CurrentVersionID string `json:"current_version_id"`
			} `json:"details"`
		} `json:"error"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("bad error body: %v; body=%s", err, rr.Body.String())
	}
	if body.Error.Code != "version_superseded" || body.Error.Details.CurrentVersionID != second {
		t.Fatalf("error = %+v, want version_superseded pointing at %s", body.Error, second)
	}
	if old := listApprovals(t, e, e.doc.ID, e.ver.ID, fixtureViewer); old.Items[0].Decision != nil {
		t.Fatalf("a decision was recorded on the superseded version: %+v", old.Items)
	}
	// The latest version still takes decisions.
	assertStatus(t, submitApproval(t, e, e.doc.ID, second, "approved", fixtureViewer), http.StatusCreated)
}

func TestApprovalsNameTheVersionTheyAreOn(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	rr := submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer)
	assertStatus(t, rr, http.StatusCreated)
	var decision struct {
		VersionNumber int    `json:"version_number"`
		VersionSHA256 string `json:"version_sha256"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &decision); err != nil {
		t.Fatalf("bad approval response: %v", err)
	}
	if decision.VersionNumber != e.ver.Number || decision.VersionSHA256 != e.ver.SHA256 || decision.VersionSHA256 == "" {
		t.Fatalf("decision = %+v, want version %d with sha %q", decision, e.ver.Number, e.ver.SHA256)
	}
	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if list.VersionNumber != e.ver.Number || list.VersionSHA256 != e.ver.SHA256 {
		t.Fatalf("list names version %d (%q), want %d (%q)", list.VersionNumber, list.VersionSHA256, e.ver.Number, e.ver.SHA256)
	}
}
