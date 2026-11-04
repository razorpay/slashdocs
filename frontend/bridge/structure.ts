// Structure is the part of the document editor that changes more than words:
// Enter, Backspace and Delete at the edges of blocks, selections across
// blocks, paste, bold, italic, links and lists. The browser does these in a
// different way in each engine, and adds markup such as styled spans, so the
// editor cancels the input and changes the DOM itself. New elements come
// only from a short allow list, and an element that continues an original
// one, such as the second half of a split paragraph, takes its source
// attributes.
//
// Bold and italic wrap text in <strong> and <em> here, not with execCommand:
// execCommand writes <b> and <i>, copies the source attribute of an element
// that it splits onto both halves, and keeps its own undo stack.

import { blockOf, placeClear, reducedMotion } from "./dom.ts";
import type { SourceMap } from "./source-map.ts";
import { SOURCE_ATTR } from "./source-pieces.ts";

// A change that the editor makes to the DOM. blocks are the blocks it
// changes: their highlights come off before run, which then reads the
// selection again, because taking highlights off rewrites text nodes.
export type Change = { blocks: Element[]; run(): void };

export interface Editor {
  d: Document;
  map: SourceMap;
  apply(change: Change): void;
  refuse(reason: string): void;
}

// The input types that structure handles, from beforeinput or a shortcut.
// ranges are the ranges that the browser says an input changes.
export type Input = {
  type: string;
  text?: string;
  html?: string;
  ranges?: StaticRange[];
};

// The reasons to refuse an input. The frame is not trusted, so the app
// shows its own text for each one.
export const REFUSED = {
  // Text that a script shows.
  script: "script",
  // A selection over content that a script shows.
  crossesScript: "crosses-script",
  drop: "drop",
  // Formatting other than bold, italic, links and lists.
  format: "format",
  // A list of blocks that are not all paragraphs.
  list: "list",
  // Structure or formatting in script text, which takes plain text only.
  plainText: "plain-text",
};

// Text that shows on the page. JavaScript's \s also matches the no-break
// space, which shows as a space.
const VISIBLE = /[^ \t\n\r\f]/;
const SPLITS = /^(p|li|h[1-6])$/;
const HEADING = /^h[1-6]$/;
const NOT_CONTENT = /^(script|style|template|noscript|textarea|title)$/;
const BRIDGE_UI =
  ".slashdocs-selection-action,.slashdocs-heading-link,.slashdocs-text-flash,.slashdocs-script-hint,.slashdocs-link-input";
