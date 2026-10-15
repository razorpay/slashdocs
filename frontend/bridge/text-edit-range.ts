export const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "dd",
  "div",
  "dt",
  "figcaption",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "nav",
  "p",
  "pre",
  "section",
  "summary",
  "td",
  "th",
]);

const STRUCTURE_SELECTOR = [
  ...BLOCK_TAGS,
  "dl",
  "details",
  "figure",
  "form",
  "hr",
  "ol",
  "table",
  "tr",
  "ul",
].join(",");

function isElement(node: Node | null): node is Element {
  return node?.nodeType === Node.ELEMENT_NODE;
}

export function blockOf(node: Node): Element | null {
  for (let n: Node | null = isElement(node) ? node : node.parentNode; n;) {
    if (!isElement(n)) return null;
    if (BLOCK_TAGS.has(n.localName)) return n;
    n = n.parentNode;
  }
  return null;
}

function childIndex(node: Node): number {
  let index = 0;
  for (let n = node.previousSibling; n; n = n.previousSibling) index++;
  return index;
}

function nodeLength(node: Node): number {
  return node.nodeType === Node.TEXT_NODE
    ? (node as Text).data.length
    : node.childNodes.length;
}

// Moves each end of a range toward the other across boundaries that hold no text, so a
// selection that ends where an element ends sits inside that element rather than at the
// start of whatever follows it. Stops at elements without children, such as br and img.
function tighten(range: Range): Range {
  const tight = range.cloneRange();
  for (;;) {
    const node = tight.startContainer;
    const offset = tight.startOffset;
    if (offset < nodeLength(node)) {
      if (node.nodeType === Node.TEXT_NODE) break;
      const child = node.childNodes[offset];
      if (child.nodeType !== Node.TEXT_NODE && !child.firstChild) break;
      if (tight.comparePoint(child, 0) > 0) break;
      tight.setStart(child, 0);
    } else {
      if (!node.parentNode || tight.collapsed) break;
      tight.setStart(node.parentNode, childIndex(node) + 1);
    }
  }
  for (;;) {
    const node = tight.endContainer;
    const offset = tight.endOffset;
    if (offset > 0) {
      if (node.nodeType === Node.TEXT_NODE) break;
      const child = node.childNodes[offset - 1];
      if (child.nodeType !== Node.TEXT_NODE && !child.firstChild) break;
      if (tight.comparePoint(child, nodeLength(child)) < 0) break;
      tight.setEnd(child, nodeLength(child));
    } else {
      if (!node.parentNode || tight.collapsed) break;
      tight.setEnd(node.parentNode, childIndex(node));
    }
  }
  return tight.collapsed ? range : tight;
}

// The outermost element between `from` and `block` that contains `from` but not `other`.
function outermostPartial(from: Node, other: Node, block: Element): Element | null {
  let found: Element | null = null;
  for (let n = from.parentNode; n && n !== block; n = n.parentNode) {
    if (isElement(n) && !n.contains(other)) found = n;
  }
  if (isElement(from) && from !== block && !from.contains(other)) {
    found = found ?? from;
  }
  return found;
}

// Grows a range so that neither end sits inside an inline element the range only partly
// covers. Returns null when the two ends have different nearest block ancestors or the
// range holds a block of its own.
export function expandToWholeInlines(selected: Range): Range | null {
  const range = tighten(selected);
  const block = blockOf(range.startContainer);
  if (!block || block !== blockOf(range.endContainer)) return null;
  const holder = block.ownerDocument.createElement("div");
  holder.appendChild(range.cloneContents());
  if (holder.querySelector(STRUCTURE_SELECTOR)) return null;
  const expanded = range.cloneRange();
  const startOuter = outermostPartial(range.startContainer, range.endContainer, block);
  if (startOuter?.parentNode) {
    expanded.setStart(startOuter.parentNode, childIndex(startOuter));
  }
  const endOuter = outermostPartial(range.endContainer, range.startContainer, block);
  if (endOuter?.parentNode) {
    expanded.setEnd(endOuter.parentNode, childIndex(endOuter) + 1);
  }
  return expanded;
}
