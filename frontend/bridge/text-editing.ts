// Text editing lets a reader change the words of a rendered document in
// place. Only the text of existing text nodes may change: new paragraphs,
// pasted markup and dropped content are refused. When asked, the editor
// reports each changed node as its text before and after, and the app turns
// those into exact find-and-replace edits on the document source. The DOM is
// never serialized back into HTML.

export type TextChange = { before: string; after: string };

export interface TextEditor {
  // The changed nodes, and whether anything changed other than text.
  collect(): { changes: TextChange[]; unsupported: boolean };
  stop(): void;
}

const NOT_TEXT = "script,style,noscript,template,textarea";

// Input that would change structure rather than text.
const STRUCTURAL_INPUT =
  /^(insertParagraph|insertLineBreak|insertOrderedList|insertUnorderedList|insertHorizontalRule|insertLink|insertFromDrop|deleteByDrag|format)/;

const STYLE_ID = "slashdocs-text-editing-style";

export function startTextEditing(
  d: Document,
  callbacks: {
    // The number of nodes whose text differs from the start.
    onDirty(count: number): void;
    // A structural change was refused.
    onRefused(): void;
  },
): TextEditor | null {
  const body = d.body;
  if (!body) return null;
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
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    originals.set(node as Text, (node as Text).data);
  }

  const touched = new Set<Text>();
  let unsupported = false;
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === "characterData" && originals.has(record.target as Text)) {
        touched.add(record.target as Text);
      }
      for (const node of Array.from(record.addedNodes)) {
        // Browsers add a <br> to keep an emptied block open; it is not text.
        if (node.nodeName === "BR") continue;
        if (node.nodeType === Node.TEXT_NODE && originals.has(node as Text)) continue;
        if (node.nodeType === Node.TEXT_NODE && !(node as Text).data) continue;
        unsupported = true;
      }
      for (const node of Array.from(record.removedNodes)) {
        if (node.nodeType === Node.TEXT_NODE && originals.has(node as Text)) {
          touched.add(node as Text);
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          // A removed element takes its text with it.
          const inner = d.createTreeWalker(node, NodeFilter.SHOW_TEXT);
          for (let n = inner.nextNode(); n; n = inner.nextNode()) {
            if (originals.has(n as Text)) touched.add(n as Text);
          }
        }
      }
    }
    let dirty = 0;
    for (const node of touched) if (textOf(node) !== originals.get(node)) dirty++;
    callbacks.onDirty(dirty + (unsupported ? 1 : 0));
  });
  observer.observe(body, { characterData: true, childList: true, subtree: true });

  const onBeforeInput = (event: InputEvent) => {
    if (STRUCTURAL_INPUT.test(event.inputType)) {
      event.preventDefault();
      callbacks.onRefused();
      return;
    }
    const target = event.inputType.startsWith("history") ? null : targetRange(d, event);
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
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    callbacks.onRefused();
  };
  d.addEventListener("beforeinput", onBeforeInput, true);
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
      "[data-slashdocs-text-editing] a{cursor:text!important}";
    (d.head || d.documentElement).appendChild(style);
  }

  return {
    collect() {
      const changes: TextChange[] = [];
      for (const [node, before] of originals) {
        const after = textOf(node);
        if (after === before) continue;
        // Browsers drop whitespace between elements as they edit; it was
        // never text the reader could see.
        if (!node.isConnected && !before.trim()) continue;
        changes.push({ before, after });
      }
      return { changes, unsupported };
    },
    stop() {
      observer.disconnect();
      d.removeEventListener("beforeinput", onBeforeInput, true);
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

// A node that left the document lost its text.
function textOf(node: Text): string {
  return node.isConnected ? node.data : "";
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
