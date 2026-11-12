// Text editing lets an editor change the words of a rendered document in
// place, at any time. Only text may change: new paragraphs, pasted markup and
// dropped content are refused. The editor tracks a burst of typing from its
// first input; taking the burst reports each text node of the source as its
// text before and after, and the app turns those into exact find-and-replace
// edits on the document source. The DOM is never serialized back into HTML.
// Only the blocks that the editor's own input reached count: the document's
// scripts may change other text, such as a clock, while the editor types.

export type TextChange = { before: string; after: string };
export type TextChanges = { changes: TextChange[]; unsupported: boolean };

export interface TextEditor {
  // The changed nodes since the burst started, and whether anything changed
  // other than text. Taking them ends the burst: the next input starts one.
  take(): TextChanges;
  stop(): void;
}

// Elements whose text is not document text: code, and the bridge's own
// controls that it adds to the document.
const NOT_TEXT =
  "script,style,noscript,template,textarea,.slashdocs-selection-action,.slashdocs-text-flash";

// Input that would change structure rather than text.
const STRUCTURAL_INPUT =
  /^(insertParagraph|insertLineBreak|insertOrderedList|insertUnorderedList|insertHorizontalRule|insertLink|insertFromDrop|deleteByDrag|format)/;

// Keys that only move the caret, select or open menus.
const NO_INPUT_KEY =
  /^(Arrow|Page|Home$|End$|Shift$|Control$|Alt$|Meta$|Escape$|Tab$|CapsLock$|F\d)/;

const STYLE_ID = "slashdocs-text-editing-style";

