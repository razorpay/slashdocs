// Text editing lets an editor change a rendered document in place: its
// words, and its paragraphs, lists, links, bold and italic. The DOM is never
// serialized back into HTML. The editor records which original blocks it
// changed, which nodes it made and which original elements it removed, and
// the source map turns those into regions that the app writes into the
// source by position.
//
// One MutationObserver sees every change. A change belongs to the editor
// only while a user operation runs: from a trusted beforeinput to its input,
// or while the editor changes the DOM itself. Every other change comes from
// the document's scripts, or from the bridge, and the source map evaluates
// it again.
//
// The steps of each user operation also make the undo journal. A step is a
// change of the text of one node, kept as the text that went and the text
// that came at an offset, or the record of a change of structure. A patch
// brings the text of other people into the same nodes, and can move text to
// other nodes, so the journal moves over each patch: Undo then takes out
// only the text that the person put in, and never puts old text over the
// text of another person.

import { blockOf, BLOCKS, sameEnds, scrollBehavior, viewOf } from "./dom.ts";
import {
  morph,
  offsetOf,
  pointAt,
  spread,
  type Morphed,
  type Splice,
  type Texts,
} from "./patch.ts";
import { createSourceMap, type SourceMap } from "./source-map.ts";
import { SOURCE_ATTR, type Patch, type Region } from "./source-pieces.ts";
import {
  createStructure,
  editable,
  elementOf,
  REFUSED,
  selection,
  type Change,
  type Input,
} from "./structure.ts";

export interface TextEditor {
  // The regions for every change since editing started. Taking them does
  // not reset them.
  take(): { regions: Region[] };
  // The same regions, for a draft: the editor keeps the highlights that it
  // took off.
  peek(): { regions: Region[] };
  // The count of user operations since editing started. A change that a
  // patch makes is not one.
  edits(): number;
  // patch shows the text of other people in place. The regions hold its
  // changes, as they hold those of a user operation. edits is the count of
  // user operations that the patches were made for. watch, when given, runs
  // when the patches fit, before they change the document. The function
  // that it gives sees the new content in the document, and a patch that
  // this function does not keep is taken out again.
  patch(
    patches: Patch[],
    edits: number,
    watch?: () => (ranges: Range[]) => boolean,
  ): Patched;
  // The source map of the document, which script text uses too.
  map: SourceMap;
  // run does an input on the selection as its shortcut does, for example
  // "formatBold" or "insertLink".
  run(type: string): void;
  // setEditable lets the reader type in the document, or stops that while
  // they comment. The editor keeps every change since it started, so that
  // the regions still hold the earlier ones.
  setEditable(on: boolean): void;
  stop(): void;
}

// What a patch did. It changes nothing when it is not ok: it is stale after
// one more user operation or while an input method composes text, withdrawn
// when it was not kept, and else it does not fit the document, or the morph
// cannot make its content. ranges are those of the new content, and a
// collapsed range is a place where text went.
export type Patched = {
  ok: boolean;
  stale?: true;
  withdrawn?: true;
  ranges?: Range[];
};

type TextEditingCallbacks = {
  // The editor is about to change a block: anything that splits its text
  // nodes, such as comment highlights, must come off first.
  beforeTouch(block: Element): void;
  // A user operation changed the document.
  onDirty(): void;
  // An input was refused, for one of the reasons in REFUSED.
  onRefused(reason: string): void;
};

// Script text that the reader may change. It takes plain text only, and is
// not part of the regions: the app writes it into the script.
const SCRIPT_EDIT = "[data-slashdocs-script-edit]";
const PLAIN_INPUT =
  /^(insertText|insertReplacementText|insertCompositionText|insertFromPaste|delete(Content|Word|SoftLine|HardLine)(Backward|Forward)|deleteByCut|historyUndo|historyRedo)$/;