const SAME_FORMAT = { strong: "strong,b", em: "em,i" };
type Format = keyof typeof SAME_FORMAT;
const SAFE_HREF = /^(https?:|mailto:|#)/i;
const LINK_HIGHLIGHT = "slashdocs-link";
const LINK_GAP = 6;
const LINK_ENTER: Keyframe[] = [
  { opacity: 0, transform: "scale(.97)" },
  { opacity: 1, transform: "none" },
];
// The link box follows the colors of the selection actions. The document's
// own styles do not reach it. The card resets without !important, which
// would stop its animation.
const LINK_STYLE = `
  .slashdocs-link-input,.slashdocs-link-input>i,.slashdocs-link-input>div *{all:initial!important}
  .slashdocs-link-input>div{all:initial;position:fixed!important;z-index:2147483647!important;display:flex!important;flex-wrap:wrap!important;gap:4px!important;max-width:calc(100vw - 16px)!important;padding:4px!important;border-radius:10px!important;background:#fff!important;color:#18181b!important;box-shadow:0 0 0 1px #0001,0 4px 16px #0002!important;font:13px/1.4 system-ui,sans-serif!important}
  .slashdocs-link-input input{box-sizing:border-box!important;width:min(280px,60vw)!important;height:40px!important;padding:0 8px!important;color:inherit!important;font:inherit!important}
  .slashdocs-link-input button{height:40px!important;padding:0 10px!important;border-radius:8px!important;color:#b91c1c!important;font:500 13px/40px system-ui,sans-serif!important;cursor:pointer!important}
  .slashdocs-link-input button:hover{background:#fef2f2!important}
  .slashdocs-link-input button:focus-visible{outline:2px solid #6366f1!important;outline-offset:-2px!important}
  .slashdocs-link-input p{flex-basis:100%!important;padding:0 8px 4px!important;color:#71717a!important;font:12px/1.4 system-ui,sans-serif!important;overflow-wrap:anywhere!important;text-wrap:pretty!important}
  .slashdocs-link-input p:empty{display:none!important}
  .slashdocs-link-input p[data-error]{color:#b91c1c!important}
  .slashdocs-link-input i{position:fixed!important;pointer-events:none!important;background:#6366f140!important}
  ::highlight(${LINK_HIGHLIGHT}){background-color:#6366f140}
  [data-slashdocs-surface=dark] .slashdocs-link-input>div{background:#27272a!important;color:#f4f4f5!important;box-shadow:0 0 0 1px #fff2,0 4px 16px #0004!important}
  [data-slashdocs-surface=dark] .slashdocs-link-input button{color:#fca5a5!important}
  [data-slashdocs-surface=dark] .slashdocs-link-input button:hover{background:#3f3f46!important}
  [data-slashdocs-surface=dark] .slashdocs-link-input p{color:#a1a1aa!important}
  [data-slashdocs-surface=dark] .slashdocs-link-input p[data-error]{color:#fca5a5!important}`;

// Pasted HTML keeps these elements. Other block elements become paragraphs,
// the content of other inline elements stays without them, and the elements
// in DROPPED go with their content.
const ALLOWED = /^(p|br|strong|b|em|i|a|ul|ol|li)$/;
const PASTED_BLOCK =
  /^(address|article|aside|blockquote|dd|div|dt|figcaption|footer|h[1-6]|header|main|nav|pre|section|tr)$/;
const DROPPED =
  /^(script|style|template|noscript|head|title|svg|math|select|textarea|iframe|object)$/;

const NOTHING: Change = { blocks: [], run() {} };
const TYPING = /^insert(Text|ReplacementText)$/;

export function createStructure(e: Editor) {
  const { d } = e;
  // The frame's window, whose highlights mark the words of a link.
  const view = d.defaultView as (Window & typeof globalThis) | null;
  let linkBox: HTMLElement | null = null;
  // Bold or italic that the reader turned on or off at a caret. They apply
  // to the next typed text while the caret stays at that place.
  let pending: { at: Range; formats: Format[] } | null = null;
  // The inline element, such as a badge or a link, whose last text the
  // reader deleted.
  let emptied: Element | null = null;

  // input gives the change for an input, a reason to refuse it, or null to
  // let the browser do it.
  function input({ type, text = "", html = "" }: Input): Change | string | null {
    if (/^(insertFromDrop|deleteByDrag)$/.test(type)) return REFUSED.drop;
    const r = selection(d);
    if (!r) return null;
    const formats = pending && sameRange(pending.at, r) ? pending.formats : [];
    pending = null;
    if (!r.collapsed && notEditableIn(e, r)) return REFUSED.crossesScript;
    if (type === "insertText" && formats.length)
      return change(r, (at) => typeFormatted(at, text, formats));
    if (type === "insertParagraph") return paragraph(r);
    if (type === "insertLineBreak") return change(r, (at) => lineBreak(at));
    if (type === "insertFromPaste" || type === "insertFromPasteAsQuotation")
      return change(r, (at) =>
        paste(at, html ? sanitize(d, html) : paragraphs(d, text)),
      );
    if (type === "formatBold") return format(r, "strong", formats);
    if (type === "formatItalic") return format(r, "em", formats);
    if (type === "insertUnorderedList") return list(r, "ul");
    if (type === "insertOrderedList") return list(r, "ol");
    if (/^(format|insertHorizontalRule|insertLink)/.test(type)) return REFUSED.format;
    if (type.startsWith("delete")) return deletion(r, type);
    // Typing over a selection across blocks joins them first, and typing
    // over a trimmed triple click replaces only the text it shows.
    if (type === "insertText" && !native(r))
      return change(r, (at) => insertText(d, at, text));
    return null;
  }

  // native tells whether the browser can change r itself: r stays in one
  // block, and the selection did not need trimming.
  function native(r: Range): boolean {
    return (
      blockOf(r.startContainer) === blockOf(r.endContainer) &&
      sameRange(r, d.getSelection()!.getRangeAt(0))
    );
  }

  // change deletes the selection, joining its end blocks, and then runs
  // edit at the caret that is left.
  function change(r: Range, edit: (caret: Range) => void): Change {
    return {
      blocks: blocksIn(d, r),
      run() {
        const at = selection(d)!;
        if (!at.collapsed) removeRange(at);
        edit(at);
      },
    };
  }

  function paragraph(r: Range): Change {
    const block = blockOf(r.startContainer);
    const list = block?.localName === "li" && empty(block) ? block.parentElement : null;
    const edit = change(r, (at) => {
      const block = blockOf(at.startContainer)!;
      if (block.closest("pre")) insertText(d, at, "\n", true);
      else if (block.localName === "li" && empty(block)) lift(block);
      else if (SPLITS.test(block.localName)) split(block, at);
      else lineBreak(at);
    });
    if (list) edit.blocks.push(list);
    return edit;
  }

  function deletion(r: Range, type: string): Change | string | null {
    const block = blockOf(r.startContainer);
    if (!block) return null;
    if (!r.collapsed) return native(r) ? null : change(r, () => {});
    const backward = type.endsWith("Backward");
    if (!atEdge(block, r, backward)) return null;
    if (backward && block.localName === "li" && !block.previousElementSibling)
      return { blocks: [block, block.parentElement!], run: () => lift(block) };
    const leaf = nearLeaf(d, block, !backward);
    if (!leaf) return NOTHING;
    if (!editable(e, leaf)) return REFUSED.crossesScript;
    const other = blockOf(leaf)!;
    const [into, from] = backward ? [other, block] : [block, other];
    return { blocks: [into, from], run: () => join(into, from) };
  }

  // keep gives the change for an input that deletes all the text of an
  // inline element, or that types next to the element that one emptied.
  // Browsers remove such an element and type the next text outside it, which
  // loses its tag and attributes. The editor keeps the element instead, and
  // types the next text in it.
  function keep({ type, text = "", ranges }: Input): Change | null {
    const typing = TYPING.test(type);
    if (!typing && !type.startsWith("delete")) return null;
    const r = typing ? selection(d) : rangeOf(ranges?.[0]);
    if (!r) return null;
    const el =
      typing &&
      r.collapsed &&
      emptied?.isConnected &&
      !emptied.textContent &&
      beside(emptied, r)
        ? emptied
        : coveredInline(r);
    if (!el) return null;
    return {
      blocks: [blockOf(el)!],
      run() {
        const t = d.createTextNode(typing ? text : "");
        el.replaceChildren(t);
        d.getSelection()!.collapse(t, t.length);
        emptied = typing ? null : el;
      },
    };
  }

  function rangeOf(target: StaticRange | undefined): Range | null {
    if (!target) return null;
    const r = d.createRange();
    r.setStart(target.startContainer, target.startOffset);
    r.setEnd(target.endContainer, target.endOffset);
    return r;
  }

  // split ends block at the caret, and puts the rest in a new element after
  // it: one like block, or a paragraph after a heading.
  function split(block: Element, at: Range) {
    const tail = d.createRange();
    tail.setStart(at.startContainer, at.startOffset);
    tail.setEnd(block, block.childNodes.length);
    const next = HEADING.test(block.localName)
      ? d.createElement("p")
      : continuation(e, block);
    next.append(extract(tail, block));
    fill(block);
    fill(next);
    block.after(next);
    d.getSelection()!.collapse(next, 0);
  }

  // lift moves a list item out of its list as a paragraph, and splits the
  // list in two when the item is in the middle. Blocks in the item, such as
  // a nested list, follow the paragraph. The second part of a numbered list
  // continues its numbers.
  function lift(li: Element) {
    const list = li.parentElement!;
    const p = d.createElement("p");
    p.append(...inlineRun(li));
    fill(p);
    const lifted = [p, ...li.childNodes];
    const rest: Node[] = [];
    for (let n = li.nextSibling; n; n = n.nextSibling) rest.push(n);
    const first = !li.previousElementSibling;
    li.remove();
    if (!rest.some((n) => n.nodeType === Node.ELEMENT_NODE)) list.after(...lifted);
    else if (first) list.before(...lifted);
    else {
      const next = continuation(e, list);
      next.append(...rest);
      if (list.localName === "ol") {
        const start = Number(list.getAttribute("start")) || 1;
        next.setAttribute("start", String(start + list.children.length));
      }
      list.after(...lifted, next);
    }
    if (!list.firstElementChild) list.remove();
    d.getSelection()!.collapse(p, 0);
  }

  // join moves the inline content of from to the end of into, or, when into
  // holds from, to just before the block that holds from. It then removes
  // what is left of from when it is empty.
  function join(into: Element, from: Element) {
    dropFiller(into);
    const anchor = [...into.childNodes].find((child) => child.contains(from)) ?? null;
    const at = anchor ? indexOf(anchor) : into.childNodes.length;
    for (const node of empty(from) ? [] : inlineRun(from))
      into.insertBefore(node, anchor);
    let el: Element | null = from;
    while (el && el !== d.body && !el.contains(into) && empty(el, true)) {
      const parent: Element | null = el.parentElement;
      el.remove();
      el = parent;
    }
    d.getSelection()!.collapse(into, at);
  }

  function removeRange(r: Range) {
    const start = blockOf(r.startContainer)!;
    const end = blockOf(r.endContainer)!;
    r.deleteContents();
    if (start !== end && end.isConnected && start.isConnected) join(start, end);
    else d.getSelection()!.collapse(r.startContainer, r.startOffset);
  }

  function lineBreak(at: Range) {
    const br = d.createElement("br");
    at.insertNode(br);
    // A line break at the end of a block shows a new line only when another
    // one follows it.
    const block = blockOf(br)!;
    const after = d.createRange();
    after.setStartAfter(br);
    after.setEnd(block, block.childNodes.length);
    if (!shows(after)) br.after(d.createElement("br"));
    d.getSelection()!.collapse(br.parentNode!, indexOf(br) + 1);
  }

  // paste puts pasted content at the caret. Inline content goes in the
  // block. Paragraphs and lists split the block: the first paragraph ends
  // it, the last one starts its rest, and the others go between.
  function paste(at: Range, content: DocumentFragment) {
    const block = blockOf(at.startContainer)!;
    const parts = blockParts(d, content);
    if (!parts.length) return;
    if (parts.length === 1 && parts[0].localName === "p") {
      insertNodes(at, [...parts[0].childNodes]);
      return;
    }
    if (!SPLITS.test(block.localName)) {
      insertNodes(at, lines(d, parts));
      return;
    }
    if (parts[0].localName === "p") insertNodes(at, [...parts.shift()!.childNodes]);
    split(block, d.getSelection()!.getRangeAt(0));
    const tail = block.nextElementSibling!;
    const last = parts.at(-1)?.localName === "p" ? [...parts.pop()!.childNodes] : [];
    const middle =
      block.localName === "li" ? parts.flatMap((part) => items(d, part)) : parts;
    block.after(...middle);
    dropFiller(tail);
    tail.prepend(...last);
    fill(tail);
    d.getSelection()!.collapse(tail, last.length);
  }

  function insertNodes(at: Range, nodes: Node[]) {
    if (!nodes.length) return;
    dropFiller(blockOf(at.startContainer)!);
    const fragment = d.createDocumentFragment();
    fragment.append(...nodes);
    at.insertNode(fragment);
    caretAfter(nodes.at(-1)!);
  }

  function caretAfter(node: Node) {
    d.getSelection()!.collapse(node.parentNode!, indexOf(node) + 1);
  }

  // format toggles bold or italic on the selection. At a caret, it toggles
  // the format of the next typed text, in addition to formats, the formats
  // that are pending there.
  function format(r: Range, tag: Format, formats: Format[]): Change {
    if (r.collapsed) {
      const others = formats.filter((f) => f !== tag);
      pending = {
        at: r,
        formats: others.length < formats.length ? others : [...formats, tag],
      };
      return NOTHING;
    }
    return {
      blocks: blocksIn(d, r),
      run() {
        const r = selection(d)!;
        const texts = textsIn(e, r);
        const within = (t: Text) => formatAround(t, tag);
        const formatted = () => texts.map(within).find(Boolean);
        if (texts.every(within)) {
          for (let el = formatted(); el; el = formatted()) unwrapAround(el, texts);
        } else {
          wrap(
            texts.filter((t) => !within(t)),
            () => d.createElement(tag),
          );
        }
        select(texts);
      },
    };
  }

  // unwrapAround takes texts out of el. The parts of el before and after
  // them stay formatted, in copies of el.
  function unwrapAround(el: Element, texts: Text[]) {
    const inside = texts.filter((t) => el.contains(t));
    const head = d.createRange();
    head.setStart(el, 0);
    head.setEndBefore(inside[0]);
    const tail = d.createRange();
    tail.setStartAfter(inside.at(-1)!);
    tail.setEnd(el, el.childNodes.length);
    for (const [range, side] of [
      [head, "before"],
      [tail, "after"],
    ] as const) {
      const content = extract(range, el);
      if (!content.textContent) continue;
      const copy = continuation(e, el);
      copy.append(content);
      el[side](copy);
    }
    el.replaceWith(...el.childNodes);
  }

  // typeFormatted types text at the caret with each of formats toggled: in a
  // new element of that format, or out of the element of that format that
  // holds the caret. The caret stays in the text, so typing continues it.
  function typeFormatted(at: Range, text: string, formats: Format[]) {
    dropFiller(blockOf(at.startContainer)!);
    const t = d.createTextNode(text);
    at.insertNode(t);
    for (const tag of formats) {
      const el = formatAround(t, tag);
      if (el) unwrapAround(el, [t]);
      else wrap([t], () => d.createElement(tag));
    }
    d.getSelection()!.collapse(t, t.length);
  }

  // wrap puts each text in a new element, and joins those that are next to
  // each other.
  function wrap(texts: Text[], make: () => Element) {
    const made = new Set<Node>();
    for (const t of texts) {
      const previous = t.previousSibling;
      if (previous && made.has(previous)) {
        previous.appendChild(t);
        continue;
      }
      const el = make();
      t.replaceWith(el);
      el.append(t);
      made.add(el);
    }
  }

  function select(texts: Text[]) {
    if (!texts.length) return;
    const last = texts.at(-1)!;
    d.getSelection()!.setBaseAndExtent(texts[0], 0, last, last.length);
  }

  function list(r: Range, tag: "ul" | "ol"): Change | string {
    const blocks = blocksIn(d, r);
    const items = blocks.every((b) => b.localName === "li");
    if (items && blocks.every((b) => b.parentElement!.localName === tag)) {
      const lists = blocks.map((b) => b.parentElement!);
      return { blocks: [...blocks, ...lists], run: () => blocks.forEach(lift) };
    }
    if (items) {
      const lists = [...new Set(blocks.map((b) => b.parentElement!))];
      return {
        blocks: [...blocks, ...lists],
        run() {
          for (const old of lists) {
            const copy = continuation(e, old, tag);
            copy.append(...old.childNodes);
            old.replaceWith(copy);
          }
        },
      };
    }
    const parent = blocks[0]?.parentElement;
    if (
      !parent ||
      !blocks.every((b) => b.localName === "p" && b.parentElement === parent)
    )
      return REFUSED.list;
    return {
      blocks,
      run() {
        const list = d.createElement(tag);
        blocks[0].before(list);
        for (const block of blocks) {
          const li = d.createElement("li");
          li.append(...block.childNodes);
          list.append(li);
          block.remove();
        }
        d.getSelection()!.selectAllChildren(list);
      },
    };
  }

  // link opens a small field for the address of a link, below the selection
  // or above it when there is no room below. The selected words stay marked
  // while the field has focus. A line under the field shows the address that
  // the link gets, or why it cannot have it. Enter applies the address, and
  // Esc or leaving the box cancels. In a link, the field shows its address
  // and a button removes the link.
  function link() {
    const r = selection(d);
    if (!r) return;
    if (notEditableIn(e, r) || !editable(e, r.startContainer)) {
      e.refuse(REFUSED.crossesScript);
      return;
    }
    closeLink();
    const a = linkAround(r);
    // At a caret in a link, the field is for the whole link.
    const words = r.collapsed && a ? d.createRange() : r;
    if (words !== r) words.selectNodeContents(a!);
    // The box is outside the body, so the editor does not see it change.
    const box = d.createElement("div");
    box.className = "slashdocs-link-input";
    box.setAttribute("contenteditable", "false");
    const style = d.createElement("style");
    style.textContent = LINK_STYLE;
    const card = d.createElement("div");
    const field = d.createElement("input");
    field.type = "url";
    field.placeholder = "Paste a link, then press Enter";
    field.setAttribute("aria-label", "Link address");
    field.value = a?.getAttribute("href") ?? "";
    const note = d.createElement("p");
    note.setAttribute("aria-live", "polite");
    card.append(field);
    if (a) {
      const remove = d.createElement("button");
      remove.type = "button";
      remove.textContent = "Remove link";
      // The field keeps the focus, so that a click does not cancel.
      remove.addEventListener("mousedown", (event) => event.preventDefault());
      remove.addEventListener("click", () => close(""));
      card.append(remove);
    }
    card.append(note);
    box.append(style, card);
    d.documentElement.append(box);
    linkBox = box;
    mark(words, box);
    place(card, words);
    motion(card, LINK_ENTER, 150);
    field.focus();
    const close = (href: string | null) => {
      closeLink();
      d.body.focus();
      d.getSelection()!.removeAllRanges();
      d.getSelection()!.addRange(r);
      if (href !== null) e.apply(linkChange(r, href));
    };
    // The note shows an address that differs from the typed one. After an
    // Enter that the field refuses, it shows why, until the address is good.
    let refused = false;
    const check = () => {
      const target = linkTarget(field.value);
      const error = refused && "error" in target ? target.error : "";
      const preview =
        "href" in target && target.href !== field.value.trim()
          ? `Links to ${target.href}`
          : "";
      note.toggleAttribute("data-error", !!error);
      note.textContent = error || preview;
      return target;
    };
    field.addEventListener("input", check);
    // The card can grow a line for the note, so it finds a clear place again.
    if (view?.ResizeObserver)
      new view.ResizeObserver(() => place(card, words)).observe(card);
    card.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" && event.target === field) {
        refused = true;
        const target = check();
        if ("href" in target) close(target.href);
      } else if (event.key === "Escape") close(null);
      else return;
      event.preventDefault();
    });
    card.addEventListener("focusout", (event) => {
      if (linkBox === box && !card.contains(event.relatedTarget as Node | null))
        close(null);
    });
  }

  // mark keeps the words of a link marked while its field has focus, with no
  // change to the document: with the Custom Highlight API, or else with boxes
  // over the words in the link box.
  function mark(words: Range, box: Element) {
    if (view?.CSS?.highlights) {
      view.CSS.highlights.set(LINK_HIGHLIGHT, new view.Highlight(words));
      return;
    }
    for (const rect of words.getClientRects?.() ?? []) {
      const over = d.createElement("i");
      over.style.cssText = `left:${rect.left}px!important;top:${rect.top}px!important;width:${rect.width}px!important;height:${rect.height}px!important`;
      box.append(over);
    }
  }

  // motion plays keyframes on el, unless the reader asks for less motion.
  // jsdom has no animations.
  function motion(el: Element, keyframes: Keyframe[], duration: number) {
    if (!el.animate || reducedMotion(d)) return null;
    return el.animate(keyframes, { duration, easing: "ease-out", fill: "forwards" });
  }

  // place puts card where it covers no text: below the last line of words,
  // else above the first line, else where placeClear finds room.
  function place(card: HTMLElement, words: Range) {
    // jsdom has no layout, and so no rectangles for ranges.
    const lines = [...(words.getClientRects?.() ?? [])];
    if (!lines.length) return;
    const [first, last] = [lines[0], lines.at(-1)!];
    placeClear(d, card, lines, [
      [last.left, last.bottom + LINK_GAP],
      [first.left, first.top - LINK_GAP - card.offsetHeight],
    ]);
  }

  function closeLink() {
    const box = linkBox;
    linkBox = null;
    view?.CSS?.highlights?.delete(LINK_HIGHLIGHT);
    if (!box) return;
    const exit = motion(box.querySelector("div")!, [...LINK_ENTER].reverse(), 120);
    if (exit) exit.onfinish = () => box.remove();
    else box.remove();
  }

  // linkChange links the selection to href: it changes the address of a
  // link around it, or takes the link off for an empty href.
  function linkChange(r: Range, href: string): Change {
    return {
      blocks: blocksIn(d, r),
      run() {
        const r = selection(d)!;
        const a = linkAround(r);
        const make = () => {
          const el = a ? continuation(e, a) : d.createElement("a");
          el.setAttribute("href", href);
          return el;
        };
        // The caret goes after a new or changed link, so that the next keys
        // do not type over its words.
        if (a && !href) a.replaceWith(...a.childNodes);
        else if (a) {
          const el = make();
          el.append(...a.childNodes);
          a.replaceWith(el);
          caretAfter(el);
        } else if (href && r.collapsed) {
          const el = make();
          el.textContent = href;
          insertNodes(r, [el]);
        } else if (href) {
          const texts = textsIn(e, r);
          wrap(texts, make);
          if (texts.length) caretAfter(texts.at(-1)!.parentNode!);
        }
      },
    };
  }

  function linkAround(r: Range): Element | null {
    const a = elementOf(r.startContainer)?.closest("a[href]");
    return a && a.contains(r.endContainer) ? a : null;
  }

  // extract takes the content of range out of the DOM. An element that the
  // range only partly holds comes back as a copy, which continues the
  // element that stays in container. Only the element that stays keeps its
  // source position.
  function extract(range: Range, container: Element): DocumentFragment {
    const content = range.extractContents();
    content.querySelectorAll(`[${SOURCE_ATTR}]`).forEach((copy) => {
      const at = copy.getAttribute(SOURCE_ATTR);
      const original = container.querySelector(`[${SOURCE_ATTR}="${at}"]`);
      if (!original) return;
      const next = continuation(e, original);
      next.append(...copy.childNodes);
      copy.replaceWith(next);
    });
    return content;
  }

  // plain types text in place of the selection, as one change that is not
  // part of any block, for script text.
  function plain(text: string): Change {
    return {
      blocks: [],
      run() {
        const at = selection(d)!;
        at.deleteContents();
        insertText(d, at, text);
      },
    };
  }

  return { input, keep, link, plain, stop: closeLink };
}