export function startTextEditing(
  d: Document,
  callbacks: {
    // A burst starts: anything that splits text nodes, such as comment
    // highlights, must come off first.
    beforeBurst(): void;
    // The number of nodes whose text differs from the start of the burst.
    onDirty(count: number): void;
    // A structural change was refused.
    onRefused(): void;
  },
): TextEditor | null {
  const body = d.body;
  if (!body) return null;
  let burst: Burst | null = null;
  const begin = () => {
    if (burst) return;
    callbacks.beforeBurst();
    burst = trackBurst(d, body, callbacks.onDirty);
  };

  // touch marks the block of node, or else of the caret, as one the editor
  // changes, when the editor and not a script made the input.
  const touch = (event: Event, node?: Node | null) => {
    node ??= d.getSelection()?.focusNode;
    if (event.isTrusted && node) burst?.touch(node);
  };

  // A burst starts before the browser changes anything: on a key that can
  // type, on paste or cut, or, for input with no key such as a spelling
  // fix, on the input itself.
  const onKeyDown = (event: KeyboardEvent) => {
    const shortcut = event.metaKey || event.ctrlKey;
    if (shortcut ? /^[vxyz]$/i.test(event.key) : !NO_INPUT_KEY.test(event.key)) {
      begin();
    }
  };
  const onBeforeInput = (event: InputEvent) => {
    if (STRUCTURAL_INPUT.test(event.inputType)) {
      event.preventDefault();
      callbacks.onRefused();
      return;
    }
    begin();
    const target = event.inputType.startsWith("history") ? null : targetRange(d, event);
    touch(event, target?.startContainer);
    if (target) {
      const text = trimToText(d, target);
      // Backspace at the start of a block, a selection over two paragraphs or
      // select-all would merge or remove blocks rather than change words.
      const edges = text || target;
      if (blockOf(edges.startContainer) !== blockOf(edges.endContainer)) {
        event.preventDefault();
        callbacks.onRefused();
        return;
      }
      // A triple click selects up to the start of the next block; typing over
      // it would pull that block in. Keep the selection to the text it shows.
      if (text && !sameRange(text, target)) {
        event.preventDefault();
        const selection = d.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(text);
        const data = event.inputType.startsWith("delete")
          ? ""
          : (event.data ?? event.dataTransfer?.getData("text/plain") ?? "");
        if (data) insertPlainText(d, data);
        else d.execCommand("delete");
        return;
      }
    }
    if (event.inputType === "insertFromPaste") {
      // Paste as plain text on one line, so pasting never adds markup.
      event.preventDefault();
      insertPlainText(d, event.dataTransfer?.getData("text/plain") || "");
    }
  };
  // Undo and redo change text where they put the caret.
  const onInput = (event: Event) => touch(event);
  const onPasteOrCut = () => begin();
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    callbacks.onRefused();
  };
  d.addEventListener("keydown", onKeyDown, true);
  d.addEventListener("paste", onPasteOrCut, true);
  d.addEventListener("cut", onPasteOrCut, true);
  d.addEventListener("compositionstart", begin, true);
  d.addEventListener("beforeinput", onBeforeInput, true);
  d.addEventListener("input", onInput, true);
  d.addEventListener("drop", onDrop, true);

  const previous = body.getAttribute("contenteditable");
  const previousSpellcheck = body.getAttribute("spellcheck");
  body.setAttribute("contenteditable", "true");
  body.setAttribute("spellcheck", "true");
  d.documentElement.setAttribute("data-slashdocs-text-editing", "");
  if (!d.getElementById(STYLE_ID)) {
    const style = d.createElement("style");
    style.id = STYLE_ID;
    style.textContent =
      "[data-slashdocs-text-editing] body{outline:none!important;caret-color:auto}" +
      "[data-slashdocs-text-editing] a{cursor:text!important}" +
      // The bridge's copy-link button sits inside each heading; hidden, the
      // caret cannot land in it and typed text stays in the heading's text.
      "[data-slashdocs-text-editing] .slashdocs-heading-link{display:none!important}";
    (d.head || d.documentElement).appendChild(style);
  }

  const take = (): TextChanges => {
    const changes = burst?.diff() || { changes: [], unsupported: false };
    burst?.stop();
    burst = null;
    return changes;
  };
  return {
    take,
    stop() {
      take();
      d.removeEventListener("keydown", onKeyDown, true);
      d.removeEventListener("paste", onPasteOrCut, true);
      d.removeEventListener("cut", onPasteOrCut, true);
      d.removeEventListener("compositionstart", begin, true);
      d.removeEventListener("beforeinput", onBeforeInput, true);
      d.removeEventListener("input", onInput, true);
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

type Burst = { diff(): TextChanges; touch(node: Node): void; stop(): void };

// trackBurst records the text of every node of body and watches the changes
// to the blocks that the editor touches.
function trackBurst(
  d: Document,
  body: HTMLElement,
  onDirty: (count: number) => void,
): Burst {
  // Removing highlights leaves the text they split in pieces; join them so
  // each node is one run of the source again.
  body.normalize();
  const originals = new Map<Text, string>();
  const walker = d.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(NOT_TEXT)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const parents = new Map<Text, Node | null>();
  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    originals.set(node, node.data);
    parents.set(node, node.parentNode);
  }

  // The blocks the editor touched, and the source nodes in them when they
  // were first touched, before the browser changed them.
  const blocks = new Set<Element>();
  const touched = new Set<Text>();
  const touch = (node: Node) => {
    const block = blockOf(node);
    if (!block || blocks.has(block)) return;
    blocks.add(block);
    const nodes = d.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let n = nodes.nextNode(); n; n = nodes.nextNode()) {
      if (originals.has(n as Text)) touched.add(n as Text);
    }
  };
  const inBlocks = (node: Node) => [...blocks].some((block) => block.contains(node));

  // Nodes the browser added while editing. Replacing all of a node's text
  // makes Chrome drop the node and type into a new one, so new text is
  // attributed to the original it replaced or sits next to; only added
  // elements are structure.
  const addedText = new Set<Text>();
  const addedElements = new Set<Element>();
  const observer = new MutationObserver((records) => {
    if (!records.some((record) => inBlocks(record.target))) return;
    for (const record of records) {
      for (const node of Array.from(record.addedNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          if (!originals.has(node as Text)) addedText.add(node as Text);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (!(node as Element).matches(NOT_TEXT)) addedElements.add(node as Element);
        }
      }
    }
    const { changes, unsupported } = diff();
    onDirty(changes.length + (unsupported ? 1 : 0));
  });

  // filler is markup the browser adds that the source never had: a <br>
  // keeping an emptied block open, or an empty text node.
  const filler = (node: Node) =>
    (node.nodeName === "BR" && addedElements.has(node as Element)) ||
    (node.nodeType === Node.TEXT_NODE && !(node as Text).data);
  const isAdded = (node: Node | null): node is Text =>
    !!node && addedText.has(node as Text) && !!(node as Text).data;

  function diff(): TextChanges {
    const claimed = new Set<Text>();
    // The added text nodes around node on one side, up to the first node that
    // came from the source.
    const run = (node: Node, forward: boolean) => {
      let text = "";
      for (
        let n = forward ? node.nextSibling : node.previousSibling;
        n && (filler(n) || isAdded(n));
        n = forward ? n.nextSibling : n.previousSibling
      ) {
        if (!isAdded(n) || claimed.has(n)) continue;
        claimed.add(n);
        text = forward ? text + n.data : n.data + text;
      }
      return text;
    };
    const changes: TextChange[] = [];
    for (const node of touched) {
      const before = originals.get(node)!;
      let after: string;
      if (node.isConnected) {
        after = run(node, false) + node.data + run(node, true);
      } else {
        // The node is gone: take the new text typed where it was.
        const parent = parents.get(node);
        const first = parent?.isConnected
          ? Array.from(parent.childNodes).find(
              (n): n is Text => isAdded(n) && !claimed.has(n),
            )
          : undefined;
        if (first) claimed.add(first);
        after = first ? first.data + run(first, true) : "";
        // Browsers drop whitespace between elements as they edit; it was
        // never text the reader could see.
        if (!after && !before.trim()) continue;
      }
      if (after !== before) changes.push({ before, after });
    }
    const unsupported =
      Array.from(addedElements).some(
        (el) => el.isConnected && inBlocks(el) && !filler(el),
      ) ||
      Array.from(addedText).some(
        (n) => n.isConnected && n.data && !claimed.has(n) && inBlocks(n),
      );
    return { changes, unsupported };
  }
  observer.observe(body, { characterData: true, childList: true, subtree: true });
  onDirty(0);
  return { diff, touch, stop: () => observer.disconnect() };
}