// The inputs of Undo and Redo.
const HISTORY = /^history(Undo|Redo)$/;
const STYLE_ID = "slashdocs-text-editing-style";
const EDITING_ATTR = "data-slashdocs-text-editing";
// While the reader edits, the page shows that its text takes the caret: an
// I-beam, and a faint ring on the innermost block of text under the pointer
// that the reader can change.
const EDITING_CSS =
  `[${EDITING_ATTR}] body{outline:none!important;caret-color:auto;cursor:text}` +
  `[${EDITING_ATTR}] a{cursor:text!important}` +
  `@media (hover:hover){[${EDITING_ATTR}] body :is(${BLOCKS}):hover:not(:has(:is(${BLOCKS}):hover),[contenteditable=false],[contenteditable=false] *){outline:1px solid rgba(37,99,235,.3);outline-offset:3px}}`;
// Typing that follows within this time undoes as one step.
const TYPING_MS = 1000;
const JOURNAL_SIZE = 200;

type Caret = [Node, number, Node, number] | null;
// A change of the text of one node: removed went at an offset, and inserted
// came in its place. Text that only came or only went can have more than one
// place, as an "l" in "hello" has: the same change can be up to slack
// characters later, and at is the first place. For marked text of a patch,
// at is the exact place.
type TextChange = {
  target: CharacterData;
  at: number;
  removed: string;
  inserted: string;
  slack: number;
  exact?: boolean;
};
// A step of a user operation or of a patch: a change of text, or the record
// of a change of child nodes or of an attribute.
type Step = TextChange | MutationRecord;
// A user operation in the journal: its steps, the selection before it and
// the one after it, and the kind of typing that later typing joins. Each
// step is in the document that the step before it left.
type Entry = {
  steps: Step[];
  carets: [Caret, Caret];
  typing?: string;
  at: number;
};

