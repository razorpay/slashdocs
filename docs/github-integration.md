# GitHub-backed documents

slashdocs users can connect their own GitHub account from **Profile**. The server
uses a GitHub OAuth App and stores the resulting access token encrypted at
rest. The token is never returned to the browser or to uploaded document code.

Configure the OAuth App with this callback URL:

```text
https://<slashdocs-app-origin>/v1/integrations/github/callback
```

Then set `SLASHDOCS_GITHUB_CLIENT_ID` and `SLASHDOCS_GITHUB_CLIENT_SECRET` (or use
the `githubOAuth` Helm values).

## Document API

Uploaded HTML can fetch the raw bytes of a repository file at a branch, tag,
or commit through the sandbox bridge:

```html
<main id="content">Loading…</main>
<script>
  const file = await window.slashdocs.github.getRawContent({
    owner: "razorpay",
    repo: "example",
    path: "docs/architecture.html",
    ref: "main", // a branch, tag, or commit SHA
  });
  document.querySelector("#content").innerHTML = file.content;
</script>
```

If a fetch fails because the reader has not connected GitHub, let the document
offer the connection action directly. The trusted slashdocs shell starts OAuth and
returns the reader to the same document and heading:

```html
<button id="connect-github" type="button">Connect GitHub</button>
<script>
  document.querySelector("#connect-github").addEventListener("click", () => {
    window.slashdocs.github.connect();
  });
</script>
```

The document can present this as a button or link-like control. It should call
`connect()` rather than constructing an OAuth URL, because the app and render
frames may be served from separate origins.

## Author access rule

Document code reads GitHub with the reader's token. Thus a document gives a
file only when **every principal who created a version of the document** can
also read the repository. The document cannot give its authors data that they
cannot already read. The rule covers all version creators, not only the
current editors, because code stays in a document after its author stops
editing.

- A service account counts as its owner, because the owner controls its keys.
  A document that a service account creates can read the repositories that
  the owner can read. Do not give the keys of a service account to a bot
  that writes documents for other people: those people then get the owner's
  GitHub access.
- An author who has not connected GitHub fails the rule. The request fails
  with `403 github_author_access`, and the error details give the author.
- The reader is not examined as an author: the fetch with the reader's own
  token proves their access.
- slashdocs caches each user's answer for each repository for 4 hours, so
  popular documents do not use up the authors' GitHub rate limit. When a user
  connects GitHub again, the cached answers for that user are no longer used.
  After GitHub removes a user's access, documents can read the repository for
  4 hours more.

The document decides how to render the returned raw content. DOM inserted
after the fetch is monitored by the existing annotation bridge, so readers can
select it and attach comments normally. Files are limited to 50 MiB.

The first implementation uses a GitHub OAuth App and requests the `repo` scope,
because OAuth Apps cannot request read-only access to private repository
contents. A future GitHub App implementation can narrow this to read-only
Contents permission and short-lived installation tokens without changing the
`window.slashdocs.github` API.
