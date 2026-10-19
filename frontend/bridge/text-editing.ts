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
    if (event.inputType === "insertFromPaste") {
      // Paste as plain text on one line, so pasting never adds markup.
      event.preventDefault();
      const text = event.dataTransfer?.getData("text/plain") || "";
      if (text) d.execCommand("insertText", false, text.replace(/\s*\n\s*/g, " "));
      return;
    }
    if (STRUCTURAL_INPUT.test(event.inputType)) {
      event.preventDefault();
      callbacks.onRefused();
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
