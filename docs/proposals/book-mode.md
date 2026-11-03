# Book mode for slashdocs

Status: Proposed

## Summary

Book mode turns a folder into an ordered book that people can read from start
to finish, pick up where they stopped, and keep up with as agents revise it.

slashdocs already stores every version of every document, with a change
summary per version. Book mode builds on that. A reader can see which chapters
changed since they last read them, which sections changed, and why. None of
the nine docs tools or the e-readers surveyed for this proposal combine
per-reader progress with revision tracking (see [Research](#research)).

The first release covers two parts of the larger plan:

- **The book**: a versioned outline (parts, chapter order, numbering,
  placeholders for planned chapters), a book home page, a reader with an
  adaptive contents rail, reading settings, book search, and CLI and MCP
  access for agents.
- **Reading state**: a reading position that survives new versions, resume
  across devices, chapter states, progress, and "updated since you read".

Private notes and highlights, lab-step checklists, AI questions, export and
offline reading are later proposals.

The motivating book is a 98-chapter technical course written by agents: more
than half published, each chapter a single-file HTML document with about 15
inline SVG figures and a hands-on lab, revised often.

## Problem

A folder is a list. A 98-chapter course in a folder has no order, no parts and
no sense of progress, and it doesn't show what changed. Today that course
works around this with a hand-built roadmap document that holds links and a KV
progress tracker, and that document has to be republished whenever a chapter
is added. Readers click through the web UI one document at
a time and remember for themselves where they stopped.

Agents revise chapters often, sometimes many in one run (for example,
recomputing every rupee conversion). A reader who finished Chapter 24 last
week has no way to tell that it changed, or where.

## Goals

- Read a folder as a book: chapters in order, grouped into parts, numbered,
  with the whole book's shape visible, including chapters not yet written.
- Open the book and continue where you stopped, on any device.
- See which chapters you have read changed since you read them, which sections
  changed, and the author's note for each version.
- Keep the chapter page calm and wide, so figures and code have room.
- Let agents manage the outline as well as people do.

## Non-goals for this release

- Private notes, highlights and bookmarks. These send more private data into
  the chapter frame and get their own proposal (see [Security](#security)).
- Lab-step checklists and completion by labs. They need a lab-step authoring
  contract. Until then a reader marks a chapter done by hand.
- In-reader AI ("ask this book", "explain this"), quizzes and spaced review.
- PDF or EPUB export of a whole book, prefetching the next chapter, and
  offline reading.
- Reading analytics for book owners. A reader's progress is private to that
  reader.
- Books that span several folders, or one document in several books.
- Book mode in `slashdocs local`.

## Decisions

| Decision                         | Chosen                                                          | Over                                                       | Why                                                                                                                         |
| -------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Where a book lives               | A folder is the book (one book per folder)                      | A separate book object that references documents anywhere  | Folders already carry ownership, grants and search scope. Most of the model already exists.                                 |
| Source of chapter order          | A versioned outline, seeded from the numbers in the titles      | Sorting by title on every visit; subfolders as parts       | Only an outline gives parts, placeholders and renumbering without renaming documents.                                       |
| When a chapter counts as updated | Every new version counts                                        | Change classes set by the author or detected from the diff | The book owner's choice. Patch-level edits will light the indicator too, so the indicator is kept small and quick to clear. |
| Reader layout                    | Adaptive rail (layout C)                                        | Three panes; focus reader with a drawer                    | Gives the chapter the full reading width and keeps the map of the book in view.                                             |
| Completion                       | Reaching the end marks a chapter Read; the reader marks it Done | Scroll depth or time as completion                         | Scroll and time overstate reading. Lab-based completion comes with the labs proposal.                                       |
| Position model                   | Section id + quote anchor + progression, pinned to a version    | Scroll offset                                              | Scroll offsets break on every new version. slashdocs already has a quote-anchoring engine.                                  |

## Concepts

**Book.** A folder with book mode turned on. It has a title, an optional
subtitle and author line, and exactly one current outline. Turning book mode
off keeps the folder and its documents and hides the book views.

**Outline.** The ordered structure of the book, saved as a new outline version
on every change, like document versions. Entries are:

- _Front matter_ and _back matter_: documents without a chapter number (for
  example the existing "00 · Roadmap & Progress" document).
- _Parts_: titled groups with no page of their own.
- _Chapters_: a document in the book's folder.
- _Placeholders_: planned chapters with a title and no document yet.

Chapters and placeholders are numbered by their position across the whole
book, starting at 1. Numbers are never stored in titles. When a document title
starts with its own number followed by a separator (for example `24 · `), the
reader hides that prefix if the number matches the computed one.

**Reading state.** Per reader and chapter: the version last seen, the furthest
point reached, whether the end was reached, and whether the chapter is marked
done. Per reader and device: the latest reading position.

## The book outline

### Creating a book

"Make this a book" on a folder, `slashdocs books create <folder>`, or the
matching MCP tool creates the book and a first outline:

1. Documents whose titles start with a number go into the chapter list in
   number order. A title number of `0` or `00` goes into front matter.
2. Other documents go into a "Not in outline" list.
3. There are no parts until someone adds them.

The response lists the documents placed and the ones left out.

### Editing the outline

- People drag and drop chapters and parts, add placeholders, and move
  documents in or out of the outline, in an outline editor on the book page.
- Agents pull and push the outline as JSON through the CLI or MCP. A push
  states the outline version it was based on and fails with a conflict if the
  outline has changed since, the same way document pushes work today.
- Every change creates a new outline version with an optional change note.
  Editors can see the list of outline versions.

The authoring format is small and easy to write by hand or generate:

```json
{
  "title": "Applied AI Engineering",
  "subtitle": "Beginner to advanced",
  "front": [{ "doc": "doc_roadmap" }],
  "parts": [
    {
      "title": "Part I — Foundations",
      "chapters": [{ "doc": "doc_chapter01" }, { "planned": "Inference Internals" }]
    }
  ],
  "back": []
}
```

The server validates a push before saving it, and returns every problem with
its JSON path, not just the first. It checks:

- every `doc` is in this folder;
- no document appears twice;
- every `planned` entry has a non-empty title;
- part titles are non-empty;
- size limits: at most 500 entries and 200 characters per title.

### Placeholders fill themselves

When a document arrives in a book's folder (created there or moved in), the
server checks the outline:

- If the document's title starts with a number and that number belongs to a
  placeholder, the document replaces that placeholder.
- Otherwise, if its title (minus any number prefix) matches a placeholder's
  title, ignoring case, it replaces that placeholder.
- Otherwise it goes into "Not in outline".

A fill creates a new outline version with a change note such as "Chapter 58
filled by doc_…". "Not in outline" is shown only to editors.

### What readers receive

Readers never see the raw outline. The server builds a manifest for each
reader, shaped like a Readium Web Publication Manifest (`readingOrder` for
chapters, nested `toc` for parts and sections), with slashdocs fields under
`properties`:

- `documentId`, `number`, `versionId`, `wordCount`;
- `status` (`published` or `planned`);
- the reader's state for the chapter.

Chapters the reader cannot open are left out of the manifest entirely: no
title, id or position. Numbering stays the same for every reader, so a reader
without access to Chapter 41 sees Chapter 40 followed by Chapter 42.
Placeholders are visible to every reader of the book.

## Reading experience

Three layouts were mocked up and compared: three panes (contents, chapter,
outline), a focus reader with a contents drawer, and an adaptive rail. The
adaptive rail was chosen. It gives the chapter the full reading width, like
the focus reader, and keeps the book's map in view, like three panes.

### Book home

The book home is the default page of a book. It shows:

- the title, the author line, and progress ("Chapter 24 of 98", the share of
  the book read, and the number of chapters read);
- a **Continue reading** card with the chapter, section and an estimate of
  reading time left in the chapter;
- **Updated since you read**: one group listing every chapter the reader has
  opened that has a newer version, with each version's change note, plus "Mark
  all seen";
- every part as a collapsible row with a state dot per chapter, and the
  chapter list inside. Planned chapters appear dimmed and cannot be opened.

### Chapter reader (layout C)

- **Chapter page.** The chapter renders in the existing sandboxed frame and
  uses the full content width.
- **Contents rail.** A narrow rail on the left shows every chapter as a dot,
  grouped by part and coloured by state. It opens into the full contents when
  pointed at, when focused, or with `T`, and can be pinned open.
- **Top bar.** Breadcrumb (book › chapter), search, reading settings and the
  existing comments toggle.
- **Section tracker.** A thin tracker under the chapter title shows the
  current section and the reader's place among the chapter's sections. It is
  built from the version's headings.
- **End of chapter.** A "Mark chapter done" button and a card for the next
  chapter. Crossing into a new part says so on the card.
- **Phones.** Below a tablet width, the rail turns into a drawer opened from
  the top bar.

### Reading settings

Text size (three steps), line width (narrow, comfortable, wide) and theme
(light, paper, system). The bridge applies them inside the frame by adding a
stylesheet. Settings are saved per reader and apply to every book.

### Keyboard

- `←` and `→` move to the previous and next chapter.
- `T` opens the contents, `/` opens search and `?` lists the shortcuts.
- Shortcuts do nothing while focus is in a text field or a comment box.
- Single-key shortcuts can be turned off in reading settings, as required by
  WCAG 2.1.4.

### Accessibility

- When the chapter changes, focus moves to the chapter title in the host page,
  and a live region announces "Chapter 25, Agents: The Core Loop".
- The rail and drawer are a `nav` landmark. The current chapter carries
  `aria-current="page"`.
- The frame has a `title` naming the chapter.
- State dots always come with text, either as a visible label or an accessible
  name, never colour alone.

## Reading state

### Reading position

The position is a version-pinned anchor:

- the document and version;
- the id of the section heading at the top of the viewport;
- a short quote with prefix and suffix, the same shape as comment anchors
  today;
- the progression through the chapter, from 0 to 1.

The bridge already reports a quote anchor for the viewport. This release adds
the section id and the progression to that report.

To restore a position, the reader tries each of these in turn:

1. navigate to the quote, using the existing quote navigation;
2. otherwise, go to the section heading;
3. otherwise, scroll to the progression.

This works across versions because quote anchoring already allows fuzzy
matches.

The client saves the position at most every few seconds while the reader is
scrolling. It also saves immediately when the page is hidden. Each device keeps
its own latest position, identified by a random device id held in local
storage. Writes carry a client timestamp, and the server ignores a write older
than the stored one.

### Resume across devices

"Continue reading" uses the reader's most recent position on any device. When
the reader opens a chapter and another device holds a newer position, a small
dismissible note offers to go there. The note appears only if that position is
in a different chapter, or more than 15% of the chapter away. It is never a
dialog.

After any jump (contents, search, a link, or the cross-device note) a "Back to
where you were" note stays available for that chapter visit.

### Chapter states

| State                  | When                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Not started            | The reader has never opened the chapter.                                                                                                 |
| Reading                | Opened, end not reached.                                                                                                                 |
| Read                   | The reader reached the end of the chapter.                                                                                               |
| Done                   | The reader pressed "Mark chapter done". It can be undone.                                                                                |
| Updated since you read | The chapter has a newer version than the one the reader last saw, and the reader had opened it before. Shown alongside the other states. |

"Reached the end" means the last section came into view and the reader scrolled
to the end of it.

### Updated since you read

Every new version of a chapter the reader has opened counts as an update.

- **In the contents and on book home**: a dot and an "Updated" label on the
  chapter.
- **In the chapter**: a small "Updated since you read" chip beside the
  chapter's part and number. It opens a panel with:
  - the change summary of every version since the one the reader saw, newest
    first;
  - links to each section that changed.
- **In the chapter text**: a small dot beside each changed section's heading.

The update counts as seen when any of these happens:

- the reader dismisses the chip;
- the reader opens a section from the panel;
- the reader reaches the end of the chapter;
- the reader presses "Mark all seen" on book home.

Opening the chapter alone does not clear it.

**Changed sections** come from comparing the two versions section by section,
using the headings parsed from the HTML. Each section's text is normalised and
hashed. A section is marked changed if its hash differs, if it is new, or if
it was removed (removed sections are listed in the panel without a link).
Hashes are computed once per version and kept. The comparison for a pair of
versions is cached.

### Progress

- **Chapter number**: "Chapter X of N", where N counts the chapters the reader
  can open.
- **Share of the book**: words read divided by words in the chapters the
  reader can open. Words read is the words of every Read or Done chapter, plus
  the current chapter's progression times its words. Word counts are taken per
  version from the text already stored for search.
- **Time left in a chapter**: remaining words divided by 230 words per minute.
  It is shown as an estimate and is not learned from the reader's speed.

### Signed-out readers

On a public deployment, a signed-out reader of a book shared with "anyone"
gets the full reader. Their position and chapter states are kept in local
storage only. Signing in does not merge local state into the account.

## Book search

Search in a book uses the existing full-text search, limited to the book's
folder, and returns only chapters the reader can open. Results are listed by
chapter number. A toggle narrows the search to the current chapter. Opening a
result takes the reader to the first match in the chapter, using the existing
text navigation. Hits pointing to individual sections are left for later,
because search covers whole documents today.

## Agents

- **CLI**: `slashdocs books create|show|delete`,
  `slashdocs books outline pull <book> [file]`, and
  `slashdocs books outline push <book> <file> --base-version <id> [--note …]`.
  `slashdocs books status <book>` lists each chapter with its number, current
  version and title, as well as placeholders and documents not in the outline.
- **MCP**: tools to get a book, get its outline, update its outline with a base
  version, and list chapters. Each uses the same API and authorization as the
  CLI.
- **`llms.txt`**: each book serves a plain-text index of its chapters in order,
  with titles and links, filtered for the caller like the manifest.
- **Generated outlines**: a book's own build script can generate the outline
  JSON (for example 12 parts and 98 entries) and push it in one command.

## Authorization

- Reading a book requires viewer access to the folder or to at least one
  chapter. A book with no chapters the caller can open returns not found,
  unless the caller can view the folder.
- Every endpoint that takes a document id (positions, chapter states, update
  seen, search results) checks the caller's access to that document on the
  server. A write that names a document the caller cannot open fails with not
  found.
- Creating or deleting a book and editing its outline require editor access to
  the folder. Outline versions, the raw outline and "Not in outline" are
  visible only to editors.
- Reading state belongs to the reader. No endpoint returns another user's
  state, and owners see no reader data.

## Security

- **Chapter HTML is untrusted.** Documents may run their own scripts, so
  anything the frame reports is a hint, not a fact. The server validates each
  position report:
  - the section id must be one of the version's parsed headings;
  - the progression is clamped to 0–1;
  - the quote is length-limited;
  - the version must be one the reader was served.
- **Nothing private goes into the frame.** This release sends no private data
  into the frame beyond the reader's own settings and the anchor being
  navigated to. Private notes and highlights, which would send more, wait for
  a separate review of how the frame is isolated.
- **Rate limits.** Position and state writes are rate-limited per user, like
  presence updates today.

## Persistence (proposed)

The final names are settled in the implementation plan.

| Table                   | Holds                                                                                                                                                                |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `books`                 | Book id, folder id (unique), title fields, current outline version, created by and at.                                                                               |
| `book_outline_versions` | Outline version id, book id, number, authoring JSON, change note, created by and at.                                                                                 |
| `version_sections`      | Per document version: section heading id, title, level, order, text hash, word count. Filled when a version is created; older versions are filled in the background. |
| `reading_positions`     | User, book, device id, document, version, anchor JSON, progression, client and server timestamps. One row per user, book and device.                                 |
| `chapter_reads`         | User, document, book, last seen version, furthest progression, reached-end time, done time, last opened time.                                                        |
| `reader_settings`       | User, text size, line width, theme, shortcuts on or off.                                                                                                             |

## Error handling

- An outline push with a stale base version returns a conflict with the
  current version id, as document pushes do.
- An invalid outline returns every validation problem with its path.
- A chapter whose document was deleted drops out of the outline in the next
  outline version, which the server creates with a change note. Readers' state
  for it is deleted with the document.
- A position that cannot be restored by quote, heading or progression opens
  the chapter at the top, with a note saying the saved place could not be
  found.

## Tests

- **Go repository and API tests**:
  - creating a book from titles, including front matter and unnumbered
    documents;
  - outline validation and conflicts;
  - placeholder fill by number and by title;
  - per-reader manifest filtering with stable numbering;
  - authorization on every endpoint, including writes naming hidden chapters;
  - the changed-section comparison;
  - the progress maths;
  - stale position writes being ignored.
- **Bridge tests**: section id and progression in viewport reports; settings
  stylesheet injection; restoring a position by quote, then heading, then
  progression.
- **Frontend tests**: rail states and keyboard; the shortcut guard while
  typing; the update chip and panel; "Mark all seen"; focus and announcement
  on chapter change.
- **Browser tests**, using the existing end-to-end suite: create a book from a
  folder, read across two chapters, publish a new version, see the update chip
  and changed sections, and resume on a second browser context.

## Observability

Counters, with no per-user reader analytics:

- book page views;
- position writes, including rejected and stale ones;
- outline versions created, including placeholder fills;
- update chips opened and dismissed;
- positions that could not be restored.

The last counter is the early warning that heading ids are changing too much
between versions.

## Rollout

- Behind a deployment setting, off by default, until the browser tests pass on
  stage.
- The motivating course is the first book. Its roadmap document stays as
  front matter until the book home replaces it.
- No data migration for existing folders or documents. `version_sections` for
  existing versions is filled in the background, like the search indexer
  today.

## Assumptions

- Agents keep heading ids stable across revisions of a chapter. Book mode
  works without this, but changed-section lists and restored positions are
  more precise with it. The `slashdocs guidelines` output will ask for it.
- 230 words per minute is used for time estimates. It is a reasonable
  average for technical reading, not a measured figure for this book.
- 15% of a chapter is the threshold for the cross-device note. Tune it after
  use.

## Requirements

- R1: An editor of a folder can turn it into a book. This creates an outline
  from numbered titles, puts `0`/`00` documents in front matter, and lists the
  rest as not in the outline.
- R2: The outline supports front matter, parts, chapters, placeholders and
  back matter, and every change creates a new outline version with an
  optional note.
- R3: Agents can pull and push the outline through the CLI and MCP, with a
  base-version conflict check and complete validation errors.
- R4: People can reorder chapters and parts, add placeholders, and move
  documents in or out of the outline in the web UI.
- R5: A document arriving in a book's folder fills a placeholder with the same
  number or title. Otherwise it goes to "Not in outline", visible only to
  editors.
- R6: Chapter numbers are computed from outline position. A matching number
  prefix in a document title is hidden in the reader.
- R7: The served manifest is RWPM-shaped, built per reader, leaves out
  chapters the reader cannot open, and keeps numbering the same for all
  readers.
- R8: Book home shows progress, Continue reading, the grouped updates list
  with Mark all seen, and the parts with chapter states, including planned
  chapters.
- R9: The chapter reader uses layout C: a full-width chapter, a contents rail
  that expands on hover, focus or `T` and can be pinned, a section tracker,
  and an end-of-chapter Done button and next-chapter card.
- R10: Below tablet width, the rail becomes a drawer.
- R11: Readers can set text size, line width, theme, and turn single-key
  shortcuts off. Settings apply to every book.
- R12: `←`/`→`, `T`, `/` and `?` work, and do nothing while focus is in a text
  field.
- R13: On a chapter change, focus moves to the chapter title and the change is
  announced. The frame has a title, and states are never shown by colour
  alone.
- R14: The reading position is saved as section id, quote anchor and
  progression, pinned to a version, per device. It is saved while scrolling
  (debounced) and immediately when the page is hidden. Stale writes are
  ignored.
- R15: Opening a book or chapter restores the position by quote, then heading,
  then progression, and says so when none works.
- R16: Continue reading uses the most recent position from any device. A
  non-modal note offers another device's newer position under the stated
  threshold. A "Back to where you were" note follows any jump.
- R17: Chapter states are Not started, Reading, Read, Done (reversible), plus
  Updated since you read.
- R18: Every new version of a chapter the reader has opened marks it updated
  until it is seen (chip dismissed, changed section opened, end reached, or
  Mark all seen). Opening the chapter alone does not clear it.
- R19: The update chip opens a panel with every version note since the seen
  version and links to each changed section. Changed section headings show a
  dot in the chapter.
- R20: Changed sections are computed by comparing section text hashes between
  the seen version and the current version.
- R21: Progress shows "Chapter X of N" and a word-weighted share, both counted
  over chapters the reader can open. Time left in a chapter uses 230 words per
  minute.
- R22: Book search uses existing full-text search scoped to the book, returns
  only chapters the reader can open, can narrow to the current chapter, and
  opens results at the first match.
- R23: Each book serves a filtered `llms.txt` of its chapters.
- R24: Every endpoint that names a document authorises it on the server, and
  writes naming a hidden chapter fail with not found.
- R25: Outline editing, outline versions and "Not in outline" require folder
  editor access. Reading state is never returned to anyone but its owner.
- R26: Position reports from the frame are validated: known heading ids,
  clamped progression, capped quote length, served version.
- R27: Signed-out readers of public books get the reader with local-only
  state.
- R28: Book mode is behind a deployment setting, off by default.

## Open questions

- Should chapters that the reader marks Done collapse in the rail's dot map,
  or should every chapter keep its dot?
- Should a book have a cover image, set by the owner, for the book home page
  and lists? The mockup uses a generated cover.

## Research

The research behind this proposal covered nine docs tools, nine reading
platforms, the W3C, Readium and EPUB standards, Hypothesis anchoring, iframe
mechanics and learning-science evidence. The main findings:

- **Which standards to use.** The served manifest follows the RWPM shape. The
  W3C Web Publications work was discontinued, and EPUB CFI is not maintained.
  Positions follow the W3C Web Annotation quote and position selectors, which
  is the shape of slashdocs comment anchors today.
- **What breaks elsewhere.** Kindle has lost highlights when a book was
  updated, and its cross-device prompts nag. Scroll and time overstate
  reading. mdBook's keyboard shortcuts fired while people were typing.
- **What is missing everywhere.** No surveyed product shows a reader what
  changed since they last read.
