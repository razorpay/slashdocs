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

// submitApproval posts a decision as the given principal. A rejection needs a
// note, so a default one is supplied; use submitApprovalWithNote to control it
// (including sending none).
func submitApproval(t *testing.T, e *testEnv, docID, versionID, decision string, as auth.Principal) *httptest.ResponseRecorder {
	t.Helper()
	note := ""
	if decision == "rejected" {
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

// pushApprovalTestVersion uploads a new version with changed content and
// returns its id.
func pushApprovalTestVersion(t *testing.T, e *testEnv, docID, baseVersionID string, as auth.Principal) string {
	t.Helper()
	return pushApprovalTestVersionHTML(t, e, docID, baseVersionID, "<html><body>updated</body></html>", as)
}

// pushApprovalTestVersionHTML uploads a new version with the given content.
func pushApprovalTestVersionHTML(t *testing.T, e *testEnv, docID, baseVersionID, html string, as auth.Principal) string {
	t.Helper()
	body, contentType := multipartBody(t, map[string]string{"base_version_id": baseVersionID, "change_summary": "update"}, "file", "doc.html", html)
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
	Decision      *string `json:"decision"`
	Note          string  `json:"note"`
	DecidedAt     string  `json:"decided_at"`
	VersionID     string  `json:"version_id"`
	VersionNumber int     `json:"version_number"`
	CommentsOpen  int     `json:"comments_open"`
	CommentsTotal int     `json:"comments_total"`
	Earlier       *struct {
		Decision  string `json:"decision"`
		DecidedAt string `json:"decided_at"`
	} `json:"earlier"`
}

type approvalsListResponse struct {
	VersionID     string `json:"version_id"`
	VersionNumber int    `json:"version_number"`
	VersionSHA256 string `json:"version_sha256"`
	Status        string `json:"status"`
	Summary       struct {
		Total    int `json:"total"`
		Approved int `json:"approved"`
		Rejected int `json:"rejected"`
		Pending  int `json:"pending"`
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
		Total    int `json:"total"`
		Approved int `json:"approved"`
		Rejected int `json:"rejected"`
		Pending  int `json:"pending"`
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
	  "error": { "code": "approver_no_access", "message": "That person can't open this document. Share it with them first." }
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
	if out.VersionID != e.ver.ID || out.VersionNumber != e.ver.Number {
		t.Fatalf("decision must name the version it was made on: %s", rr.Body.String())
	}

	after := scrapeMetric(t, "slashdocs_approval_events_total", map[string]string{"event": "decided", "decision": "approved"})
	if after != before+1 {
		t.Fatalf("decided metric = %v, want %v", after, before+1)
	}
}

func TestServiceAccountApprover(t *testing.T) {
	e := newTestEnv(t)
	// The fixture service account belongs to the owner, who wrote version 1, so
	// the approver is a bot of someone else.
	sa, err := e.store.CreateServiceAccount(context.Background(), fixtureStranger, "reviewer-bot")
	if err != nil {
		t.Fatal(err)
	}
	grantServiceAccountViewer(t, e, sa.ID)

	rr := assignApprover(t, e, e.doc.ID, fmt.Sprintf(`{"principal": {"type": "service_account", "id": %q}}`, sa.ID), fixtureOwner)
	assertStatus(t, rr, http.StatusCreated)

	saPrincipal := auth.Principal{Type: auth.PrincipalServiceAccount, ID: sa.ID}
	rr = submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", saPrincipal)
	assertStatus(t, rr, http.StatusCreated)

	doc := getDocumentApprovalFields(t, e, e.doc.ID, fixtureOwner)
	if doc.ApprovalStatus != "approved" {
		t.Fatalf("approval_status = %q, want approved", doc.ApprovalStatus)
	}
}

func grantServiceAccountViewer(t *testing.T, e *testEnv, saID string) {
	t.Helper()
	rr := do(t, e.h, http.MethodPost, "/v1/documents/"+e.doc.ID+"/grants", fmt.Sprintf(`{
	  "principal": { "type": "service_account", "id": %q },
	  "role": "viewer"
	}`, saID), map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureOwner),
	})
	assertStatus(t, rr, http.StatusCreated)
}

func TestReject(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)

	rr := submitApproval(t, e, e.doc.ID, e.ver.ID, "rejected", fixtureViewer)
	assertStatus(t, rr, http.StatusCreated)

	doc := getDocumentApprovalFields(t, e, e.doc.ID, fixtureOwner)
	if doc.ApprovalStatus != "rejected" {
		t.Fatalf("approval_status = %q, want rejected", doc.ApprovalStatus)
	}
}

