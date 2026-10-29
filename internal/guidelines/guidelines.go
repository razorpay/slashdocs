// Package guidelines holds the slashdocs document authoring guidelines shared by
// the CLI (slashdocs guidelines) and the server-side MCP tool
// (get_authoring_guidelines). Content is intentionally plain text so agents
// can read it directly before writing a slashdocs document; both surfaces offer
// the same sections with progressive disclosure from an index.
package guidelines

import "strings"

// Page is one addressable guidelines section.
type Page struct {
	Path    []string
	Summary string
	Body    string
	Aliases [][]string
}

var Pages = []Page{
	{
		Path:    []string{"core"},
		Summary: "The single-file HTML contract and default authoring posture.",
		Body: `slashdocs guidelines: core

A document is ONE HTML file.
  - Anything reasonable that fits in a single .html file is fine, including
    inline code and external stylesheets, fonts, scripts, Mermaid/CDN assets,
    iframes, workers, media, data: URLs, and blob: URLs.
  - Prefer semantic, selectable HTML for prose and data. Review comments anchor
    more reliably when text is real text instead of pixels.
  - Keep the first screen useful. slashdocs opens the rendered document directly,
    so avoid marketing-style wrappers around documents that are meant to be read
    or reviewed.
  - Do not hide important content behind hover-only interactions. Readers and
    reviewers should be able to scan, select, copy, and comment on the artifact.

Useful next pages:
  slashdocs guidelines core assets
  slashdocs guidelines rendering theme
  slashdocs guidelines review
`,
	},
	{
		Path:    []string{"core", "assets"},
		Summary: "How images, fonts, CDNs, and embedded media should be handled.",
		Aliases: [][]string{{"assets"}},
		Body: `slashdocs guidelines: core assets

slashdocs stores your HTML, not a directory of supporting files.
  - slashdocs does NOT host assets for you. There is no image/file hosting.
  - Embed important images as base64 data URLs:
      data:image/png;base64,...
  - External HTTPS URLs are allowed when you control them or they are stable
    enough for the document's purpose.
  - CDNs, external stylesheets, fonts, scripts, iframes, workers, media,
    data: URLs, and blob: URLs are allowed.
  - If the document must remain useful offline or years later, inline the
    critical CSS, JS, and images.
  - Keep large generated assets intentional. A single HTML file can become hard
    to review if it carries many megabytes of media.
`,
	},
	{
		Path:    []string{"core", "publishing"},
		Summary: "Create and update documents from the CLI.",
		Aliases: [][]string{{"publishing"}, {"publish"}},
		Body: `slashdocs guidelines: core publishing

Publish a new document:
  slashdocs docs create report.html --title 'Report'

Push an update to an existing document:
  slashdocs docs push <doc_id> report.html --base-version <version_id> --summary 'Address comments'

Write one change per line in --summary; the version history shows each line
as a list item.

If you previously ran slashdocs docs pull <doc_id>, the CLI remembers that base
version for the active context, so --base-version is optional.

Publishing model:
  - Creating a document stores the uploaded HTML as version 1.
  - Pushing HTML creates a new immutable version.
  - The slashdocs UI is for review; agents and CLI/API publishers create versions.
  - Runtime KV changes from uploaded HTML do not create versions; see:
      slashdocs guidelines interactivity kv

Before publishing, run the relevant guideline pages for the kind of document you
are authoring. For example:
  slashdocs guidelines rendering theme
  slashdocs guidelines review
`,
	},
	{
		Path:    []string{"rendering"},
		Summary: "How slashdocs renders uploaded HTML inside the reader.",
		Body: `slashdocs guidelines: rendering

slashdocs renders uploaded HTML inside the document reader.
  - The document should be complete on its own and not depend on parent-page DOM.
  - Assume the document may be resized often as sidebars, comments, and browser
    windows change.
  - Use responsive layout constraints instead of viewport-only tricks.
  - Keep text selectable. Commenting and review workflows work best on real text.
  - Links should be explicit and safe for a reader to open in a new tab.
  - If your document has scripts, make initialization idempotent; the render
    frame may reload as versions or theme settings change.

Useful next pages:
  slashdocs guidelines rendering theme
  slashdocs guidelines rendering layout
  slashdocs guidelines interactivity
`,
	},
	{
		Path:    []string{"rendering", "theme"},
		Summary: "Follow the reader's light/dark theme.",
		Aliases: [][]string{{"theme"}, {"themes"}},
		Body: `slashdocs guidelines: rendering theme

Theme: follow the reader's slashdocs theme.
  The viewer chooses light or dark in the slashdocs UI. The render bridge sets
  this attribute on <html> inside your document and keeps it in sync:

    <html data-slashdocs-theme="light">
    <html data-slashdocs-theme="dark">

  Opt in by defining your palette against the attribute and driving the page
  from variables:

    :root[data-slashdocs-theme="dark"] {
      --bg: #0b0d12; --ink: #e7ecf3;
    }
    :root { --bg: #fff; --ink: #111; }
    body { background: var(--bg); color: var(--ink); }
    html { color-scheme: light; }
    :root[data-slashdocs-theme="dark"] { color-scheme: dark; }

  Notes:
  - "system" is resolved to a concrete light/dark before it reaches you.
  - The value updates live when the reader toggles; CSS reacts automatically.
  - For JS, listen for the event on your own window:
      window.addEventListener('slashdocs:theme', e => {
        // e.detail.theme is "light" or "dark"
      });
  - Do NOT ship your own theme toggle. The slashdocs UI is the single control.
  - A document that never references data-slashdocs-theme keeps its hard-coded
    look, so theming is strictly opt-in.
`,
	},
	{
		Path:    []string{"rendering", "layout"},
		Summary: "Responsive, printable, review-friendly layout guidance.",
		Aliases: [][]string{{"layout"}},
		Body: `slashdocs guidelines: rendering layout

Layout for reading and review:
  - Use real headings, paragraphs, tables, lists, and figures where they fit.
  - Keep line lengths comfortable and leave enough space for comment highlights.
  - Prefer responsive grids and wrapping tables to fixed-width canvases for
    operational reports, specs, and trackers.
  - If you include a print stylesheet, keep it additive and avoid hiding content
    that reviewers need in the browser.
  - Avoid UI text overlapping content at narrow widths. Test mobile-sized and
    split-pane-sized viewports, not only a full desktop window.
  - For dashboards or trackers, make controls compact and predictable. The first
    screen should be the working surface, not a landing page.
`,
	},
	{
		Path:    []string{"interactivity"},
		Summary: "Scripts, controls, links, and stateful document behavior.",
		Body: `slashdocs guidelines: interactivity

Interactive documents are allowed.
  - Inline scripts, external scripts, iframes, workers, blob: URLs, and
    client-side rendering are allowed inside the single HTML file.
  - Prefer progressive enhancement: the core information should remain readable
    if a script is slow or a CDN is unavailable.
  - Use ordinary form controls for document-local tools: selects for option
    sets, checkboxes/toggles for binary state, inputs/sliders for numbers, and
    buttons for clear commands.
  - For links, make the target obvious in the visible text.
  - For persisted document-local state such as tracker rows and dropdown
    selections, use the slashdocs KV primitive:
      slashdocs guidelines interactivity kv
  - For document sign-off, use the native approval workflow instead of
    hand-rolled KV approval state:
      slashdocs guidelines review approvals
  - For documents that render files from GitHub at read time, use the GitHub
    bridge rather than embedding credentials or fetching private URLs directly:
      slashdocs guidelines interactivity github
  - For live-state printing and generated file downloads:
      slashdocs guidelines interactivity exports
`,
	},
	{
		Path:    []string{"interactivity", "exports"},
		Summary: "Print live document state and download generated files safely.",
		Aliases: [][]string{{"print"}, {"downloads"}},
		Body: `slashdocs guidelines: interactivity exports

Print and download buttons:
  - Call window.print() or window.slashdocs.print() directly from a click handler.
    Export as PDF in the document toolbar uses the same live-document snapshot.
  - Call window.slashdocs.download({ filename: "report.txt", blob: new Blob([text],
    { type: "text/plain" }) }) from a click handler. It returns a Promise.
    Prepare large or asynchronous exports before the user clicks Download.
  - Downloads accept file bytes, not a remote URL or filesystem path, and are
    limited to 20 MB. Names are normalized. Requests need browser user activation
    and are limited to one document-initiated export per five seconds.
  - Native download links remain sandboxed. Use the download API for generated
    files. No file is automatically opened or executed by slashdocs.

Print preparation is optional:
  - Existing synchronous beforeprint listeners can reveal collapsed sections.
  - For asynchronous preparation, register:
      window.addEventListener("slashdocs:beforeprint", event => {
        event.detail.waitUntil(revealSectionsForPrint());
      });
  - Register before printing, and call waitUntil synchronously in the listener.
    The platform waits up to 1.5 seconds, then snapshots the current DOM even if
    preparation rejects, hangs, or has no listener.
  - Use afterprint or slashdocs:afterprint to restore temporary document changes.
  - The preview preserves live form values, open details, and readable canvases.
    Password/file inputs are excluded. The snapshot has scripts disabled;
    embedded frames, inaccessible cross-origin canvases, and unmounted content
    cannot be captured. Render that content into the DOM during preparation.
  - Use @media print for pagination and print-only styling. Users can retry with
    the Print / Save as PDF button in the preview if their browser blocks auto-print.
`,
	},
	{
		Path:    []string{"interactivity", "kv"},
		Summary: "Persist tracker fields, dropdowns, and other document-local state.",
		Aliases: [][]string{{"kv"}, {"state"}, {"store"}, {"storage"}},
		Body: `slashdocs guidelines: interactivity kv

Uploaded HTML can use a document-scoped KV store through window.slashdocs.kv.
This is for runtime state such as tracker fields, dropdown choices,
checkboxes, and lightweight workflow metadata. (For document sign-off, prefer
the native approval workflow: slashdocs guidelines review approvals.)

API:
  const value = await window.slashdocs.kv.get("tracker:owner");
  const all = await window.slashdocs.kv.all();

  await window.slashdocs.kv.set("tracker:owner", {
    status: "done",
    by: "pm@example.com"
  });

  await window.slashdocs.kv.delete("tracker:owner");

  await window.slashdocs.kv.patch({
    "tracker:owner": { status: "done" },
    "tracker:old-row": null
  });

  await window.slashdocs.kv.undo();
  await window.slashdocs.kv.redo();

Events:
  function renderFromKV(event) {
    // event.source is "initial" for hydrate and "local" for local writes.
    // event.revision is the document KV revision.
    // event.items exists on hydrate/all-key snapshots.
    // event.changes exists on writes and lists changed keys.
    // event.operation is "set", "delete", "patch", "undo", or "redo".
  }

  window.slashdocs.on("kvchange", renderFromKV);
  window.slashdocs.off("kvchange", renderFromKV);

  window.addEventListener("kvchange", e => {
    // e.detail is the same event payload.
  });

Semantics:
  - KV is scoped to one document. One document's keys are not visible to another.
  - KV is document-level state, not version-level state.
  - KV writes persist immediately. There is no Save button for KV updates.
  - KV writes do not create document versions.
  - Template/HTML updates still go through the ordinary publish/version flow.
  - Viewers can read KV values. Editors can write KV values.
  - Values must be JSON-serializable.
  - null is a delete sentinel. set(key, null) deletes key, and passing null or
    undefined in patch deletes that key.
  - Keys must be non-empty, at most 128 bytes, and use only letters, numbers,
    dot, underscore, colon, or dash.
  - Values can be up to 64 KiB. A patch can change up to 256 keys and the
    request body can be up to 256 KiB.
  - slashdocs keeps an in-session undo/redo stack for local KV writes made through
    window.slashdocs.kv. Ctrl/Cmd+Z undoes the last local KV write; Ctrl/Cmd+Y and
    Ctrl/Cmd+Shift+Z redo it. Undo/redo apply ordinary KV patches, persist
    immediately, and emit kvchange events with operation "undo" or "redo".
  - Undo/redo is scoped to the current document iframe session. It does not
    create versions and should not be used as an audit log.
  - Treat kvchange as a render/update signal and read the payload or call
    get/all for the state you need. Do not rely on remote realtime fanout unless
    a future slashdocs guideline explicitly promises it.

Small dropdown example:
  <select id="status">
    <option value="pending">Pending</option>
    <option value="approved">Approved</option>
    <option value="blocked">Blocked</option>
  </select>

  <script>
    const key = "tracker:status";
    const select = document.querySelector("#status");

    window.slashdocs.kv.get(key).then(value => {
      if (value) select.value = value;
    });

    select.addEventListener("change", () => {
      window.slashdocs.kv.set(key, select.value);
    });

    window.slashdocs.on("kvchange", event => {
      if (event.items && event.items[key]) {
        select.value = event.items[key];
        return;
      }
      if ((event.changes || []).some(change => change.key === key)) {
        window.slashdocs.kv.get(key).then(value => {
          if (value) select.value = value;
        });
      }
    });
  </script>
`,
	},
	{
		Path:    []string{"interactivity", "github"},
		Summary: "Render GitHub repository files as reviewable document content.",
		Aliases: [][]string{{"github"}, {"github-backed"}, {"git-source"}},
		Body: `slashdocs guidelines: interactivity github

Uploaded HTML can read a GitHub repository file through
window.slashdocs.github.getRawContent. Use this for specifications, generated
references, package metadata, source definitions, and other content that should
remain in GitHub while being rendered and reviewed in slashdocs.

API:
  const file = await window.slashdocs.github.getRawContent({
    owner: "razorpay",
    repo: "example",
    path: "api/openapi.json",
    ref: "main"
  });

  // file contains owner, repo, path, ref, and content.
  // The document chooses how to parse and render file.content.

Ref behavior:
  - ref may be a branch, tag, or commit SHA.
  - Prefer a stable commit ref unless the document intentionally needs to follow
    a floating branch or tag. Floating refs can change without a new slashdocs
    version, so existing comments may need to be re-anchored.
  - Show the repository, path, and ref in the rendered document so reviewers know
    exactly what source they are reading.

Access and security:
  - Every reader loads the file using their own connected GitHub account and can
    only read repositories that GitHub permits that account to access.
  - Private organisation repositories may also require organisation approval of
    the configured GitHub integration.
  - slashdocs keeps the GitHub token outside uploaded HTML. Never put a token in the
    document or fetch a private raw.githubusercontent.com URL directly.
  - Treat repository content as untrusted input. Parse known formats and build DOM
    with textContent. Do not eval source code or assign arbitrary repository
    content to innerHTML.
  - Files are limited to 50 MiB.

Connection fallback:
  If loading fails because the reader may not have connected GitHub, offer a
  visible button that calls window.slashdocs.github.connect(). The trusted slashdocs
  shell starts the connection flow and returns to the same document. Also show a
  useful error because an incorrect path, ref, or repository permission can fail
  in the same place.

Reviewability:
  - Convert the source into semantic, selectable headings, paragraphs, lists,
    tables, and code blocks. Content added after the fetch remains commentable.
  - Do not render important review text only into canvas, images, or inaccessible
    widgets.
  - Keep stable DOM structure and headings when possible so comments can be
    re-anchored across slashdocs versions.

Small JSON renderer example:
  <p id="source">Loading GitHub source…</p>
  <dl id="metadata"></dl>

  <script>
    const source = document.querySelector("#source");
    const metadata = document.querySelector("#metadata");

    async function renderGitHubFile() {
      try {
        const file = await window.slashdocs.github.getRawContent({
          owner: "razorpay",
          repo: "example",
          path: "package.json",
          ref: "0123456789abcdef0123456789abcdef01234567"
        });
        const manifest = JSON.parse(file.content);
        source.textContent =
          file.owner + "/" + file.repo + ":" + file.path + "@" + file.ref;

        for (const [label, value] of [
          ["Package", manifest.name || "Unnamed"],
          ["Version", manifest.version || "Not specified"]
        ]) {
          const term = document.createElement("dt");
          const description = document.createElement("dd");
          term.textContent = label;
          description.textContent = value;
          metadata.append(term, description);
        }
      } catch (error) {
        source.textContent = String(error && error.message || error);
        const connect = document.createElement("button");
        connect.type = "button";
        connect.textContent = "Connect GitHub";
        connect.addEventListener("click", () => {
          window.slashdocs.github.connect();
        });
        source.after(connect);
      }
    }

    renderGitHubFile();
  </script>
`,
	},
	{
		Path:    []string{"review"},
		Summary: "Make documents easy to comment on, revise, and approve.",
		Aliases: [][]string{{"comments"}, {"accessibility"}, {"a11y"}},
		Body: `slashdocs guidelines: review

Write documents for review, not just display.
  - Use real text for important claims, numbers, headings, and decisions.
  - Keep tables and lists selectable whenever possible.
  - Give charts and screenshots nearby captions or summaries so comments can
    refer to them precisely.
  - Preserve stable headings between versions so reviewers can keep orientation.
  - Use accessible labels for controls in interactive documents.
  - Keep approval or tracker controls close to the content they affect.
  - Use KV for live document-local workflow state. Use versioned HTML updates for
    changes to the document template or source content.
  - For formal sign-off, use the native approval workflow:
      slashdocs guidelines review approvals
`,
	},
	{
		Path:    []string{"review", "approvals"},
		Summary: "Request and track document sign-off with the native approval workflow.",
		Aliases: [][]string{{"approvals"}, {"approval"}, {"approve"}},
		Body: `slashdocs guidelines: review approvals

slashdocs has a first-class approval workflow. Prefer it over hand-rolled KV
approval state: it is version-aware, server-enforced, and shows up in the
reader UI and document listings.

Model:
  - The document owner assigns approvers. Approvers need viewer access first.
  - Anyone who created a version of the document (including the owner who
    published it) cannot be an approver or decide: they wrote what is reviewed.
  - Approvers approve or request changes on a specific version, and only on
    the latest one; a decision on an older version is refused.
  - The document is "approved" only when every assigned approver approved.
  - A new version with changed content resets every approval: the approvers
    review it again. Pushing identical content keeps them.
  - Push with --keep-approvals to carry approved decisions onto a changed
    version (they show "approved on vN"); use it only for changes the approvers
    do not need to see again.
  - Approvers can revoke their decision at any time.
  - Requesting changes needs either open comments of yours on the document (they
    say what to change) or a note; a note is optional when approving. In the UI
    this is the Reject button: it lists your open comments, and approving with
    open comments asks you to confirm.

Commands:
  slashdocs docs approvers add <doc_id> --to reviewer@org.example
  slashdocs docs approvers list <doc_id>
  slashdocs docs approvers remove <doc_id> <approver_id>
  slashdocs docs approvals list <doc_id> [--version <version_id>]
  slashdocs docs approve <doc_id> [--version <version_id>] [--note "..."]
  slashdocs docs request-changes <doc_id> [--note "what needs to change"]
  slashdocs docs revoke-approval <doc_id> [--version <version_id>]
  slashdocs docs push <doc_id> <file> --keep-approvals

The document response includes approval_status and approval_summary once
approvers are assigned; use --json for machine-readable output.

Over MCP, the owner's side is available (the rules above apply unchanged):
  request_document_approval  ask a person or bot to approve (share first)
  list_document_approvers    who was asked, with the approval-request IDs
  list_document_approvals    what each decided on a version, and the status
  remove_document_approver   take a request back
  update_document            keep_approvals=true carries approvals forward
Approving, rejecting and revoking are not available over MCP: an approval is the
approver's own decision, made through the UI, the CLI or the API.
`,
	},
}

// Find returns the page whose path or alias matches the normalized path.
func Find(path []string) (Page, bool) {
	for _, p := range Pages {
		if samePath(path, p.Path) {
			return p, true
		}
		for _, alias := range p.Aliases {
			if samePath(path, NormalizePath(alias)) {
				return p, true
			}
		}
	}
	return Page{}, false
}

// NormalizePath lowercases, splits, and canonicalizes user-supplied section
// path segments so lookups tolerate spacing and underscore variants.
func NormalizePath(parts []string) []string {
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		for _, token := range strings.Fields(strings.ToLower(part)) {
			token = strings.ReplaceAll(token, "_", "-")
			if token != "" {
				out = append(out, token)
			}
		}
	}
	return out
}

func samePath(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