// selection gives the selected range. A triple click selects up to the start
// of the next block. The range then ends where the text it shows ends, so
// that the next block keeps its text.
export function selection(d: Document): Range | null {
  const s = d.getSelection();
  if (!s?.rangeCount) return null;
  const r = s.getRangeAt(0).cloneRange();
  const end = blockOf(r.endContainer);
  if (
    !r.collapsed &&
    end &&
    end !== blockOf(r.startContainer) &&
    atEdge(end, r, true, true)
  ) {
    const leaf = nearLeaf(d, end, false);
    if (leaf?.nodeType === Node.TEXT_NODE) r.setEnd(leaf, (leaf as Text).length);
    else if (leaf) r.setEndAfter(leaf);
  }
  return r;
}

// coveredInline gives the innermost inline element in a block whose text r
// covers all of.
function coveredInline(r: Range): Element | null {
  if (r.collapsed) return null;
  const block = blockOf(r.startContainer);
  for (
    let el = elementOf(r.commonAncestorContainer);
    el && el !== block && block?.contains(el);
    el = el.parentElement
  ) {
    if (!el.querySelector("br,img") && !textOutside(r, el)) return el;
  }
  return null;
}

// textOutside tells whether el holds text before or after r.
function textOutside(r: Range, el: Element): boolean {
  const rest = el.ownerDocument.createRange();
  rest.selectNodeContents(el);
  rest.setEnd(r.startContainer, r.startOffset);
  if (rest.toString()) return true;
  rest.selectNodeContents(el);
  rest.setStart(r.endContainer, r.endOffset);
  return !!rest.toString();
}