func TestChangeDecisionUpserts(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)

	rr := submitApproval(t, e, e.doc.ID, e.ver.ID, "rejected", fixtureViewer)
	assertStatus(t, rr, http.StatusOK)

	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if len(list.Items) != 1 {
		t.Fatalf("items = %+v, want exactly one", list.Items)
	}
	if list.Items[0].Decision == nil || *list.Items[0].Decision != "rejected" {
		t.Fatalf("decision = %v, want rejected", list.Items[0].Decision)
	}
	if list.Status != "rejected" {
		t.Fatalf("status = %q, want rejected", list.Status)
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
	  "error": { "code": "bad_request", "message": "decision must be \"approved\" or \"rejected\"" }
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
	if list.Summary.Total != 2 || list.Summary.Approved != 1 || list.Summary.Pending != 1 || list.Summary.Rejected != 0 {
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
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "rejected", fixtureViewer), http.StatusCreated)
	pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, fixtureEditor)

	historical := listApprovals(t, e, e.doc.ID, e.ver.ID, fixtureViewer)
	if historical.VersionID != e.ver.ID || historical.Status != "rejected" {
		t.Fatalf("historical = %+v, want rejected on %s", historical, e.ver.ID)
	}

	current := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if current.Status != "pending" {
		t.Fatalf("current status = %q, want pending", current.Status)
	}
	// The pending approver still shows what they decided before the change.
	if got := current.Items[0]; got.Decision != nil || got.Earlier == nil || got.Earlier.Decision != "rejected" || got.Earlier.DecidedAt == "" {
		t.Fatalf("current item = %+v, want pending with an earlier rejection", got)
	}
	if historical.Items[0].Earlier != nil {
		t.Fatalf("historical item = %+v, want no earlier decision beside the decision", historical.Items[0])
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
// Decisions follow content
// ---------------------------------------------------------------------------

func TestChangedContentResetsApprovals(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)

	pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, fixtureEditor)

	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if list.Status != "pending" {
		t.Fatalf("status = %q, want pending after a change of content", list.Status)
	}
	if len(list.Items) != 1 || list.Items[0].Decision != nil {
		t.Fatalf("items = %+v, want pending approver after reset", list.Items)
	}
}

func TestIdenticalContentKeepsDecisions(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	mustAssignApprover(t, e, e.doc.ID, "commenter@example.com", fixtureOwner)
	const html = "<html><body>final</body></html>"
	second := pushApprovalTestVersionHTML(t, e, e.doc.ID, e.ver.ID, html, fixtureEditor)
	assertStatus(t, submitApproval(t, e, e.doc.ID, second, "approved", fixtureViewer), http.StatusCreated)
	assertStatus(t, submitApproval(t, e, e.doc.ID, second, "rejected", fixtureCommenter), http.StatusCreated)

	// Nothing changed, so there is nothing new to decide.
	third := pushApprovalTestVersionHTML(t, e, e.doc.ID, second, html, fixtureEditor)

	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if list.VersionID != third || list.Status != "rejected" || list.Summary.Approved != 1 || list.Summary.Rejected != 1 {
		t.Fatalf("list = %+v, want one approval and one rejection on %s", list, third)
	}
	for _, item := range list.Items {
		if item.VersionID != second || item.VersionNumber != 2 {
			t.Fatalf("item = %+v, want the decision to name version 2 (%s)", item, second)
		}
	}
}

