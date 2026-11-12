// A patch brings a part of the live document to a newer source without a
// load. The morph changes the live nodes of a run to the nodes of the new
// HTML, and changes as little as it can: a node that is the same stays, text
// changes only where it differs, and only a node with no pair goes or comes.
// The reader of the document can type in the same paragraph at that moment,
// so their caret and their selection stay at their characters, and the text
// that they typed is not text that the patch changed.

import { equalPairs, sameEnds } from "./dom.ts";
import { EDIT_ATTR } from "./script-text.ts";
import { BRIDGE_NODE, patchBreaks, patchTags, type Place } from "./source-map.ts";
import { SOURCE_ATTR, type Mark, type Patch } from "./source-pieces.ts";

// The elements that a morph leaves as they are: the bridge's own, and the
// content that a script made or changed, which the source map sets not
// editable.
const LEFT = `${BRIDGE_NODE},[contenteditable="false"],[${EDIT_ATTR}]`;
// The attributes that the bridge sets on the elements of a document.
const BRIDGE_ATTRIBUTE = /^(contenteditable$|data-slashdocs-)/;
// The browser types a no-break space where a space would not show. The
// source has a space there, so the two are the same text.
const NBSP = "\u00a0";
const spaced = (text: string | null) => (text ?? "").replaceAll(NBSP, " ");
const sameText = (a: string, b: string) => a === b || spaced(a) === b;
// A place in a text between the two code units of one character. A caret
// cannot be there.
const halves = (text: string, at: number) =>
  at > 0 && /[\udc00-\udfff]/.test(text.charAt(at));

// The value that a patch gave to an attribute of an original element, or
// null when the patch removed the attribute. While the element has that
// value, the attribute is not one that a script set.
const patched = new WeakMap<Element, Map<string, string | null>>();
// The text that a patch gave to an original style.
const styled = new WeakMap<Element, string>();

// The two characters that carry a mark through a parse: one before its text
// and one after it. A document does not use them.
const MARK_START = "\ue000";
const MARK_END = "\ue001";
const MARKER = /[\ue000\ue001]/;
// A parse drops a newline at the start of these elements.
const DROPS_NEWLINE = /^(pre|listing)$/;

// One element or comment, or the text nodes that are next to each other,
// which are one text. Items of the same kind can pair. Items of the same
// kind and key are equal. left is an element that the morph leaves, and its
// key is the text that it has in the source.
type Item = { kind: string; key: string; nodes: Node[]; left?: true };

// A splice of a text: the characters from one offset to another become
// other text.
export type Splice = [start: number, stop: number, text: string];

// The text nodes of a run in order, each with the text that it has at one
// moment.
export type Texts = { node: Text; text: string }[];

// The changes that make a text from another one, in two passes. The first
// pass makes the text without the text that other people put in, and a
// comparison finds its changes. The second pass puts that text in, each one
// at its exact place. The changes of a pass are in order, in the text that
// the pass before it left.
type Changes = [found: Splice[], marked: Splice[]];

// What a morph did to a run: the ranges of the new content and a collapsed
// range at each place where content went, the texts of the run before and
// after, and the changes of all the text of the run. A change of looks, as
// of a start tag or a style, has no new content. undo takes out a change
// that the observer of the body does not see.
export type Morphed = {
  ranges: Range[];
  was: Texts;
  now: Texts;
  changes: Changes;
  undo?: () => void;
};

// What a morph has of its patch. added records the new content: node, or
// its text from one offset to another. went records the place of a node,
// before the node goes. marks gives the marks of a text, by its first node.
// sourceOf gives the element of the source for an original element. unsafe
// tells whether the morph left the document in a state that is not the new
// HTML.
type Morph = {
  added(node: Node, from?: number, to?: number): void;
  went(node: Node): void;
  marks: Map<Node, Mark[]>;
  tags: Map<Element, string>;
  sourceOf: Place["sourceOf"];
  unsafe: boolean;
};