// beside tells whether the caret of r is in el, or next to it with nothing
// that shows between them.
function beside(el: Element, r: Range): boolean {
  if (el.contains(r.startContainer)) return true;
  const gap = el.ownerDocument.createRange();
  gap.selectNode(el);
  if (r.compareBoundaryPoints(Range.START_TO_START, gap) < 0)
    gap.setStart(r.startContainer, r.startOffset);
  else gap.setEnd(r.startContainer, r.startOffset);
  return blockOf(el) === blockOf(r.startContainer) && !shows(gap);
}

function sameRange(a: Range, b: Range): boolean {
  return (
    a.startContainer === b.startContainer &&
    a.startOffset === b.startOffset &&
    a.endContainer === b.endContainer &&
    a.endOffset === b.endOffset
  );
}

export function elementOf(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

// formatAround gives the element of a format that holds node in its block.
function formatAround(node: Node, tag: Format): Element | null {
  const el = elementOf(node)?.closest(SAME_FORMAT[tag]);
  return el && blockOf(node)!.contains(el) ? el : null;
}

// editable tells whether the editor may change node as HTML: it is not in
// content that a script makes or owns, nor in content set not editable.
export function editable(e: Editor, node: Node): boolean {
  return hostEditable(node) && !e.map.scriptOwned(node);
}

function bridgeUI(node: Node): boolean {
  return !!elementOf(node)?.closest(BRIDGE_UI);
}

// walk visits the text and elements under root, without the bridge's own
// controls and elements whose text is not content.
function walk(d: Document, root: Node): TreeWalker {
  return d.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.nodeType === Node.ELEMENT_NODE &&
      (NOT_CONTENT.test((node as Element).localName) ||
        (node as Element).matches(BRIDGE_UI))
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
}

function rootOf(r: Range): Node {
  const root = r.commonAncestorContainer;
  return root.nodeType === Node.TEXT_NODE ? root.parentNode! : root;
}

// notEditableIn tells whether r holds content that the editor may not
// change. Inside the range, the source map's contenteditable="false" marks
// are enough, and much faster to read for a long selection.
function notEditableIn(e: Editor, r: Range): boolean {
  if (![r.startContainer, r.endContainer].every((n) => bridgeUI(n) || editable(e, n)))
    return true;
  const walker = walk(e.d, rootOf(r));
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (r.intersectsNode(n) && !hostEditable(n)) return true;
  }
  return false;
}