func TestRevertedContentRestoresApprovals(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)
	html, err := e.store.GetVersionHTML(context.Background(), e.ver.ID)
	if err != nil {
		t.Fatal(err)
	}

	second := pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, fixtureEditor)
	third := pushApprovalTestVersionHTML(t, e, e.doc.ID, second, string(html), fixtureEditor)

	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if list.VersionID != third || list.Status != "approved" {
		t.Fatalf("list = %+v, want the version 1 approval back on %s", list, third)
	}
	if item := list.Items[0]; item.VersionID != e.ver.ID || item.VersionNumber != 1 {
		t.Fatalf("item = %+v, want the decision to name version 1", item)
	}
}

func TestDecidingAgainOnTheSameContentReplacesTheDecision(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	html, err := e.store.GetVersionHTML(context.Background(), e.ver.ID)
	if err != nil {
		t.Fatal(err)
	}
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)
	second := pushApprovalTestVersionHTML(t, e, e.doc.ID, e.ver.ID, string(html), fixtureEditor)

	// The approver reviews the same content again from version 2.
	assertStatus(t, submitApprovalWithNote(t, e, e.doc.ID, second, "approved", "still good", fixtureViewer), http.StatusOK)

	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if len(list.Items) != 1 || list.Items[0].VersionID != second || list.Items[0].Note != "still good" {
		t.Fatalf("items = %+v, want one decision on %s", list.Items, second)
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
func TestRejectionRequiresNote(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)

	rr := submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "rejected", "", fixtureViewer)
	assertStatus(t, rr, http.StatusBadRequest)

	// Whitespace is not an explanation either.
	rr = submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "rejected", "   ", fixtureViewer)
	assertStatus(t, rr, http.StatusBadRequest)

	// The rejected decision must not have been recorded.
	list := listApprovals(t, e, e.doc.ID, "", fixtureViewer)
	if list.Status != "pending" {
		t.Fatalf("status = %q, want pending after rejected decision", list.Status)
	}
}

// The commenter fixture already has one open comment thread on the document
// (e.cmt), so a rejection needs no reason from them.
func TestRejectionNeedsNoReasonWhenTheReviewerHasOpenComments(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "commenter@example.com", fixtureOwner)

	rr := submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "rejected", "", fixtureCommenter)
	assertStatus(t, rr, http.StatusCreated)

	list := listApprovals(t, e, e.doc.ID, "", fixtureOwner)
	if len(list.Items) != 1 || list.Items[0].CommentsOpen != 1 || list.Items[0].CommentsTotal != 1 {
		t.Fatalf("items = %+v, want 1 open of 1 comment for the reviewer", list.Items)
	}
}

func TestRejectionNeedsAReasonOnceTheReviewersCommentsAreResolved(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "commenter@example.com", fixtureOwner)
	rr := do(t, e.h, http.MethodPatch, "/v1/documents/"+e.doc.ID+"/comments/"+e.cmt.ID, `{"status":"resolved"}`, map[string]string{
		"Content-Type":     "application/json",
		"X-Test-Principal": principalHeader(fixtureCommenter),
	})
	assertStatus(t, rr, http.StatusOK)

	rr = submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "rejected", "", fixtureCommenter)
	assertStatus(t, rr, http.StatusBadRequest)
	if !strings.Contains(rr.Body.String(), "Add a comment on the document or a reason") {
		t.Fatalf("body = %s, want the add-a-comment-or-reason message", rr.Body.String())
	}
	// A reason is still enough on its own.
	rr = submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "rejected", "still needs a rollback plan", fixtureCommenter)
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
	rr := submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "rejected", "", fixtureViewer)
	assertStatus(t, rr, http.StatusBadRequest)
}

