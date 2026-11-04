// Source edits write the regions that an editor changed in the rendered
// document back into its HTML source, by position. The pieces of a region
// refer to the nodes of the version source by offset, so every node that did
// not change keeps its exact source bytes, and only new content is written
// as new HTML. The save is then the difference between two such sources, as
// replacements at UTF-8 byte offsets of the version that the server holds.

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

// A source and its parse5 tree. Elements are found by the offset of their
// start tag. Treat it as opaque: only this module reads it.
export type SourceTree = {
  readonly source: string;
  readonly document: P.Document;
  readonly elements: Map<number, P.Element>;
  // The attribute names that each tag name has somewhere in the source.
  readonly attributes: Map<string, Set<string>>;
  readonly decode: (reference: string) => string;
};

type Child =
  | { element: P.Element }
  | { kind: "text" | "comment" | "other"; start: number; end: number };

// The tags that new content can have, as the bridge writes them.
const NEW_TAG = /^(p|br|strong|b|em|i|a|ul|ol|li)$/;
const NEW_OPEN = /^<([a-z]+)((?: [^\s"'>/=]+="[^"]*")*)>$/;
const NEW_ATTRIBUTE = / ([^\s"'>/=]+)="([^"]*)"/g;
const SAFE_HREF = /^(https?:|mailto:|#)/i;
const TAG_NAME = /[^\s/>]*/y;

// The units of source text: a character reference, a line break, or one
// character. Each decodes on its own, so the spelling of each one that did
// not change can stay.
const TEXT_UNIT = /&(?:#\d+;?|#x[\da-f]+;?|[a-z][a-z\d]*;?)|\r\n?|[\s\S]/giu;

// parseSource parses a version source. It loads parse5 only when it is first
// needed, because only editors need it.
export async function parseSource(source: string): Promise<SourceTree> {
  const { parse, parseFragment } = await import("parse5");
  const document = parse(source, { sourceCodeLocationInfo: true });
  const elements = new Map<number, P.Element>();
  const attributes = new Map<string, Set<string>>();
  const visit = (node: P.ParentNode) => {
    for (const child of node.childNodes) {
      if (!("tagName" in child)) continue;
      const start = child.sourceCodeLocation?.startTag?.startOffset;
      if (start !== undefined) elements.set(start, child);
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
      const node = parseFragment(reference).childNodes[0];
      text = node && "value" in node ? node.value : "";
      decoded.set(reference, text);
    }
    return text;
  };
  return { source, document, elements, attributes, decode };
}

// The reason that a region cannot apply.
class Refusal extends Error {}

// applyRegions writes every region into the source of tree. It refuses when
// a piece refers to a node that the source does not have, or when a region
// would drop an original element that its pieces do not name.
export function applyRegions(
  tree: SourceTree,
  regions: Region[],
): { html: string } | { refused: string } {
  try {
    const spans = regions
      .map((region) => ({ region, ...spanOf(tree, region) }))
      .sort((a, b) => a.start - b.start);
    let html = "";
    let at = 0;
    for (const span of spans) {
      if (span.start < at) throw new Refusal("two regions overlap");
      html += tree.source.slice(at, span.start) + writeRegion(tree, span);
      at = span.end;
    }
    return { html: html + tree.source.slice(at) };
  } catch (error) {
    if (error instanceof Refusal) return { refused: error.message };
    throw error;
  }
}

type Span = { region: Region; parent: P.ParentNode; start: number; end: number };

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

function writeRegion(tree: SourceTree, span: Span): string {
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
      return tree.source.slice(start, end);
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
      return tree.source.slice(child.start, child.end);
    }
    if ("text" in piece) {
      if (!piece.was) return newText(piece.text, "");
      const was = childAt(tree, piece.was);
      if (!("kind" in was) || was.kind !== "text") {
        throw new Refusal(`no text at ${refName(piece.was)}`);
      }
      return respell(tree, tree.source.slice(was.start, was.end), piece.text);
    }
    if ("element" in piece) {
      const element = elementAt(tree, piece.element);
      const location = element.sourceCodeLocation;
      if (!location?.startTag) throw new Refusal(`no start tag at ${piece.element}`);
      mention(element, "element");
      const { startTag, endTag } = location;
      return (
        tree.source.slice(startTag.startOffset, startTag.endOffset) +
        piece.children.map(write).join("") +
        (endTag ? tree.source.slice(endTag.startOffset, endTag.endOffset) : "")
      );
    }
    checkNewTag(tree, piece.open, piece.close);
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
// event handler.
function checkNewTag(tree: SourceTree, open: string, close: string) {
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
// as &nbsp; or a CRLF line break.
function respell(tree: SourceTree, old: string, text: string): string {
  const units = old.match(TEXT_UNIT) ?? [];
  const decoded = units.map((unit) =>
    unit[0] === "&" ? tree.decode(unit) : unit[0] === "\r" ? "\n" : unit,
  );
  let head = 0;
  let from = 0;
  while (head < units.length && text.startsWith(decoded[head], from)) {
    from += decoded[head++].length;
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
    units.slice(tail).join("")
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
function childrenOf(parent: P.ParentNode): Child[] {
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
// UTF-8 byte offsets of prev: one from the first to the last word that
// differs. Whole words read better in the version history than parts of
// them, and they never split a surrogate pair.
export function replacementsBetween(prev: string, next: string): Replacement[] {
  if (prev === next) return [];
  const shorter = Math.min(prev.length, next.length);
  let head = 0;
  while (head < shorter && prev[head] === next[head]) head++;
  let tail = 0;
  while (tail < shorter - head && prev.at(-1 - tail) === next.at(-1 - tail)) tail++;
  while (head > 0 && WORD.test(prev[head - 1])) head--;
  while (tail > 0 && WORD.test(prev[prev.length - tail])) tail--;
  const old_html = prev.slice(head, prev.length - tail);
  const start = utf8Length(prev.slice(0, head));
  return [
    {
      start,
      end: start + utf8Length(old_html),
      old_html,
      new_html: next.slice(head, next.length - tail),
    },
  ];
}

const encoder = new TextEncoder();
const utf8Length = (text: string) => encoder.encode(text).length;
// A character of a word: not white space and not the edge of a tag.
const WORD = /[^\s<>]/;

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
