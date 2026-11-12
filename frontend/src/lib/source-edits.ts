// Source edits write the regions that an editor changed in the rendered
// document back into its HTML source, by position. The pieces of a region
// refer to the nodes of the version source by offset, so every node that did
// not change keeps its exact source bytes, and only new content is written
// as new HTML. An operation is then the difference between two such sources,
// as replacements at UTF-8 byte offsets of the source at its base seq.

import type { DefaultTreeAdapterTypes as P } from "parse5";
import {
  SOURCE_ATTR,
  type ChildRef,
  type Piece,
  type Region,
} from "../../bridge/source-pieces.ts";

export type Replacement = {
  start: number;
  end: number;
  old_html: string;
  new_html: string;
};

// A change replaces the text from start to end of a source with text. The
// offsets count UTF-16 code units, as JavaScript strings and parse5 count.
export type Change = { start: number; end: number; text: string };

// A source and its parse5 tree. Elements are found by the offset of their
// start tag. Treat it as opaque: only this module and source-patch.ts read
// it.
export type SourceTree = {
  readonly source: string;
  readonly document: P.Document;
  readonly elements: Map<number, P.Element>;
  // The offsets of the start tags that the parser made more than one element
  // for, such as a <b> that closes too late.
  readonly copied: Set<number>;
  // The attribute names that each tag name has somewhere in the source.
  readonly attributes: Map<string, Set<string>>;
  readonly decode: (reference: string) => string;
  // Parses another source with the parser that this tree loaded.
  readonly parse: (source: string) => SourceTree;
};

// The parser puts the text after </body> in the last text of the body. That
// source stays after the end tag: the child ends at the tag, and past is
// where its source ends.
export type Child =
  | { element: P.Element }
  | { kind: "text" | "comment" | "other"; start: number; end: number; past?: number };

// The elements that have no end tag.
export const VOID =
  /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;
