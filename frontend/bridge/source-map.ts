// The source map connects the live document of a frame to the version
// source that the frame loaded. The frame's srcdoc carries SOURCE_ATTR on
// every start tag, so parsing it again gives the pristine tree: the document
// before any script ran, with the source offset of each element. A live
// element is original when it is the one live element with its offset and
// the pristine element at that offset has the same tag name. The editor can
// change original content and its own new nodes. Content that a script made,
// and original elements whose text a script changed, are not editable, and
// a save never takes them from the DOM.
//
// regions() describes all the editor's changes as source pieces. The
// bridge's own nodes, such as comment highlights and heading links, are left
// out, and the text that they split is one text again. Text and comments
// line up with the pristine children by their places between the original
// elements around them.

import { SOURCE_ATTR, type Piece, type Region } from "./source-pieces.ts";

// The changes of the editor since editing started. The editor keeps adding
// to them; the source map reads them when it needs them.
export type EditorChanges = {
  // The original blocks that the editor changed.
  touched: Iterable<Element>;
  // The nodes that the editor, or the browser for the editor's input, made.
  made: WeakSet<Node>;
  // The source offsets of the original elements that the editor deleted.
  removed: Iterable<number>;
};

export interface SourceMap {
  // The source offset of el when el is the one live element for an original
  // element, else null.
  offsetOf(el: Element): number | null;
  // Whether node is in content that a script made or changed, which is not
  // editable as HTML.
  scriptOwned(node: Node): boolean;
  // The source attributes of an original element without id and SOURCE_ATTR,
  // for the element that Enter opens.
  attributesOf(el: Element): [string, string][];
  // Examines again the content at these nodes after a script changed it, and
  // marks what a script made or changed. Give the nodes that a script added,
  // and the elements whose text or children a script changed.
  refresh(roots: Iterable<Node>): void;
  // The regions for all the editor's changes since editing started.
  regions(): Region[];
  // Takes the marks off.
  stop(): void;
}

// The bridge's own nodes in the document. Comment highlights wrap text and
// are unwrapped. The other nodes are left out.
const BRIDGE_WRAPPER = "mark.slashdocs-mark";
const BRIDGE_NODE =
  ".slashdocs-heading-link,.slashdocs-selection-action,.slashdocs-text-flash," +
  ".slashdocs-svg-mark-rect,[data-slashdocs-injected],[id^='slashdocs-']";

