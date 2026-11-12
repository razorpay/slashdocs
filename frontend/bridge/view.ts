// The view of a reader must stay as it is when other people change the
// document. A change above the view moves the text that the reader reads,
// so the scroll moves with it and that text stays in its place. What then
// still changes in the view is what the reader sees change: text that is new
// or different, and text that moved. Its share of the view tells whether a
// change can go in under the eyes of the reader.

import { snapToWords } from "./anchoring/word-range.ts";
import { blockOf, BLOCKS, scrollerOf } from "./dom.ts";

// The blocks of a document. A div is one when it holds text.
const BLOCK = `${BLOCKS},div,img`;
// At most this many blocks of the view are measured.
const MOST = 400;
// A block that is at most this share of the height of the view from its
// place did not move for the reader: one more line in a paragraph before it
// moves it that far.
const MOVED_SHARE = 0.1;
// A change is quiet for the reader when less than this share of the height
// of the view changes or moves: about four lines of a page of text.
export const QUIET_SHARE = 0.12;

// A text that is shorter than this is a number or a label, not text that a
// reader is in the middle of.
const READ_LENGTH = 20;

// A block of the view before a change: its box, the height of its part in
// the view, its text, and its image when it is one.
type Seen = {
  el: Element;
  box: DOMRect;
  height: number;
  text: string;
  src: string | null;
};

// The words of a text, without the marks around them: "notes." and "notes"
// are one word.
const wordsOf = (text: string) => text.match(/[\p{L}\p{N}]+/gu) ?? [];

// rewritten tells whether a text is mostly another text now: more than half
// of the words of the longer text are not in the other one. A word counts
// as often as it is there.
function rewritten(old: string, text: string): boolean {
  if (Math.max(old.length, text.length) < READ_LENGTH) return false;
  const [more, fewer] = [wordsOf(old), wordsOf(text)].sort(
    (a, b) => b.length - a.length,
  );
  const left = new Map<string, number>();
  for (const word of fewer) left.set(word, (left.get(word) ?? 0) + 1);
  let other = 0;
  for (const word of more) {
    const count = left.get(word) ?? 0;
    if (count) left.set(word, count - 1);
    else other++;
  }
  return other * 2 > more.length;
}

// watchView measures the view before a change. settle, after the change,
// keeps the first block of the view that the change left as it is in its
// place, and gives the share of the view that changed or moved all the
// same. A block in an element that stays in the view when the page scrolls,
// such as a sticky header, is not the one that it keeps in its place. The
// scroll is that of the element that scrolls the block, which can be an
// element in the page. The share is all of the view when the change
// rewrote or removed a block of it, because the reader reads that text. A
// block that is no longer in its place, that lost all its text, or that
// shows another image counts with all of its height. A block that lost
// lines in the view counts their height. changed are the ranges of the new
// content, and a collapsed range is a place where content went. restore
// puts the scroll back, for a change that was taken out again.
export function watchView(d: Document): {
  settle(changed: Range[]): number;
  restore(): void;
} {
  const view = d.defaultView;
  const height = view?.innerHeight ?? 0;
  // The part of a box that is in the view.
  const inView = (box: DOMRect) =>
    Math.max(0, Math.min(box.bottom, height) - Math.max(box.top, 0));
  const blocks = innermost(d.body);
  const seen: Seen[] = [];
  for (let i = firstInView(blocks); i < blocks.length && seen.length < MOST; i++) {
    const el = blocks[i];
    const box = el.getBoundingClientRect();
    if (box.top >= height) break;
    if (!box.height || !inView(box)) continue;
    const text = el.textContent ?? "";
    if (el.localName !== "div" || text.trim())
      seen.push({
        el,
        box,
        height: inView(box),
        text,
        src: el.getAttribute("src"),
      });
  }
  let restore = () => {};
  return {
    settle(changed) {
      if (!view || !height) return 0;
      const touched = (el: Element) => changed.some((r) => r.intersectsNode(el));
      const pinned = (el: Element | null): boolean =>
        !!el &&
        (/^(fixed|sticky)$/.test(view.getComputedStyle(el).position) ||
          pinned(el.parentElement));
      const anchor = seen.find(
        ({ el }) => el.isConnected && !touched(el) && !pinned(el),
      );
      if (anchor) {
        const scroller = scrollerOf(anchor.el, true);
        const top = scroller.scrollTop;
        const scroll = (by: number) =>
          scroller.scrollBy({ top: by, behavior: "instant" });
        scroll(anchor.el.getBoundingClientRect().top - anchor.box.top);
        restore = () => scroller.scrollTo({ top, behavior: "instant" });
        // An image of the new content that loads later gets its height then.
        // When it is above the anchor, the scroll moves by that height once.
        for (const img of loading(changed)) {
          const was = img.getBoundingClientRect().height;
          const onLoad = () => {
            const box = img.getBoundingClientRect();
            const above = box.top < anchor.el.getBoundingClientRect().top;
            if (img.isConnected && anchor.el.isConnected && above)
              scroll(box.height - was);
          };
          img.addEventListener("load", onLoad, { once: true });
        }
      }
      const now = (el: Element) => (el.isConnected ? (el.textContent ?? "") : "");
      if (seen.some(({ el, text }) => rewritten(text, now(el)))) return 1;
      // Each line of new text counts once, also when it holds two changes.
      const lines = new Map<number, number>();
      for (const range of changed) {
        for (const box of Array.from(range.getClientRects())) {
          if (inView(box)) lines.set(Math.round(box.top), inView(box));
        }
      }
      let share = 0;
      for (const block of seen) {
        const { el } = block;
        const box = el.isConnected ? el.getBoundingClientRect() : null;
        // A block that lost or got lines moves only when its two ends move.
        const moved = box
          ? Math.min(
              Math.abs(box.top - block.box.top),
              Math.abs(box.bottom - block.box.bottom),
            )
          : Infinity;
        const emptied = !!block.text.trim() && !now(el).trim();
        // The new text of a block that stayed in place is in the lines.
        if (
          moved > height * MOVED_SHARE ||
          emptied ||
          el.getAttribute("src") !== block.src
        )
          share += block.height;
        else if (touched(el)) share += Math.max(0, block.height - inView(box!));
      }
      for (const line of lines.values()) share += line;
      return Math.min(1, share / height);
    },
    restore: () => restore(),
  };
}