export function startTextEditing(
  d: Document,
  taggedSource: string,
  callbacks: TextEditingCallbacks,
  // A reader who does not edit gets the editor too, so that its regions hold
  // the patches. It then starts not editable.
  startEditable = true,
): TextEditor | null {
  const body = d.body;
  if (!body) return null;
  // The nodes that were in the document before the editor's operation that
  // adds them. Every other node that a user operation adds is made.
  const seen = new WeakSet<Node>();
  const see = (root: Node) => {
    const walker = d.createTreeWalker(root);
    for (let n: Node | null = root; n; n = walker.nextNode()) seen.add(n);
  };
  see(body);
  const made = new WeakSet<Node>();
  const touched = new Set<Element>();
  const beside = new Set<Element>();
  // The original elements that the editor took out. Undo can put them back.
  const removed = new Set<Element>();
  const map = createSourceMap(d, taggedSource, {
    touched,
    beside,
    made,
    removed: {
      *[Symbol.iterator]() {
        for (const el of removed)
          if (!el.isConnected) yield Number(el.getAttribute(SOURCE_ATTR));
      },
    },
  });
  // The blocks that changed, and those with their highlights off, since the
  // last take.
  const dirty = new Set<Element>();
  const held = new Set<Element>();
  const undos: Entry[] = [];
  const redos: Entry[] = [];
  let edits = 0;
  // An input method composes text in place, as for Japanese, until the
  // composition ends. A patch that changes the text under it breaks it.
  let composing = false;

  // The input that the browser does itself, between its beforeinput and
  // input events.
  let native: { records: MutationRecord[]; caret: Caret; typing: string } | null = null;
  let nativeTimer: ReturnType<typeof setTimeout> | undefined;

  const observer = new MutationObserver((records) => {
    if (native) native.records.push(...records);
    else fromScripts(records);
  });

  // fromScripts takes changes that a script or the bridge made. The source
  // map evaluates their content again. Attributes do not change content.
  function fromScripts(records: MutationRecord[]) {
    const roots = new Set<Node>();
    for (const record of records) {
      if (record.type === "attributes") continue;
      roots.add(record.target);
      record.addedNodes.forEach(see);
    }
    if (roots.size) map.refresh(roots);
  }
  const flush = () => fromScripts(observer.takeRecords());

  // fromEditor takes the changes of a user operation. Changes in script
  // text are not part of the regions.
  function fromEditor(records: MutationRecord[], touch: boolean) {
    for (const record of records) {
      if (elementOf(record.target)?.closest(SCRIPT_EDIT)) continue;
      if (touch && record.target.isConnected) mark(blockOf(record.target));
      record.addedNodes.forEach((node) => {
        const walker = d.createTreeWalker(node);
        for (let n: Node | null = node; n; n = walker.nextNode()) {
          if (!seen.has(n)) made.add(n);
          seen.add(n);
        }
      });
      record.removedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        for (const el of [
          node as Element,
          ...(node as Element).querySelectorAll("*"),
        ]) {
          if (el.hasAttribute(SOURCE_ATTR) && !made.has(el)) removed.add(el);
        }
      });
    }
  }

  // mark counts block as changed. An original block is touched: the regions
  // cover it. A block that the editor made is covered by the region of the
  // original block next to which the editor made it.
  function mark(block: Element | null) {
    if (!block) return;
    dirty.add(block);
    if (map.offsetOf(block) !== null) touched.add(block);
  }

  // hold marks a block that the editor is about to change, and takes its
  // highlights off. Taking them off is not part of the operation.
  function hold(block: Element | null) {
    mark(block);
    unhighlight(block);
  }
  function unhighlight(block: Element | null) {
    if (!block || held.has(block)) return;
    held.add(block);
    flush();
    callbacks.beforeTouch(block);
    flush();
  }

  function caret(): Caret {
    const s = d.getSelection();
    return s?.anchorNode && s.focusNode
      ? [s.anchorNode, s.anchorOffset, s.focusNode, s.focusOffset]
      : null;
  }
  // restore puts the selection back when its places are still there. A
  // script can take a node out, or make its text shorter.
  function restore(at: Caret) {
    const there = (node: Node, offset: number) =>
      node.isConnected && offset <= (node.nodeValue ?? node.childNodes).length;
    if (at && there(at[0], at[1]) && there(at[2], at[3]))
      d.getSelection()?.setBaseAndExtent(...at);
  }

  // commit journals a user operation, unless it changed nothing.
  function commit(records: MutationRecord[], before: Caret, typing?: string) {
    if (!records.length) return;
    edits++;
    redos.length = 0;
    const last = undos.at(-1);
    const now = Date.now();
    const steps = stepsOf(records);
    if (typing && last?.typing === typing && now - last.at < TYPING_MS) {
      last.steps.push(...steps);
      last.carets[1] = caret();
      last.at = now;
    } else {
      undos.push({ steps, carets: [before, caret()], typing, at: now });
      if (undos.length > JOURNAL_SIZE) undos.shift();
    }
    if (dirty.size) callbacks.onDirty();
  }

  function apply(change: Change) {
    closeNative();
    change.blocks.forEach(hold);
    const before = caret();
    change.run();
    const records = observer.takeRecords();
    fromEditor(records, false);
    commit(records, before);
  }

  // patch shows the text of other people. It is not a user operation: it is
  // not in the journal, it is not an edit, and the document is not dirty
  // after it. A patch that is not kept, or that the morph cannot make, goes
  // out step by step, so the nodes and the selection are again as they were.
  function patch(
    patches: Patch[],
    at: number,
    watch?: () => (ranges: Range[]) => boolean,
  ): Patched {
    closeNative();
    flush();
    if (composing || at !== edits) return { ok: false, stale: true };
    const places = patches.flatMap((patch) => map.find(patch) ?? []);
    if (places.length < patches.length) return { ok: false };
    places.forEach((place) => unhighlight(place.in));
    const keep = watch?.();
    const before = caret();
    const runs = places.flatMap((place, i) => morph(place, patches[i]) ?? []);
    const ranges = runs.flatMap((run) => run.ranges);
    const records = observer.takeRecords();
    const steps = stepsOf(records);
    const complete = runs.length === places.length;
    if (!complete || (keep && !keep(ranges))) {
      steps.reverse().forEach(undoStep);
      runs.forEach((run) => run.undo?.());
      observer.takeRecords();
      restore(before);
      return complete ? { ok: false, withdrawn: true } : { ok: false };
    }
    fromEditor(records, false);
    for (const record of records) {
      if (changesText(record) && record.target.isConnected) markText(record);
    }
    // An entry with a step of structure that meets a step of the patch
    // cannot revert, and no older entry can revert before it does.
    const met = ({ steps: own }: Entry) =>
      own.some((step) => !("at" in step) && steps.some((change) => meet(step, change)));
    for (const journal of [undos, redos]) {
      journal.splice(0, journal.map(met).lastIndexOf(true) + 1);
      runs.forEach((run) => follow(journal, run));
    }
    return { ok: true, ranges };
  }

  // markText puts the text that a record of a patch changed in the regions.
  // A new or removed element is in them by itself. Text between two original
  // elements goes with those two, so that the region is the source from one
  // to the other, and not all of their parent. Other text goes with its
  // block, which can be the body.
  function markText(record: MutationRecord) {
    const original = (from: Node | null, next: "previousSibling" | "nextSibling") => {
      for (let node = from; node; node = node[next]) {
        if (
          node.nodeType === Node.ELEMENT_NODE &&
          map.offsetOf(node as Element) !== null
        )
          return node as Element;
      }
      return null;
    };
    const { previousSibling, nextSibling } =
      record.type === "characterData" ? record.target : record;
    const before = original(previousSibling, "previousSibling");
    const after = original(nextSibling, "nextSibling");
    if (before && after) beside.add(before).add(after);
    else mark(blockOf(record.target));
  }

  function openNative(type: string, nodes: Node[]) {
    closeNative();
    nodes.forEach((node) => hold(blockOf(node)));
    native = {
      records: [],
      caret: caret(),
      typing: type.replace(/Backward|Forward/, ""),
    };
    // A browser that changes nothing sends no input event.
    nativeTimer = setTimeout(closeNative, 0);
  }
  function closeNative() {
    clearTimeout(nativeTimer);
    if (!native) return;
    const { records, caret: before, typing } = native;
    records.push(...observer.takeRecords());
    native = null;
    fromEditor(records, true);
    commit(records, before, typing);
  }

  // revert undoes the newest entry of from, and journals the undo in to, so
  // that it can be undone in turn. Steps are reverted from the last one, so
  // the document is as each one left it. A step that does not find that
  // document does not revert. No older entry can then revert in order, so
  // they all go, and the next Undo does nothing.
  function revert(from: Entry[], to: Entry[]) {
    closeNative();
    const entry = from.pop();
    if (!entry) return;
    edits++;
    // The blocks of the entry were touched when it was journaled.
    for (const { target } of entry.steps) {
      const block = target.isConnected ? blockOf(target) : null;
      unhighlight(block);
      if (block) dirty.add(block);
    }
    const exact = entry.steps.reverse().map(undoStep).every(Boolean);
    if (!exact) from.length = 0;
    const records = observer.takeRecords();
    fromEditor(records, false);
    restore(entry.carets[0]);
    if (records.length)
      to.push({
        steps: stepsOf(records),
        carets: [entry.carets[1], entry.carets[0]],
        at: 0,
      });
    const changed = records.map((record) => record.target);
    reveal(changed.filter((node) => node.isConnected).at(-1));
    if (dirty.size) callbacks.onDirty();
  }

  // reveal scrolls to the block of a node that Undo or Redo changed when the
  // block is outside the view, so that no text changes where the person does
  // not see it.
  function reveal(node: Node | undefined) {
    const block = node && blockOf(node);
    const box = block?.getBoundingClientRect();
    if (box && (box.bottom < 0 || box.top > viewOf(d).height))
      block!.scrollIntoView({ block: "center", behavior: scrollBehavior(d) });
  }

  const editor = { d, map, apply, refuse: callbacks.onRefused };
  const structure = createStructure(editor);

  // handle routes an input of the editor. It tells whether the browser must
  // not do the input itself.
  function handle(input: Input): boolean {
    closeNative();
    flush();
    const { type } = input;
    if (HISTORY.test(type)) {
      if (type === "historyUndo") revert(undos, redos);
      else revert(redos, undos);
      return true;
    }
    const r = selection(d);
    if (!r) return false;
    const ends = [r.startContainer, r.endContainer];
    const script = ends.map((n) => elementOf(n)?.closest(SCRIPT_EDIT));
    if (script[0] || script[1]) {
      if (script[0] !== script[1] || !PLAIN_INPUT.test(type))
        return refuse(REFUSED.plainText);
      const kept = structure.keep(input);
      // Script text is not part of any block.
      if (kept) apply({ ...kept, blocks: [] });
      // Pasted text in script text stays on one line.
      else if (type.startsWith("insertFromPaste"))
        apply(structure.plain((input.text ?? "").replace(/\s*\n\s*/g, " ")));
      else {
        openNative(type, ends);
        return false;
      }
      return true;
    }
    const locked = ends.find((n) => !editable(editor, n));
    if (locked) return refuse(map.fixed(locked) ? REFUSED.fixed : REFUSED.script);
    if (type === "insertLink") {
      structure.link();
      return true;
    }
    const change = structure.keep(input) ?? structure.input(input);
    if (typeof change === "string") return refuse(change);
    if (change) apply(change);
    else openNative(type, ends);
    return !!change;
  }
  function refuse(reason: string): true {
    callbacks.onRefused(reason);
    return true;
  }

  // The editor takes no input while it is not editable: an input then
  // belongs to a field of the document.
  let editing = false;
  const onBeforeInput = (event: InputEvent) => {
    if (!editing || !event.isTrusted || !body.contains(event.target as Node)) return;
    // Composition stays with the browser and the input method.
    if (event.isComposing) return openNative("insertCompositionText", []);
    const handled = handle({
      type: event.inputType,
      text: event.data ?? event.dataTransfer?.getData("text/plain") ?? "",
      html: event.dataTransfer?.getData("text/html") ?? "",
      ranges: event.getTargetRanges(),
    });
    if (handled) event.preventDefault();
  };
  const onInput = () => closeNative();
  // A composition starts before it changes text: the highlights come off
  // then, so that the editor does not change the text under it. A
  // composition in a field of the document also makes the patches wait.
  const onCompositionStart = () => {
    composing = true;
    const r = editing && selection(d);
    if (r) hold(blockOf(r.startContainer));
  };
  const onCompositionEnd = () => (composing = false);
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.isTrusted || event.altKey) return;
    const target = elementOf(event.target as Node);
    if (!target || !body.contains(target) || target.closest("input,textarea,select"))
      return;
    const command = event.metaKey || event.ctrlKey;
    // Undo and Redo also work in Comment mode, on the reader's own edits.
    if (!editing && !(command && HISTORY.test(shortcut(event) ?? ""))) return;
    // Tab does not move the focus out of the document, where the next keys
    // go nowhere. In a table, it moves the caret from cell to cell.
    if (event.key === "Tab" && !command) {
      event.preventDefault();
      toCell(d, event.shiftKey);
      return;
    }
    if (!command) return;
    const type = shortcut(event);
    if (!type) return;
    event.preventDefault();
    handle({ type });
  };
  const onDrop = (event: DragEvent) => {
    if (!editing) return;
    event.preventDefault();
    callbacks.onRefused(REFUSED.drop);
  };
  d.addEventListener("keydown", onKeyDown, true);
  d.addEventListener("beforeinput", onBeforeInput, true);
  d.addEventListener("input", onInput, true);
  d.addEventListener("compositionstart", onCompositionStart, true);
  d.addEventListener("compositionend", onCompositionEnd, true);
  d.addEventListener("drop", onDrop, true);

  const previous = body.getAttribute("contenteditable");
  const previousSpellcheck = body.getAttribute("spellcheck");
  const setEditable = (on: boolean) => {
    editing = on;
    d.documentElement.toggleAttribute(EDITING_ATTR, on);
    if (on) {
      body.setAttribute("contenteditable", "true");
      // Squiggles over every rendered word would bury the document.
      body.setAttribute("spellcheck", "false");
      return;
    }
    if (previous === null) body.removeAttribute("contenteditable");
    else body.setAttribute("contenteditable", previous);
    if (previousSpellcheck === null) body.removeAttribute("spellcheck");
    else body.setAttribute("spellcheck", previousSpellcheck);
  };
  setEditable(startEditable);
  if (!d.getElementById(STYLE_ID)) {
    const style = d.createElement("style");
    style.id = STYLE_ID;
    style.textContent = EDITING_CSS;
    (d.head || d.documentElement).appendChild(style);
  }
  observer.observe(body, {
    childList: true,
    subtree: true,
    characterData: true,
    characterDataOldValue: true,
    attributes: true,
    attributeOldValue: true,
  });

  return {
    map,
    edits() {
      closeNative();
      return edits;
    },
    patch,
    run(type) {
      handle({ type });
    },
    peek() {
      closeNative();
      flush();
      return { regions: map.regions() };
    },
    take() {
      const changes = this.peek();
      dirty.clear();
      held.clear();
      return changes;
    },
    setEditable,
    stop() {
      closeNative();
      observer.disconnect();
      structure.stop();
      map.stop();
      d.removeEventListener("keydown", onKeyDown, true);
      d.removeEventListener("beforeinput", onBeforeInput, true);
      d.removeEventListener("input", onInput, true);
      d.removeEventListener("compositionstart", onCompositionStart, true);
      d.removeEventListener("compositionend", onCompositionEnd, true);
      d.removeEventListener("drop", onDrop, true);
      setEditable(false);
      d.getElementById(STYLE_ID)?.remove();
    },
  };
}

