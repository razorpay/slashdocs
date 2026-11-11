// A patch brings a part of the live document to a newer source without a
// load. The morph changes the live nodes of a run to the nodes of the new
// HTML, and changes as little as it can: a node that is the same stays, text
// changes only where it differs, and only a node with no pair goes or comes.
// The reader of the document can type in the same paragraph at that moment,
// so their caret and their selection stay where they are.

import { EDIT_ATTR } from "./script-text.ts";
import { BRIDGE_NODE, type Place } from "./source-map.ts";
import { SOURCE_ATTR } from "./source-pieces.ts";

// The elements that a morph leaves as they are: the bridge's own, and the
// content that a script made or changed, which the source map sets not
// editable and which is not in the source.
const LEFT = `${BRIDGE_NODE},[contenteditable="false"],[${EDIT_ATTR}]`;
// The attributes that the bridge sets on the elements of a document.
const BRIDGE_ATTRIBUTE = /^(contenteditable$|data-slashdocs-)/;
// The browser types a no-break space where a space would not show. The
// source has a space there, so the two are the same text.
const NBSP = "\u00a0";

// One element or comment, or the text nodes that are next to each other,
// which are one text. Items of the same kind can pair. Items of the same
// kind and key are equal.
type Item = { kind: string; key: string; nodes: Node[] };

// Records the new content: node, or its text from one offset to another.
type Added = (node: Node, from?: number, to?: number) => void;

// morph changes the nodes of place to html, and gives the ranges of the new
// content. It parses html in an inert document, as the content of an element
// with the tag of the parent.
export function morph({ in: element, after, before }: Place, html: string): Range[] {
  const d = element.ownerDocument;
  // An element with no start tag in the source, such as an implied <tbody>,
  // holds the run when it holds the children around it.
  const parent = (after ?? before)?.parentElement ?? element;
  const target = d.implementation
    .createHTMLDocument("")
    .createElement(parent.localName);
  target.innerHTML = html;
  const ranges: Range[] = [];
  const added: Added = (
    node,
    from = 0,
    to = node.nodeValue?.length ?? node.childNodes.length,
  ) => {
    const range = d.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    ranges.push(range);
  };
  const first = after ? after.nextSibling : parent.firstChild;
  const end = before?.parentNode === parent ? before : null;
  morphRun(parent, first, end, target, added);
  return ranges;
}

// morphRun changes the children of parent from first up to end to the
// children of target. Equal items pair first. Between two such pairs, the
// items pair in order when they are of the same kind. Then a new item with
// no pair goes in, and a live item with no pair goes.
function morphRun(
  parent: Node,
  first: Node | null,
  end: Node | null,
  target: Node,
  added: Added,
) {
  const run: Node[] = [];
  for (let node = first; node && node !== end; node = node.nextSibling) run.push(node);
  const live = itemsOf(run);
  const next = itemsOf(Array.from(target.childNodes));
  // A new <br> at the end of a block keeps an emptied block open. The source
  // does not have it, so it stays.
  const last = live.at(-1);
  const opener =
    last?.kind === "br" && !(last.nodes[0] as Element).hasAttribute(SOURCE_ATTR)
      ? last
      : null;
  const remove = (item: Item) =>
    item !== opener && item.nodes.forEach((node) => parent.removeChild(node));

  let i = 0;
  let j = 0;
  for (const [pi, pj] of [...equalPairs(live, next), [live.length, next.length]]) {
    for (; j < pj; j++) {
      let k = i;
      while (k < pi && live[k].kind !== next[j].kind) k++;
      if (k < pi) {
        live.slice(i, k).forEach(remove);
        morphItem(live[k], next[j], added);
        i = k + 1;
      } else {
        for (const node of next[j].nodes) {
          parent.insertBefore(node, live[i]?.nodes[0] ?? end);
          added(node);
        }
      }
    }
    live.slice(i, pi).forEach(remove);
    if (pi < live.length) morphItem(live[pi], next[pj], added);
    i = pi + 1;
    j = pj + 1;
  }
}