// innermost gives the blocks in an element that hold no other block, in the
// order of the page: a block that holds another one has it next in that
// order. A selector with :has costs about seven times more, and a patch
// for the operation of a typist runs this about each 50 ms.
function innermost(root: Element | null): Element[] {
  const blocks = Array.from(root?.querySelectorAll(BLOCK) ?? []);
  return blocks.filter((el, i) => !el.contains(blocks[i + 1] ?? null));
}

// firstInView gives the index of the first of blocks that is not above the
// view. The blocks are in the order of the page, which is mostly from the
// top down, so a search by halves finds it. A block with no height can be
// anywhere: the search goes on before it.
function firstInView(blocks: Element[]): number {
  let [low, high] = [0, blocks.length];
  while (low < high) {
    const middle = (low + high) >> 1;
    const box = blocks[middle].getBoundingClientRect();
    if (box.height && box.bottom <= 0) low = middle + 1;
    else high = middle;
  }
  return low;
}

// loading gives the images of the new content that did not load yet.
function loading(ranges: Range[]): HTMLImageElement[] {
  return ranges
    .flatMap(({ startContainer, collapsed }) => {
      const el = startContainer as Element;
      if (el.localName === "img") return [el as HTMLImageElement];
      return collapsed ? [] : Array.from(el.querySelectorAll?.("img") ?? []);
    })
    .filter((img) => !img.complete);
}

// changedRects gives the rectangles that flash for the new content of a
// patch. A block flashes as one when the new content is more than half of
// its text: single words that flash in a rewritten paragraph look like a
// fault. Else each word of new content flashes.
export function changedRects(ranges: Range[]): DOMRect[] {
  const blocks = new Map<Element, Range[]>();
  for (const range of wholeWords(ranges)) {
    const block = blockOf(range.commonAncestorContainer);
    if (block) blocks.set(block, [...(blocks.get(block) ?? []), range]);
  }
  return Array.from(blocks).flatMap(([block, ranges]) => {
    const length = ranges.reduce((sum, range) => sum + range.toString().length, 0);
    return length * 2 > (block.textContent ?? "").length
      ? [block.getBoundingClientRect()]
      : ranges.flatMap((range) =>
          // A place where text went flashes as a thin line.
          Array.from(range.getClientRects(), (rect) =>
            range.collapsed ? new DOMRect(rect.x - 1, rect.y, 2, rect.height) : rect,
          ),
        );
  });
}

// wholeWords gives the ranges of new text out to whole words, with ranges
// that then meet as one, and the places where text went outside of them. A
// patch can change parts of a word, and the word flashes as one piece.
function wholeWords(ranges: Range[]): Range[] {
  const words: Range[] = [];
  ranges
    .filter((range) => !range.collapsed)
    .map(snapToWords)
    .sort((a, b) => a.compareBoundaryPoints(Range.START_TO_START, b))
    .forEach((range) => {
      const last = words.at(-1);
      if (!last || last.comparePoint(range.startContainer, range.startOffset) > 0)
        words.push(range);
      else if (last.comparePoint(range.endContainer, range.endOffset) > 0)
        last.setEnd(range.endContainer, range.endOffset);
    });
  const went = ranges.filter(
    (range) =>
      range.collapsed &&
      !words.some((word) =>
        word.isPointInRange(range.startContainer, range.startOffset),
      ),
  );
  return [...words, ...went];
}
