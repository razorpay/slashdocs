// Source pieces describe the edited content of a document so that the app can
// write it back into the HTML source by position, never by searching for text.
//
// The server renders each version with SOURCE_ATTR on every element that has
// a start tag in the source. Its value is the offset of that start tag in the
// version source, counted in UTF-16 code units, as JavaScript strings and
// parse5 count. The attribute is never saved: the app writes the source of
// an original element from the version source, not from the live DOM.
//
// The bridge describes each edited region of the document as pieces. An
// original node is referred to by its position in the version source, and
// only new content is HTML. The app then emits the source bytes of every
// original node that did not change.

export const SOURCE_ATTR = "data-slashdocs-source";

// A text or comment node of the version source: the offset of the start tag
// of its parent element, or -1 for the document, and its index among that
// parent's children in the version source. Children are counted as the
// source map counts them: the children of an element with no start tag, such
// as an implied <tbody>, count as children of its parent, and adjacent text
// is one child.
export type ChildRef = { parent: number; index: number };

export type Piece =
  // An original element, unchanged: its source, by the offset of its start tag.
  | { keep: number }
  // An original text or comment node, unchanged: its source.
  | { keepChild: ChildRef }
  // Text. was names the original text node it replaces, so that the source
  // keeps the spelling of the characters that did not change, such as &nbsp;.
  | { text: string; was?: ChildRef }
  // An original element with new children: its own start and end tags from
  // the source, around the children.
  | { element: number; children: Piece[] }
  // A new element: its start and end tags as HTML, around the children.
  | { open: string; close: string; children: Piece[] };

// A region replaces the original sibling elements from through to, and all
// the source between them, with pieces. removed names the original elements
// in that span that the editor deleted. Every other original element in the
// span must appear in the pieces, so that a region never drops content that
// a script moved away.
export type Region = { from: number; to: number; pieces: Piece[]; removed: number[] };

// A node that a script made has no source position. A locator finds it from
// the nearest original element above it, by the indexes of the children on
// the way down, without the bridge's own nodes. at is null for the body when
// it has no start tag in the source.
export type Locator = { at: number | null; path: number[] };

// A change to text that a script shows: its text before and after the edit.
export type ScriptChange = { locator: Locator; before: string; after: string };

// A patch brings the frame to a newer source without a load. The offsets
// are those of the version that the frame loaded.
export type Patch =
  // A run changes the nodes of the original element `in` that lie between
  // its original child elements `after` and `before` to html. null is the
  // start or the end of the element. `in` is null for a body that has no
  // start tag in the source. marks are the ranges of html that other people
  // put in, as [start, end) offsets in html (UTF-16 code units), in order,
  // with no overlap. The frame puts that text at exactly those places.
  | {
      in: number | null;
      after: number | null;
      before: number | null;
      html: string;
      marks?: Mark[];
    }
  // The start tag of an original element changes to html: the element gets
  // its attributes.
  | { tag: number; html: string }
  // The text of an original style element changes to html.
  | { style: number; html: string }
  // The code of an original script changes to html, in one string that the
  // page shows: each of its places shows to in place of from. places is the
  // count of those places. The script does not run again.
  | { script: number; html: string; from: string; to: string; places: number };
export type Mark = [start: number, end: number];
