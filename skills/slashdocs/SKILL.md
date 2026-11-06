---
name: slashdocs
description: Use whenever the user mentions slashdocs (formerly aidocs), a slashdocs or aidocs URL, a slashdocs document/folder/comment/share/version, or asks to publish, review, open, or update a long-form artifact in slashdocs.
---

# slashdocs

slashdocs was formerly named aidocs. Treat an aidocs URL, document, or command
as a slashdocs one: old aidocs links still work, and the `aidocs` CLI is now
`slashdocs`.

Use this skill for **any slashdocs-related task**. If the user mentions slashdocs or
points at a slashdocs asset, use the `slashdocs` CLI to inspect or act on it. If given a slashdocs document URL, don't try to curl or web fetch it. Use the slashdocs cli.

## First rule: read the guidelines before authoring

Before writing or publishing a slashdocs document in a session, run:

```bash
slashdocs guidelines
```

Treat that command as the source of truth for authoring constraints (single-file
HTML, images/assets, theme integration, and publishing examples). Read the CLI
output and follow it.

## Common workflows

### Existing slashdocs asset

When the user asks about an existing slashdocs document, folder, comment, share,
version, or URL:

1. Use `slashdocs --help` and the relevant subcommand help to discover exact syntax.
2. Use the CLI to inspect the asset (`docs show`, `docs versions`, `docs pull`,
   `docs comments`, `folders`, `open`, etc. as appropriate).
3. Perform the requested action through the CLI.
4. Return the important CLI result or URL to the user.

### New long-form artifact

When the user wants a report, RCA, postmortem, spec, review, analysis, launch
plan, findings doc, or other long-form artifact and has not specified another
format:

1. Run `slashdocs guidelines` if you have not already done so in this session.
2. Write the artifact as a single HTML file that follows those guidelines.
3. Save it locally (for example `report.html`).
4. Use `slashdocs docs --help` and `slashdocs docs create --help` to confirm current
   syntax.
5. Publish with the CLI.
6. Return the printed slashdocs document URL.

### Updating an existing document

If the user is iterating on an existing slashdocs document, push a new version
instead of creating a duplicate. Use the CLI help to find the current push/update
syntax and include a short summary of what changed. Write one change per line;
the version history shows a multi-line summary as a list.

### Searching and labels

Use the same Slack-style search language as the web application:

```bash
slashdocs docs list 'incident from:alice@example.com label:api,review in:"Product Specs"'
slashdocs docs list 'rollout -draft from:me after:last week' --json
```

Every word must appear in the title or the text of the latest version, and
the most relevant documents come first. A word also matches longer words that
start with it. `"quoted text"` matches the words in order, and `-word`
excludes documents that contain the word. `from:` (an email, the name
before the @, or `me`), `in:` (a folder or any folder above the document),
`label:`, `before:`, `after:`, `on:`, and `during:` narrow the results. Repeat
`from:` or `in:` to match any of the values. A date is a day (`25-09-26`,
`5 september`, `monday`, `today`, `3 days ago`), a week, a month, or a year
(`last week`, `september`, `this year`, `2026`), or `last 7 days`, in UTC.

Manage labels directly from the CLI:

```bash
slashdocs docs labels list doc_123
slashdocs docs labels set doc_123 api review-ready
slashdocs docs labels clear doc_123
```

## Local documents (`--local`)

`--local` runs a command against slashdocs local, a limited version of
slashdocs on this computer. It needs no server or login, and it starts by
itself the first time:

```bash
slashdocs --local docs create report.html --title "Q3 plan"
slashdocs --local docs comments list report.html
```

Use `--local` only when the user asks for local documents, or when the user
has no slashdocs server and wants to try slashdocs. A local document ID is its
path in the documents folder (default `~/slashdocs`). Local documents support
comments, but not sharing, version history, full-text search, labels, or
notifications.
When the user wants to share a document or get reviews from the team, tell
them that a slashdocs server does this, and publish there if they have one.

## MCP server (optional)

The slashdocs application server exposes MCP directly over Streamable HTTP at:

```bash
https://<your-slashdocs-host>/mcp
```

Connect the URL from the MCP client; no slashdocs CLI installation or local MCP
process is required. Interactive clients authenticate through the server's
browser flow. Headless clients can use a service-account bearer key created in
the slashdocs web application. If the remote slashdocs MCP tools are already available
in your session, prefer them; otherwise use the CLI commands described above.

## Authentication and setup

Assume the user installed slashdocs and the bundled skill via the server's
`curl ... | sh` installer. If the CLI reports that auth is missing or expired,
run `slashdocs auth login` (include the server URL if the current context requires
it), then retry the requested CLI action. If login cannot be completed in the
environment, explain that clearly and ask the user to authenticate.

## When not to publish

Do not publish to slashdocs if the user explicitly asks for Markdown, plain text, a
PDF, inline chat only, or another destination. If they mention slashdocs while asking
for one of those formats, still use the CLI when relevant to inspect or reference
the slashdocs asset, but respect the requested output format.