// shortcut gives the input type of an editing shortcut with Cmd or Ctrl.
function shortcut(event: KeyboardEvent): string | null {
  const key = event.key.toLowerCase();
  if (key === "z") return event.shiftKey ? "historyRedo" : "historyUndo";
  if (key === "y" && !event.shiftKey) return "historyRedo";
  if (event.shiftKey) {
    if (event.code === "Digit8") return "insertUnorderedList";
    if (event.code === "Digit7") return "insertOrderedList";
    return null;
  }
  if (key === "b") return "formatBold";
  if (key === "i") return "formatItalic";
  if (key === "k") return "insertLink";
  return null;
}

// toCell puts the caret at the end of the next cell of the table of the
// caret, or of the cell before it with back. At the last cell, and outside a
// table, the caret stays.
function toCell(d: Document, back: boolean) {
  const r = selection(d);
  const cell = r && elementOf(r.startContainer)?.closest<HTMLTableCellElement>("td,th");
  const table = cell?.closest("table");
  if (!cell || !table) return;
  const cells = [...table.rows].flatMap((row) => [...row.cells]);
  const to = cells[cells.indexOf(cell) + (back ? -1 : 1)];
  if (to) d.getSelection()?.collapse(to, to.childNodes.length);
}

// changesText tells whether a record changed text or a comment, not only
// elements.
function changesText(record: MutationRecord): boolean {
  return (
    record.type === "characterData" ||
    [...record.addedNodes, ...record.removedNodes].some(
      (node) => node.nodeType !== Node.ELEMENT_NODE,
    )
  );
}

