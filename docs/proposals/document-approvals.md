# Document Approvals

**Date:** 2026-07-13 (updated 2026-07-16)
**Status:** Draft
**Author:** Manas Kinkar

## Decision Log

| Date       | Decision                                                              | Context                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-13 | Dedicated tables over KV or grants (Approach A)                       | Brainstorm: approvals are a distinct domain concept                                                                                                                                                        |
| 2026-07-16 | Confirmed: first-class flow, not a KV convention                      | Maintainer review (Slack): KV satisfies ~60% of requirements; per-action authorization, version-scoping, server-derived status, and atomic cleanup all need server enforcement. See "Why not KV" appendix. |
| 2026-07-16 | Notifications fully out of scope                                      | Maintainer: notifications will start with comment mentions only; the HTML notify primitive idea is dropped                                                                                                 |
| 2026-07-16 | Approved decisions carry forward across versions (replaces reset-all) | Maintainer concern: every small edit is a new version in aidocs; resetting all approvals on each push erodes the credibility of the system because people won't chase re-approvals                         |

## Summary

Add optional, version-scoped document approvals to aidocs. Document owners assign approvers; approvers submit decisions (approved / changes requested) against specific versions. The document's approval status is derived from the current version's decisions. Approved decisions carry forward automatically when a new version is pushed; only approvers who requested changes (or never decided) need to act on the new version.

## Requirements

- Only the document owner can assign or remove approvers.
- Approvers must already have viewer+ access on the document.
- Approvers can approve or request changes on a specific version.
- All assigned approvers must approve for the document status to be "approved."
- Approvals are version-scoped — decisions are recorded against a specific version ID; history is preserved.
- On a new version, approved decisions **carry forward** (with provenance); changes-requested decisions reset to pending.
- The author can force a full re-review on push (`--reset-approvals`) for significant changes.
- An approver can change their decision on a given version (upsert) or **revoke** it entirely (back to pending).
- Approval is entirely optional. Documents without approvers have no approval status.
- Service accounts can be assigned as approvers for agent workflows.

## Version Semantics (Carry-Forward)

What happens to each decision when the author pushes a new version:

| Decision on previous version | Push (default)                           | Push with `--reset-approvals` |
| ---------------------------- | ---------------------------------------- | ----------------------------- |
| approved                     | Carried to new version (provenance kept) | pending                       |
| changes_requested            | pending (author presumably addressed it) | pending                       |
| (no decision)                | pending                                  | pending                       |

Rules:

