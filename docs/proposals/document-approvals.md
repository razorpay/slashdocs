# Document Approvals

**Date:** 2026-07-13 (updated 2026-11-01)
**Status:** Draft
**Author:** Manas Kinkar

## Decision Log

| Date       | Decision                                                              | Context                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-13 | Dedicated tables over KV or grants (Approach A)                       | Brainstorm: approvals are a distinct domain concept                                                                                                                                                        |
| 2026-07-16 | Confirmed: first-class flow, not a KV convention                      | Maintainer review (Slack): KV satisfies ~60% of requirements; per-action authorization, version-scoping, server-derived status, and atomic cleanup all need server enforcement. See "Why not KV" appendix. |
| 2026-07-16 | Notifications fully out of scope                                      | Maintainer: notifications will start with comment mentions only                                                                                                                                            |
| 2026-07-16 | Approved decisions carry forward across versions (replaces reset-all) | **Superseded 2026-10-26.** Concern as noted by the author from a Slack discussion: every small edit is a new version, and resetting all approvals on each push means people won't chase re-approvals       |
| 2026-10-26 | A change of content resets every approval; keeping them is opt-in     | **Superseded 2026-11-01** (the opt-in `keep_approvals` is removed; see below)                                                                                                                              |
| 2026-10-26 | Anyone who created a version of the document cannot approve it        | As an author cannot approve their own pull request; here it covers every contributor, not only the last. Enforced when assigning and when deciding                                                         |
| 2026-10-26 | A decision on replaced content is refused (409)                       | Otherwise an approval lands on replaced content, counts for nothing, and the approver is not told                                                                                                          |
| 2026-11-01 | A decision vouches for content (sha256), not for a version row        | Versions become an automatic edit history, so they are frequent. A version with the same content shows the decision; other content does not. A revert restores approvals. No rows are copied               |
| 2026-11-01 | `keep_approvals` is removed                                           | It let a publisher keep approvals over content the approvers did not see, which breaks the tie between an approval and its content                                                                         |
| 2026-11-01 | An approver who pushes a version stops being an approver              | The push removes them and their decisions in its transaction, so the "creators cannot approve" rule always holds. Before, they stayed assigned but could never decide, so the document waited forever      |
| 2026-11-01 | One name: reject                                                      | The decision value, the CLI verb (`docs reject`), the UI and the events all say "rejected". The value was `changes_requested` while the UI said Reject                                                     |

## Summary

Document owners assign approvers. Approvers approve or reject the content of the document. The document's approval status is derived from the decisions on its current content. A version with changed content resets every decision, so approvers review what changed. A version with the same content as an earlier one, for example a revert, shows the decisions on that content. Anyone who created a version of the document cannot approve it.

## Requirements

- Only the document owner can assign or remove approvers.
- Approvers must already have viewer+ access on the document.
- Anyone who created a version of the document cannot be assigned as an approver or decide. An approver who pushes a version stops being an approver.
- Approvers approve or reject what the document says now. A decision names the version it was made on and vouches for that version's content (`sha256`).
- All assigned approvers must approve for the document status to be "approved."
- An approver can change their decision (upsert) or **revoke** it (back to pending).
- Approval is optional. Documents without approvers have no approval status.
- Service accounts can be assigned as approvers for agent workflows.

## Content Semantics

A decision row stores the content hash (`sha256`) of the version it was made on. The status of any version reads the decisions on that version's content:

| Push                                 | Effect on decisions                                             |
| ------------------------------------ | --------------------------------------------------------------- |
| Changed content                      | Every approver is pending on the new content                    |
| Same content (no-op save, re-upload) | Decisions stay; they name the version they were made on         |
| Revert to approved content           | The decisions on that content come back ("approved on v3")      |
| Push by an assigned approver         | The approver and their decisions are removed in the same commit |

Rules:

- A decision on a version whose content is no longer the document's content is refused with 409 (`version_superseded`, with `current_version_id`). A decision on an older version with the same content as the current one is accepted.
- Assigning, deciding and pushing serialize on the document row: a push holds it for update, and an approval write holds it for share before it reads the current version and the version creators. A decision that starts during a push sees that push.

## Data Model

```sql
CREATE TABLE approval_requests (
  id                TEXT PRIMARY KEY,                 -- apr_…
  document_id       TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  approver_type     TEXT NOT NULL CHECK (approver_type IN ('user', 'service_account')),
  approver_id       TEXT NOT NULL,
  requested_by_type TEXT NOT NULL,
  requested_by_id   TEXT NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at        TIMESTAMPTZ
);  -- unique active (document_id, approver_type, approver_id)

CREATE TABLE approvals (
  id            TEXT PRIMARY KEY,                     -- apv_…
  document_id   TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_id    TEXT NOT NULL REFERENCES versions(id) ON DELETE CASCADE,
  sha256        TEXT NOT NULL,                        -- the content decided on
  approver_type TEXT NOT NULL,
  approver_id   TEXT NOT NULL,
  decision      TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  note          TEXT NOT NULL DEFAULT '',
  decided_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ
);  -- unique active (document_id, sha256, approver_type, approver_id)
```