// The text that each node of a step has after the newest step of the node.
// A node with other text was changed by a script since.
const known = new WeakMap<CharacterData, string>();

// stepsOf gives the steps of the records that the observer gave just now.
// The text of a node after a record is its text before the next record of
// the node, or its text now.
function stepsOf(records: MutationRecord[]): Step[] {
  const next = new Map<Node, string>();
  return [...records]
    .reverse()
    .map((record): Step => {
      if (record.type !== "characterData") return record;
      const target = record.target as CharacterData;
      known.set(target, target.data);
      const [old, text] = [record.oldValue ?? "", next.get(target) ?? target.data];
      next.set(target, old);
      return textChange(target, old, text);
    })
    .reverse();
}

// textChange gives the change that makes text from old, the text of target.
function textChange(target: CharacterData, old: string, text: string): TextChange {
  const [at, end] = sameEnds(old, text);
  let slack = 0;
  while (old[at + slack] && old[at + slack] === text[at + slack]) slack++;
  return {
    target,
    at,
    removed: old.slice(at, old.length - end),
    inserted: text.slice(at, text.length - end),
    slack,
  };
}

// follow moves the text steps of a journal over the morph of a run. The
// morph is two things for the journal. First the text of the run changes in
// the nodes that held it, and each change is a change of the text of one
// node. Then the same text is in the nodes that hold the run now: a new
// inline element splits a text, and one that goes joins two. The place of
// marked text is exact, so its change is at that place, not at the first
// place that gives the same text.
function follow(journal: Entry[], { was, now, changes: [found, marked] }: Morphed) {
  const texts = was.map((text) => ({ ...text }));
  const over = (pass: Splice[], exact: boolean) => {
    for (const change of [...pass].reverse()) {
      spread(
        texts.map(({ text }) => text.length),
        change,
        (part, from, to, put) => {
          const { node, text } = texts[part];
          texts[part].text = text.slice(0, from) + put + text.slice(to);
          const step = textChange(node, text, texts[part].text);
          rebase(journal, exact ? { ...slide(step, from - step.at), exact } : step);
        },
      );
    }
  };
  over(found, false);
  over(marked, true);
  relocate(
    journal,
    texts,
    now.map((text) => ({ ...text })),
  );
}