func TestRejectionStoresNote(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)

	rr := submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "rejected", "  needs a rollback plan  ", fixtureViewer)
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
	assertStatus(t, submitApprovalWithNote(t, e, e.doc.ID, e.ver.ID, "rejected", long, fixtureViewer), http.StatusBadRequest)
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
	_, otherVersion, err := e.store.CreateDocument(context.Background(), fixtureOwner, "other doc", "", []byte("<html><body>other</body></html>"))
	if err != nil {
		t.Fatalf("create second document: %v", err)
	}
	rr := do(t, e.h, http.MethodGet, "/v1/documents/"+e.doc.ID+"/approvals?version="+otherVersion.ID, "", map[string]string{
		"X-Test-Principal": principalHeader(fixtureViewer),
	})
	assertStatus(t, rr, http.StatusNotFound)
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
	if !strings.Contains(rr.Body.String(), "That person edited this document") {
		t.Fatalf("body = %s, want the edited-this-document message", rr.Body.String())
	}
}

func TestEditorWhoPushedAVersionCannotBeAssignedAsApprover(t *testing.T) {
	e := newTestEnv(t)
	pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, fixtureEditor)

	rr := assignApprover(t, e, e.doc.ID, `{"principal": {"type": "user", "email": "editor@example.com"}}`, fixtureOwner)
	assertStatus(t, rr, http.StatusBadRequest)
	if list := listApprovals(t, e, e.doc.ID, "", fixtureOwner); len(list.Items) != 0 {
		t.Fatalf("items = %+v, want no approver assigned", list.Items)
	}
}

// An approver who pushes a version wrote part of what is under review, so the
// push removes them as an approver, with their decisions.
func TestApproverWhoCreatesAVersionIsRemoved(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "editor@example.com", fixtureOwner)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	// The editor has not created a version yet, so they may approve version 1.
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureEditor), http.StatusCreated)

	second := pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, fixtureEditor)

	list := listApprovals(t, e, e.doc.ID, "", fixtureOwner)
	if len(list.Items) != 1 || list.Items[0].Approver.Email != "viewer@example.com" || list.Status != "pending" {
		t.Fatalf("list = %+v, want only the viewer, pending", list)
	}
	for _, decision := range []string{"approved", "rejected"} {
		rr := submitApproval(t, e, e.doc.ID, second, decision, fixtureEditor)
		assertStatus(t, rr, http.StatusForbidden)
		if !strings.Contains(rr.Body.String(), "You edited this document") {
			t.Fatalf("body = %s, want the edited-this-document message", rr.Body.String())
		}
	}
}

// An edit that its author undoes, back to the content before it, changes
// nothing under review. So a stray key does not stop an editor from
// approving, but an edit that stays does.
func TestEditThatItsAuthorUndoesDoesNotMakeAnAuthor(t *testing.T) {
	e := newTestEnv(t)
	html, err := e.store.GetVersionHTML(context.Background(), e.ver.ID)
	if err != nil {
		t.Fatal(err)
	}
	typed := pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, fixtureEditor)
	undone := pushApprovalTestVersionHTML(t, e, e.doc.ID, typed, string(html), fixtureEditor)
	mustAssignApprover(t, e, e.doc.ID, "editor@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, undone, "approved", fixtureEditor), http.StatusCreated)

	// An undo after another person's edit does not undo that edit.
	theirs := pushApprovalTestVersionHTML(t, e, e.doc.ID, undone, "<html><body>theirs</body></html>", fixtureOwner)
	pushApprovalTestVersionHTML(t, e, e.doc.ID, theirs, string(html), fixtureEditor)
	if list := listApprovals(t, e, e.doc.ID, "", fixtureOwner); len(list.Items) != 0 {
		t.Fatalf("items = %+v, want the editor removed", list.Items)
	}
}

