# TODOs

## Signed-out readers of public books

**What:** Let signed-out visitors read public books, with reading position and chapter state kept in local storage only (spec R27, deferred as D1).

**Why:** On a public deployment a book shared with "anyone" should open without sign-in, like a public document does. v1 requires sign-in for every book route.

**Context:** Book routes sit in the `authed` group in `api/internal/server/server.go`. The follow-up needs:

- reader-group routes for the manifest, `llms.txt` and chapter reads;
- an AppShell exemption for the book routes in the frontend;
- anonymous rate-limit keys for those routes (there is no user id to key on);
- reading state in localStorage only, with no merge into the account on sign-in.

Razorpay's deployment is `org` mode, so nobody is blocked today.

**Depends on:** Book mode v1 (`SLASHDOCS_BOOKS_ENABLED`) shipped.

## One batched access query for manifests

**What:** Replace the per-chapter `RoleForDocument` calls used to build a reader's manifest with one query that returns the caller's role for every chapter in the book. It must match `RoleForDocument` exactly.

**Why:** Building a manifest costs one access check per chapter. That is fine for dozens of chapters and slow for books with hundreds.

**Context:** The batched query has to honour the same rules as `RoleForDocument`: ownership, direct and group grants, folder inheritance and deployment mode. Add a test that runs both paths over the same fixtures and asserts identical roles, so the two cannot drift. Hidden chapters must stay out of the manifest entirely (R7, R24).

**Depends on:** Book mode v1 shipped.
