import type { CursorPlace, CursorPoint, CursorSpot } from "../src/api.ts";
import {
  blockOf,
  isEditableTarget,
  MAX_CARET,
  overlap,
  placeClear,
  reducedMotion,
  scrollBehavior,
  scrollerOf,
  union,
} from "./dom.ts";
import { BRIDGE_NODE } from "./source-map.ts";

// Live cursors of other viewers. A cursor names the element under the pointer
// and a place in that element's box, so it lands on the same content in every
// window size. Points play back a short delay behind real time, and so the
// motion stays smooth while batches arrive late or out of rhythm.

// Elements the bridge adds to a document. Viewers do not all have the same
// ones, so cursor paths skip them.
const BRIDGE_ELEMENTS =
  "mark.slashdocs-mark,.slashdocs-svg-mark-rect,.slashdocs-selection-action,.slashdocs-heading-link,.slashdocs-text-flash";
const MAX_PATH_DEPTH = 64;

// The playback delay follows how late batches arrive, within these limits.
const START_DELAY = 150;
const MIN_DELAY = 50;
const MAX_DELAY = 500;
const DELAY_MARGIN = 30;
// Each batch lets the clock offset and the delay move by this much, so a
// lasting change in network delay plays back in order, and a short one heals.
const DRIFT = 1;
// When the delay changes, playback runs slower or faster, at these limits,
// until it is on time again. It never jumps back.
const MIN_RATE = 0.5;
const MAX_RATE = 2;
const CATCH_UP = 200;
// A pointer that rests sends no points. Its next move takes at most this
// long, not the whole rest.
const MAX_STEP = 50;
// The time constant that smooths jumps, such as where two viewers see
// different layouts, or after a lost batch.
const SMOOTHING = 30;
// How long cursors keep redrawing after a follow moves the document.
const SETTLE = 800;
// After the view moves to a followed viewer's view, it waits this long before
// it moves again, so that an animated move can finish first. The next move
// goes to their newest view.
const FOLLOW_REST = 400;
// A followed view this close to this one, in pixels and as a zoom factor,
// does not move it.
const FOLLOW_STILL_PX = 2;
const FOLLOW_STILL_ZOOM = 1.01;

function sharedChildren(el: Element): Element[] {
  return Array.from(el.children).filter((child) => !child.matches(BRIDGE_ELEMENTS));
}

function fraction(offset: number, size: number, clamp = true): number {
  if (!(size > 0)) return 0;
  const f = offset / size;
  return Math.round((clamp ? Math.min(1, Math.max(0, f)) : f) * 1e4) / 1e4;
}

// A view's place may lie outside its element, up to this many times its size.
export const MAX_VIEW_FRACTION = 1000;
// A cursor chat message holds at most this many characters, like the server.
const MAX_CURSOR_MESSAGE = 100;
// A sent cursor chat message stays this long after Enter.
const MESSAGE_LINGER = 5000;
// The cursor chat field and labels keep this far from the window's edges.
const EDGE = 8;
// After a resize, the followed view is put back once this long has passed.
const RESIZE_SETTLE = 150;
// A viewer who has not typed or moved the caret for this long no longer
// shows as editing.
const EDIT_IDLE = 30_000;
// Where a cursor's label sits from its pointer's tip.
const LABEL_X = 12;
const LABEL_Y = 16;

// The zoom that a spot records is clamped to this, like the server does.
const MAX_ZOOM = 100;
// A zoom this close to 1 is rounding, not zoom.
const ZOOM_EPSILON = 0.01;
// Control characters, which the server refuses in a cursor chat message.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

// zoomOf tells how much larger an element shows than its layout size, as on
// a document that zooms itself with a CSS transform. 1 means that it is not zoomed.
function zoomOf(el: Element): number {
  let node: Element | null = el;
  // SVG and empty elements have no layout width; their nearest box has.
  while (node && !((node as HTMLElement).offsetWidth > 0)) node = node.parentElement;
  if (!node) return 1;
  const zoom = node.getBoundingClientRect().width / (node as HTMLElement).offsetWidth;
  // offsetWidth rounds to whole pixels, so an element with a fractional width
  // reads a little off 1 without any zoom.
  if (!Number.isFinite(zoom) || zoom <= 0 || Math.abs(zoom - 1) < ZOOM_EPSILON)
    return 1;
  return Math.min(MAX_ZOOM, Math.max(1e-3, Math.round(zoom * 1e3) / 1e3));
}

// elementAt gives the document element under a point in the viewport that
// every viewer has, at most MAX_PATH_DEPTH deep, or the body.
function elementAt(d: Document, x: number, y: number): Element | null {
  return sharedElement(d, d.elementFromPoint(x, y));
}

// sharedElement gives the element that every viewer has for el: el, or the
// element that a bridge element sits in, at most MAX_PATH_DEPTH deep. It is
// the body for anything outside the body.
export function sharedElement(d: Document, el: Element | null): Element | null {
  const body = d.body;
  if (!body) return null;
  for (
    let added = el?.closest(BRIDGE_ELEMENTS);
    added;
    added = el?.closest(BRIDGE_ELEMENTS)
  )
    el = added.parentElement;
  const chain: Element[] = [];
  if (el && body.contains(el))
    for (let node = el; node !== body; node = node.parentElement!) chain.unshift(node);
  return chain.slice(0, MAX_PATH_DEPTH).at(-1) ?? body;
}

// placeIn names a point in the viewport by an element and fractions of its
// box. Unclamped fractions may name a point outside the element.
function placeIn(el: Element, x: number, y: number, clamp = true): CursorPlace {
  const box = el.getBoundingClientRect();
  const zoom = zoomOf(el);
  const limit = (f: number) =>
    Math.min(MAX_VIEW_FRACTION, Math.max(-MAX_VIEW_FRACTION, f));
  return {
    path: pathOf(el),
    x: limit(fraction(x - box.left, box.width, clamp)),
    y: limit(fraction(y - box.top, box.height, clamp)),
    ...(zoom !== 1 && { z: zoom }),
  };
}