// rebase moves a journal over a change of the text of a node. Undo and Redo
// revert the newest entry first, so each step of the journal is in the
// document that the reverts of the steps after it leave. The change thus
// goes back through the journal from the newest step, and it and each step
// of the text of the same node move over each other. When they meet, the
// entry cannot revert, and no older entry can revert before it does: they
// all go.
function rebase(journal: Entry[], change: TextChange) {
  for (let i = journal.length - 1; i >= 0; i--) {
    const { steps, carets } = journal[i];
    carets[1] = caretAfter(carets[1], change);
    for (let j = steps.length - 1; j >= 0; j--) {
      const step = steps[j];
      if (!("at" in step) || step.target !== change.target) continue;
      const passed = pass(step, change);
      if (!passed) {
        journal.splice(0, i + 1);
        return;
      }
      [steps[j], change] = passed;
    }
    carets[0] = caretAfter(carets[0], change);
  }
}

// relocate moves a journal from the nodes that held the text of a run to
// the nodes that hold the same text now. from and to are those texts. The
// walk goes back through the journal as rebase does, and the revert of a
// step changes the text of its node in from and in to, so the two stay the
// same text. The text of a step must be all in one node, else the entry
// cannot revert, and the older entries go with it.
function relocate(journal: Entry[], from: Texts, to: Texts) {
  const moved = (caret: Caret): Caret => {
    if (!caret) return caret;
    const point = (node: Node, offset: number): [Node, number] => {
      const at = offsetOf(from, node, offset);
      const there = at === null ? null : pointAt(to, at, 0, node, offset === 0);
      return there ?? [node, offset];
    };
    return [...point(caret[0], caret[1]), ...point(caret[2], caret[3])];
  };
  // revert gives the texts the text that node has before a step at offset.
  const revert = (texts: Texts, node: Node, at: number, step: TextChange) => {
    const text = texts.find((one) => one.node === node)!;
    text.text =
      text.text.slice(0, at) +
      step.removed +
      text.text.slice(at + step.inserted.length);
  };
  for (let i = journal.length - 1; i >= 0; i--) {
    const { steps, carets } = journal[i];
    carets[1] = moved(carets[1]);
    for (let j = steps.length - 1; j >= 0; j--) {
      const step = steps[j];
      const start = "at" in step ? offsetOf(from, step.target, step.at) : null;
      if (!("at" in step) || start === null) continue;
      const { target, at, inserted } = step;
      const point = pointAt(to, start, inserted.length, target, at === 0);
      if (!point) {
        journal.splice(0, i + 1);
        return;
      }
      revert(from, target, at, step);
      revert(to, ...point, step);
      // A node of the patch has the text that the patch left in it.
      if (point[0] !== target) known.set(point[0], point[0].data);
      steps[j] = { ...step, target: point[0], at: point[1] };
    }
    carets[0] = moved(carets[0]);
  }
}