function hostEditable(node: Node): boolean {
  const host = elementOf(node)?.closest("[contenteditable]");
  return !!host && host.getAttribute("contenteditable") !== "false";
}

// blocksIn gives the blocks that a range shows text of, in order.
function blocksIn(d: Document, r: Range): Element[] {
  const blocks = new Set([blockOf(r.startContainer)]);
  const walker = walk(d, rootOf(r));
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (isLeaf(n) && r.intersectsNode(n)) blocks.add(blockOf(n));
  }
  blocks.add(blockOf(r.endContainer));
  blocks.delete(null);
  return [...blocks] as Element[];
}

// textsIn splits the text nodes at the edges of a range, and gives the
// editable text nodes in it that show text.
function textsIn(e: Editor, r: Range): Text[] {
  const { startContainer, startOffset, endContainer, endOffset } = r;
  const texts: Text[] = [];
  const walker = walk(e.d, rootOf(r));
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE && r.intersectsNode(n)) texts.push(n as Text);
  }
  return texts
    .map((t) => {
      if (t === endContainer && endOffset < t.length) t.splitText(endOffset);
      return t === startContainer && startOffset > 0 ? t.splitText(startOffset) : t;
    })
    .filter((t) => VISIBLE.test(t.data) && editable(e, t));
}