// cursorSpot names the place under a point in the viewport.
function cursorSpot(d: Document, x: number, y: number): CursorPlace | null {
  const el = elementAt(d, x, y);
  return el && placeIn(el, x, y);
}

// pathOf names an element by its child indexes under the body, skipping the
// elements that the bridge adds.
export function pathOf(el: Element): string {
  const path: number[] = [];
  const body = el.ownerDocument.body;
  for (let node = el; node !== body && node.parentElement; node = node.parentElement)
    path.unshift(sharedChildren(node.parentElement).indexOf(node));
  return path.join(".");
}

// elementAtPath finds the element that pathOf named, if it is there.
export function elementAtPath(d: Document, path: string): Element | undefined {
  let el: Element | undefined = d.body ?? undefined;
  for (const step of path ? path.split(".") : []) el = el && sharedChildren(el)[+step];
  return el;
}

// textsOf gives the text nodes of a block in order, without those of the
// bridge's own nodes, which viewers do not all have.
function textsOf(block: Element): Text[] {
  const walker = block.ownerDocument.createTreeWalker(
    block,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) =>
        node.nodeType === Node.ELEMENT_NODE && (node as Element).matches(BRIDGE_NODE)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    },
  );
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node.nodeType === Node.TEXT_NODE) texts.push(node as Text);
  return texts;
}

// caretOffset counts the characters of the text of block before a caret.
export function caretOffset(block: Element, node: Node, offset: number): number {
  const before = block.ownerDocument.createRange();
  before.setStart(block, 0);
  before.setEnd(node, offset);
  // comparePoint gives 0 for the end of a text that is all before the caret.
  const count = textsOf(block).reduce(
    (sum, text) =>
      sum +
      (text === node
        ? offset
        : before.comparePoint(text, text.length)
          ? 0
          : text.length),
    0,
  );
  return Math.min(count, MAX_CARET);
}

// caretLine gives the line of a caret in the viewport, for its offset in the
// text of block. A caret past the text is at its end. A collapsed range has
// no box in each browser, so the nearest character before the caret that
// shows gives the line, or else the nearest one after it. White space that
// the browser collapses does not show. With no such character, as in an
// empty block, the caret is at the start of the block.
export function caretLine(block: Element, offset: number): DOMRect {
  const texts = textsOf(block);
  const length = texts.reduce((sum, text) => sum + text.length, 0);
  const range = block.ownerDocument.createRange();
  // The boxes of the character at an offset in the text of block.
  const boxesAt = (at: number) => {
    let text = texts[0];
    for (text of texts) {
      if (at < text.length) break;
      at -= text.length;
    }
    range.setStart(text, at);
    range.setEnd(text, at + 1);
    return Array.from(range.getClientRects()).filter((rect) => rect.height);
  };
  const caret = Math.min(offset, length);
  for (let at = caret - 1; at >= 0; at--) {
    const rect = boxesAt(at).at(-1);
    if (rect) return new DOMRect(rect.right, rect.top, 0, rect.height);
  }
  for (let at = caret; at < length; at++) {
    const rect = boxesAt(at)[0];
    if (rect) return new DOMRect(rect.left, rect.top, 0, rect.height);
  }
  const box = block.getBoundingClientRect();
  return new DOMRect(box.left, box.top, 0, box.height);
}

// selectionBoxes gives the boxes of the text of block between two offsets
// in that text, one for each line. The boxes of the text nodes make them, so
// that an element in the selection does not count twice.
function selectionBoxes(block: Element, a: number, c: number): DOMRect[] {
  const range = block.ownerDocument.createRange();
  const lines = new Map<string, DOMRect>();
  let at = 0;
  for (const text of textsOf(block)) {
    const start = Math.max(Math.min(a, c) - at, 0);
    const end = Math.min(Math.max(a, c) - at, text.length);
    at += text.length;
    if (start >= end) continue;
    range.setStart(text, start);
    range.setEnd(text, end);
    for (const box of Array.from(range.getClientRects())) {
      if (!box.width || !box.height) continue;
      const line = `${Math.round(box.top)} ${Math.round(box.height)}`;
      lines.set(line, union(lines.get(line) ?? box, box));
    }
  }
  return Array.from(lines.values());
}

// shownIn gives the box in the viewport in which the content of a scroller
// shows: the viewport for the document, else the box of the scroller.
function shownIn(scroller: Element): DOMRect {
  const d = scroller.ownerDocument;
  return scroller === (d.scrollingElement ?? d.documentElement)
    ? new DOMRect(0, 0, d.defaultView!.innerWidth, d.defaultView!.innerHeight)
    : scroller.getBoundingClientRect();
}

// within gives the part of box that is in clip, or null when no part is.
function within(box: DOMRect, clip: DOMRect): DOMRect | null {
  const [left, top] = [Math.max(box.left, clip.left), Math.max(box.top, clip.top)];
  const width = Math.min(box.right, clip.right) - left;
  const height = Math.min(box.bottom, clip.bottom) - top;
  return width > 0 && height > 0 ? new DOMRect(left, top, width, height) : null;
}

type PointerTracker = {
  // position is the pointer's place in the document viewport, if it is there.
  position: () => { x: number; y: number } | null;
  // setMessage shows a cursor chat message at this viewer's cursor, or none.
  setMessage: (message: string) => void;
};

// A spot for a pointer outside the document, which may still carry the view.
const LEFT = { path: "", x: 0, y: 0, hidden: true } as const;

