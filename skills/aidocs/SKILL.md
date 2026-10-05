---
name: aidocs
description: Use whenever the user mentions aidocs, an aidocs URL, an aidocs document/folder/comment/share/version, or asks to publish, review, open, or update a long-form artifact in aidocs.
---

# aidocs

Use this skill for **any aidocs-related task**. If the user mentions aidocs or
points at an aidocs asset, use the `aidocs` CLI to inspect or act on it. If given an aidocs document URL, don't try to curl or web fetch it. Use the aidocs cli.

## First rule: read the guidelines before authoring

Before writing or publishing an aidocs document in a session, run:

```bash
aidocs guidelines
```

Treat that command as the source of truth for authoring constraints (single-file
HTML, images/assets, theme integration, and publishing examples). Read the CLI
output and follow it.

## Common workflows

### Existing aidocs asset

When the user asks about an existing aidocs document, folder, comment, share,
version, or URL:

1. Use `aidocs --help` and the relevant subcommand help to discover exact syntax.
2. Use the CLI to inspect the asset (`docs show`, `docs versions`, `docs pull`,
   `docs comments`, `folders`, `open`, etc. as appropriate).
3. Perform the requested action through the CLI.
4. Return the important CLI result or URL to the user.

### New long-form artifact

When the user wants a report, RCA, postmortem, spec, review, analysis, launch
plan, findings doc, or other long-form artifact and has not specified another
format:

1. Run `aidocs guidelines` if you have not already done so in this session.
2. Write the artifact as a single HTML file that follows those guidelines.
3. Save it locally (for example `report.html`).
4. Use `aidocs docs --help` and `aidocs docs create --help` to confirm current
   syntax.
5. Publish with the CLI.
6. Return the printed aidocs document URL.

### Updating an existing document

If the user is iterating on an existing aidocs document, push a new version
instead of creating a duplicate. Use the CLI help to find the current push/update
syntax and include a short summary of what changed. Write one change per line;
the version history shows a multi-line summary as a list.

### Searching and labels

Use the same Slack-style search language as the web application:

```bash
aidocs docs list 'incident from:alice@example.com label:api,review in:"Product Specs"'
aidocs docs list 'rollout -draft from:me after:last week' --json
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
aidocs docs labels list doc_123
aidocs docs labels set doc_123 api review-ready
aidocs docs labels clear doc_123
```

## JSON output

Pass `--json` when you need to parse the result. Stdout then carries exactly one
JSON value: the payload on success, `{"ok": true}` when the server returns no
body, and `{"error": {"code", "message", "status", "details"}}` on failure.
Read `error.details` to recover — a 409 `version_conflict` names
`current_version_id`. Commands taking several ids answer with one value listing
each id's outcome, so a partial failure still says which ids were applied. The
exit code reports the failure either way.

## MCP server (optional)

The aidocs application server exposes MCP directly over Streamable HTTP at:

```bash
https://<your-aidocs-host>/mcp
```

Connect the URL from the MCP client; no aidocs CLI installation or local MCP
process is required. Interactive clients authenticate through the server's
browser flow. Headless clients can use a service-account bearer key created in
the aidocs web application. If the remote aidocs MCP tools are already available
in your session, prefer them; otherwise use the CLI commands described above.

## Authentication and setup

Assume the user installed aidocs and the bundled skill via the server's
`curl ... | bash` installer. If the CLI reports that auth is missing or expired,
run `aidocs auth login` (include the server URL if the current context requires
it), then retry the requested CLI action. If login cannot be completed in the
environment, explain that clearly and ask the user to authenticate.

## When not to publish

Do not publish to aidocs if the user explicitly asks for Markdown, plain text, a
PDF, inline chat only, or another destination. If they mention aidocs while asking
for one of those formats, still use the CLI when relevant to inspect or reference
the aidocs asset, but respect the requested output format.