- Carried rows are real `approvals` rows on the new version, created in the same transaction as the version insert. `decided_at` keeps the original decision time; `carried_from_version_id` points to the version where the **explicit** decision was made (propagates through chains: v3 → v4 → v5 still points at v3).
- Any approver can revoke their decision at any time (`DELETE`), returning themselves to pending. This is the safety valve for "all approved, then author pushed a big change that auto-carried."
- Trade-off accepted: a changes-requested decision is cleared by any push (like GitHub's dismiss-stale-reviews). The author can't push their way to "approved" though — that still requires every approver's explicit or carried approval.

## Data Model

Two new tables:

```
┌──────────────────────────────────────────────┐
│              approval_requests               │
├──────────────────────────────────────────────┤
│ id               TEXT PK (apr_xxx)           │
│ document_id      TEXT FK → documents         │
│ approver_type    TEXT (user | sa)            │
│ approver_id      TEXT                        │
│ requested_by_type TEXT                        │
│ assigned_by_id   TEXT                        │
│ created_at       TIMESTAMPTZ                 │
├──────────────────────────────────────────────┤
│ UNIQUE(document_id, approver_type,           │
│        approver_id)                          │
└──────────────────────────────────────────────┘

┌──────────────────────────────────────────────┐
│                 approvals                    │
├──────────────────────────────────────────────┤
│ id                      TEXT PK (apv_xxx)    │
│ document_id             TEXT FK → documents  │
│ version_id              TEXT FK → versions   │
│ approver_type           TEXT                 │
│ approver_id             TEXT                 │
│ decision                TEXT (approved |     │
│                         changes_requested)   │
│ decided_at              TIMESTAMPTZ          │
│ carried_from_version_id TEXT NULL            │
│                         FK → versions        │
│                         ON DELETE SET NULL   │
├──────────────────────────────────────────────┤
│ UNIQUE(version_id, approver_type,            │
│        approver_id)                          │
└──────────────────────────────────────────────┘
```

### Derived document status

Computed at query time, not stored:

| Condition                                                                        | Status                          |
| -------------------------------------------------------------------------------- | ------------------------------- |
| No approval_requests exist                                                       | `null` (no approval configured) |
| Current version has all approvers with decision "approved" (explicit or carried) | `"approved"`                    |
| Any decision on current version is "changes_requested"                           | `"changes_requested"`           |
| Otherwise (some or all pending)                                                  | `"pending"`                     |

### Relationship to existing model

```
documents ──1:N──► approval_requests (who should approve)
                        │
documents ──1:N──► approvals (per-version decisions)
    │                   │
versions ──1:N─────────┘
```

- `approval_requests` is version-independent — the set of approvers survives new versions.
- `approvals` is version-scoped — audit trail per version; carry-forward copies rows.
- Deleting a document CASCADEs to both tables.
- Deleting an approval request also deletes all approval rows for that approver on that document (app-level DELETE, not FK CASCADE — the two tables are siblings, not parent-child).

## API

### Approval Requests (who should approve)

```
POST   /v1/documents/:id/approvers          assign approver
GET    /v1/documents/:id/approvers          list assigned approvers
DELETE /v1/documents/:id/approvers/:apr_id  remove approver
```

### Approval Decisions (per-version verdicts)

```
POST   /v1/documents/:id/approvals          submit or update decision
GET    /v1/documents/:id/approvals          list decisions + summary
DELETE /v1/documents/:id/approvals/:apv_id  revoke own decision
```

### Version push

`POST /v1/documents/:id/versions` gains an optional multipart form field `reset_approvals=true` to skip carry-forward.

### Authorization

| Action                 | Required                            |
| ---------------------- | ----------------------------------- |
| Assign/remove approver | Owner role                          |
| List approvers         | Viewer+ role                        |
| Submit decision        | Assigned approver with viewer+ role |
| Revoke decision        | The decision's author only          |
| List decisions         | Viewer+ role                        |

### Request/Response Shapes

**Assign approver:**

```
POST /v1/documents/:id/approvers
Body: { "user_id": "usr_42" }
→ 201 { "id": "apr_1", "approver": {...}, "requested_by": {...} }
→ 400 invalid_approver (no viewer access) | 409 conflict (already assigned)
```

**Submit decision:**

```
POST /v1/documents/:id/approvals
Body: { "version_id": "ver_7", "decision": "approved" }
→ 201 (new) / 200 (updated) { "id": "apv_1", "version_id": "ver_7", "decision": "approved", ... }
→ 403 not an assigned approver | 400 invalid decision | 404 version not found
```

**Revoke decision:**

```
DELETE /v1/documents/:id/approvals/apv_1
→ 204 (own decision removed; approver back to pending)
→ 403 not your decision
```

**List decisions:**

```
GET /v1/documents/:id/approvals?version=ver_8
→ 200 {
    "version_id": "ver_8",
    "status": "pending",
    "summary": { "total": 3, "approved": 2, "changes_requested": 0, "pending": 1 },
    "items": [
      { "approver": {...}, "decision": "approved",
        "decided_at": "...", "carried_from_version_id": "ver_7" },
      { "approver": {...}, "decision": "approved", "decided_at": "..." },
      { "approver": {...}, "decision": null, "decided_at": null }
    ]
  }
```

**Enriched document response:**

```json
{
  "id": "doc_1",
  "title": "Tech Spec",
  "approval_status": "pending",
  "approval_summary": {
    "total": 3,
    "approved": 2,
    "changes_requested": 0,
    "pending": 1
  }
}
```

Both fields are omitted entirely (not null) when no approvers are assigned — backward compatible, zero-noise.

## Backend Implementation

### New files

| File                                             | Purpose          |
| ------------------------------------------------ | ---------------- |
| `api/internal/db/migrations/00018_approvals.sql` | Schema migration |
| `api/internal/server/handlers_approvals.go`      | 6 HTTP handlers  |

### Modified files

| File                                       | Change                                                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `api/internal/repo/repo.go`                | Types, 7 new Repository interface methods, carry-forward in `CreateVersion`, Memory impl                                                  |
| `api/internal/repo/postgres/postgres.go`   | Postgres impl (carry-forward inside the CreateVersion transaction)                                                                        |
| `api/internal/server/server.go`            | Register 6 routes                                                                                                                         |
| `api/internal/server/handlers_versions.go` | Parse `reset_approvals` form field                                                                                                        |
| `api/internal/server/metrics.go`           | Approval counters                                                                                                                         |
| `api/internal/server/server_test.go`       | Handler tests                                                                                                                             |
| `cli/internal/cmd_guidelines.go`           | Update `review`/`kv` guideline pages: native approvals are the recommended flow; KV `approval:*` examples become generic tracker examples |

Regenerate OpenAPI docs (`make swagger`) after handler annotations are added.

### Repository interface additions

```go
// Approval requests
CreateApprovalRequest(ctx, documentID string, approver, requestedBy auth.Principal) (ApprovalRequest, error)
ListApprovalRequests(ctx, documentID string) ([]ApprovalRequest, error)
DeleteApprovalRequest(ctx, documentID, requestID string) error

// Approval decisions
CreateOrUpdateApproval(ctx, documentID, versionID, decision string, approver auth.Principal) (Approval, error)
DeleteApproval(ctx, documentID, approvalID string, approver auth.Principal) error
ListApprovals(ctx, documentID, versionID string) ([]Approval, error)

// Derived summary (GetDocument / ListDocuments enrichment)
DocumentApprovalSummary(ctx, documentID, versionID string) (*ApprovalSummary, error)
```

Modified: `CreateVersion` gains a `resetApprovals bool` parameter. Unless set, it copies `decision = 'approved'` rows from the base version to the new version inside the same transaction, preserving `decided_at` and propagating the original `carried_from_version_id`.

Performance note: `ListDocuments` enrichment must be a single batched query (`GROUP BY document_id` over the page of documents), not one summary query per document.

`CreateOrUpdateApproval` is an upsert — changing your mind replaces the previous decision for that version.

### Migration

```sql
CREATE TABLE approval_requests (
    id               TEXT PRIMARY KEY,
    document_id      TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    approver_type    TEXT NOT NULL,
    approver_id      TEXT NOT NULL,
    requested_by_type TEXT NOT NULL,
    requested_by_id   TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(document_id, approver_type, approver_id)
);
CREATE INDEX idx_approval_requests_document ON approval_requests(document_id);

CREATE TABLE approvals (
    id                      TEXT PRIMARY KEY,
    document_id             TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    version_id              TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
    approver_type           TEXT NOT NULL,
    approver_id             TEXT NOT NULL,
    decision                TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
    decided_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    carried_from_version_id TEXT REFERENCES versions(id) ON DELETE SET NULL,
    UNIQUE(version_id, approver_type, approver_id)
);
CREATE INDEX idx_approvals_document ON approvals(document_id);
CREATE INDEX idx_approvals_version  ON approvals(version_id);
```

## CLI

```
slashdocs docs approvers list <doc_id>
slashdocs docs approvers add <doc_id> --user <user_id_or_email>
slashdocs docs approvers remove <doc_id> <apr_id>
slashdocs docs approvals list <doc_id> [--version <version_id>]
slashdocs docs approve <doc_id> [--version <version_id>]
slashdocs docs request-changes <doc_id> [--version <version_id>]
slashdocs docs revoke-approval <doc_id> [--version <version_id>]
slashdocs docs push <doc_id> <file> [--reset-approvals]
```

- `--version` defaults to the current version (or the version remembered from `slashdocs docs pull`).
- `approvals list` marks carried decisions: `approved (carried from ver_3)`.
- All commands support `--json`.

## Frontend

### UI components

1. **Status badge in DocBar** — "Approvals: Approved", "Approvals: Pending 1/3", "Approvals: Changes requested", or hidden when no approvers. The badge always names its subject and is itself the button that opens the approvals dialog.
2. **Approvals dialog** — a dedicated modal, _not_ a tab in the comments sidebar (maintainer review, 2026-09-04: approvals are a different concern from discussion). Per-approver status; action buttons for assigned approvers; add/remove controls for the owner.
3. **Add Approver field** — reuses the user search pattern from the share sheet and submits the raw address, so a bot (service-account) address resolves the same way an email does.
4. **Request-changes note** — requesting changes opens a short note form and will not submit while it is empty.

### Files

| File                                        | Change                                       |
| ------------------------------------------- | -------------------------------------------- |
| `frontend/src/pages/doc-bar.tsx`            | Approval status badge                        |
| `frontend/src/pages/doc-page.tsx`           | Comments sidebar left unchanged by approvals |
| New: `frontend/src/pages/doc-approvals.tsx` | Approvals dialog and status badge            |
| `frontend/src/pages/doc-upload-version.tsx` | "Reset approvals" checkbox on version upload |
| `frontend/src/api.ts`                       | Approval API methods                         |
| `frontend/src/lib/queryKeys.ts`             | Approval query keys                          |

### Behavior

- Optimistic updates (same pattern as comment resolve/reopen).
- Carried approvals display provenance: "✓ Approved (on v3)" with muted styling, so carried consent is visually distinct from an explicit review of the current version.
- An approver who has a decision sees a "Revoke" action returning them to pending.
- Viewing a historical version shows that version's approvals read-only.
- Tab label includes count: "Approvals (2/3)".

## Observability

| Metric                              | Type    | Labels                       | Description                              |
| ----------------------------------- | ------- | ---------------------------- | ---------------------------------------- |
| `slashdocs_approvers_total`            | Counter | `action` (assigned, removed) | Approver assignments/removals            |
| `slashdocs_approvals_total`            | Counter | `decision`, `actor_type`     | Decisions submitted                      |
| `slashdocs_approvals_carried_total`    | Counter | —                            | Approvals copied forward on version push |
| `slashdocs_approval_revocations_total` | Counter | `actor_type`                 | Decisions revoked                        |
| `slashdocs_approval_status_on_fetch`   | Counter | `status`                     | Status distribution at document GET      |

## Edge Cases

| Scenario                              | Behavior                                                                                                             | HTTP |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---- |
| Assign user without doc access        | Reject — "user must have viewer access"                                                                              | 400  |
| Assign same user twice                | Reject                                                                                                               | 409  |
| Owner assigns themselves              | Allowed                                                                                                              | 201  |
| Approver loses access (grant deleted) | Request stays; they can't view/act; counts as pending; owner should remove                                           | —    |
| Decision on non-current version       | Allowed; doc status only reflects current version                                                                    | 201  |
| Decision on non-existent version      | Not found                                                                                                            | 404  |
| Non-approver submits decision         | Forbidden                                                                                                            | 403  |
| Push new version (default)            | Approved decisions carried with provenance; changes_requested/pending → pending                                      | —    |
| Push with reset_approvals             | Nothing carried; everyone pending                                                                                    | —    |
| Carried chain v3→v4→v5                | `carried_from_version_id` always points to v3 (original explicit approval)                                           | —    |
| Approve races with concurrent push    | Decision lands on the old version; not carried (copy already ran); approver re-approves current. Visible in history. | 201  |
| Revoke own decision                   | Row deleted; approver back to pending; status recalculates                                                           | 204  |
| Revoke someone else's decision        | Forbidden                                                                                                            | 403  |
| Remove approver who already approved  | Request + all their approval rows deleted; summary recalculates                                                      | 204  |
| All approvers removed                 | Approval fields omitted from responses                                                                               | —    |
| Approve twice, same decision          | Upsert; updates decided_at, clears carried provenance (now explicit)                                                 | 200  |
| Change mind                           | Upsert replaces previous decision                                                                                    | 200  |
| Document deleted                      | CASCADE both tables                                                                                                  | —    |
| Version deleted                       | CASCADE approvals for it; carried_from references SET NULL                                                           | —    |
| Service account as approver           | Supported via approver_type                                                                                          | 201  |
| Invalid decision value                | Reject                                                                                                               | 400  |

## Testing

Handler tests (in-memory repo): assign/duplicate/no-access/not-owner; list ordering; delete-approver-cleans-decisions; approve/request-changes/upsert/not-approver/invalid-decision; list merges pending approvers with null decision; historical version listing; document response enrichment (present/omitted); status derivation (approved/changes_requested/pending).

Carry-forward tests:

- `TestNewVersion_CarriesApprovals` — approved rows copied, decided_at preserved, provenance set
- `TestNewVersion_DoesNotCarryChangesRequested` — requester resets to pending
- `TestNewVersion_ResetApprovalsFlag` — nothing carried
- `TestCarriedFrom_PropagatesOrigin` — chain points to original version
- `TestRevokeApproval_OwnDecision` / `TestRevokeApproval_OthersDecision`
- `TestExplicitReapproval_ClearsCarriedProvenance`

Postgres integration tests: unique constraints, CASCADE on document/version deletion, SET NULL on carried_from, upsert semantics, carry-forward inside CreateVersion transaction, summary correctness.

CLI E2E: full lifecycle including push-with-carry, revoke, `--reset-approvals`, JSON output.

## Migration & Rollout

- Migration is additive; no ALTER on existing tables; no backfill (existing docs have zero approvers).
- API fields omitted unless approvers assigned → backward compatible.
- Rollout order: migration (auto via goose) → backend → frontend + CLI (any order; feature is additive).

## Appendix: Why Not KV?

The maintainer asked whether the shipped document-KV feature could implement this. Analysis (from Slack review):

KV satisfies ~60% of requirements (storing decisions, upsert, optional, additive). It cannot satisfy:

- **Per-action authorization** — any editor can patch any KV key; approvals need owner-assigns / approver-decides / viewer-reads.
- **Version-scoping** — KV has no version dimension; key-name conventions (`approval:ver_7:usr_42`) are unenforceable and unqueryable server-side.
- **Server-derived status** — `approval_status` in document responses would require client-side computation; the server must be the arbiter of "is this approved?"
- **Atomic cascade cleanup** — removing an approver means deleting arbitrary key patterns non-transactionally.
- **Carry-forward** — requires a hook inside version creation, which KV has no access to.

Per-key write gating (a considered KV extension) closes the authorization gap but not version-scoping, response enrichment, atomicity, or carry-forward. Key insight: **KV is document-controlled state; approvals are a server-enforced contract between multiple parties.**

## Review outcomes (maintainer review, 2026-09-04)

Devstack review by the maintainer moved four things out of "future work" and into this change:

- **Decision notes** — a `note` column on `approvals` (migration `00025`), required when requesting changes and optional when approving, surfaced through the API, CLI (`--note`) and UI. Requesting changes without saying what to change left the author guessing.
- **Approvals live in a modal**, not the comments sidebar; the status badge is the trigger.
- **Carried provenance names the version** — the list response carries `carried_from_version_number`, so the UI reads "Approved on v3" instead of an unattributed "carried forward".
- **Version scoping is enforced** — `GET /approvals?version=` now 404s for an unknown or foreign version instead of returning an invented all-pending state.
- **Search results keep approval status** — the search branch of `ListDocuments` enriches the same way the plain listing does.

## Not in Scope

- Notifications — dropped per maintainer; notifications will start with comment mentions only, independent of this feature
- Approval deadlines or reminders
- Document types (phase 2) and approval templates ("always require PM + Eng Lead")
- Document locking on approval
- Re-request review (owner nudges a specific approver to re-review, optionally clearing their carried approval) — natural follow-up
- Approval request note — owner states _why_ each approver's sign-off is needed (maintainer suggestion, 2026-07-22); a `note` column on `approval_requests` + optional field end to end