// pass gives a step of the journal in the document after a change of a
// patch, and the change in the document before the step. The two change the
// text of one node. pass gives null when they meet: the patch changed the
// text that the step put in. They do not meet when one of them can be at a
// later place, within its slack, so that the change is all before the text
// of the step, or all after it. The slack of the first of the two then ends
// where the other one starts.
function pass(step: TextChange, change: TextChange): [TextChange, TextChange] | null {
  const grew = (by: TextChange) => by.inserted.length - by.removed.length;
  const end = (of: TextChange, text: string) => of.at + text.length;
  // The change is before the step when the step starts this many characters
  // later: at the end of the text that the change took out. Else the change
  // is after the step when the change starts this many characters later: at
  // the end of the text that the step put in. A change at its exact place
  // that is after the step as it is does not move the step.
  const stepLater = Math.max(0, end(change, change.removed) - step.at);
  const changeLater = Math.max(0, end(step, step.inserted) - change.at);
  const after = change.exact && stepLater > 0 && changeLater === 0;
  if (stepLater <= step.slack && !after) {
    const moved = slide(step, stepLater);
    const room = moved.at - end(change, change.removed);
    // The step moves by the size of the change before it.
    return [
      { ...moved, at: moved.at + grew(change) },
      { ...change, slack: Math.min(change.slack, room) },
    ];
  }
  if (changeLater <= change.slack) {
    const moved = slide(change, changeLater);
    const room = moved.at - end(step, step.inserted);
    // Before the step, its text is not before the change.
    return [
      { ...step, slack: Math.min(step.slack, room) },
      { ...moved, at: moved.at - grew(step) },
    ];
  }
  return null;
}