function insertPlainText(d: Document, text: string) {
  if (text) d.execCommand("insertText", false, text.replace(/\s*\n\s*/g, " "));
}

// The range the input will change: the browser's target range, or the
// selection when it does not report one.
function targetRange(d: Document, event: InputEvent): Range | null {
  const target = event.getTargetRanges?.()[0];
  if (target) {
    const range = d.createRange();
    range.setStart(target.startContainer, target.startOffset);
    range.setEnd(target.endContainer, target.endOffset);
    return range;
  }
  const selection = d.getSelection();
  return selection && selection.rangeCount ? selection.getRangeAt(0) : null;
}

// trimToText narrows a range to the first and last words it covers, dropping
// block boundaries and whitespace at its edges. It returns a collapsed range
// as it is, and null when the range covers no words.
function trimToText(d: Document, range: Range): Range | null {
  if (range.collapsed) return range;
  const root =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode!
      : range.commonAncestorContainer;
  const walker = d.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let first: { node: Text; offset: number } | null = null;
  let last: { node: Text; offset: number } | null = null;
  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    if (!range.intersectsNode(node)) continue;
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.data.length;
    // Whitespace between blocks is source formatting, not words.
    if (!node.data.slice(start, end).trim()) continue;
    first ??= { node, offset: start };
    last = { node, offset: end };
  }
  if (!first || !last) return null;
  const text = d.createRange();
  text.setStart(first.node, first.offset);
  text.setEnd(last.node, last.offset);
  return text;
}

function sameRange(a: Range, b: Range): boolean {
  return (
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  );
}

// The nearest ancestor laid out as a block, such as a paragraph or list item.
function blockOf(node: Node): Element | null {
  let element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  const view = node.ownerDocument?.defaultView;
  while (element && view) {
    if (!view.getComputedStyle(element).display.startsWith("inline")) return element;
    element = element.parentElement;
  }
  return element;
}
