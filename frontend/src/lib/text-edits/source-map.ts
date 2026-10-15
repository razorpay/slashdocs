import { parse, type DefaultTreeAdapterTypes as P5 } from "parse5";

export type BoundarySide = "start" | "end";

export type SourceDocument = {
  html: string;
  doc: Document;
  // Maps a DOM boundary point to an offset in `html`. A "start" point prefers the start of
  // the following node and an "end" point the end of the preceding one.
  position(node: Node, offset: number, side: BoundarySide): number | null;
};

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const REFERENCE = /&(?:#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[A-Za-z][A-Za-z0-9]*;?)/y;

function p5Name(node: P5.Node): string {
  return node.nodeName.toLowerCase();
}

function domName(node: Node): string {
  switch (node.nodeType) {
    case Node.TEXT_NODE:
      return "#text";
    case Node.COMMENT_NODE:
      return "#comment";
    case Node.DOCUMENT_TYPE_NODE:
      return "#documenttype";
    default:
      return node.nodeName.toLowerCase();
  }
}

function p5Children(node: P5.Node): P5.ChildNode[] {
  if (p5Name(node) === "template") return [];
  return "childNodes" in node ? node.childNodes : [];
}

function pair(dom: Node, p5: P5.Node, map: Map<Node, P5.Node>): boolean {
  if (domName(dom) !== p5Name(p5)) return false;
  if (
    dom.nodeType === Node.TEXT_NODE &&
    dom.textContent !== (p5 as P5.TextNode).value
  ) {
    return false;
  }
  map.set(dom, p5);
  const domKids = dom.nodeName === "TEMPLATE" ? [] : Array.from(dom.childNodes);
  const p5Kids = p5Children(p5);
  if (domKids.length !== p5Kids.length) return false;
  return domKids.every((kid, i) => pair(kid, p5Kids[i], map));
}

function decodeReference(reference: string, doc: Document): string {
  const textarea = doc.createElement("textarea");
  textarea.innerHTML = reference;
  return textarea.value;
}

// Offsets into `raw` where each UTF-16 unit of `data` starts, plus one for the end.
function textOffsets(raw: string, data: string, doc: Document): number[] | null {
  const offsets: number[] = [];
  let decoded = "";
  for (let i = 0; i < raw.length;) {
    let piece: string;
    let length: number;
    REFERENCE.lastIndex = i;
    const reference = raw[i] === "&" ? REFERENCE.exec(raw)?.[0] : undefined;
    if (reference) {
      const value = decodeReference(reference, doc);
      const terminated = reference.endsWith(";") || reference[1] === "#";
      if (terminated) {
        piece = value;
        length = reference.length;
      } else if (value === reference) {
        piece = "&";
        length = 1;
      } else {
        return null;
      }
    } else if (raw[i] === "\r") {
      piece = "\n";
      length = raw[i + 1] === "\n" ? 2 : 1;
    } else {
      piece = raw[i];
      length = 1;
    }
    for (let k = 0; k < piece.length; k++) offsets.push(i);
    decoded += piece;
    i += length;
  }
  offsets.push(raw.length);
  return decoded === data ? offsets : null;
}

export function parseSource(html: string): SourceDocument | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tree = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: false });
  const map = new Map<Node, P5.Node>();
  if (!pair(doc, tree, map)) return null;

  const textCache = new Map<Node, { start: number; offsets: number[] } | null>();
  function textPosition(node: Text, offset: number): number | null {
    if (!textCache.has(node)) {
      const location = (map.get(node) as P5.TextNode | undefined)?.sourceCodeLocation;
      let entry: { start: number; offsets: number[] } | null = null;
      if (location) {
        const raw = html.slice(location.startOffset, location.endOffset);
        for (const skip of [0, raw.startsWith("\r\n") ? 2 : 1]) {
          const offsets = textOffsets(raw.slice(skip), node.data, doc);
          if (offsets) {
            entry = { start: location.startOffset + skip, offsets };
            break;
          }
        }
      }
      textCache.set(node, entry);
    }
    const entry = textCache.get(node);
    const local = entry?.offsets[offset];
    return entry && local !== undefined ? entry.start + local : null;
  }

  function startOf(node: Node): number | null {
    if (node.nodeType === Node.TEXT_NODE) return textPosition(node as Text, 0);
    const location = (map.get(node) as P5.Element | undefined)?.sourceCodeLocation;
    return location ? location.startOffset : null;
  }

  function endOf(node: Node): number | null {
    if (node.nodeType === Node.TEXT_NODE) {
      return textPosition(node as Text, (node as Text).data.length);
    }
    const p5 = map.get(node);
    const location = (p5 as P5.Element | undefined)?.sourceCodeLocation;
    if (!p5 || !location) return null;
    if (node.nodeType === Node.ELEMENT_NODE && !VOID_TAGS.has(p5Name(p5))) {
      return location.endTag ? location.endTag.endOffset : null;
    }
    return location.endOffset;
  }

  function position(node: Node, offset: number, side: BoundarySide): number | null {
    if (node.nodeType === Node.TEXT_NODE) return textPosition(node as Text, offset);
    const kids = node.childNodes;
    if (side === "start" && offset < kids.length) return startOf(kids[offset]);
    if (side === "end" && offset > 0) return endOf(kids[offset - 1]);
    const location = (map.get(node) as P5.Element | undefined)?.sourceCodeLocation;
    if (!location) return null;
    if (offset === 0 && kids.length === 0) return location.startTag?.endOffset ?? null;
    if (offset === 0) return startOf(kids[0]);
    return location.endTag?.startOffset ?? null;
  }

  return { html, doc, position };
}