// trackPointer reports where this viewer's pointer is, in v the place at the
// center of their view with its zoom, which those who follow them show, in m
// their cursor chat message, and in e and c the block that holds their caret
// while they edit and the caret's offset in its text. a is the offset of the
// other end of their selection, when the selection holds text and that end
// is in the same block. It reports at most once a frame and only when any
// changes. Null means that the pointer left.
export function trackPointer(
  d: Document,
  report: (spot: CursorSpot | null) => void,
): PointerTracker | undefined {
  const view = d.defaultView;
  if (!view) return;
  let pointer: { x: number; y: number } | null = null;
  let message = "";
  let frame = 0;
  let reported = "";
  let edited = -Infinity;
  let idle = 0;
  // The view is named by the element at its center. When the center is on
  // empty space that does not zoom, such as around a board that the document
  // zooms itself, it stays named by the last zoomed element, so that it keeps
  // its zoom.
  let anchor: Element | null = null;
  const center = () => {
    const x = view.innerWidth / 2;
    const y = view.innerHeight / 2;
    const el = elementAt(d, x, y);
    const keep = anchor?.isConnected && zoomOf(anchor) !== 1 && el && zoomOf(el) === 1;
    if (!keep) anchor = el;
    return anchor && placeIn(anchor, x, y, false);
  };
  // The path of the block with the caret, and the offsets of the caret and
  // of the other end of the selection in the text of the block, while this
  // viewer edits it.
  const editing = () => {
    const selection = d.getSelection();
    const caret = selection?.focusNode;
    if (
      !caret ||
      performance.now() - edited >= EDIT_IDLE ||
      !isEditableTarget(d, caret)
    )
      return undefined;
    const block = sharedElement(d, blockOf(caret));
    const e = block && pathOf(block);
    if (!e) return undefined;
    const c = caretOffset(block, caret, selection.focusOffset);
    const anchor = selection.anchorNode;
    const a =
      anchor && sharedElement(d, blockOf(anchor)) === block
        ? caretOffset(block, anchor, selection.anchorOffset)
        : c;
    return { e, c, ...(a !== c && { a }) };
  };
  const send = () => {
    frame = 0;
    const at = pointer && cursorSpot(d, pointer.x, pointer.y);
    const centerPlace = center();
    const edit = editing();
    const extras = { ...(centerPlace && { v: centerPlace }), ...edit };
    // With the pointer out of the document, the view and the edited block are
    // still sent, so that followers keep following while this viewer zooms by
    // key or reads, and others see where they type.
    const spot: CursorSpot | null = at
      ? { ...at, ...extras, ...(message && { m: message }) }
      : centerPlace || edit
        ? { ...LEFT, ...extras }
        : null;
    const key = JSON.stringify(spot);
    if (key === reported) return;
    reported = key;
    report(spot);
  };
  const schedule = () => {
    frame ||= view.requestAnimationFrame(send);
  };
  d.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType === "touch") return;
      pointer = { x: e.clientX, y: e.clientY };
      schedule();
    },
    { capture: true, passive: true },
  );
  d.addEventListener("mouseout", (e) => {
    if (e.relatedTarget) return;
    pointer = null;
    schedule();
  });
  // Content moves under a resting pointer, and the view changes, while the
  // page scrolls, and while a document pans or zooms itself, which it may animate.
  for (const type of ["scroll", "wheel", "keyup", "transitionend", "focusout"])
    d.addEventListener(type, schedule, { capture: true, passive: true });
  // Typing and caret moves keep this viewer editing, until they rest.
  const edit = () => {
    edited = performance.now();
    view.clearTimeout(idle);
    idle = view.setTimeout(schedule, EDIT_IDLE);
    schedule();
  };
  d.addEventListener("selectionchange", edit);
  d.addEventListener("input", edit, true);
  view.addEventListener("resize", schedule);
  // The view goes out at once, so that a viewer who has not moved yet can be
  // followed.
  schedule();
  return {
    position: () => pointer,
    setMessage: (next) => {
      message = next.replace(CONTROL_CHARS, " ").trim().slice(0, MAX_CURSOR_MESSAGE);
      schedule();
    },
  };
}

// createCursorChat lets a viewer type a short message at their cursor, as in
// Figma: "/" opens a field by the pointer, and others see the text live at
// this viewer's cursor. Enter keeps it a few seconds; Esc clears it. The field
// lives in the bridge window, over the document, and lets the pointer through.
export function createCursorChat(
  d: Document,
  pointer: PointerTracker,
  // color gives this viewer's cursor color, as others see it, or nothing when
  // this viewer cannot chat, as when signed out.
  color: () => string | undefined,
) {
  document.getElementById("slashdocs-cursor-chat")?.remove();
  const box = document.createElement("div");
  box.id = "slashdocs-cursor-chat";
  box.className = "slashdocs-chat";
  box.hidden = true;
  // A textarea, so the sender sees the message wrap as others do.
  const input = document.createElement("textarea");
  input.rows = 1;
  input.maxLength = MAX_CURSOR_MESSAGE;
  input.placeholder = "Say something";
  input.setAttribute("aria-label", "Cursor chat message");
  box.appendChild(input);
  document.body.appendChild(box);
  let linger = 0;
  // place keeps the field by the pointer, and flips it to the pointer's
  // other side near the right or bottom edge so it never goes off screen.
  const place = () => {
    const at = pointer.position();
    if (!at) return;
    const w = box.offsetWidth;
    const h = box.offsetHeight;
    const x = at.x + 14 + w > window.innerWidth - EDGE ? at.x - 6 - w : at.x + 14;
    const y = at.y + 18 + h > window.innerHeight - EDGE ? at.y - 6 - h : at.y + 18;
    box.style.transform = `translate(${Math.max(EDGE, x)}px,${Math.max(EDGE, y)}px)`;
  };
  const close = (keep: boolean) => {
    if (box.hidden) return;
    box.hidden = true;
    const text = input.value.trim();
    input.value = "";
    window.clearTimeout(linger);
    pointer.setMessage(keep ? text : "");
    if (keep && text)
      linger = window.setTimeout(() => pointer.setMessage(""), MESSAGE_LINGER);
    d.defaultView?.focus();
  };
  // open shows the field at the pointer, if the pointer is in the document.
  const open = () => {
    const own = color();
    if (!own || !pointer.position()) return false;
    window.clearTimeout(linger);
    pointer.setMessage("");
    box.style.setProperty("--c", own);
    box.hidden = false;
    place();
    input.focus();
    return true;
  };
  // After the document's own handlers, so a document that takes "/" keeps it.
  d.defaultView?.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented)
      return;
    if (isEditableTarget(d, e.target)) return;
    if (open()) e.preventDefault();
  });
  d.addEventListener("pointermove", () => !box.hidden && place(), {
    capture: true,
    passive: true,
  });
  input.addEventListener("input", () => {
    // One line: a pasted line break becomes a space.
    if (/[\r\n]/.test(input.value)) input.value = input.value.replace(/[\r\n]+/g, " ");
    pointer.setMessage(input.value);
    place();
  });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    // Enter that ends an IME composition picks the text; it does not send.
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" || e.key === "Escape") {
      e.preventDefault();
      close(e.key === "Enter");
    }
  });
  input.addEventListener("blur", () => close(true));
  return { open };
}