// A leaf shows something: text, a line break or an image.
function isLeaf(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return VISIBLE.test((node as Text).data);
  return /^(br|img)$/.test((node as Element).localName);
}

// nearLeaf finds the first leaf before or after block, outside it.
function nearLeaf(d: Document, block: Element, forward: boolean): Node | null {
  const walker = walk(d, d.body);
  walker.currentNode = block;
  for (let n = forward ? walker.nextNode() : walker.previousNode(); n;) {
    if (!block.contains(n) && isLeaf(n)) return n;
    n = forward ? walker.nextNode() : walker.previousNode();
  }
  return null;
}

// atEdge tells whether the start (or the end) of r is at the start (or the
// end) of what block shows. A line break at the end of a block shows nothing.
function atEdge(block: Element, r: Range, start: boolean, ofEnd = false): boolean {
  const probe = block.ownerDocument.createRange();
  probe.selectNodeContents(block);
  const [node, offset] = ofEnd
    ? [r.endContainer, r.endOffset]
    : [r.startContainer, r.startOffset];
  if (start) probe.setEnd(node, offset);
  else probe.setStart(node, offset);
  if (VISIBLE.test(probe.toString())) return false;
  return !probe.cloneContents().querySelector(start ? "br,img" : "img");
}

function shows(r: Range): boolean {
  return VISIBLE.test(r.toString()) || !!r.cloneContents().querySelector("br,img");
}