// morph makes the change of a patch at its place, and tells what it did. It
// gives null when it cannot make the change: the caller must then take its
// changes out.
export function morph(place: Place, patch: Patch): Morphed | null {
  if ("in" in patch) return morphChildren(place, patch.html, patch.marks);
  const { in: element, sourceOf } = place;
  const done: Morphed = { ranges: [], was: [], now: [], changes: [[], []] };
  if ("tag" in patch) {
    const inert = element.ownerDocument.implementation.createHTMLDocument("");
    const template = inert.createElement("template");
    template.innerHTML = patch.html;
    const twin = template.content.firstElementChild;
    if (twin?.localName !== element.localName) return null;
    setAttributes(element, twin, sourceOf(element));
    return done;
  }
  // Script text makes the change of a script.
  if ("script" in patch) return null;
  // A script can change the text of a style, its rules, or turn it off. A
  // load runs the script again, so the style keeps its state only when it
  // has none: its rules are those of its text. A sheet that a new text
  // drops can hold rules that a script added.
  const style = element as HTMLStyleElement;
  const text = styled.get(style) ?? sourceOf(style)?.textContent ?? "";
  if (
    style.textContent !== text ||
    style.sheet?.disabled ||
    (style.sheet && rulesOf(style.sheet) !== rulesOf(sheetOf(style, text)))
  )
    return null;
  style.textContent = patch.html;
  styled.set(style, patch.html);
  // A style in the head is outside the body that the observer sees.
  const undo = () => {
    if (style.textContent !== text) style.textContent = text;
    styled.set(style, text);
  };
  return { ...done, undo };
}

// sheetOf gives the sheet of text as the window of style reads it, with no
// element. It has no @import rules, so a style that has them never changes
// in place.
function sheetOf(style: Element, text: string): CSSStyleSheet {
  const view = style.ownerDocument.defaultView as Window & typeof globalThis;
  const sheet = new view.CSSStyleSheet();
  sheet.replaceSync(text);
  return sheet;
}

// rulesOf gives the text of each rule of a sheet.
const rulesOf = (sheet: CSSStyleSheet) =>
  Array.from(sheet.cssRules, (rule) => rule.cssText).join("\n");

// morphChildren changes the nodes of place to html. marks are the ranges of
// html that other people put in. It gives null when an element that it
// leaves has no equal element in html.
function morphChildren(
  { in: element, after, before, sourceOf }: Place,
  html: string,
  marks: Mark[] = [],
): Morphed | null {
  const d = element.ownerDocument;
  // An element with no start tag in the source, such as an implied <tbody>,
  // holds the run when it holds the children around it.
  const parent = (after ?? before)?.parentElement ?? element;
  // A load of the document does not have the newline that a parse drops.
  const dropped =
    !after && DROPS_NEWLINE.test(parent.localName) ? /^\r?\n/.exec(html) : null;
  const cut = dropped?.[0].length ?? 0;
  const [target, marked] = parse(
    parent,
    html.slice(cut),
    marks.map(([from, to]) => [from - cut, to - cut]),
  );
  const ranges: Range[] = [];
  const added: Morph["added"] = (
    node,
    from = 0,
    to = node.nodeValue?.length ?? node.childNodes.length,
  ) => {
    const range = d.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    ranges.push(range);
  };
  const went: Morph["went"] = (node) => {
    const range = d.createRange();
    range.setStartBefore(node);
    ranges.push(range);
  };
  const end = before?.parentNode === parent ? before : null;
  const first = () => (after ? after.nextSibling : parent.firstChild);
  const was = textsOf(first(), end);
  const keep = selectionIn(d, was);
  const tags = startTags(target, html.slice(cut));
  const how = { added, went, marks: marked, tags, sourceOf, unsafe: false };
  morphRun(parent, first(), end, target, how);
  if (how.unsafe) return null;
  const now = textsOf(first(), end);
  const changes = changesOf(textOf(was), textOf(now), marksOf(now, marked));
  keep(now, changes);
  return { ranges, was, now, changes };
}

