# Ephemeral documents

Status: Proposed

## Summary

Many documents are useful for a short time: a draft for one review, or a page
that an agent made for one question. Today every document stays until its
owner deletes it by hand, so a workspace collects documents that nobody needs.

This proposal gives a document an optional expiry time. The owner sets it when
the document is created, or later. After that time the server deletes the
document, as `DELETE /v1/documents/{id}` does, and later removes its HTML from
blob storage. A document without an expiry time is kept, as today.

## Decisions for the reviewer

Two rules of the security guidance are not met by the code that this change
builds on. The change does not make either worse, and it does not settle
them.

- **Rate limit** (`api/security`: an API endpoint has a rate limit).
  `POST /v1/documents` and `PATCH /v1/documents/{id}` have none today, and
  they now take a field that plans a delete. The options:
  1. Give the two routes a limit in this change, as the inbox and the comment
     routes have. This meets the rule. It can refuse an agent that creates
     many documents in a short time, which works today.
  2. Give all write routes a limit in a change of its own.
  3. Leave it. Only the owner can set an expiry, and only on their own
     document, and the sweep deletes at most 100 documents in a round.
- **Secure deletion** (`data-protection/sensitive-data`: a delete of user
  data prevents its recovery). The server deletes rows and objects. It does
  not overwrite them, the objects stay for the retention period, and a bucket
  with versioning keeps them longer. The options:
  1. A retention of `0`, and a bucket with a key that the operator can
     destroy. The operator guide tells this, and what stays after a delete.
  2. A key for each document, which the delete destroys. This is a change of
     its own.

## Goals

- An owner can say, at create time or later, that a document is deleted after
  1 day, 3 days, 7 days, 1 month, 3 months, or another period.
- The owner can change the period or remove it until the document is deleted.
- Everyone who can read the document sees that it has an expiry time, and when.
- An expired document leaves nothing in Postgres or in blob storage that a
  manual delete does not also leave.
- It works with every blob store, and with `slashdocs local`.
- A document that has no expiry time behaves exactly as before.

## Non-goals