// empty tells whether el shows nothing, or holds nothing at all.
function empty(el: Element, nothing = false): boolean {
  if (nothing) return !el.firstElementChild && !VISIBLE.test(el.textContent ?? "");
  return !VISIBLE.test(el.textContent ?? "") && !el.querySelector("img,ul,ol");
}

// An empty block holds a line break, so that it keeps a line for the caret.
function fill(block: Element) {
  if (!VISIBLE.test(block.textContent ?? "") && !block.querySelector("br,img"))
    block.append(block.ownerDocument.createElement("br"));
}

function dropFiller(block: Element) {
  const only = block.children.length === 1 ? block.firstElementChild : null;
  if (only?.localName === "br" && !VISIBLE.test(block.textContent ?? "")) only.remove();
}

// inlineRun gives the children of el up to its first block child.
function inlineRun(el: Element): Node[] {
  const run: Node[] = [];
  for (const child of el.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE && blockOf(child) === child) break;
    run.push(child);
  }
  return run;
}

function indexOf(node: Node): number {
  return Array.prototype.indexOf.call(node.parentNode!.childNodes, node);
}

// continuation makes a new element that continues el, with el's source
// attributes, or the attributes of an element the editor made.
function continuation(e: Editor, el: Element, tag = el.localName): Element {
  const copy = e.d.createElement(tag);
  const attributes =
    e.map.offsetOf(el) === null
      ? [...el.attributes]
          .filter(
            (a) => !/^(id|contenteditable|spellcheck|data-slashdocs-.*)$/.test(a.name),
          )
          .map((a): [string, string] => [a.name, a.value])
      : e.map.attributesOf(el);
  for (const [name, value] of attributes) copy.setAttribute(name, value);
  return copy;
}