// morphItem changes a live item to the item that it pairs with.
function morphItem(item: Item, to: Item, added: Added) {
  const [node, twin] = [item.nodes[0], to.nodes[0]];
  if (node.nodeType === Node.TEXT_NODE)
    return retext(item.nodes as Text[], dataOf(to), added);
  if (node.nodeType !== Node.ELEMENT_NODE) {
    if (dataOf(item) !== dataOf(to))
      (node as CharacterData).replaceData(0, dataOf(item).length, dataOf(to));
    return;
  }
  // The source keeps the attributes of an original element, and a script
  // can change them, so only a new element takes the attributes.
  if (!(node as Element).hasAttribute(SOURCE_ATTR))
    setAttributes(node as Element, twin as Element);
  morphRun(node, node.firstChild, null, twin, added);
}

// itemsOf gives the items of nodes, without the elements that a morph
// leaves.
function itemsOf(nodes: Node[]): Item[] {
  const items: Item[] = [];
  for (const node of nodes) {
    const key = (node.textContent ?? "").replaceAll(NBSP, " ");
    const last = items.at(-1);
    if (node.nodeType !== Node.TEXT_NODE) {
      if (node.nodeType !== Node.ELEMENT_NODE || !(node as Element).matches(LEFT))
        items.push({ kind: node.nodeName.toLowerCase(), key, nodes: [node] });
    } else if (last?.kind === "#text" && last.nodes.at(-1)!.nextSibling === node) {
      last.key += key;
      last.nodes.push(node);
    } else items.push({ kind: "#text", key, nodes: [node] });
  }
  return items;
}

// dataOf gives the text of an item of text, or of a comment.
const dataOf = (item: Item) =>
  item.nodes.map((node) => (node as CharacterData).data).join("");

// equalPairs gives the longest list of pairs [i, j], in order, of an item of
// a and an item of b that are equal.
function equalPairs(a: Item[], b: Item[]): [number, number][] {
  const equal = (i: number, j: number) =>
    a[i].kind === b[j].kind && a[i].key === b[j].key;
  // lengths[i * width + j] is the count of the pairs from a[i] and b[j] on.
  const width = b.length + 1;
  const lengths = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i * width + j] = equal(i, j)
        ? lengths[(i + 1) * width + j + 1] + 1
        : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (equal(i, j)) pairs.push([i++, j++]);
    else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) i++;
    else j++;
  }
  return pairs;
}

// retext changes the text of nodes, which are next to each other, to text.
// It changes only the range that differs, in place, so that the browser
// keeps a caret, a selection and each live range in the text where they are.
function retext(nodes: Text[], text: string, added: Added) {
  const old = nodes.map((node) => node.data).join("");
  const same = (i: number, j: number) =>
    old[i] === text[j] || (old[i] === NBSP && text[j] === " ");
  const most = Math.min(old.length, text.length);
  let start = 0;
  while (start < most && same(start, start)) start++;
  let tail = 0;
  while (tail < most - start && same(old.length - 1 - tail, text.length - 1 - tail))
    tail++;
  const stop = old.length - tail;
  // The new text goes in the first node that reaches the start of the range.
  let rest = text.slice(start, text.length - tail);
  let at = 0;
  for (const node of nodes) {
    const { length } = node;
    const within = (offset: number) => Math.min(Math.max(offset - at, 0), length);
    const [from, to] = [within(start), within(stop)];
    const here = start - at <= length ? rest : "";
    if (to > from || here) node.replaceData(from, to - from, here);
    if (here) {
      added(node, from, from + here.length);
      rest = "";
    }
    at += length;
  }
}

// setAttributes makes the attributes of el those of twin, apart from the
// attributes that the bridge sets.
function setAttributes(el: Element, twin: Element) {
  for (const { name } of Array.from(el.attributes)) {
    if (!BRIDGE_ATTRIBUTE.test(name) && !twin.hasAttribute(name))
      el.removeAttribute(name);
  }
  for (const { name, value } of Array.from(twin.attributes)) {
    if (!BRIDGE_ATTRIBUTE.test(name) && el.getAttribute(name) !== value)
      el.setAttribute(name, value);
  }
}