// parse gives html as the content of an element with the tag of parent, in
// an inert document, and the marks of each text of it. A mark must be all
// in one text. The marks go through the parse as two characters around each
// one, which come out of the texts again. When the content is then not the
// content of html, a mark was not in text, and html has no marks.
function parse(
  parent: Element,
  html: string,
  marks: Mark[],
): [Element, Map<Node, Mark[]>] {
  const inert = parent.ownerDocument.implementation.createHTMLDocument("");
  const read = (html: string) => {
    const element = inert.createElement(parent.localName);
    element.innerHTML = html;
    return element;
  };
  const plain = read(html);
  const found = new Map<Node, Mark[]>();
  let last = 0;
  const inText = marks.filter(([from, to]) => {
    const fits = from >= last && to > from && !/[<>&]/.test(html.slice(from, to));
    if (fits) last = to;
    return fits;
  });
  if (!inText.length || last > html.length || MARKER.test(html)) return [plain, found];
  // From the last mark, so the offsets of the others stay.
  const marked = inText.reduceRight(
    (text, [from, to]) =>
      `${text.slice(0, from)}${MARK_START}${text.slice(from, to)}${MARK_END}${text.slice(to)}`,
    html,
  );
  const target = read(marked);
  const walker = inert.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    // Each second part is the text of a mark.
    const parts = (node as Text).data.split(MARKER);
    if (parts.length === 1) continue;
    let end = 0;
    const ranges = parts.map((part): Mark => {
      end += part.length;
      return [end - part.length, end];
    });
    found.set(
      node,
      ranges.filter((_, i) => i % 2),
    );
    (node as Text).data = parts.join("");
  }
  return target.innerHTML === plain.innerHTML ? [target, found] : [plain, new Map()];
}

// textsOf gives the texts of the nodes from first up to end, which are
// next to each other.
function textsOf(first: Node | null, end: Node | null): Texts {
  const texts: Texts = [];
  for (let top = first; top && top !== end; top = top.nextSibling) {
    const walker = top.ownerDocument!.createTreeWalker(top, NodeFilter.SHOW_TEXT);
    for (let node: Node | null = top; node; node = walker.nextNode())
      if (node.nodeType === Node.TEXT_NODE)
        texts.push({ node: node as Text, text: (node as Text).data });
  }
  return texts;
}

const textOf = (texts: Texts) => texts.map(({ text }) => text).join("");

// marksOf gives the marks of texts, as ranges of all their text.
function marksOf(texts: Texts, marks: Morph["marks"]): Mark[] {
  let at = 0;
  return texts.flatMap(({ node, text }) => {
    const start = at;
    at += text.length;
    return (marks.get(node) ?? []).map(([from, to]): Mark => [
      start + from,
      start + to,
    ]);
  });
}

// offsetOf gives the count of the characters of texts before a place in one
// of their nodes, or null when the node is not one of them.
export function offsetOf(texts: Texts, node: Node, offset: number): number | null {
  let at = 0;
  for (const text of texts) {
    if (text.node === node) return at + offset;
    at += text.text.length;
  }
  return null;
}

// pointAt gives the node of texts that holds length characters from the
// offset at in all their text, and the offset in that node. A place between
// two nodes is in both. It then stays in from, the node that it was in. Else
// it is in the later node with later, and in the earlier one without. A
// line break between elements comes last: it does not show, and the keys
// of a caret in it go into the next block. It gives null when no node holds
// all of the characters.
export function pointAt(
  texts: Texts,
  at: number,
  length: number,
  from: Node,
  later: boolean,
): [Text, number] | null {
  const holds: [Text, number][] = [];
  let start = 0;
  for (const { node, text } of texts) {
    if (start <= at && at + length <= start + text.length)
      holds.push([node, at - start]);
    start += text.length;
  }
  const shown = holds.filter(([node]) => !betweenElements(node));
  const best = shown.length ? shown : holds;
  return (
    best.find(([node]) => node === from) ?? (later ? best.at(-1) : best[0]) ?? null
  );
}

// betweenElements tells whether a text is a line break of the source next to
// an element, with only white space.
const betweenElements = (node: Text) =>
  node.data.includes("\n") &&
  !node.data.trim() &&
  [node.previousSibling, node.nextSibling].some(
    (n) => n?.nodeType === Node.ELEMENT_NODE,
  );

// placeAfter gives the offset of a place in a text after changes, and the
// side on which the character next to it stays: "before", else "after", else
// null. A place in characters that went is after the text that came for
// them, also in a later pass: marked text can be all that is in their place,
// and it can be text that the reader typed. A place where text came in is
// before that text.
export function placeAfter(
  changes: Changes,
  offset: number,
): [number, "before" | "after" | null] {
  let stays: "before" | "after" | null = "before";
  for (const pass of changes) {
    let grown = 0;
    for (const [start, stop, text] of pass) {
      if (offset < start || (offset === start && stays)) break;
      grown += text.length - (stop - start);
      if (offset === stop) stays &&= "after";
      if (offset < stop) [offset, stays] = [stop, null];
    }
    offset += grown;
  }
  return [offset, stays];
}