// A track holds a cursor's points that playback has not passed. offset maps
// the sender's clock to this one with the smallest network delay seen. head
// is the playback time on the sender's clock at the local time now.
export type Track = {
  points: CursorPoint[];
  offset: number;
  delay: number;
  head: number;
  now: number;
};

export function newTrack(): Track {
  return { points: [], offset: Infinity, delay: START_DELAY, head: 0, now: NaN };
}

export function addPoints(track: Track, points: CursorPoint[], now: number) {
  const newest = track.points.at(-1)?.t ?? -Infinity;
  const fresh = points.filter((point) => point.t > newest);
  const first = fresh[0];
  const last = fresh.at(-1);
  if (!first || !last) return;
  track.offset = Math.min(now - last.t, track.offset + DRIFT);
  const late = now - first.t - track.offset;
  track.delay = Math.min(
    MAX_DELAY,
    Math.max(MIN_DELAY, late + DELAY_MARGIN, track.delay - DRIFT),
  );
  track.points.push(...fresh);
}

// advance moves playback to the local time now. Playback goes toward the
// delayed sender time at a changing rate, so a new delay or offset bends the
// motion and never makes it jump. After a long pause, it starts again on time.
function advance(track: Track, now: number) {
  const target = now - track.offset - track.delay;
  const elapsed = now - track.now;
  const rate = 1 + (target - track.head - elapsed) / CATCH_UP;
  track.head =
    elapsed < 1000
      ? track.head + elapsed * Math.min(MAX_RATE, Math.max(MIN_RATE, rate))
      : target;
  track.now = now;
}

// playback finds the two points that playback is between at time now, and
// how far it is from the first to the second. It drops passed points. Null
// means that the cursor is hidden or has not started.
export function playback(
  track: Track,
  now: number,
): { from: CursorPoint; to: CursorPoint; f: number } | null {
  advance(track, now);
  const { head: at, points } = track;
  let current = -1;
  while (current + 1 < points.length && points[current + 1].t <= at) current++;
  if (current < 0) return null;
  points.splice(0, current);
  const [from, to] = points;
  if (from.hidden) return null;
  if (!to || to.hidden) return { from, to: from, f: 0 };
  const start = Math.max(from.t, to.t - MAX_STEP);
  return { from, to, f: Math.min(1, Math.max(0, (at - start) / (to.t - start))) };
}

// played tells if playback passed the last point at its last advance.
function played(track: Track): boolean {
  const last = track.points.at(-1);
  return !last || track.head >= last.t;
}

type Cursor = {
  track: Track;
  el: HTMLElement;
  label: HTMLElement;
  arrow: SVGPathElement;
  shown: boolean;
  // The shown position, in document coordinates so that scrolling moves the
  // cursor with the content at once.
  x: number;
  y: number;
  // The newest view of this cursor's viewer, if they send it.
  view?: CursorPlace;
  // The place the cursor heads for and where it was on the last frame, to
  // tell this view's own pans and zooms from the remote viewer's movement.
  anchor?: { place: CursorPlace; x: number; y: number };
  // The label's size, and to which sides of the pointer it is flipped.
  labelSize: { w: number; h: number };
  flip: string;
};

export type RemoteCursor = {
  session: string;
  name: string;
  color: string;
  points: CursorPoint[];
  // own tells that the cursor is this reader's, in another tab.
  own?: boolean;
};

// An edit mark shows where another viewer edits, in their color. c is the
// offset of their caret in the text of the block, and a that of the other
// end of their selection. With c, the mark is a thin caret, a flag with their
// name on top of it, and a light wash over their selection, one box for each
// line. The flag shows when the caret comes and each time it moves, and
// goes when flagTimer ends, so that only the thin caret stays over the text.
// Without c, the mark is a bar beside the block and a label where it covers
// no text. fit holds the label text and block size that the label was placed
// for, and dx and dy where it went from the block's corner.
type EditMark = {
  path: string;
  c?: number;
  a?: number;
  el: HTMLElement;
  bar: HTMLElement;
  label: HTMLElement;
  caret: HTMLElement;
  flag: HTMLElement;
  flagTimer: number;
  fit: string;
  dx: number;
  dy: number;
};
// The corners of a flag are round, but not the one at its caret.
const FLAG_RADIUS = 3;
// A flag shows this long after its caret last moved.
const FLAG_SHOWS = 2000;
// A pointer this near to a caret, in pixels, points at it.
const POINT_AT = 6;
// The selection toolbar of the reader, in the document. A flag is in the
// window over the document, and so it must keep off the toolbar.
const TOOLBAR = ".slashdocs-selection-action";