// An approver's stray edit removes them, with their decisions. Its undo
// gives both back, so that the stray edit costs no approval.
func TestUndoOfAnApproversEditRestoresTheirApproval(t *testing.T) {
	e := newTestEnv(t)
	html, err := e.store.GetVersionHTML(context.Background(), e.ver.ID)
	if err != nil {
		t.Fatal(err)
	}
	mustAssignApprover(t, e, e.doc.ID, "editor@example.com", fixtureOwner)
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureEditor), http.StatusCreated)

	typed := pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, fixtureEditor)
	if list := listApprovals(t, e, e.doc.ID, "", fixtureOwner); len(list.Items) != 0 {
		t.Fatalf("items = %+v, want the editor removed by their edit", list.Items)
	}
	undone := pushApprovalTestVersionHTML(t, e, e.doc.ID, typed, string(html), fixtureEditor)

	list := listApprovals(t, e, e.doc.ID, "", fixtureOwner)
	if list.VersionID != undone || list.Status != "approved" || len(list.Items) != 1 || list.Items[0].VersionID != e.ver.ID {
		t.Fatalf("list = %+v, want the editor's version 1 approval back on %s", list, undone)
	}
}

// A service account works for its owner, so a version that a person's bot
// pushes is that person's work too.
func TestApproverWhoseBotCreatesAVersionIsRemoved(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	sa, err := e.store.CreateServiceAccount(ctx, fixtureEditor, "editor-bot")
	if err != nil {
		t.Fatal(err)
	}
	bot := auth.Principal{Type: auth.PrincipalServiceAccount, ID: sa.ID}
	if _, err := e.store.CreateGrant(ctx, "document", e.doc.ID, bot, "editor", fixtureOwner); err != nil {
		t.Fatal(err)
	}
	mustAssignApprover(t, e, e.doc.ID, "editor@example.com", fixtureOwner)

	second := pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, bot)

	if list := listApprovals(t, e, e.doc.ID, "", fixtureOwner); len(list.Items) != 0 {
		t.Fatalf("items = %+v, want the bot's owner removed", list.Items)
	}
	assertStatus(t, submitApproval(t, e, e.doc.ID, second, "approved", fixtureEditor), http.StatusForbidden)
	rr := assignApprover(t, e, e.doc.ID, `{"principal": {"type": "user", "email": "editor@example.com"}}`, fixtureOwner)
	assertStatus(t, rr, http.StatusBadRequest)
}

func TestBotOfTheCreatorCannotBeAssignedAsApprover(t *testing.T) {
	e := newTestEnv(t)
	// The fixture service account belongs to the owner, who uploaded version 1.
	grantServiceAccountViewer(t, e, e.sa.ID)
	rr := assignApprover(t, e, e.doc.ID, fmt.Sprintf(`{"principal": {"type": "service_account", "id": %q}}`, e.sa.ID), fixtureOwner)
	assertStatus(t, rr, http.StatusBadRequest)
	if !strings.Contains(rr.Body.String(), "That person edited this document") {
		t.Fatalf("body = %s, want the edited-this-document message", rr.Body.String())
	}
}