// selectionIn notes the ends of the selection that are in texts, before a
// morph. The function that it gives puts them at the same characters of now,
// the texts after the morph, when the browser did not leave them there: the
// browser keeps an end in its node, and a morph can move its characters to
// another node. An end stays with the character before it, or with the one
// after it when only that one stays. When the two went, it goes after the
// text that came for them, as placeAfter says. The browser puts it before
// that text, and that text can be text that the reader typed: the next keys
// of the reader would then go before their own text.
function selectionIn(d: Document, was: Texts) {
  const s = d.getSelection();
  const ends = (): [Node, number][] =>
    s?.anchorNode && s.focusNode
      ? [
          [s.anchorNode, s.anchorOffset],
          [s.focusNode, s.focusOffset],
        ]
      : [];
  const held = ends().map(([node, offset]) => ({
    node,
    atStart: offset === 0,
    at: offsetOf(was, node, offset),
  }));
  return (now: Texts, changes: Changes) => {
    const left = ends();
    const kept = left.map((end, i): [Node, number] => {
      const { node, atStart, at } = held[i];
      if (at === null) return end;
      const [place, stays] = placeAfter(changes, at);
      if (offsetOf(now, ...end) === place) return end;
      return pointAt(now, place, 0, node, atStart || stays !== "before") ?? end;
    });
    if (kept.some(([node, offset], i) => node !== left[i][0] || offset !== left[i][1]))
      s!.setBaseAndExtent(...kept[0], ...kept[1]);
  };
}

// morphRun changes the children of parent from first up to end to the
// children of target. Equal items pair first. Between two such pairs, the
// items pair in order when they are of the same kind. Then a new item with
// no pair goes in, and a live item with no pair goes. An item that the morph
// leaves cannot go: the morph is then not safe.
function morphRun(
  parent: Node,
  first: Node | null,
  end: Node | null,
  target: Node,
  how: Morph,
) {
  const run: Node[] = [];
  for (let node = first; node && node !== end; node = node.nextSibling) run.push(node);
  const live = itemsOf(run, how);
  const next = itemsOf(Array.from(target.childNodes));
  // A <br> that the browser put at the end of a block, and not after another
  // <br>, shows no line: it keeps an emptied block open. The source does not
  // have it, so it stays.
  const last = live.at(-1);
  const opener =
    !end &&
    last?.kind === "br" &&
    live.at(-2)?.kind !== "br" &&
    !(last.nodes[0] as Element).hasAttribute(SOURCE_ATTR) &&
    !patchBreaks.has(last.nodes[0])
      ? last
      : null;
  const remove = (item: Item) => {
    if (item.left) how.unsafe = true;
    else if (item !== opener) {
      how.went(item.nodes[0]);
      item.nodes.forEach((node) => parent.removeChild(node));
    }
  };

  let i = 0;
  let j = 0;
  const pairs = equalPairs(
    live.length,
    next.length,
    (i, j) => live[i].kind === next[j].kind && live[i].key === next[j].key,
  );
  for (const [pi, pj] of [...pairs, [live.length, next.length]]) {
    for (; j < pj; j++) {
      // An element pairs with one of the same attributes first, as the
      // paragraph that the reader types in, with its id, when a patch takes
      // out the paragraphs around it.
      const kin = (k: number) => live[k].kind === next[j].kind;
      const twin = (k: number) =>
        kin(k) && attributesOf(live[k]) === attributesOf(next[j]);
      let k = i;
      while (k < pi && !twin(k)) k++;
      if (k === pi) {
        k = i;
        while (k < pi && !kin(k)) k++;
      }
      if (k < pi) {
        live.slice(i, k).forEach(remove);
        morphItem(live[k], next[j], how);
        i = k + 1;
      } else {
        for (const node of next[j].nodes) {
          parent.insertBefore(node, live[i]?.nodes[0] ?? end);
          how.added(node);
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          for (const el of [
            node as Element,
            ...(node as Element).querySelectorAll("*"),
          ]) {
            if (el.localName === "br") patchBreaks.add(el);
            const tag = how.tags.get(el);
            if (tag !== undefined) patchTags.set(el, tag);
          }
        }
      }
    }
    live.slice(i, pi).forEach(remove);
    if (pi < live.length) morphItem(live[pi], next[pj], how);
    i = pi + 1;
    j = pj + 1;
  }
}