const SVG_NS = "http://www.w3.org/2000/svg";

// Styles for the follow frame and the cursor chat field in the bridge window.
// The app's doc bar names the followed viewer and stops following, so the
// frame covers no text of the document.
// --c is the followed viewer's color, or this viewer's own for the chat.
const BRIDGE_CSS = `
.slashdocs-follow{position:fixed;inset:0;z-index:2147483646;pointer-events:none;border:2px solid var(--c);opacity:0;visibility:hidden;transition:opacity 100ms ease-out,visibility 0s linear 100ms}
.slashdocs-follow[data-on]{opacity:1;visibility:visible;transition:opacity 150ms cubic-bezier(.23,1,.32,1),visibility 0s}
.slashdocs-edit{position:absolute;left:0;top:0;opacity:0;transition:opacity 120ms ease-out}
.slashdocs-edit[data-on]{opacity:1;transition-duration:180ms}
.slashdocs-edit>*{position:absolute;background:var(--c)}
.slashdocs-edit[data-caret]>:is(i,span),.slashdocs-edit:not([data-caret])>:is(u,em,b){display:none}
.slashdocs-edit>:is(i,u){border-radius:1px}
.slashdocs-edit>b{opacity:.2;border-radius:2px}
.slashdocs-edit>:is(span,em){color:#fff;font:500 11px/16px system-ui,-apple-system,sans-serif;white-space:nowrap}
.slashdocs-edit>span{padding:1px 6px;border-radius:4px;box-shadow:0 1px 2px rgba(0,0,0,.15)}
.slashdocs-edit>:is(u,em){z-index:1}
.slashdocs-edit>em{max-width:160px;overflow:hidden;text-overflow:ellipsis;padding:0 4px;font-weight:600;line-height:14px;opacity:0;transition:opacity 300ms ease-out}
.slashdocs-edit[data-flag]>em{opacity:1;transition-duration:120ms}
@media (prefers-reduced-motion:reduce){.slashdocs-edit,.slashdocs-edit>em{transition:none}}
.slashdocs-chat{position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none}
.slashdocs-chat textarea{all:unset;display:block;box-sizing:border-box;field-sizing:content;min-width:120px;max-width:260px;padding:5px 10px;border-radius:3px 12px 12px 12px;background:var(--c,#27272a);color:#fff;font:500 13px/18px system-ui,-apple-system,sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;resize:none;box-shadow:0 1px 3px rgba(0,0,0,.2);caret-color:#fff}
.slashdocs-chat textarea::placeholder{color:rgba(255,255,255,.7)}
`;