// The tags that new content can have, as the bridge writes them.
const NEW_TAG = /^(p|br|strong|b|em|i|a|ul|ol|li)$/;
const NEW_OPEN = /^<([a-z]+)((?: [^\s"'>/=]+="[^"]*")*)>$/;
const NEW_ATTRIBUTE = / ([^\s"'>/=]+)="([^"]*)"/g;
const SAFE_HREF = /^(https?:|mailto:|#)/i;
const TAG_NAME = /[^\s/>]*/y;
const MARKUP = /<!--[\s\S]*?-->|<[^>]*>/g;

// The units of source text: a character reference, a line break, or one
// character. Each decodes on its own, so the spelling of each one that did
// not change can stay.
const TEXT_UNIT = /&(?:#\d+;?|#x[\da-f]+;?|[a-z][a-z\d]*;?)|\r\n?|[\s\S]/giu;

// parseSource parses a version source. It loads parse5 only when it is first
// needed, because only editors need it.
export async function parseSource(source: string): Promise<SourceTree> {
  return treeOf(await import("parse5"), source);
}

function treeOf(parser: typeof import("parse5"), source: string): SourceTree {
  const document = parser.parse(source, { sourceCodeLocationInfo: true });
  const elements = new Map<number, P.Element>();
  const copied = new Set<number>();
  const attributes = new Map<string, Set<string>>();
  const visit = (node: P.ParentNode) => {
    for (const child of node.childNodes) {
      if (!("tagName" in child)) continue;
      const start = child.sourceCodeLocation?.startTag?.startOffset;
      if (start !== undefined) {
        if (elements.has(start)) copied.add(start);
        elements.set(start, child);
      }
      const names = attributes.get(child.tagName) ?? new Set();
      child.attrs.forEach((attr) => names.add(attr.name));
      attributes.set(child.tagName, names);
      visit(child.tagName === "template" ? (child as P.Template).content : child);
    }
  };
  visit(document);
  const decoded = new Map<string, string>();
  const decode = (reference: string) => {
    let text = decoded.get(reference);
    if (text === undefined) {
      const node = parser.parseFragment(reference).childNodes[0];
      text = node && "value" in node ? node.value : "";
      decoded.set(reference, text);
    }
    return text;
  };
  const parse = (other: string) => treeOf(parser, other);
  return { source, document, elements, copied, attributes, decode, parse };
}

// The reason that a region cannot apply.
class Refusal extends Error {}

// applyRegions writes every region into the source of tree. outside are the
// changes that the frame shows and that no region writes: of a start tag,
// or of the text of a style. They are in order, and each one is in the
// source of one original element, which the regions copy whole. made are
// the start tags of the elements that patches put in the frame: a region
// writes such an element with its start tag as the patch had it. It refuses
// when a piece refers to a node that the source does not have, or when a
// region would drop an original element that its pieces do not name.
export function applyRegions(
  tree: SourceTree,
  regions: Region[],
  outside: Change[] = [],
  made: ReadonlySet<string> = new Set(),
): { html: string } | { refused: string } {
  // copy gives the source from start to end, with the changes in it.
  const copy: Copy = (start, end) => {
    let html = "";
    let at = start;
    for (const change of outside) {
      if ((change.end <= start && change.start < start) || change.start >= end)
        continue;
      if (change.start < start || change.end > end)
        throw new Refusal("a change outside the regions is in a region");
      html += tree.source.slice(at, change.start) + change.text;
      at = change.end;
    }
    return html + tree.source.slice(at, end);
  };
  try {
    const spans = regions
      .map((region) => ({ region, ...spanOf(tree, region) }))
      .sort((a, b) => a.start - b.start);
    let html = "";
    let at = 0;
    for (const span of spans) {
      if (span.start < at) throw new Refusal("two regions overlap");
      html += copy(at, span.start) + writeRegion(tree, span, copy, made);
      at = span.end;
    }
    return { html: html + copy(at, tree.source.length) };
  } catch (error) {
    if (error instanceof Refusal) return { refused: error.message };
    throw error;
  }
}

type Span = { region: Region; parent: P.ParentNode; start: number; end: number };
type Copy = (start: number, end: number) => string;

// spanOf finds the source that a region replaces: from the start of its
// first element to the end of its last one, two children of one parent.
function spanOf(tree: SourceTree, region: Region): Omit<Span, "region"> {
  const from = rangeOf(elementAt(tree, region.from));
  const to = rangeOf(elementAt(tree, region.to));
  const parent = logicalParent(from.element);
  if (parent !== logicalParent(to.element) || from.start > to.start) {
    throw new Refusal(
      `the region from ${region.from} to ${region.to} is not a run of siblings`,
    );
  }
  return { parent, start: from.start, end: to.end };
}

function writeRegion(
  tree: SourceTree,
  span: Span,
  copy: Copy,
  made: ReadonlySet<string>,
): string {
  const mentions = new Map<P.Element, "keep" | "element">();
  const mention = (element: P.Element, how: "keep" | "element") => {
    if (mentions.has(element))
      throw new Refusal(`the region writes ${describe(element)} twice`);
    mentions.set(element, how);
  };
  const inSpan = (start: number, end: number) => start >= span.start && end <= span.end;

  const write = (piece: Piece): string => {
    if ("keep" in piece) {
      const { element, start, end } = rangeOf(elementAt(tree, piece.keep));
      mention(element, "keep");
      return copy(start, end);
    }
    if ("keepChild" in piece) {
      const child = childAt(tree, piece.keepChild);
      if (
        !("kind" in child) ||
        child.kind === "other" ||
        !inSpan(child.start, child.end)
      ) {
        throw new Refusal(
          `no text or comment in the region at ${refName(piece.keepChild)}`,
        );
      }
      return copy(child.start, child.end);
    }
    if ("text" in piece) {
      if (!piece.was) return newText(piece.text, "");
      const was = childAt(tree, piece.was);
      if (!("kind" in was) || was.kind !== "text") {
        throw new Refusal(`no text at ${refName(piece.was)}`);
      }
      const old = tree.source.slice(was.start, was.end);
      const past = tree.source.slice(was.end, was.past ?? was.end).replace(MARKUP, "");
      return respell(tree, old, piece.text, past);
    }
    if ("element" in piece) {
      const element = elementAt(tree, piece.element);
      const location = element.sourceCodeLocation;
      if (!location?.startTag) throw new Refusal(`no start tag at ${piece.element}`);
      mention(element, "element");
      const { startTag, endTag } = location;
      return (
        copy(startTag.startOffset, startTag.endOffset) +
        piece.children.map(write).join("") +
        (endTag ? copy(endTag.startOffset, endTag.endOffset) : "")
      );
    }
    checkNewTag(tree, piece.open, piece.close, made);
    return piece.open + piece.children.map(write).join("") + piece.close;
  };
  const html = span.region.pieces.map(write).join("");

  // Every original element in the span must be written, or deleted by the
  // editor, so that a region never drops content that a script moved away.
  // An element in a kept one is written with it. An element in a deleted
  // one goes with it, unless the pieces write it somewhere else.
  const removed = new Set(span.region.removed.map((at) => elementAt(tree, at)));
  const written = new Set<P.Element>();
  const cover = (element: P.Element, outer: "kept" | "removed" | null) => {
    const how = mentions.get(element);
    if (how && outer === "kept")
      throw new Refusal(`the region writes ${describe(element)} twice`);
    if (how) written.add(element);
    else if (!outer && !removed.has(element)) {
      throw new Refusal(`the region leaves out ${describe(element)}`);
    }
    const inner =
      how === "keep" ? "kept" : how === "element" ? null : (outer ?? "removed");
    for (const child of childrenOf(element))
      if ("element" in child) cover(child.element, inner);
  };
  for (const child of childrenOf(span.parent)) {
    if ("element" in child && inSpan(...bounds(child.element)))
      cover(child.element, null);
  }
  for (const element of mentions.keys()) {
    if (!written.has(element))
      throw new Refusal(`${describe(element)} is not in the region`);
  }
  return html;
}

// checkNewTag makes sure that new content is one of the tags that the bridge
// writes, with attributes that the source already uses on that tag or the
// start number of a list, so that a region can never add a script or an
// event handler. An element that a patch put in has its start tag exactly as
// the patch had it, one of made: that text is already in the document.
function checkNewTag(
  tree: SourceTree,
  open: string,
  close: string,
  made: ReadonlySet<string>,
) {
  if (made.has(open)) {
    const name = /^<([^\s/>]+)/.exec(open)![1].toLowerCase();
    if (close !== (VOID.test(name) ? "" : `</${name}>`))
      throw new Refusal(`new content cannot be ${open}${close}`);
    return;
  }
  const [, name, attributes] = NEW_OPEN.exec(open) ?? [];
  if (!name || !NEW_TAG.test(name) || close !== (name === "br" ? "" : `</${name}>`)) {
    throw new Refusal(`new content cannot be ${open}${close}`);
  }
  for (const [, attribute, value] of attributes.matchAll(NEW_ATTRIBUTE)) {
    const allowed =
      attribute === "href"
        ? name === "a" && SAFE_HREF.test(value.replace(/&amp;/g, "&"))
        : (attribute === "start" && name === "ol" && /^[1-9]\d*$/.test(value)) ||
          (attribute !== "id" && tree.attributes.get(name)?.has(attribute));
    if (!allowed)
      throw new Refusal(`new content cannot have ${attribute} on <${name}>`);
  }
}

// respell writes text in place of the source text old. The characters at
// the start and the end that did not change keep their old spelling, such
// as &nbsp; or a CRLF line break. past is the text that follows old after
// </body>: the source keeps it there, so it is not written when it did not
// change. A frame that loaded the source shows the past after old, and a
// frame that a patch changed does not.
function respell(tree: SourceTree, old: string, text: string, past = ""): string {
  const units = (old + past).match(TEXT_UNIT) ?? [];
  const decoded = units.map((unit) =>
    unit[0] === "&" ? tree.decode(unit) : unit[0] === "\r" ? "\n" : unit,
  );
  const end = units.length - (past.match(TEXT_UNIT) ?? []).length;
  let head = 0;
  let from = 0;
  while (head < units.length && text.startsWith(decoded[head], from)) {
    from += decoded[head++].length;
  }
  // A text that goes on from old into the past shows the past. Only the
  // text before the past can change, because the source keeps the past
  // after </body>.
  if (head > end) {
    const kept = decoded.slice(end).join("");
    if (!text.endsWith(kept)) throw new Refusal("the text after </body> cannot change");
    return respell(tree, old, text.slice(0, text.length - kept.length));
  }
  let tail = units.length;
  let to = text.length;
  while (
    tail > head &&
    to - decoded[tail - 1].length >= from &&
    text.startsWith(decoded[tail - 1], to - decoded[tail - 1].length)
  ) {
    to -= decoded[--tail].length;
  }
  return (
    units.slice(0, head).join("") +
    newText(text.slice(from, to), decoded.join("")) +
    units.slice(tail, Math.max(tail, end)).join("")
  );
}

// newText escapes what the reader typed. Browsers type a non-breaking space
// where an ordinary one would collapse, which the source should not keep
// unless the old text already used them.
function newText(typed: string, old: string): string {
  const spaces = old.includes("\u00a0") ? typed : typed.replace(/\u00a0/g, " ");
  return spaces
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00a0/g, "&nbsp;");
}

// elementAt finds the element whose start tag is at offset at. The start tag
// of an <html> or <body> that the parser had already made, as after a byte
// order mark, only adds its attributes to that element.
function elementAt(tree: SourceTree, at: number): P.Element {
  const element = tree.elements.get(at);
  if (element) return element;
  const merged = /^<(html|body)[\s/>]/i.exec(tree.source.slice(at, at + 6))?.[1];
  const html = tree.document.childNodes.find((node) => node.nodeName === "html") as
    P.Element | undefined;
  const root =
    merged === "body" ? html?.childNodes.find((n) => n.nodeName === "body") : html;
  if (merged && root) return root as P.Element;
  throw new Refusal(`no element at ${at}`);
}

function rangeOf(element: P.Element) {
  const [start, end] = bounds(element);
  if (start < 0) throw new Refusal(`${describe(element)} has no source`);
  return { element, start, end };
}

function bounds(element: P.Element): [number, number] {
  const location = element.sourceCodeLocation;
  return location?.startTag ? [location.startOffset, location.endOffset] : [-1, -1];
}

function childAt(tree: SourceTree, ref: ChildRef): Child {
  const parent = ref.parent < 0 ? tree.document : elementAt(tree, ref.parent);
  const child = childrenOf(parent)[ref.index];
  if (!child) throw new Refusal(`no child at ${refName(ref)}`);
  return child;
}

// An element with no start tag in the source, such as an implied <tbody>,
// is not a parent of its own: its children count as children of its parent.
// The bridge counts children in the same way.
const implied = (node: P.Node) =>
  "tagName" in node && !node.sourceCodeLocation?.startTag;

function logicalParent(element: P.Element): P.ParentNode {
  let parent = element.parentNode!;
  while ("tagName" in parent && implied(parent) && parent.parentNode)
    parent = parent.parentNode;
  return parent;
}

// childrenOf gives the children of parent as the bridge counts them: implied
// elements are flattened, and adjacent text is one child.
const children = new WeakMap<P.ParentNode, Child[]>();
export function childrenOf(parent: P.ParentNode): Child[] {
  let list = children.get(parent);
  if (list) return list;
  list = [];
  const add = (node: P.ParentNode) => {
    for (const child of node.childNodes) {
      if (implied(child)) {
        add(child as P.Element);
        continue;
      }
      if ("tagName" in child) {
        list!.push({ element: child });
        continue;
      }
      const { startOffset: start, endOffset: end } = child.sourceCodeLocation!;
      const kind =
        child.nodeName === "#text"
          ? "text"
          : child.nodeName === "#comment"
            ? "comment"
            : "other";
      const last = list!.at(-1);
      if (kind === "text" && last && "kind" in last && last.kind === "text")
        last.end = end;
      else list!.push({ kind, start, end });
    }
  };
  add(parent);
  const close = (parent as P.Element).sourceCodeLocation?.endTag?.startOffset;
  const last = list.at(-1);
  if (close !== undefined && last && "kind" in last && last.end > close) {
    last.past = last.end;
    last.start = Math.min(last.start, close);
    last.end = close;
  }
  children.set(parent, list);
  return list;
}

const describe = (element: P.Element) =>
  `<${element.tagName}>` +
  (element.sourceCodeLocation?.startTag
    ? ` at ${element.sourceCodeLocation.startOffset}`
    : "");

const refName = (ref: ChildRef) => `child ${ref.index} of ${ref.parent}`;

// replacementsBetween gives the replacements that turn prev into next, at
// UTF-8 byte offsets of prev: one for each change of wordChanges. Separate
// replacements let the server move each one onto a newer version.
export function replacementsBetween(prev: string, next: string): Replacement[] {
  // The UTF-8 length of prev before at.
  let at = 0;
  let byte = 0;
  return wordChanges(prev, next).map(({ start, end, text }) => {
    const old_html = prev.slice(start, end);
    byte += utf8Length(prev.slice(at, start));
    at = start;
    return { start: byte, end: byte + utf8Length(old_html), old_html, new_html: text };
  });
}

// wordChanges gives the changes that turn prev into next: one for each run
// of words that differs. Whole words read better in the version history
// than parts of them, and they never split a surrogate pair.
export function wordChanges(prev: string, next: string): Change[] {
  if (prev === next) return [];
  const a = prev.match(TOKEN) ?? [];
  const b = next.match(TOKEN) ?? [];
  const changes: Change[] = [];
  // The tokens of prev and next before the end of the last common run, and
  // the length of those of prev.
  let i = 0;
  let j = 0;
  let at = 0;
  for (const [ai, bj, length] of [...commonRuns(a, b), [a.length, b.length, 0]]) {
    const end = at + a.slice(i, ai).join("").length;
    if (ai > i || bj > j)
      changes.push({ start: at, end, text: b.slice(j, bj).join("") });
    at = end + a.slice(ai, ai + length).join("").length;
    i = ai + length;
    j = bj + length;
  }
  return changes;
}

const encoder = new TextEncoder();
const utf8Length = (text: string) => encoder.encode(text).length;
// A token is a word, a run of white space, or the edge of a tag.
const TOKEN = /[^\s<>]+|\s+|[<>]/g;
const WORD = /[^\s<>]/;
// A run of tokens that a and b have in common: its index in a and in b, and
// its length.
type Run = [number, number, number];

// commonRuns gives the runs that a and b have in common, in order: their
// common start and end, and between those the runs around a token that each
// of the two has only once. A word such as "the" or a space is in many
// places, and a match with one of them by chance puts typed text in the
// middle of other text. A token that is there once is the same token in the
// two. A run without words does not divide two changes, so that "twice" to
// "three times" stays one change.
function commonRuns(a: string[], b: string[]): Run[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a.at(-1 - tail) === b.at(-1 - tail)
  )
    tail++;
  const [aEnd, bEnd] = [a.length - tail, b.length - tail];
  const runs: Run[] = [[0, 0, head]];
  // The end of the last run in a and in b.
  let [x0, y0] = [head, head];
  for (const [x, y] of inOrder(onlyOnce(a, b, head, aEnd, bEnd))) {
    if (x < x0 || y < y0) continue;
    // The run grows over the equal tokens around the one that is there once.
    let back = 0;
    while (x - back > x0 && y - back > y0 && a[x - back - 1] === b[y - back - 1])
      back++;
    let on = 1;
    while (x + on < aEnd && y + on < bEnd && a[x + on] === b[y + on]) on++;
    runs.push([x - back, y - back, back + on]);
    [x0, y0] = [x + on, y + on];
  }
  runs.push([aEnd, bEnd, tail]);
  return runs.filter(([x, , length]) =>
    a.slice(x, x + length).some((t) => WORD.test(t)),
  );
}

// onlyOnce gives the places in a and in b of each token that a has once
// from head to aEnd, and b once from head to bEnd, in the order of a.
function onlyOnce(a: string[], b: string[], head: number, aEnd: number, bEnd: number) {
  // The place of a token, or -1 when it is there more than once.
  const places = (tokens: string[], end: number) => {
    const at = new Map<string, number>();
    for (let i = head; i < end; i++) at.set(tokens[i], at.has(tokens[i]) ? -1 : i);
    return at;
  };
  const inB = places(b, bEnd);
  return [...places(a, aEnd)]
    .map(([token, x]): [number, number] => [x, inB.get(token) ?? -1])
    .filter(([x, y]) => x >= 0 && y >= 0);
}

// inOrder gives the longest list of the pairs, which are in the order of
// their first number, that is also in the order of their second number.
function inOrder(pairs: [number, number][]): [number, number][] {
  // ends[n] is the index of the pair with the smallest second number that
  // ends a list of n + 1 pairs, and before[i] is the pair before pair i.
  const ends: number[] = [];
  const before: number[] = [];
  pairs.forEach(([, y], i) => {
    let lo = 0;
    let hi = ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[ends[mid]][1] < y) lo = mid + 1;
      else hi = mid;
    }
    before[i] = lo ? ends[lo - 1] : -1;
    ends[lo] = i;
  });
  const list: [number, number][] = [];
  for (let i = ends.at(-1) ?? -1; i >= 0; i = before[i]) list.push(pairs[i]);
  return list.reverse();
}

// tagSource gives the source with SOURCE_ATTR on every start tag, right
// after the tag name, as the server renders it. offsetOf maps the offset of
// a tag to the value to write, so that a probe of a changed source can carry
// the offsets of the version that the frame loaded.
export function tagSource(tree: SourceTree, offsetOf = (at: number) => at): string {
  let html = "";
  let at = 0;
  for (const start of [...tree.elements.keys()].sort((a, b) => a - b)) {
    TAG_NAME.lastIndex = start + 1;
    TAG_NAME.exec(tree.source);
    const nameEnd = TAG_NAME.lastIndex;
    html += tree.source.slice(at, nameEnd) + ` ${SOURCE_ATTR}="${offsetOf(start)}"`;
    at = nameEnd;
  }
  return html + tree.source.slice(at);
}
