# Document page metadata

Status: Proposed

## Summary

Every page of the web app is served from one static `index.html`, so a
document URL fetched without JavaScript reads `<title>slashdocs</title>` with
no description and no preview image. The tab title is only set after the
React app loads the document. Link unfurlers (Slack, chat apps, social sites),
bookmarks saved before hydration, and the browser history all see the generic
shell.

This proposal serves a document-specific `<head>` for `/app/d/:id` to callers
who may read the document, and a generated preview card image for it.

## Goals

- The first HTML byte of `/app/d/:id` carries the document title, a short
  description and Open Graph / Twitter Card metadata, for a caller with at
  least the viewer role.
- A generated 1200×630 PNG preview card (title, excerpt, owner, date) that
  `og:image` points to.
- No document metadata is revealed to a caller who cannot read the document.

## Non-goals

- Rich Slack previews on `org` deployments. Slack's unfurler has no session,
  so it is not a reader of any document there and receives the generic shell.
  That needs a Slack app that unfurls on behalf of the person who shared the
  link (`link_shared` → access check → `chat.unfurl`), which is a separate
  proposal. It can reuse the preview card from this one.
- A per-document favicon.
- Author-declared descriptions read from the uploaded HTML.

## Who sees what

| Caller                                      | `org` deployment | `public` deployment |
| ------------------------------------------- | ---------------- | ------------------- |
| Signed-in reader of the document            | Document head    | Document head       |
| Signed-in non-reader                        | Generic shell    | Generic shell       |
| No session, document shared with anyone     | Generic shell    | Document head       |
| No session, document not shared with anyone | Generic shell    | Generic shell       |

A missing document, a lookup error, an invalid bearer token or unavailable
Google Group membership all serve the generic shell. The shell never fails a
page load and never redirects to sign-in; the React app keeps handling those
cases as it does today.

## Approach

### Document head

The SPA fallback handler recognises `/app/d/{id}` and asks a document-head
builder for a replacement `<head>` fragment. The builder:

1. Authenticates the request with the same reader authenticator as
   `GET /v1/documents/:id` (anonymous on `public` deployments, required on
   `org`), and resolves Google Group membership when that is enabled.
2. Checks `RoleForDocument` for at least the viewer role.
3. Loads the document and a preview of its current version: the first 2,000
   characters of `versions.search_text` and the version's creation time.
4. Renders the fragment with `html/template`, so the title and description are
   escaped for their text and attribute contexts.

It has no side effects: it does not record a workspace entry as
`GET /v1/documents/:id` does.

The fragment replaces the `<title>slashdocs</title>` tag of the built
`index.html`. Once both delivery steps below have landed, it reads:

```html
<title>{title} · slashdocs</title>
<meta name="description" content="{description}" />
<meta property="og:site_name" content="slashdocs" />
<meta property="og:type" content="article" />
<meta property="og:title" content="{title}" />
<meta property="og:description" content="{description}" />
<meta property="og:url" content="{app origin}/app/d/{id}" />
<meta
  property="og:image"
  content="{app origin}/v1/documents/{id}/preview.png?v={card hash}"
/>
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
```

`og:url` and `og:image` are omitted when no app origin is configured.

A response that carries a document head is per caller, so every `/app/d/`
shell is sent with `Cache-Control: no-store`.

### Description

The description is an excerpt of what a reader sees: the current version's
indexed text with a leading copy of the title removed, cut at a word boundary to at most 200
characters with an ellipsis. When the version has no indexed text yet, the
description is a byline: `By {owner name} · Updated {2 Jan 2006}`.

The excerpt can start with navigation or table-of-contents text. That is
accepted for now; author-declared descriptions are the later fix. Documents
often repeat their title in `<title>` and `<h1>`, which is why a leading copy
is removed.

### Preview card

`GET /v1/documents/:id/preview.png` sits in the reader route group, so it has
the same authentication and the same viewer-role check as
`GET /v1/documents/:id`. It returns a 1200×630 PNG drawn in Go: the title
(wrapped, at most three lines), one line of the excerpt, the owner's initials
and name, the update date, and the slashdocs wordmark, using the fonts the web
app already ships. The response carries an `ETag` over the card's inputs and
`Cache-Control: private, max-age=3600`; the `v` query parameter in `og:image`
is the same hash, so a new version or a rename changes the URL.

The card is drawn from data, not from the document. Rendering the uploaded
HTML in a headless browser would execute untrusted scripts on the server.

The card draws no owner photo, so the server makes no outbound request.

### Tab title on navigation

`useTitle` restores the previous title when a page unmounts. With a
server-rendered document title, that previous title is the document's, and a
page that sets no title of its own (such as Start) would keep it. `useTitle`
will reset to `slashdocs` instead.

## Delivery

1. Document head with `twitter:card=summary` and no `og:image`, the
   description, `Cache-Control`, and the `useTitle` fix.
2. The preview card endpoint, and `og:image` plus `summary_large_image` in the
   head.

## Testing

- Handler tests against the Postgres-backed test environment for each row of
  the "Who sees what" table, including a title containing `"` and `<` to
  prove escaping, and for the preview card's role check, content type, size
  and `ETag` revalidation.
- Unit tests for the excerpt (title stripping, word-boundary cut, byline
  fallback).
- A test that the frontend `index.html` still contains the exact
  `<title>slashdocs</title>` tag the server replaces.

## Assumptions

- Document owners do not change, so "owner" is the person or service account
  that created the document.
- Titles in non-Latin scripts render with missing glyphs on the card, because
  the embedded fonts cover Latin only. The HTML head is unaffected.

## Security guidance applied

- `authorization/access-control`
- `validation/untrusted-input`