// The tags that new content can have. Other new elements are unwrapped.
const NEW_TAG = /^(p|br|strong|b|em|i|a|ul|ol|li)$/;
const SAFE_HREF = /^(https?:|mailto:|#)/i;

// The script that the server puts before the document in the srcdoc.
const PRELUDE = "script#slashdocs-bootstrap";

// The changes in the children of one live parent: the nodes that the editor
// changed or made, the original children that it deleted, and the original
// elements that it deleted deeper down.
type Group = {
  parent: Node;
  nodes: Set<Element>;
  removed: Element[];
  inner: Element[];
};
// The live children of a group's parent that a region replaces, and the
// source offsets of the first and last original elements in them.
type Run = { from: number; to: number; items: Item[] };

type Item =
  | { kind: "text" | "comment"; data: string }
  | { kind: "element"; element: Element }
  | { kind: "other" };

// What a live element is. A flat element, such as an implied <tbody> with no
// start tag or a comment highlight, is not a parent of its own: its children
// count as children of its parent.
type Kind = "original" | "flat" | "editor" | "script" | "bridge";

export function createSourceMap(
  d: Document,
  taggedSource: string,
  changes: EditorChanges,
): SourceMap {
  const pristine = new DOMParser().parseFromString(taggedSource, "text/html");
  const byOffset = new Map<number, Element | null>();
  const attributeNames = new Map<string, Set<string>>();
  for (const el of Array.from(pristine.querySelectorAll(`[${SOURCE_ATTR}]`))) {
    const at = Number(el.getAttribute(SOURCE_ATTR));
    // The parser copies some elements, such as <b> that closes too late. A
    // copy carries the same offset: no element owns it.
    byOffset.set(at, byOffset.has(at) ? null : el);
    const names = attributeNames.get(el.localName) ?? new Set();
    for (const { name } of Array.from(el.attributes)) {
      if (name !== "id" && name !== SOURCE_ATTR) names.add(name);
    }
    attributeNames.set(el.localName, names);
  }
  const pristineItems = new WeakMap<Node, Item[]>();
  const pristineChildren = (parent: Node) => {
    let items = pristineItems.get(parent);
    if (!items) {
      items = itemsOf(parent, (el) =>
        el.matches(PRELUDE)
          ? "bridge"
          : el.hasAttribute(SOURCE_ATTR)
            ? "original"
            : "flat",
      );
      pristineItems.set(parent, items);
    }
    return items;
  };

  // The elements that the source map made not editable, and the value of
  // their contenteditable attribute before that.
  const marked = new Map<Element, string | null>();
  const mark = (el: Element) => {
    if (marked.has(el)) return;
    marked.set(el, el.getAttribute("contenteditable"));
    el.setAttribute("contenteditable", "false");
  };

  // view reads the live document as it is now. Scripts can copy or move
  // elements at any time, so each call makes a new one.
  const view = () => {
    const counts = new Map<string, number>();
    for (const el of Array.from(d.querySelectorAll(`[${SOURCE_ATTR}]`))) {
      const at = el.getAttribute(SOURCE_ATTR)!;
      counts.set(at, (counts.get(at) ?? 0) + 1);
    }
    const twins = new Map<Element, Element | null>();
    // twin gives the pristine element of a live one, or null.
    const twin = (el: Element): Element | null => {
      if (!twins.has(el)) twins.set(el, findTwin(el));
      return twins.get(el)!;
    };
    const findTwin = (el: Element): Element | null => {
      const at = el.getAttribute(SOURCE_ATTR);
      if (at !== null) {
        const p = counts.get(at) === 1 ? byOffset.get(Number(at)) : null;
        return p?.localName === el.localName ? p : null;
      }
      if (el === d.documentElement) return pristine.documentElement;
      if (el === d.head) return pristine.head;
      if (el === d.body) return pristine.body;
      // An implied element holds original children whose pristine parent is
      // implied too.
      for (const child of Array.from(el.children)) {
        const parent = child.hasAttribute(SOURCE_ATTR)
          ? twin(child)?.parentElement
          : null;
        if (
          parent &&
          !parent.hasAttribute(SOURCE_ATTR) &&
          parent.localName === el.localName
        ) {
          return parent;
        }
      }
      return null;
    };
    const kinds = new Map<Element, Kind>();
    const kind = (el: Element): Kind => {
      let k = kinds.get(el);
      if (!k) {
        if (el.matches(BRIDGE_NODE)) k = "bridge";
        else if (el.matches(BRIDGE_WRAPPER)) k = "flat";
        else if (twin(el)) k = el.hasAttribute(SOURCE_ATTR) ? "original" : "flat";
        // Nodes in new content are new too, as when the browser splits them.
        else if (changes.made.has(el)) k = "editor";
        else {
          const parent = el.parentElement;
          k = parent && kind(parent) === "editor" ? "editor" : "script";
        }
        kinds.set(el, k);
      }
      return k;
    };
    const liveItems = new Map<Node, Item[]>();
    const children = (parent: Node) => {
      let items = liveItems.get(parent);
      if (!items) {
        items = itemsOf(parent, (el) => kind(el));
        liveItems.set(parent, items);
      }
      return items;
    };
    const parentOf = (node: Node): Node | null => {
      let parent = node.parentNode;
      while (
        parent?.nodeType === Node.ELEMENT_NODE &&
        kind(parent as Element) === "flat"
      ) {
        parent = parent.parentNode;
      }
      return parent;
    };
    // placeOf gives the index of the twin of a live original element among
    // the pristine children that places indexes, when it is one of them.
    const placeOf = (places: Map<Element, number>, el: Element) =>
      kind(el) === "original" ? places.get(twin(el)!) : undefined;
    const offset = (el: Element) =>
      kind(el) === "original" ? Number(el.getAttribute(SOURCE_ATTR)) : null;
    const pristineOf = (parent: Node) =>
      parent === d ? pristine : twin(parent as Element);
    const liveAt = (at: number) =>
      Array.from(d.querySelectorAll(`[${SOURCE_ATTR}="${at}"]`)).find(
        (el) => kind(el) === "original",
      );
    return { twin, kind, children, parentOf, placeOf, offset, pristineOf, liveAt };
  };
  type View = ReturnType<typeof view>;

  // ownText tells whether the text of an original element is still the text
  // of the source. Elements may move: only the text counts.
  const ownText = (v: View, el: Element) =>
    joinText(v.children(el)) === joinText(pristineChildren(v.twin(el)!));

  // examine marks the content at el that a script made, and the original
  // elements under it whose text a script changed. The editor's own content
  // and the blocks that it changed are left as they are.
  const examine = (v: View, el: Element, touched: Set<Element>, edited: boolean) => {
    const k = v.kind(el);
    if (k === "bridge" || marked.has(el)) return;
    if (k === "script") return mark(el);
    edited ||= k === "editor" || touched.has(el);
    const root = el === d.body || el === d.documentElement;
    if (k === "original" && !edited && !root && !ownText(v, el)) return mark(el);
    for (const child of Array.from(el.children)) examine(v, child, touched, edited);
  };
  const examineAt = (nodes: Iterable<Node>) => {
    const v = view();
    const touched = new Set(changes.touched);
    for (const node of nodes) {
      let el =
        node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
      // A change of text belongs to the original element that holds it.
      while (el && node !== el && el !== d.body && v.kind(el) !== "original") {
        el = el.parentElement;
      }
      if (!el?.isConnected || !d.body?.contains(el)) continue;
      let edited = false;
      for (let up = el.parentElement; up; up = up.parentElement) {
        edited ||= touched.has(up) || v.kind(up) === "editor";
      }
      examine(v, el, touched, edited);
    }
  };
  if (d.body) examineAt([d.body]);

  // A live element whose content is the same as in the source, apart from
  // the bridge's nodes and what scripts added.
  const unchanged = (v: View, el: Element): boolean => {
    if (marked.has(el) || el.localName === "noscript") return true;
    const live = v
      .children(el)
      .filter((item) => item.kind !== "element" || v.kind(item.element) !== "script");
    const source = pristineChildren(v.twin(el)!);
    return (
      live.length === source.length &&
      live.every((item, i) => {
        const p = source[i];
        if (item.kind !== p.kind) return false;
        if (item.kind === "element") {
          const twin = v.twin(item.element);
          return (
            v.kind(item.element) === "original" &&
            twin === (p as { element: Element }).element &&
            unchanged(v, item.element)
          );
        }
        return item.kind === "other" || item.data === (p as { data: string }).data;
      })
    );
  };

  // piecesOf writes a live element: an original one by reference, and new
  // content as HTML.
  const piecesOf = (v: View, el: Element): Piece[] => {
    const k = v.kind(el);
    if (k === "script") return [];
    if (k === "original") {
      const at = v.offset(el)!;
      if (unchanged(v, el)) return [{ keep: at }];
      return [{ element: at, children: aligned(v, v.children(el), el, false) }];
    }
    const children = v
      .children(el)
      .flatMap((item): Piece[] =>
        item.kind === "element"
          ? piecesOf(v, item.element)
          : item.kind === "text"
            ? [{ text: item.data }]
            : [],
      );
    const name = el.localName;
    if (name === "br") {
      // A new <br> that only keeps an emptied block open is not content.
      const items = v.children(v.parentOf(el)!);
      const last = items.at(-1);
      return last?.kind === "element" && last.element === el
        ? []
        : [{ open: "<br>", close: "", children: [] }];
    }
    if (
      !NEW_TAG.test(name) ||
      (name === "a" && !SAFE_HREF.test(el.getAttribute("href") ?? ""))
    ) {
      return children;
    }
    return [{ open: `<${name}${newAttributes(el)}>`, close: `</${name}>`, children }];
  };

  // The attributes of a new element: href, the start of a numbered list
  // that continues another, and the attributes that the source uses on that
  // tag, which Enter copies from the block it splits.
  const newAttributes = (el: Element) =>
    Array.from(el.attributes)
      .filter(({ name }) =>
        name === "href"
          ? el.localName === "a"
          : (name === "start" && el.localName === "ol") ||
            attributeNames.get(el.localName)?.has(name),
      )
      .map(
        ({ name, value }) =>
          ` ${name}="${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`,
      )
      .join("");

  // aligned writes the live items of parent. Text and comments between two
  // original elements line up with the pristine ones between their twins.
  // With edges, the items before the first original element and after the
  // last one are outside the source that the region replaces, so their
  // text is written again rather than kept.
  const aligned = (v: View, items: Item[], parent: Node, edges: boolean): Piece[] => {
    const source = pristineChildren(v.pristineOf(parent)!);
    const ref = parent === d ? -1 : v.offset(parent as Element)!;
    const places = placesOf(source);
    const pieces: Piece[] = [];
    let segment: Item[] = [];
    let last = -1;
    const flush = (next: number, outside: boolean) => {
      const old = next > last ? indexes(source, last + 1, next) : [];
      const live = segment.filter(
        (item) => item.kind === "text" || item.kind === "comment",
      );
      const paired =
        live.length === old.length &&
        live.every((item, i) => item.kind === source[old[i]].kind);
      const texts = old.filter((i) => source[i].kind === "text");
      let n = 0;
      for (const item of segment) {
        if (item.kind === "element") {
          pieces.push(...piecesOf(v, item.element));
          continue;
        }
        if (item.kind === "other") continue;
        const at = paired ? old[n++] : undefined;
        if (item.kind === "comment") {
          if (at !== undefined && !outside)
            pieces.push({ keepChild: { parent: ref, index: at } });
          continue;
        }
        const was = at ?? (texts.length === 1 ? texts[0] : undefined);
        if (
          at !== undefined &&
          !outside &&
          (source[at] as { data: string }).data === item.data
        ) {
          pieces.push({ keepChild: { parent: ref, index: at } });
        } else {
          pieces.push(
            was === undefined
              ? { text: item.data }
              : { text: item.data, was: { parent: ref, index: was } },
          );
        }
      }
      segment = [];
    };
    let first = true;
    for (const item of items) {
      const at = item.kind === "element" ? v.placeOf(places, item.element) : undefined;
      if (at === undefined) {
        segment.push(item);
        continue;
      }
      flush(at, edges && first);
      first = false;
      pieces.push(...piecesOf(v, (item as { element: Element }).element));
      last = at;
    }
    flush(source.length, edges);
    return pieces;
  };

  const regions = (): Region[] => {
    const v = view();
    const groups = new Map<Node, Group>();
    const groupOf = (parent: Node) => {
      let group = groups.get(parent);
      if (!group) {
        group = { parent, nodes: new Set(), removed: [], inner: [] };
        groups.set(parent, group);
      }
      return group;
    };
    const add = (el: Element) => {
      const parent = v.parentOf(el);
      if (parent === d || (parent && v.kind(parent as Element) === "original")) {
        return groupOf(parent).nodes.add(el);
      }
    };
    for (const el of changes.touched)
      if (el.isConnected && v.offset(el) !== null) add(el);
    for (const el of Array.from(d.body?.querySelectorAll("*") ?? [])) {
      if (changes.made.has(el) && v.kind(el) === "editor") add(el);
    }
    for (const at of changes.removed) {
      const p = byOffset.get(at);
      if (!p || v.liveAt(at)) continue;
      let parent = p.parentNode!;
      while (parent !== pristine && !(parent as Element).hasAttribute(SOURCE_ATTR)) {
        parent = parent.parentNode!;
      }
      const live =
        parent === pristine
          ? d
          : v.liveAt(Number((parent as Element).getAttribute(SOURCE_ATTR)));
      if (live) groupOf(live).removed.push(p);
    }

    // When no original element is next to the new content of a parent, the
    // change belongs to the parent itself, one level up.
    const runs = new Map<Group, Run>();
    const queue = [...groups.values()];
    for (let group = queue.shift(); group; group = queue.shift()) {
      const run = runOf(v, group);
      if (run) {
        runs.set(group, run);
        continue;
      }
      if (group.parent === d || !add(group.parent as Element)) continue;
      const outer = groups.get(v.parentOf(group.parent)!)!;
      outer.inner.push(...group.removed, ...group.inner);
      runs.delete(outer);
      queue.push(outer);
    }
    // A run in an element that another run writes is written with it.
    const host = (group: Group) =>
      [...runs].find(
        ([other, run]) =>
          other !== group &&
          run.items.some(
            (item) => item.kind === "element" && item.element.contains(group.parent),
          ),
      )?.[0];
    const removed = new Map<Group, Element[]>();
    for (const group of runs.keys()) {
      let outer = group;
      for (let next = host(outer); next; next = host(outer)) outer = next;
      removed.set(outer, [
        ...(removed.get(outer) ?? []),
        ...group.removed,
        ...group.inner,
      ]);
    }
    return [...removed].map(([group, elements]) => {
      const run = runs.get(group)!;
      return {
        from: run.from,
        to: run.to,
        pieces: aligned(v, run.items, group.parent, true),
        removed: elements.map((p) => Number(p.getAttribute(SOURCE_ATTR))),
      };
    });
  };

  // runOf finds the live run of a group's parent that a region replaces: from
  // the first changed node to the last one, out to the original elements
  // next to them, and over every live original whose source lies between.
  const runOf = (v: View, group: Group): Run | null => {
    const items = v.children(group.parent);
    const source = pristineChildren(v.pristineOf(group.parent)!);
    const places = placesOf(source);
    const placeAt = (i: number) => {
      const item = items[i];
      return item.kind === "element" ? v.placeOf(places, item.element) : undefined;
    };
    const changed = items.flatMap((item, i) =>
      item.kind === "element" && group.nodes.has(item.element) ? [i] : [],
    );
    const anchors = items.flatMap((_, i) => (placeAt(i) === undefined ? [] : [i]));
    let lo = items.length;
    let hi = -1;
    if (changed.length) {
      const [first, last] = [changed[0], changed.at(-1)!];
      lo = anchors.filter((i) => i <= first).at(-1) ?? first;
      hi = anchors.find((i) => i >= last) ?? last;
    }
    const removed = group.removed.map((p) => places.get(p)!);
    for (;;) {
      const at = [...removed];
      for (let i = lo; i <= hi; i++) {
        const place = placeAt(i);
        if (place !== undefined) at.push(place);
      }
      if (!at.length) return null;
      const from = Math.min(...at);
      const to = Math.max(...at);
      let grew = false;
      items.forEach((_, i) => {
        const place = placeAt(i);
        if (place !== undefined && place >= from && place <= to && (i < lo || i > hi)) {
          lo = Math.min(lo, i);
          hi = Math.max(hi, i);
          grew = true;
        }
      });
      if (!grew) {
        const offsetAt = (i: number) =>
          Number((source[i] as { element: Element }).element.getAttribute(SOURCE_ATTR));
        return {
          from: offsetAt(from),
          to: offsetAt(to),
          items: items.slice(lo, hi + 1),
        };
      }
    }
  };

  return {
    offsetOf: (el) => view().offset(el),
    scriptOwned(node) {
      const v = view();
      for (
        let el =
          node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
        el;
        el = el.parentElement
      ) {
        if (marked.has(el) || v.kind(el) === "script") return true;
      }
      return false;
    },
    attributesOf(el) {
      const v = view();
      const twin = v.offset(el) === null ? null : v.twin(el);
      return Array.from(twin?.attributes ?? [])
        .filter(({ name }) => name !== "id" && name !== SOURCE_ATTR)
        .map(({ name, value }) => [name, value]);
    },
    refresh: examineAt,
    regions,
    stop() {
      for (const [el, value] of marked) {
        if (value === null) el.removeAttribute("contenteditable");
        else el.setAttribute("contenteditable", value);
      }
      marked.clear();
    },
  };
}

// itemsOf gives the logical children of parent: the children of flat
// elements count as children of parent, the bridge's nodes are left out, and
// adjacent text is one item.
function itemsOf(parent: Node, kind: (el: Element) => Kind): Item[] {
  const items: Item[] = [];
  const add = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const el = child as Element;
        const k = kind(el);
        if (k === "flat") add(el);
        else if (k !== "bridge") items.push({ kind: "element", element: el });
      } else if (
        child.nodeType === Node.TEXT_NODE ||
        child.nodeType === Node.COMMENT_NODE
      ) {
        const data = (child as CharacterData).data;
        const kind = child.nodeType === Node.TEXT_NODE ? "text" : "comment";
        const last = items.at(-1);
        if (kind === "text" && !data) continue;
        if (kind === "text" && last?.kind === "text") last.data += data;
        else items.push({ kind, data });
      } else {
        items.push({ kind: "other" });
      }
    }
  };
  add(parent);
  return items;
}

const joinText = (items: Item[]) =>
  items.map((item) => (item.kind === "text" ? item.data : "")).join("");

// placesOf indexes the pristine elements among the pristine children.
function placesOf(source: Item[]): Map<Element, number> {
  const places = new Map<Element, number>();
  source.forEach((item, i) => item.kind === "element" && places.set(item.element, i));
  return places;
}

// indexes gives the indexes from start up to end of the text and comments.
function indexes(source: Item[], start: number, end: number): number[] {
  const list: number[] = [];
  for (let i = start; i < end; i++) {
    if (source[i].kind === "text" || source[i].kind === "comment") list.push(i);
  }
  return list;
}
