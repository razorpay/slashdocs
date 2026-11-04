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
// it again. The records of each user operation also make the undo journal.

import { blockOf } from "./dom.ts";
import { createSourceMap, type SourceMap } from "./source-map.ts";
import { SOURCE_ATTR, type Region } from "./source-pieces.ts";
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
  // The source map of the document, which script text uses too.
  map: SourceMap;
  // run does an input on the selection as its shortcut does, for example
  // "formatBold" or "insertLink".
  run(type: string): void;
  stop(): void;
}

type TextEditingCallbacks = {
  // The editor is about to change a block: anything that splits its text
  // nodes, such as comment highlights, must come off first.
  beforeTouch(block: Element): void;
  // The number of blocks that changed since the last take.
  onDirty(count: number): void;
  // An input was refused, for one of the reasons in REFUSED.
  onRefused(reason: string): void;
};

// Script text that the reader may change. It takes plain text only, and is
// not part of the regions: the app writes it into the script.
const SCRIPT_EDIT = "[data-slashdocs-script-edit]";
const PLAIN_INPUT =
  /^(insertText|insertReplacementText|insertCompositionText|insertFromPaste|delete(Content|Word|SoftLine|HardLine)(Backward|Forward)|deleteByCut|historyUndo|historyRedo)$/;

const STYLE_ID = "slashdocs-text-editing-style";
// Typing that follows within this time undoes as one step.
const TYPING_MS = 1000;
const JOURNAL_SIZE = 200;

type Caret = [Node, number, Node, number] | null;
// A user operation in the journal: its records, the selection before it and
// the one after it, and the kind of typing that later typing joins.
type Entry = {
  records: MutationRecord[];
  carets: [Caret, Caret];
  typing?: string;
  at: number;
};

export function startTextEditing(
  d: Document,
  taggedSource: string,
  callbacks: TextEditingCallbacks,
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
  // The original elements that the editor took out. Undo can put them back.
  const removed = new Set<Element>();
  const map = createSourceMap(d, taggedSource, {
    touched,
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
  function restore(at: Caret) {
    if (at && at[0].isConnected && at[2].isConnected)
      d.getSelection()?.setBaseAndExtent(...at);
  }

  // commit journals a user operation, unless it changed nothing.
  function commit(records: MutationRecord[], before: Caret, typing?: string) {
    if (!records.length) return;
    redos.length = 0;
    const last = undos.at(-1);
    const now = Date.now();
    if (typing && last?.typing === typing && now - last.at < TYPING_MS) {
      last.records.push(...records);
      last.carets[1] = caret();
      last.at = now;
    } else {
      undos.push({ records, carets: [before, caret()], typing, at: now });
      if (undos.length > JOURNAL_SIZE) undos.shift();
    }
    if (dirty.size) callbacks.onDirty(dirty.size);
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
  // that it can be undone in turn. Records are reverted from the last one,
  // so the siblings that each one names are where they were.
  function revert(from: Entry[], to: Entry[]) {
    closeNative();
    const entry = from.pop();
    if (!entry) return;
    // The blocks of the entry were touched when it was journaled.
    for (const record of entry.records) {
      const block = record.target.isConnected ? blockOf(record.target) : null;
      unhighlight(block);
      if (block) dirty.add(block);
    }
    for (const record of [...entry.records].reverse()) {
      try {
        undoRecord(record);
      } catch {
        // A script changed these nodes since: the rest still reverts.
      }
    }
    const records = observer.takeRecords();
    fromEditor(records, false);
    restore(entry.carets[0]);
    to.push({ records, carets: [entry.carets[1], entry.carets[0]], at: 0 });
    if (dirty.size) callbacks.onDirty(dirty.size);
  }

  const editor = { d, map, apply, refuse: callbacks.onRefused };
  const structure = createStructure(editor);

  // handle routes an input of the editor. It tells whether the browser must
  // not do the input itself.
  function handle(input: Input): boolean {
    closeNative();
    flush();
    const { type } = input;
    if (type === "historyUndo" || type === "historyRedo") {
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
    if (ends.some((n) => !editable(editor, n))) return refuse(REFUSED.script);
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

  const onBeforeInput = (event: InputEvent) => {
    if (!event.isTrusted || !body.contains(event.target as Node)) return;
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
  // then, so that the editor does not change the text under it.
  const onCompositionStart = () => {
    const r = selection(d);
    if (r) hold(blockOf(r.startContainer));
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!event.isTrusted || event.altKey || !(event.metaKey || event.ctrlKey)) return;
    const target = elementOf(event.target as Node);
    if (!target || !body.contains(target) || target.closest("input,textarea,select"))
      return;
    const type = shortcut(event);
    if (!type) return;
    event.preventDefault();
    handle({ type });
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    callbacks.onRefused(REFUSED.drop);
  };
  d.addEventListener("keydown", onKeyDown, true);
  d.addEventListener("beforeinput", onBeforeInput, true);
  d.addEventListener("input", onInput, true);
  d.addEventListener("compositionstart", onCompositionStart, true);
  d.addEventListener("drop", onDrop, true);

  const previous = body.getAttribute("contenteditable");
  const previousSpellcheck = body.getAttribute("spellcheck");
  body.setAttribute("contenteditable", "true");
  // Squiggles over every rendered word would bury the document.
  body.setAttribute("spellcheck", "false");
  d.documentElement.setAttribute("data-slashdocs-text-editing", "");
  if (!d.getElementById(STYLE_ID)) {
    const style = d.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "[data-slashdocs-text-editing] body{outline:none!important;caret-color:auto}" +
      "[data-slashdocs-text-editing] a{cursor:text!important}";
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
    stop() {
      closeNative();
      observer.disconnect();
      structure.stop();
      map.stop();
      d.removeEventListener("keydown", onKeyDown, true);
      d.removeEventListener("beforeinput", onBeforeInput, true);
      d.removeEventListener("input", onInput, true);
      d.removeEventListener("compositionstart", onCompositionStart, true);
      d.removeEventListener("drop", onDrop, true);
      if (previous === null) body.removeAttribute("contenteditable");
      else body.setAttribute("contenteditable", previous);
      if (previousSpellcheck === null) body.removeAttribute("spellcheck");
      else body.setAttribute("spellcheck", previousSpellcheck);
      d.documentElement.removeAttribute("data-slashdocs-text-editing");
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

// undoRecord reverts one mutation record.
function undoRecord(record: MutationRecord) {
  const target = record.target;
  if (record.type === "characterData") {
    (target as CharacterData).data = record.oldValue ?? "";
  } else if (record.type === "attributes") {
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
    record.removedNodes.forEach((node) =>
      target.insertBefore(node, record.nextSibling),
    );
  }
}