function insertText(d: Document, at: Range, text: string, preformatted = false) {
  const block = blockOf(at.startContainer);
  if (block) dropFiller(block);
  // A new line at the end of preformatted text shows only when text follows.
  const after = d.createRange();
  after.setStart(at.startContainer, at.startOffset);
  if (block) after.setEnd(block, block.childNodes.length);
  const filler = preformatted && !VISIBLE.test(after.toString()) ? text : "";
  const node =
    at.startContainer.nodeType === Node.TEXT_NODE
      ? (at.startContainer as Text)
      : d.createTextNode("");
  const offset = node === at.startContainer ? at.startOffset : 0;
  if (node !== at.startContainer) at.insertNode(node);
  node.insertData(offset, text + filler);
  d.getSelection()!.collapse(node, offset + text.length);
}

// linkTarget gives the address that a typed link gets, or why it cannot have
// one. A web address needs a host with a dot, an IP address or localhost.
function linkTarget(value: string): { href: string } | { error: string } {
  let href = value.trim();
  if (!href) return { href };
  // A port, as in localhost:3000, is not a scheme.
  if (!/^[a-z][a-z\d+.-]*:(?!\d)/i.test(href) && !href.startsWith("#"))
    href = (/^[^/]+@[^/]+$/.test(href) ? "mailto:" : "https://") + href;
  if (!SAFE_HREF.test(href))
    return { error: "A link must start with http, https, mailto or #." };
  if (
    /\s/.test(href) ||
    (/^https?:/i.test(href) && !/[.:]|^localhost$/.test(hostOf(href)))
  )
    return { error: "This is not a link." };
  return { href };
}

function hostOf(href: string): string {
  try {
    return new URL(href).hostname;
  } catch {
    return "";
  }
}

// paragraphs turns pasted plain text into paragraphs at blank lines, with
// line breaks at single new lines.
function paragraphs(d: Document, text: string): DocumentFragment {
  const fragment = d.createDocumentFragment();
  for (const block of text.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n\s*/)) {
    if (!block.trim()) continue;
    const p = d.createElement("p");
    block
      .replace(/^\n+|\n+$/g, "")
      .split("\n")
      .forEach((line, i) => {
        if (i) p.append(d.createElement("br"));
        p.append(line);
      });
    fragment.append(p);
  }
  return fragment;
}

// sanitize keeps the allowed elements of pasted HTML, and of their
// attributes only a safe href.
export function sanitize(d: Document, html: string): DocumentFragment {
  const parsed = new d.defaultView!.DOMParser().parseFromString(html, "text/html");
  const fragment = d.createDocumentFragment();
  clean(d, parsed.body, fragment);
  // A paragraph cannot hold blocks: it gives way to its content.
  fragment.querySelectorAll("p").forEach((p) => {
    if (p.querySelector("p,ul,ol,li")) p.replaceWith(...p.childNodes);
  });
  return fragment;
}

function clean(d: Document, from: Node, into: Node) {
  for (const node of from.childNodes) {
    if (node.nodeType === Node.TEXT_NODE)
      into.appendChild(d.createTextNode((node as Text).data));
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const tag = (node as Element).localName;
    if (DROPPED.test(tag)) continue;
    const href = (node as Element).getAttribute("href")?.trim() ?? "";
    // A link with an address that is not safe keeps only its text.
    const kept =
      tag === "a" && !SAFE_HREF.test(href) ? null : ALLOWED.test(tag) ? tag : null;
    const name = kept ?? (PASTED_BLOCK.test(tag) ? "p" : null);
    if (!name) {
      clean(d, node, into);
      continue;
    }
    const copy = d.createElement(name);
    if (name === "a") copy.setAttribute("href", href);
    clean(d, node, copy);
    into.appendChild(copy);
  }
}

// blockParts gives pasted content as blocks: paragraphs and lists. Inline
// content between them becomes a paragraph, and an item outside a list too.
function blockParts(d: Document, content: DocumentFragment): Element[] {
  const parts: Element[] = [];
  let p: Element | null = null;
  for (const node of [...content.childNodes]) {
    const tag = node.nodeType === Node.ELEMENT_NODE ? (node as Element).localName : "";
    if (/^(p|ul|ol)$/.test(tag)) {
      parts.push(node as Element);
      p = null;
    } else if (tag === "li") {
      const item = d.createElement("p");
      item.append(...node.childNodes);
      parts.push(item);
      p = null;
    } else if (p || VISIBLE.test(node.textContent ?? "") || tag === "br") {
      if (!p) parts.push((p = d.createElement("p")));
      p.append(node);
    }
  }
  return parts;
}

// lines flattens blocks into lines of one block, with line breaks between.
function lines(d: Document, parts: Element[]): Node[] {
  return parts
    .flatMap((part) => (part.localName === "p" ? [part] : [...part.children]))
    .flatMap((part, i) => [...(i ? [d.createElement("br")] : []), ...part.childNodes]);
}

// items turns a pasted block into list items for a list that it goes in.
function items(d: Document, part: Element): Element[] {
  if (part.localName !== "p") return [...part.children];
  const li = d.createElement("li");
  li.append(...part.childNodes);
  return [li];
}