// createCursorLayer draws other viewers' cursors over the document frame,
// which fills the bridge window. Viewport coordinates of the document are
// thus coordinates of the layer.
export function createCursorLayer(
  doc: () => Document | null,
  // unfollowed tells that following stopped here, not by a follow request.
  unfollowed: () => void = () => {},
) {
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText =
    "position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:2147483647;contain:strict";
  document.body.appendChild(layer);
  const cursors = new Map<string, Cursor>();
  const edits = new Map<string, EditMark>();
  const elements = new WeakMap<CursorPlace, Element | undefined>();
  let frame = 0;
  let lastFrame = 0;
  // Until this time, cursors redraw on every frame.
  let settleUntil = 0;
  // The session whose view this view follows, if any, when this view last
  // moved to it, and a timer for the next move.
  let followed: string | null = null;
  // The newest view of each session that sent one, kept after its cursor
  // goes, so a viewer whose pointer is outside the document can be followed.
  const views = new Map<string, { view: CursorPlace; color: string }>();
  let followMoved = -Infinity;
  let followTimer = 0;

  // While the view follows a cursor, a frame in its color shows it.
  const style = document.createElement("style");
  style.textContent = BRIDGE_CSS;
  document.head.appendChild(style);
  const followFrame = document.createElement("div");
  followFrame.className = "slashdocs-follow";
  followFrame.setAttribute("aria-hidden", "true");
  document.body.appendChild(followFrame);

  // locate gives a point's place in the document viewport, or null when the
  // point's element is not in this document.
  function locate(point: CursorPlace): { x: number; y: number } | null {
    const d = doc();
    if (!d) return null;
    let el = elements.get(point);
    if (!el?.isConnected) elements.set(point, (el = elementAtPath(d, point.path)));
    if (!el) return null;
    const box = el.getBoundingClientRect();
    return { x: box.left + point.x * box.width, y: box.top + point.y * box.height };
  }

  function create(session: string): Cursor {
    const el = document.createElement("div");
    el.style.cssText =
      "position:absolute;left:0;top:0;opacity:0;transition:opacity 150ms ease-out;will-change:transform,opacity";
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", "18");
    svg.setAttribute("height", "18");
    svg.setAttribute("viewBox", "0 0 18 18");
    svg.style.cssText =
      "position:absolute;left:-2.5px;top:-1.5px;overflow:visible;filter:drop-shadow(0 1px 2px rgba(0,0,0,.3))";
    const arrow = document.createElementNS(SVG_NS, "path");
    arrow.setAttribute("d", "M2.5 1.5 15.5 8.8 9.3 10.2 6.5 16.2Z");
    arrow.setAttribute("stroke", "#fff");
    arrow.setAttribute("stroke-width", "1.5");
    arrow.setAttribute("stroke-linejoin", "round");
    svg.appendChild(arrow);
    const label = document.createElement("span");
    label.style.cssText = `position:absolute;left:${LABEL_X}px;top:${LABEL_Y}px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 7px;border-radius:3px 9px 9px 9px;color:#fff;font:500 12px/16px system-ui,-apple-system,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,.2);transform-origin:0 0`;
    el.append(svg, label);
    layer.appendChild(el);
    const cursor = {
      track: newTrack(),
      el,
      label,
      arrow,
      shown: false,
      x: 0,
      y: 0,
      labelSize: { w: 0, h: 0 },
      flip: "",
    };
    cursors.set(session, cursor);
    return cursor;
  }

  // markEdit shows that a viewer edits the block at path, with their caret
  // at the offset c in the text of the block and the other end of their
  // selection at a.
  function markEdit(
    { session, name, color, own }: RemoteCursor,
    path: string,
    c?: number,
    a?: number,
  ) {
    let mark = edits.get(session);
    const moved = mark?.path !== path || mark.c !== c || mark.a !== a;
    if (!mark) {
      const el = document.createElement("div");
      el.className = "slashdocs-edit";
      const [bar, label, caret, flag] = ["i", "span", "u", "em"].map((tag) =>
        el.appendChild(document.createElement(tag)),
      );
      layer.appendChild(el);
      mark = { path, el, bar, label, caret, flag, flagTimer: 0, fit: "", dx: 0, dy: 0 };
      edits.set(session, mark);
    }
    if (moved) showFlag(mark);
    Object.assign(mark, { path, c, a });
    mark.label.textContent = own
      ? "You are editing in another tab"
      : `${name} is editing`;
    mark.flag.textContent = own ? "You" : name;
    mark.el.style.setProperty("--c", color);
    mark.el.toggleAttribute("data-caret", c !== undefined);
  }

  // showFlag shows the name at a caret for a short time.
  function showFlag(mark: EditMark) {
    mark.el.toggleAttribute("data-flag", true);
    window.clearTimeout(mark.flagTimer);
    mark.flagTimer = window.setTimeout(
      () => mark.el.removeAttribute("data-flag"),
      FLAG_SHOWS,
    );
  }

  function unmarkEdit(session: string) {
    const mark = edits.get(session);
    if (!mark) return;
    edits.delete(session);
    window.clearTimeout(mark.flagTimer);
    mark.el.removeAttribute("data-on");
    setTimeout(() => mark.el.remove(), 150);
  }

  const put = (el: HTMLElement, { x, y, width, height }: DOMRect) =>
    (el.style.cssText = `left:${x}px;top:${y}px;width:${width}px;height:${height}px`);

  // placeEdit puts an edit mark at its block, and hides it while the block
  // is not in this document.
  function placeEdit(mark: EditMark) {
    const d = doc();
    const block = d && elementAtPath(d, mark.path);
    const box = block?.getBoundingClientRect();
    if (d && block && box?.height) {
      if (mark.c === undefined) placeLabel(d, mark, block, box);
      else placeCaret(d, mark, block, mark.c);
    }
    // Last, so that a new mark fades in from its first style.
    mark.el.toggleAttribute("data-on", !!box?.height);
  }

  // placeLabel puts the bar at the left of the block, and the label at the
  // end of the block's text, else above or below it, where it covers no
  // text. The label keeps its place from the block's corner until the label
  // or the block's text changes size.
  function placeLabel(d: Document, mark: EditMark, block: Element, box: DOMRect) {
    const { label, bar } = mark;
    const range = d.createRange();
    range.selectNodeContents(block);
    const lines = Array.from(range.getClientRects()).filter((line) => line.width);
    const [first, last] = [lines[0] ?? box, lines.at(-1) ?? box];
    const fit = `${mark.path} ${label.textContent} ${last.right - box.left} ${box.width}x${box.height}`;
    if (mark.fit !== fit) {
      mark.fit = fit;
      const { offsetWidth: w, offsetHeight: h } = label;
      placeClear(d, label, lines, [
        [last.right + 8, last.top + (last.height - h) / 2],
        [first.left, first.top - h - 4],
        [last.right - w, last.bottom + 4],
      ]);
      mark.dx = parseFloat(label.style.left) - box.left;
      mark.dy = parseFloat(label.style.top) - box.top;
    }
    label.style.setProperty("left", `${box.left + mark.dx}px`, "important");
    label.style.setProperty("top", `${box.top + mark.dy}px`, "important");
    put(bar, new DOMRect(box.left - 6, box.top, 2, box.height));
  }

  // placeCaret puts the caret at its offset in the text that the block has
  // now, the flag on top of the caret, and the wash on the lines of the
  // selection. They show only in the part of the view where the block
  // shows, so a caret that scrolled out of a box that scrolls is hidden. The
  // flag starts at the caret and goes to the right, or to the left when it
  // has no room at the right. It goes under the caret when it has no room on
  // top, or covers the selection toolbar of the reader there.
  function placeCaret(d: Document, mark: EditMark, block: Element, c: number) {
    const { el, caret, flag } = mark;
    const clip = shownIn(scrollerOf(block));
    const line = caretLine(block, c);
    const shown = within(new DOMRect(line.x - 1, line.y, 2, line.height), clip);
    caret.hidden = flag.hidden = !shown;
    if (shown) {
      put(caret, shown);
      const { offsetWidth: w, offsetHeight: h } = flag;
      const toolbar = d.querySelector(TOOLBAR)?.getBoundingClientRect();
      const right = shown.x + w <= clip.right || shown.right - w < clip.left;
      const x = right ? shown.x : shown.right - w;
      const covers = toolbar && overlap(new DOMRect(x, line.y - h, w, h), toolbar);
      const top = line.y - h >= clip.top && !covers;
      // From the top left corner, as CSS names them.
      const round = [top || !right, top || right, !top || right, !top || !right];
      const radius = round.map((is) => `${is ? FLAG_RADIUS : 0}px`).join(" ");
      flag.style.cssText = `left:${x}px;top:${top ? line.y - h : line.bottom}px;border-radius:${radius}`;
    }
    const boxes =
      mark.a === undefined
        ? []
        : selectionBoxes(block, mark.a, c).flatMap((box) => within(box, clip) ?? []);
    const wash = Array.from(el.querySelectorAll("b"));
    boxes.forEach((box, i) =>
      put(wash[i] ?? el.appendChild(document.createElement("b")), box),
    );
    wash.slice(boxes.length).forEach((b) => b.remove());
  }

  function show(cursor: Cursor, shown: boolean) {
    if (cursor.shown === shown) return;
    cursor.shown = shown;
    cursor.el.style.opacity = shown ? "1" : "0";
  }

  function tick(now: number) {
    frame = 0;
    const view = doc()?.defaultView;
    const scrollX = view?.scrollX ?? 0;
    const scrollY = view?.scrollY ?? 0;
    const smooth = lastFrame ? 1 - Math.exp(-(now - lastFrame) / SMOOTHING) : 1;
    lastFrame = now;
    let moving = false;
    for (const [session, cursor] of cursors) {
      const at = playback(cursor.track, now);
      const from = at && locate(at.from);
      const to = at && (locate(at.to) ?? from);
      if (!at || !from || !to) {
        show(cursor, false);
        if (!played(cursor.track)) moving = true;
        else {
          cursors.delete(session);
          setTimeout(() => cursor.el.remove(), 200);
        }
        continue;
      }
      const x = from.x + (to.x - from.x) * at.f + scrollX;
      const y = from.y + (to.y - from.y) * at.f + scrollY;
      // When this view pans or zooms (a document moving itself under the cursor), the
      // same place moved on screen: carry the cursor with it at once, and
      // smooth only the remote viewer's own movement.
      const toX = to.x + scrollX;
      const toY = to.y + scrollY;
      if (cursor.anchor?.place === at.to) {
        cursor.x += toX - cursor.anchor.x;
        cursor.y += toY - cursor.anchor.y;
      }
      cursor.anchor = { place: at.to, x: toX, y: toY };
      const step = cursor.shown ? smooth : 1;
      cursor.x += (x - cursor.x) * step;
      cursor.y += (y - cursor.y) * step;
      cursor.el.style.transform = `translate3d(${cursor.x - scrollX}px,${cursor.y - scrollY}px,0)`;
      // Near the right or bottom edge the label goes to the pointer's other
      // side, so a message is never cut off.
      const { w, h } = cursor.labelSize;
      const flipX = cursor.x - scrollX + LABEL_X + w > window.innerWidth - EDGE;
      const flipY = cursor.y - scrollY + LABEL_Y + h > window.innerHeight - EDGE;
      // The key holds the size too: a label that grows into a message bubble
      // on a flipped side moves further.
      const flip = `${flipX ? "x" : ""}${flipY ? "y" : ""}${w}x${h}`;
      if (cursor.flip !== flip) {
        cursor.flip = flip;
        cursor.label.style.translate = `${flipX ? -w - LABEL_X - 4 : 0}px ${flipY ? -h - LABEL_Y - 4 : 0}px`;
      }
      show(cursor, true);
      moving ||=
        !played(cursor.track) ||
        Math.abs(x - cursor.x) > 0.1 ||
        Math.abs(y - cursor.y) > 0.1;
    }
    edits.forEach(placeEdit);
    if (moving || now < settleUntil) refresh();
    else lastFrame = 0;
  }

  // refresh draws the cursors again on the next frame, for example after the
  // document scrolls or changes size.
  function refresh() {
    frame ||= requestAnimationFrame(tick);
  }

  function receive(remote: RemoteCursor) {
    const { session, name, color, points } = remote;
    const last = points.at(-1);
    if (!last?.e) unmarkEdit(session);
    else markEdit(remote, last.e, last.c, last.a);
    const cursor = cursors.get(session) ?? create(session);
    // A cursor chat message shows in the label, in the viewer's color.
    const message = points.at(-1)?.m ?? "";
    const text = message || name;
    // The label grows into a bubble when a message starts and back when it
    // ends; a quick settle from slightly smaller hides the jump in size.
    // Keystrokes within a message change the text only.
    const chatting = cursor.label.style.whiteSpace === "normal";
    if (!!message !== chatting && cursor.label.textContent && !reducedMotion(doc()))
      cursor.label.animate(
        [
          { transform: "scale(.94)", opacity: 0.6 },
          { transform: "scale(1)", opacity: 1 },
        ],
        { duration: 160, easing: "cubic-bezier(.23,1,.32,1)" },
      );
    if (cursor.label.textContent !== text) cursor.label.textContent = text;
    cursor.label.style.whiteSpace = message ? "normal" : "nowrap";
    // A long word wraps instead of running under the edge.
    cursor.label.style.overflowWrap = message ? "anywhere" : "";
    cursor.label.style.maxWidth = message ? "260px" : "200px";
    cursor.label.style.width = message ? "max-content" : "";
    cursor.label.style.fontSize = message ? "13px" : "12px";
    cursor.label.style.padding = message ? "5px 10px" : "2px 7px";
    cursor.label.style.background = color;
    cursor.arrow.setAttribute("fill", color);
    cursor.labelSize = { w: cursor.label.offsetWidth, h: cursor.label.offsetHeight };
    addPoints(cursor.track, points, performance.now());
    let view: CursorPlace | undefined;
    for (const point of points) view = point.v ?? view;
    if (view) cursor.view = view;
    if (cursor.view) views.set(session, { view: cursor.view, color });
    if (session === followed) {
      showFollowing(color);
      if (view) scheduleFollow();
    }
    refresh();
  }

  // viewOf gives the newest view of a session, also after its cursor went
  // away because the pointer left the document.
  function viewOf(session: string) {
    return cursors.get(session)?.view ?? views.get(session)?.view;
  }

  function clear() {
    views.clear();
    edits.forEach((_, session) => unmarkEdit(session));
    for (const cursor of cursors.values()) cursor.el.remove();
    cursors.clear();
  }

  // moveTo puts a place at the center of the view, at the given zoom. A
  // document that pans and zooms by itself may take the "slashdocs:follow"
  // event: its detail has the place in the viewport (x, y) and how much to
  // zoom so that the content shows as large as the followed viewer sees it
  // (zoom, a factor). A document that cancels the event moves itself; for any
  // other one, the nearest scroller of the place scrolls.
  function moveTo(spot: CursorPlace, now: number) {
    const view = doc()?.defaultView;
    const place = locate(spot);
    const el = elements.get(spot);
    if (!view || !place || !el) return;
    const zoom = spot.z ? spot.z / zoomOf(el) : 1;
    const scroller = scrollerOf(el);
    const box = shownIn(scroller);
    const dx = place.x - box.left - box.width / 2;
    const dy = place.y - box.top - box.height / 2;
    const still =
      Math.abs(dx) <= FOLLOW_STILL_PX &&
      Math.abs(dy) <= FOLLOW_STILL_PX &&
      Math.abs(Math.log(zoom)) <= Math.log(FOLLOW_STILL_ZOOM);
    if (still) return;
    const event = new view.CustomEvent("slashdocs:follow", {
      cancelable: true,
      detail: { x: place.x, y: place.y, zoom },
    });
    if (view.dispatchEvent(event))
      scroller.scrollBy({
        left: dx,
        top: dy,
        behavior: scrollBehavior(doc()),
      });
    followMoved = now;
    // A document that moves itself sends no scroll events, so redraw while
    // it settles.
    settleUntil = now + SETTLE;
    refresh();
  }

  // scheduleFollow moves to the followed viewer's newest view once the last
  // move has had time to finish.
  function scheduleFollow() {
    if (followTimer) return;
    const wait = Math.max(0, followMoved + FOLLOW_REST - performance.now());
    followTimer = window.setTimeout(() => {
      followTimer = 0;
      const view = followed && viewOf(followed);
      if (view) moveTo(view, performance.now());
    }, wait);
  }

  function showFollowing(color: string) {
    followFrame.style.setProperty("--c", color);
    followFrame.toggleAttribute("data-on", true);
  }

  // caretOf gives the place of the caret of a viewer who edits: the middle
  // of its line.
  function caretOf(session: string): CursorPlace | undefined {
    const d = doc();
    const mark = edits.get(session);
    const block = d && mark && elementAtPath(d, mark.path);
    if (!block || mark?.c === undefined) return undefined;
    const line = caretLine(block, mark.c);
    return placeIn(block, line.x, line.y + line.height / 2);
  }

  // follow shows what another viewer sees. Once, it goes to their caret when
  // they edit, else to their cursor, or else to the center of their view: the
  // place is then in the middle of this view. Continuous, it shows the
  // center of their view at their zoom, and keeps showing it as they move,
  // until unfollow. A viewer who sent no view yet is followed from their
  // first one.
  function follow(session: string, continuous: boolean) {
    unfollow();
    const cursor = cursors.get(session);
    const kept = views.get(session);
    const point = cursor?.track.points.at(-1);
    const view = viewOf(session);
    const shown = point && !point.hidden ? point : undefined;
    const target = continuous ? (view ?? shown) : (caretOf(session) ?? shown ?? view);
    if (target && locate(target)) {
      moveTo(target, performance.now());
      const mark = edits.get(session);
      if (mark) showFlag(mark);
      // One short pulse as the view lands says whose cursor this is.
      if (cursor && !reducedMotion(doc()))
        cursor.label.animate(
          [
            { transform: "scale(1)" },
            { transform: "scale(1.15)" },
            { transform: "scale(1)" },
          ],
          { duration: 320, delay: 250, easing: "cubic-bezier(.77,0,.175,1)" },
        );
    }
    if (!continuous) return;
    followed = session;
    // Their color comes with their first report, if not known yet.
    const color = cursor?.label.style.background || kept?.color;
    if (color) showFollowing(color);
  }

  // unfollow stops following. here tells that this reader moved the view or
  // asked to stop in the frame, and so the app has to know.
  function unfollow(here = false) {
    if (!followed) return;
    followed = null;
    window.clearTimeout(followTimer);
    followTimer = 0;
    followFrame.toggleAttribute("data-on", false);
    if (here) unfollowed();
  }

  // watchInput stops following when the reader moves the view: a wheel, a
  // press, a touch or a key in the document. A pointer that only moves does
  // not: it shows the flag of a caret that it points at.
  function watchInput(d: Document) {
    const stop = () => unfollow(true);
    for (const type of ["wheel", "pointerdown", "touchstart"])
      d.addEventListener(type, stop, { capture: true, passive: true });
    d.addEventListener(
      "pointermove",
      ({ clientX: x, clientY: y }) => {
        const near = new DOMRect(
          x - POINT_AT,
          y - POINT_AT,
          POINT_AT * 2,
          POINT_AT * 2,
        );
        for (const mark of edits.values())
          if (!mark.caret.hidden && overlap(near, mark.caret.getBoundingClientRect()))
            showFlag(mark);
      },
      { capture: true, passive: true },
    );
    d.addEventListener(
      "keydown",
      (e) => {
        if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return;
        // "/" opens cursor chat, which a follower may use while following,
        // unless it types into the document.
        if (e.key !== "/" || isEditableTarget(d, e.target)) stop();
      },
      true,
    );
  }

  // refollow puts the followed view back after this window changes size,
  // once the document has laid itself out again (some refit on resize).
  function refollow() {
    if (!followed) return;
    window.clearTimeout(followTimer);
    followTimer = window.setTimeout(() => {
      followTimer = 0;
      const view = followed && viewOf(followed);
      if (view) moveTo(view, performance.now());
    }, RESIZE_SETTLE);
  }

  return { receive, clear, follow, unfollow, watchInput, refresh, refollow };
}