// attributesOf gives the attributes of an element item, without those that
// the bridge sets, as one text.
const attributesOf = ({ nodes: [node] }: Item) =>
  node.nodeType === Node.ELEMENT_NODE
    ? Array.from((node as Element).attributes)
        .filter(({ name }) => !BRIDGE_ATTRIBUTE.test(name))
        .map(({ name, value }) => `${name}=${JSON.stringify(value)}`)
        .join(" ")
    : "";

// morphItem changes a live item to the item that it pairs with. An item
// that the morph leaves stays as it is, and its pair must be equal to it.
function morphItem(item: Item, to: Item, how: Morph) {
  const [node, twin] = [item.nodes[0], to.nodes[0]];
  if (item.left) {
    how.unsafe ||= item.key !== to.key;
    return;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    const marks = how.marks.get(twin) ?? [];
    // The marks are now those of the live text.
    how.marks.set(node, marks);
    return retext(item.nodes as Text[], dataOf(to), marks, how.added);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    if (dataOf(item) !== dataOf(to))
      (node as CharacterData).replaceData(0, dataOf(item).length, dataOf(to));
    return;
  }
  setAttributes(node as Element, twin as Element, how.sourceOf(node as Element));
  // An element that a patch put in takes the start tag of its new pair.
  if (patchTags.has(node as Element)) {
    const tag = how.tags.get(twin as Element);
    if (tag !== undefined) patchTags.set(node as Element, tag);
    else patchTags.delete(node as Element);
  }
  morphRun(node, node.firstChild, null, twin, how);
}

// itemsOf gives the items of nodes. For the live nodes of a morph, how is
// given. An element that the morph leaves is then an item only when the
// source has it: it pairs with the element of the new HTML that has the text
// of the source. The source has no element that the bridge or a script made.
// An element with the place of the source and no element of the source, such
// as a copy that the parser made of an unclosed <b>, has no safe pair.
function itemsOf(nodes: Node[], how?: Morph): Item[] {
  const items: Item[] = [];
  for (const node of nodes) {
    const kind = node.nodeName.toLowerCase();
    const key = spaced(node.textContent);
    const last = items.at(-1);
    if (node.nodeType === Node.TEXT_NODE) {
      if (last?.kind === kind && last.nodes.at(-1)!.nextSibling === node) {
        last.key += key;
        last.nodes.push(node);
      } else items.push({ kind, key, nodes: [node] });
    } else if (!how || !(node as Element).matches?.(LEFT)) {
      items.push({ kind, key, nodes: [node] });
    } else if ((node as Element).hasAttribute(SOURCE_ATTR)) {
      const source = how.sourceOf(node as Element);
      if (!source) how.unsafe = true;
      else
        items.push({
          kind,
          key: spaced(source.textContent),
          nodes: [node],
          left: true,
        });
    }
  }
  return items;
}

// A start tag, or a comment, which can hold text like a tag.
const START_TAG = /<!--[\s\S]*?-->|<([a-zA-Z][^\s/>]*)(?:"[^"]*"|'[^']*'|[^"'>])*>/g;

// The elements that the parser makes in a table when the html has no tag
// for them.
const IMPLIED = /^(tbody|colgroup)$/;

// startTags gives, for each element of root, the parse of html, its start
// tag in html. A <tbody> or a <colgroup> that the parser made with no tag in
// html has the empty tag. It gives none when the parser made another element
// that html has no start tag for, or dropped one.
function startTags(root: Element, html: string): Map<Element, string> {
  const tags = Array.from(html.matchAll(START_TAG)).filter((tag) => tag[1]);
  const out = new Map<Element, string>();
  let i = 0;
  for (const el of root.querySelectorAll("*")) {
    if (el.localName === tags[i]?.[1].toLowerCase()) out.set(el, tags[i++][0]);
    else if (IMPLIED.test(el.localName)) out.set(el, "");
    else return new Map();
  }
  return i === tags.length ? out : new Map();
}

// dataOf gives the text of an item of text, or of a comment.
const dataOf = (item: Item) =>
  item.nodes.map((node) => (node as CharacterData).data).join("");