// An approver who cannot read the document cannot decide, so revoking the
// grant they read it through removes them, with their decisions. An approver
// who still has access through another grant stays.
func TestApproverWhoLosesAccessIsRemoved(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	owner := principalHeader(fixtureOwner)
	folderID := createFolder(t, e, `{"title":"Reviews"}`, owner)
	if _, err := e.store.MoveDocumentToFolder(ctx, fixtureOwner, folderID, e.doc.ID); err != nil {
		t.Fatal(err)
	}
	rr := do(t, e.h, http.MethodPost, "/v1/folders/"+folderID+"/grants",
		`{"address":"`+fixtureStranger.Email+`","role":"viewer"}`,
		map[string]string{"X-Test-Principal": owner, "Content-Type": "application/json"})
	assertStatus(t, rr, http.StatusCreated)
	folderGrantID := jsonField(t, rr.Body.Bytes(), "id")
	for _, email := range []string{"viewer@example.com", "commenter@example.com", "stranger@example.com"} {
		mustAssignApprover(t, e, e.doc.ID, email, fixtureOwner)
	}
	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)

	grants, err := e.store.ListGrants(ctx, e.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, grant := range grants {
		if grant.Principal.ID == fixtureViewer.ID {
			rr := do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/grants/"+grant.ID, "", map[string]string{"X-Test-Principal": owner})
			assertStatus(t, rr, http.StatusNoContent)
		}
	}
	rr = do(t, e.h, http.MethodDelete, "/v1/folders/"+folderID+"/grants/"+folderGrantID, "", map[string]string{"X-Test-Principal": owner})
	assertStatus(t, rr, http.StatusNoContent)

	list := listApprovals(t, e, e.doc.ID, "", fixtureOwner)
	if len(list.Items) != 1 || list.Items[0].Approver.Email != "commenter@example.com" || list.Summary.Approved != 0 {
		t.Fatalf("list = %+v, want only the commenter, pending", list)
	}
}

// The owner of a folder can read what is inside it without a grant, so a
// revoked grant does not remove them as an approver.
func TestFolderOwnerApproverStaysWhenAGrantIsRevoked(t *testing.T) {
	e := newTestEnv(t)
	ctx := context.Background()
	folderID := createFolder(t, e, `{"title":"Theirs"}`, principalHeader(fixtureStranger))
	if _, err := e.store.MoveDocumentToFolder(ctx, fixtureOwner, folderID, e.doc.ID); err != nil {
		t.Fatal(err)
	}
	mustAssignApprover(t, e, e.doc.ID, fixtureStranger.Email, fixtureOwner)

	grants, err := e.store.ListGrants(ctx, e.doc.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, grant := range grants {
		if grant.Principal.ID == fixtureViewer.ID {
			rr := do(t, e.h, http.MethodDelete, "/v1/documents/"+e.doc.ID+"/grants/"+grant.ID, "", map[string]string{"X-Test-Principal": principalHeader(fixtureOwner)})
			assertStatus(t, rr, http.StatusNoContent)
		}
	}

	list := listApprovals(t, e, e.doc.ID, "", fixtureOwner)
	if len(list.Items) != 1 || list.Items[0].Approver.Email != fixtureStranger.Email {
		t.Fatalf("list = %+v, want the folder owner to stay an approver", list)
	}
}

func TestDecisionOnReplacedContentIsRefused(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	second := pushApprovalTestVersion(t, e, e.doc.ID, e.ver.ID, fixtureEditor)

	// The approver was reading version 1 when version 2 changed the content.
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
		t.Fatalf("a decision was recorded on the replaced content: %+v", old.Items)
	}
	// The latest version still takes decisions.
	assertStatus(t, submitApproval(t, e, e.doc.ID, second, "approved", fixtureViewer), http.StatusCreated)
}

// A version that is no longer the latest still takes a decision when the
// latest version has the same content: the approver read what is current.
func TestDecisionOnAnOlderVersionWithTheSameContentCounts(t *testing.T) {
	e := newTestEnv(t)
	mustAssignApprover(t, e, e.doc.ID, "viewer@example.com", fixtureOwner)
	html, err := e.store.GetVersionHTML(context.Background(), e.ver.ID)
	if err != nil {
		t.Fatal(err)
	}
	pushApprovalTestVersionHTML(t, e, e.doc.ID, e.ver.ID, string(html), fixtureEditor)

	assertStatus(t, submitApproval(t, e, e.doc.ID, e.ver.ID, "approved", fixtureViewer), http.StatusCreated)
	if doc := getDocumentApprovalFields(t, e, e.doc.ID, fixtureViewer); doc.ApprovalStatus != "approved" {
		t.Fatalf("approval_status = %q, want approved", doc.ApprovalStatus)
	}
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