- A trash or a restore action in the product. An operator can still get the
  HTML of a deleted document back for some days (see
  [Blob removal](#blob-removal)).
- A message before the expiry. The document page and the lists show the time.
- A page that tells a reader that a document expired, and when. An expired
  link shows "Document not found", as a deleted one does.
- An expiry that moves when the document changes. The time is fixed until the
  owner changes it.
- A default period for a folder, a person, or a deployment.
- Removal of the grant and pin rows of a deleted document. They have no
  foreign key to the document and stay after a manual delete today.
- Removal of the blobs of documents that were deleted before this change.

## Requirements

- R1: A document has an optional expiry time. Without one, the server keeps it.
- R2: Only the owner sets, changes, or removes the expiry time: the role that
  `DELETE` needs.
- R3: A request gives the time as a period from now (`expires_in`) or as a
  time (`expires_at`), not both.
- R4: Every response that holds a document holds its `expires_at`, when set.
- R5: After the expiry time, the server deletes the document and all that a
  manual delete removes.
- R6: The delete is correct with many server replicas. A document is deleted
  once, and an expiry that the owner changed before the delete counts.
- R7: The HTML of a deleted document leaves blob storage after a retention
  period. A blob store that is down, or a server that stops, delays this and
  does not lose it.
- R8: A manual delete removes the HTML in the same way.
- R9: The document page and the document lists show the expiry time.
- R10: The CLI, the MCP tools, and the web app can set the expiry.
- R11: `slashdocs local` keeps the expiry in the state file of the document
  and moves the document to a trash folder after it.
- R12: An operator can change how often the server looks for expired
  documents, can change the retention period, and can turn the feature off.
- R13: The server counts and logs what it deletes for expiry and what it
  removes from blob storage.

## What a person sees

### Web app

- The document bar shows a small mark, such as "Deletes in 3 days", when the
  document has an expiry time. A tooltip gives the exact time. In the last day
  the mark has the warning colour.
- The More menu of the owner has "Auto-delete…". It opens a dialog with the
  choices Keep, 1 day, 3 days, 7 days, 1 month and 3 months. The dialog shows
  the current expiry time, and says that the delete removes the history and
  the comments and cannot be undone.
- A document row and a document card show the same mark in the lists.
- The upload dialog has the same choice for a new document.
- A page that is open when the document expires shows "Document not found", as
  it does after a manual delete.
- On a phone, the bar shows the mark as an icon, and the More menu tells the
  time.
- The time text never tells more than the time that is left: 36 hours is "in
  36 hours", not "in 2 days".

### CLI

```bash
slashdocs docs create notes.html --title "Scratch" --ttl 7d
slashdocs docs update doc_123 --ttl 3mo     # from now
slashdocs docs update doc_123 --ttl never   # keep the document
slashdocs docs show doc_123                 # prints expires_at
```

`--ttl` takes a whole number and a unit: `min`, `h`, `d`, `w`, or `mo`. A
month is 30 days. A bare `m` could mean minutes or months, and a wrong guess
deletes a document, so the CLI and the API refuse it and name the two units.

The command prints the time of the delete and how long that is from now,
such as "which is in 7 days". A wrong unit, such as `30min` for a month, then
shows at once.

A server of an older release does not know the fields, and takes a request
without them. So a command with `--ttl` first reads `GET /v1/config`, and
changes nothing when the server sets no expiry. It also fails when a response
has no `expires_at`.

### MCP

`create_document` takes an optional `expires_in`. A new tool,
`set_document_expiry`, takes `document_id` and `expires_in`, where `never`
removes the expiry. An agent does not know the current time, so the tools take
a period and not a time.

The tool descriptions, the agent skill, and the authoring guidelines tell an
agent to set an expiry only when the user asks for one, to tell the user the
date and that the delete cannot be undone, and to ask before it sets an
expiry on a document that exists. The result of a tool holds `expiry_warning`,
with the time and how long that is from now.

The MCP tools take no period under 1 hour. An agent that means a month and
writes `30min` would delete a document in half an hour, and its user would
not see that in time. The web app and the CLI take a shorter period.

## API

`repo.Document` gets `expires_at`, an RFC 3339 time in UTC, left out when the
document has none.

`POST /v1/documents` takes two more optional form fields:

| Field        | Value                                                               |
| ------------ | ------------------------------------------------------------------- |
| `expires_in` | A period from now: `30min`, `12h`, `7d`, `2w`, `3mo`.               |
| `expires_at` | An RFC 3339 time, at least 1 minute and at most 3650 days from now. |

A period is at least 1 minute and at most 3650 days. A request with both
fields, or with a value that does not parse, gets `400`. The create response
holds `expires_at`.

`PATCH /v1/documents/{id}` takes the same two fields in its JSON body, beside
`title`. `"expires_at": null` removes the expiry. A body with none of the
three fields gets `400`, as a body without a title does today. The handler
checks all fields first and then writes them in one transaction. It keeps its
owner check, and it tells the open pages of the document, as a rename does.

The server makes the time from a period with its own clock, so the clock of
the client does not matter.

`GET /v1/config` gets `document_expiry_enabled`. When the feature is off, a
request that sets an expiry gets the error `feature_disabled`, as a request
for labels does when labels are off, and a request that removes one still
works.

## Data model

```sql
ALTER TABLE documents ADD COLUMN expires_at TIMESTAMPTZ;
CREATE INDEX documents_expires_at_idx ON documents(expires_at, id)
  WHERE expires_at IS NOT NULL;

CREATE TABLE blob_deletions (
  document_id TEXT PRIMARY KEY,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX blob_deletions_queued_idx ON blob_deletions(queued_at, document_id);
```

The column is nullable and has no default, so the migration does not rewrite
the table, and a server of the release before works with the new schema. The
index is in a migration of its own, so that the lock of `ALTER TABLE` is not
held while the index is built. A change of the expiry does not change
`updated_at`: the lists sort by it, and the content did not change.

`blob_deletions` is the list of deleted documents whose blobs are still in the
blob store. It has no foreign key, because a row outlives its document.

The delete of a document, a version or a comment makes Postgres look for the
rows that point to it. Eight of those columns had no index that Postgres can
use, so each look-up read a whole table. A third migration adds the indexes,
because the sweep deletes many documents. On a database with 200,000
documents, the delete of one document went from 27 ms to under 1 ms.

The migrations take a lock for at most 10 seconds, so that a long
transaction cannot hold all requests behind a migration. The indexes are not
built with `CREATE INDEX CONCURRENTLY`. Servers that start at the same time
wait for the advisory lock of the one that migrates, and a server that waits
holds a snapshot. A concurrent build waits for that snapshot, so Postgres
finds a deadlock and stops a server. A test starts four servers at the same
time.

## Deleting an expired document

### The sweep

Every server runs the sweep, as every server seals idle versions. In each
round it deletes expired documents one at a time, up to a limit. For each one
it opens a transaction and:

1. takes one document whose `expires_at` is not after `now()`, the oldest
   first, with `FOR UPDATE SKIP LOCKED`. A row that another server or another
   write holds is passed over, and a later round takes it. The condition is
   read under the lock, so an expiry that the owner changed counts;
2. puts the document in `blob_deletions`;
3. deletes the document row, and sends the notification that a manual delete
   sends. The foreign keys remove the versions, comments, approvals,
   operations, and the other rows of the document.

A delete that fails is logged, and the round goes on with the next document,
so one document cannot hold the others back. The time is the clock of the
database, so the clocks of the servers do not matter.

`DELETE /v1/documents/{id}` uses the same steps 2 and 3. So a manual delete
also puts its document in the list, where it left the blobs in the bucket
before.

### Blob removal

All blobs of a document have keys that start with `docs/<document id>/`. This
holds for the content of a version, for the seal of an open version, and for
a snapshot. After the documents, each round takes rows from `blob_deletions`
whose retention period passed. For each one it lists the keys with the prefix
of the document, deletes each blob, and then deletes the row.

The list by prefix needs one new method on `blob.Store`, `List`, in the S3
store and the memory store. It also finds the blobs that no version names: a
seal or a snapshot whose own delete failed. The S3 store needs permission to
list the bucket, which the readiness check of the server already uses.

A server takes a row with a lease, as the notification workers do: it moves
`available_at` forward and counts the attempt, and it holds no transaction
while it talks to the blob store. Each call to the store has a timeout. When a
call fails, the row waits longer after each attempt, up to 6 hours, so a store
that is down for a day costs a few calls and no stream of log lines. A server
that stops in the middle loses nothing: the lease runs out, and another round
takes the row.

The statement that takes a row chooses it with a subquery in `WHERE`, which
PostgreSQL works out once. With the subquery as a table in `FROM`, the plan
for an empty table ran it again for each row, and one statement took every
waiting row while the server had the first one only. The table is empty most
of the time, so that plan is the usual one. The full browser suite on the
compose stack found this: rows waited for their lease to end and no line was
logged.

Before it lists, the removal makes sure that no document has the ID of the
row. A document ID is random and is never used again, so this cannot happen.
If it does, the removal logs an error, keeps the blobs, and drops the row. It
also deletes no key that is not under the prefix, whatever the store lists.

The check reads one database. A copy of the database that uses the same
bucket has no such check, so the operator guide says: one bucket for one
database.

#### Retention

The removal waits for a retention period after the delete. The default is 7
days. In that time the HTML is still in the bucket under `docs/<document
id>/`, so an operator can get it back for a person who set a wrong period, and
a restore of a Postgres backup from that week finds its blobs. `0` removes the
blobs in the next round.

Before this change a deleted document left its blobs in the bucket for ever. A
deployment that restores older backups needs versioning on the bucket.

### Open pages

The delete sends the notification that a manual delete sends. The event
brokers then find that the document is gone and close its streams, and the
page loads the document again and shows "Document not found".

### Configuration

| Variable                                   | Default | Purpose                                                               |
| ------------------------------------------ | ------- | --------------------------------------------------------------------- |
| `SLASHDOCS_DOCUMENT_EXPIRY_SWEEP_INTERVAL` | `1m`    | How often a server runs a round. `0` turns the feature off.           |
| `SLASHDOCS_DELETED_BLOB_RETENTION`         | `168h`  | How long the blobs of a deleted document stay. `0` is the next round. |

The Helm values are `documentExpiry.sweepInterval` and
`documentExpiry.blobRetention`.

With the feature off, the server deletes no expired document and removes no
blob, as before this change, and it refuses a new expiry. Documents keep the
expiry time that they have, and the first round after the feature is on again
deletes those that are due. So the web app still shows the mark of such a
document, and its owner can still keep it. It offers no new period.

An interval is at least 1 second, because a shorter one keeps the database
busy.

So a document can live up to one interval after its expiry time. Until the
delete, it is a normal document, and its owner can still change the expiry.

### Metrics and logs

- `slashdocs_document_events_total{event="expired",actor_type="system"}`
  counts the deleted documents.
- `slashdocs_blob_purge_events_total{result}` counts the documents whose blobs
  were removed, or failed.
- `slashdocs_blob_purge_pending_documents` and
  `slashdocs_blob_purge_oldest_pending_seconds` show the list.
- `slashdocs_document_expiry_sweep_errors_total` counts failed rounds.

Each delete logs the ID of the document, the ID of its owner, and the expiry
time. A change of the expiry logs the ID of the document, the ID of the
principal, and the new time. No log line holds a title, a name or an email. A
round logs one line for the blobs that failed. A server that stops in the
middle of a round counts no failure.

## slashdocs local

A local document is a file, and its state is in the hidden file next to it.
The state gets an `expires_at` field. The local server takes `expires_in` and
`expires_at` on create and on `PATCH`, and returns `expires_at`, as the server
does.

Once a minute, and when it starts, the local server looks for documents whose
expiry time passed. It moves each one, with its state file, to the hidden
folder `.slashdocs-trash` in the documents folder. It does not delete a file:
the folder belongs to the person, and other tools write to it. The person
empties the trash.

The expiry belongs to a path, as the comments do. Three rules keep that from
moving a file that a person wants:

- A file that changed after its expiry time is kept, and its expiry is
  removed. It is probably a new file with the name of an old one, or a
  document that a person worked on while the server was off.
- When a document is gone but its state file has an expiry, the sweep removes
  the expiry. A new file with that name is then kept.
- The state of a document goes to the trash without the expiry. A document
  that a person moves back from the trash then stays.

The sweep moves regular files only, and the trash must be a folder of the
documents folder, not a link.

## Alternatives rejected

- To hide an expired document at read time, every query that reads a document
  would filter on `expires_at`, and a job would remove the rows later. The
  expiry would be exact to the second. But it changes every read path of the
  product for a need that is about clutter, and one missed query would show a
  document that the rest of the product hides.
- A trash with a restore action is the safest design. It is also a feature of
  its own, with a list, a restore action and a second expiry. A manual delete
  has no trash today. The retention period gives an operator most of the
  safety for a small part of the work.
- Bucket lifecycle rules and `pg_cron` need set-up by each operator. They
  differ between blob stores, and they do not know the documents.
- A blob delete inside the delete request makes a delete as slow as the blob
  store. When the blob delete fails, the request fails or the blob is lost.
- A list of blob keys, one row for each blob of a deleted document, needs no
  `List` method. But it misses the blobs that no version names, and its
  safety check reads versions that the delete already removed.
- A client could turn the period into a time. Its clock could be wrong, and an
  agent does not know the time.
- `CREATE INDEX CONCURRENTLY` does not stop the writes to a table. But it
  deadlocks with the servers that wait for the migration lock (see
  [Data model](#data-model)), and a build that fails leaves an index that is
  not valid.
- A folder whose documents all expire moves the choice from the document to
  its place. A document that moves in or out then gets or loses an expiry
  that nobody chose. It can come later, on top of the per-document field.

## Delivery

1. Schema, repository, API and sweep, with the blob list. CLI flags.
2. MCP tools, `slashdocs local`, the web app, documentation, Helm values, the
   agent skill.

The first part holds all that deletes data, so it can have a review of its
own.

## Testing

- Repository tests on Postgres: the expiry is stored and returned by each
  query that returns a document; the sweep deletes only expired documents;
  two stores that sweep at the same time delete each document once; a
  document that fails does not stop the others; a document that a write holds
  is passed over; an owner who removes the expiry while the sweep runs keeps
  the document; a manual delete and an expiry both fill the list; a write
  after the delete leaves no blob; the removal waits for the retention
  period, empties the memory store, holds no database connection while it
  deletes, keeps the row of a document whose blobs failed, stops after three
  failures, leaves a document whose lease another server took, and takes one
  document for each claim when the table is planned as empty.
- Migration tests: up and down twice on a database with a document, and four
  servers that migrate at the same time.
- Blob store tests for `List`, with a store that gives the keys in pages.
- Handler tests: create and `PATCH` with a period, a time, both, and bad
  values; a bad expiry keeps the title; the owner check; the document in each
  list response; the feature turned off; the MCP tools.
- Unit tests for the period parser, with the bare `m`.
- CLI tests for the flags, the output, an older server, and `--local`, with
  the local sweep and its trash.
- Frontend tests for the time text, the dialog, and the marks.
- A browser test that sets the expiry from the More menu.
- A run on the compose stack, with versitygw as the S3 store and no
  retention: a document with a short period goes away, and its objects leave
  the bucket. `scripts/e2e.sh` has this step, so that CI runs the sweep of a
  real server.

## Assumptions

- The need is less clutter. A document that lives up to one sweep interval
  after its expiry time is acceptable.
- A person who sets an expiry accepts that they cannot undo the delete. The
  mark on the page and in the lists is the warning for the other readers.
- The owner of a document does not change, so the owner check of today is
  enough.
- The presets of the web app are enough there. The CLI and the API take any
  period in the range.
- The clocks of the server and the database agree to within seconds. The
  server turns a period into a time, and the database compares it.
- A delete is a row delete in Postgres and an object delete in the blob
  store. It is no secure erase: storage with versioning or backups can still
  hold the data. The self-hosting guide tells an operator what to set up for
  that.

## Security guidance applied

- `authorization/state-changing-operations`
- `authorization/access-control`
- `validation/untrusted-input`
- `data-protection/sensitive-data`
- `secrets/handling`
- `api/security`