// partsOf gives the words of a text and the white space between them, each
// with its offset.
const partsOf = (text: string) =>
  Array.from(text.matchAll(/\s+|\S+/g), (part) => ({ at: part.index, text: part[0] }));

// changesOf gives the changes that make text from old. marks are the ranges
// of text that other people put in. In the comparison, the words that pair
// stay, and between them only the characters that differ change.
export function changesOf(old: string, text: string, marks: Mark[]): Changes {
  if (sameText(old, text)) return [[], []];
  let [rest, last] = ["", 0];
  const puts = marks.map(([from, to]): Splice => {
    rest += text.slice(last, from);
    last = to;
    return [rest.length, rest.length, text.slice(from, to)];
  });
  rest += text.slice(last);
  const [a, b] = [partsOf(old), partsOf(rest)];
  const same = (i: number, j: number) => sameText(a[i].text, b[j].text);
  const [head, tail] = sameEnds(a, b, same);
  const [n, m] = [a.length - head - tail, b.length - head - tail];
  const pairs = equalPairs(n, m, (i, j) => same(head + i, head + j));
  const changes: Splice[] = [];
  let [i, j] = [head, head];
  for (const [pi, pj] of [...pairs, [n, m]].map(([x, y]) => [head + x, head + y])) {
    const [start, stop] = [a[i]?.at ?? old.length, a[pi]?.at ?? old.length];
    const was = old.slice(start, stop);
    const now = rest.slice(b[j]?.at ?? rest.length, b[pj]?.at ?? rest.length);
    let [front, back] = sameEnds(was, now, (x, y) => sameText(was[x], now[y]));
    if (halves(was, front)) front--;
    if (halves(was, was.length - back)) back--;
    if (front + back < Math.max(was.length, now.length))
      changes.push([start + front, stop - back, now.slice(front, now.length - back)]);
    [i, j] = [pi + 1, pj + 1];
  }
  return [changes, puts];
}

// spread gives a change of a text to the parts that hold the text, which
// have these lengths: change gets each part that changes, with the offsets
// in it of the characters that go, and the new text for the first part that
// reaches the start of the change.
export function spread(
  lengths: number[],
  [start, stop, text]: Splice,
  change: (part: number, from: number, to: number, text: string) => void,
) {
  let at = 0;
  lengths.forEach((length, part) => {
    const within = (offset: number) => Math.min(Math.max(offset - at, 0), length);
    const [from, to] = [within(start), within(stop)];
    const put = start - at <= length ? text : "";
    if (to > from || put) change(part, from, to, put);
    if (put) text = "";
    at += length;
  });
}

// retext changes the text of nodes, which are next to each other, to text
// with these marks. The browser keeps a caret that is not in the characters
// that change at its character, and one at the place of new text before that
// text. Each change is one record for the editor.
function retext(nodes: Text[], text: string, marks: Mark[], added: Morph["added"]) {
  const old = nodes.map((node) => node.data).join("");
  for (const pass of changesOf(old, text, marks)) {
    // The changes go in from the last one, so the offsets of the others stay.
    for (const change of pass.reverse()) {
      spread(
        nodes.map((node) => node.length),
        change,
        (part, from, to, put) => {
          nodes[part].replaceData(from, to - from, put);
          added(nodes[part], from, from + put.length);
        },
      );
    }
  }
}

// setAttributes makes the attributes of el those of twin, apart from the
// attributes that the bridge sets. For an original element, source is its
// element of the source, and a script can set attributes on it that the
// source does not have. Thus only an attribute that the patch has not as
// the source has it changes, and one that a patch changed before.
function setAttributes(el: Element, twin: Element, source: Element | null) {
  const names = [...Array.from(el.attributes), ...Array.from(twin.attributes)].map(
    ({ name }) => name,
  );
  for (const name of new Set(names)) {
    const value = twin.getAttribute(name);
    const live = el.getAttribute(name);
    const scripted =
      source?.getAttribute(name) === value && patched.get(el)?.get(name) !== live;
    if (BRIDGE_ATTRIBUTE.test(name) || live === value || scripted) continue;
    if (value === null) el.removeAttribute(name);
    else el.setAttribute(name, value);
    if (source) patched.set(el, (patched.get(el) ?? new Map()).set(name, value));
  }
}