Revoked rows stay for audit. Removing an approver revokes their request and all their decisions on the document.

### Derived document status

| Condition                                   | Status       |
| ------------------------------------------- | ------------ |
| No active approval requests                 | field absent |
| Every approver approved the current content | `approved`   |
| Any approver rejected the current content   | `rejected`   |
| Otherwise                                   | `pending`    |

## API

```
POST   /v1/documents/:id/approvers          assign approver (owner)
GET    /v1/documents/:id/approvers          list assigned approvers
DELETE /v1/documents/:id/approvers/:apr_id  remove approver (owner)
POST   /v1/documents/:id/approvals          submit or replace a decision
GET    /v1/documents/:id/approvals          decisions on a version's content + summary
DELETE /v1/documents/:id/approvals/:apv_id  revoke own decision
```

**Submit decision:**

```
POST /v1/documents/:id/approvals
Body: { "version_id": "ver_7", "decision": "approved" | "rejected", "note": "…" }
→ 201 (new) / 200 (replaced) { "id": "apv_1", "version_id": "ver_7", "version_number": 7, "version_sha256": "…", "decision": "approved", … }
→ 400 invalid decision, or a rejection with neither a note nor open comments by the caller
→ 403 not an assigned approver, or the caller created a version
→ 404 version not found | 409 version_superseded
```

**List decisions:**

```
GET /v1/documents/:id/approvals?version=ver_8
→ 200 {
    "version_id": "ver_8", "version_number": 8, "version_sha256": "…",
    "status": "pending",
    "summary": { "total": 3, "approved": 2, "rejected": 0, "pending": 1 },
    "items": [
      { "id": "apv_1", "approver": {…}, "decision": "approved", "version_id": "ver_7", "version_number": 7, "comments_open": 0, "comments_total": 2 },
      { "approver": {…}, "decision": null }
    ]
  }
```

Document responses carry `approval_status` and `approval_summary` only when approvers are assigned.

## CLI and MCP

```
slashdocs docs approvers list|add|remove
slashdocs docs approvals list <doc_id> [--version <version_id>]
slashdocs docs approve <doc_id> [--version <version_id>] [--note "…"]
slashdocs docs reject <doc_id> [--version <version_id>] [--note "what needs to change"]
slashdocs docs revoke-approval <doc_id> [--version <version_id>]
```

`--version` defaults to the version remembered from `slashdocs docs pull`, then the current version. Over MCP, the owner's side is available: `request_document_approval`, `list_document_approvers`, `list_document_approvals`, `remove_document_approver`. Deciding is not: an approval is the approver's own decision.

## Frontend

1. **Status chip in the document bar**: "2 of 2 approved", "1 of 3 approved", "Rejected · 1 of 3 approved". With no approvers, the owner sees a **Request approval** button.
2. **Approvals dialog**: per-approver status, "N open of M comments", and "on vN" when a decision was made on an earlier version with the same content. Decision controls sit beside the approver's own row; owner controls add and remove approvers.
3. **Reject** opens a dialog with the reviewer's open comments and an optional reason. With no open comments, the reason is required. Approving with open comments asks to confirm.

## Edge Cases

| Scenario                                | Behavior                                                   | HTTP |
| --------------------------------------- | ---------------------------------------------------------- | ---- |
| Assign user without doc access          | Refused                                                    | 400  |
| Assign same user twice                  | Refused                                                    | 409  |
| Assign someone who created a version    | Refused, including the owner who published it              | 400  |
| Approver pushes a version               | Push succeeds; approver and their decisions removed        | —    |
| Approver loses access                   | Request stays; counts as pending; owner should remove them | —    |
| Decision on replaced content            | Refused; nothing recorded                                  | 409  |
| Decision on older version, same content | Recorded on that content                                   | 201  |
| Decision races a push                   | Waits for the push; then refused if content changed        | 409  |
| Non-approver submits decision           | Forbidden                                                  | 403  |
| Revoke someone else's decision          | Forbidden                                                  | 403  |
| Remove approver who already decided     | Request and all their decisions revoked                    | 204  |
| Document deleted                        | CASCADE                                                    | —    |

## Appendix: Why Not KV?

KV satisfies ~60% of requirements (storing decisions, upsert, optional, additive). It cannot satisfy:

- **Per-action authorization**: any editor can patch any KV key; approvals need owner-assigns / approver-decides / viewer-reads.
- **Content-scoping**: KV has no version or content dimension.
- **Server-derived status**: the server must be the arbiter of "is this approved?"
- **Atomic cleanup**: removing an approver, or an approver's push, must change several records in one transaction.

Key insight: **KV is document-controlled state; approvals are a server-enforced contract between multiple parties.**

## Not in Scope

- Approval deadlines or reminders
- Document types and approval templates ("always require PM + Eng Lead")
- Document locking on approval
- Re-request review (owner nudges a specific approver)
- Approval request note: the owner states _why_ each approver's sign-off is needed