// slide gives the same change of text at a place that is by characters
// later. Its slack must allow that.
function slide(change: TextChange, by: number): TextChange {
  const turn = (text: string) =>
    text && text.slice(by % text.length) + text.slice(0, by % text.length);
  return {
    ...change,
    at: change.at + by,
    slack: change.slack - by,
    removed: turn(change.removed),
    inserted: turn(change.inserted),
  };
}

// caretAfter gives a caret after a change of a patch. The browser moves the
// selection in the same way.
function caretAfter(caret: Caret, change: TextChange): Caret {
  if (!caret) return caret;
  const { target, at, removed, inserted } = change;
  const move = (node: Node, offset: number) =>
    node !== target || offset <= at
      ? offset
      : offset <= at + removed.length
        ? at
        : offset + inserted.length - removed.length;
  return [caret[0], move(caret[0], caret[1]), caret[2], move(caret[2], caret[3])];
}

// meet tells whether one of two steps, a step of structure of the journal
// and a step of a patch, changed a node that the other one changed, added or
// removed. Two steps that add or remove children of one
// parent do not meet when their children are other nodes: Undo of Enter thus
// works after another person adds a paragraph to the same parent.
function meet(a: Step, b: Step): boolean {
  const nodes = (step: Step) =>
    "at" in step ? [] : [...step.addedNodes, ...step.removedNodes];
  const moved = (step: Step, node: Node) => nodes(step).some((n) => n.contains(node));
  if (moved(a, b.target) || moved(b, a.target)) return true;
  if (a.target !== b.target) return false;
  const children = (step: Step) => !("at" in step) && step.type === "childList";
  return !(children(a) && children(b)) || nodes(b).some((node) => moved(a, node));
}

// undoStep reverts one step, and tells whether it did. A change of text
// reverts only while its node has the text that the newest step left in it,
// and the text that the change put in is at its place. It thus puts no text
// in the text of a script, and takes out no other text.
function undoStep(step: Step): boolean {
  if ("at" in step) {
    const { target, at, removed, inserted } = step;
    if (
      known.get(target) !== target.data ||
      target.data.slice(at, at + inserted.length) !== inserted
    )
      return false;
    target.replaceData(at, inserted.length, removed);
    known.set(target, target.data);
    return true;
  }
  try {
    undoRecord(step);
    return true;
  } catch {
    // A script changed these nodes since.
    return false;
  }
}

// undoRecord reverts the record of a change of child nodes or of an
// attribute. A removed node goes back before the node that was after it,
// or else after the node that was before it: a patch can take one of the
// two out of the parent.
function undoRecord(record: MutationRecord) {
  const target = record.target;
  if (record.type === "attributes") {
    const el = target as Element;
    if (record.oldValue === null)
      el.removeAttributeNS(record.attributeNamespace, record.attributeName!);
    else
      el.setAttributeNS(
        record.attributeNamespace,
        record.attributeName!,
        record.oldValue,
      );
  } else {
    record.addedNodes.forEach(
      (node) => node.parentNode === target && target.removeChild(node),
    );
    const { previousSibling: before, nextSibling: after } = record;
    const next =
      after?.parentNode !== target && before?.parentNode === target
        ? before.nextSibling
        : after;
    record.removedNodes.forEach((node) => target.insertBefore(node, next));
  }
}
