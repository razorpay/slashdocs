import type { CursorPoint, CursorSpot } from "../src/api.ts";

// Live cursors of other viewers. A cursor names the element under the pointer
// and a place in that element's box, so it lands on the same content in every
// window size. Points play back a short delay behind real time, and so the
// motion stays smooth while batches arrive late or out of rhythm.

// Elements the bridge adds to a document. Viewers do not all have the same
// ones, so cursor paths skip them.
const BRIDGE_ELEMENTS =
  "mark.slashdocs-mark,.slashdocs-selection-action,.slashdocs-text-flash";
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

function sharedChildren(el: Element): Element[] {
  return Array.from(el.children).filter((child) => !child.matches(BRIDGE_ELEMENTS));
}

function fraction(offset: number, size: number): number {
  return size > 0 ? Math.round(Math.min(1, Math.max(0, offset / size)) * 1e4) / 1e4 : 0;
}

// cursorSpot names the place under a point in the viewport.
export function cursorSpot(d: Document, x: number, y: number): CursorSpot | null {
  const body = d.body;
  if (!body) return null;
  let el = d.elementFromPoint(x, y);
  for (
    let added = el?.closest(BRIDGE_ELEMENTS);
    added;
    added = el?.closest(BRIDGE_ELEMENTS)
  )
    el = added.parentElement;
  const chain: Element[] = [];
  if (el && body.contains(el))
    for (let node = el; node !== body; node = node.parentElement!) chain.unshift(node);
  const path = chain.slice(0, MAX_PATH_DEPTH);
  const box = (path.at(-1) ?? body).getBoundingClientRect();
  return {
    path: path
      .map((node) => sharedChildren(node.parentElement!).indexOf(node))
      .join("."),
    x: fraction(x - box.left, box.width),
    y: fraction(y - box.top, box.height),
  };
}

function cursorElement(d: Document, path: string): Element | undefined {
  let el: Element | undefined = d.body ?? undefined;
  for (const step of path ? path.split(".") : []) el = el && sharedChildren(el)[+step];
  return el;
}

// trackPointer reports where this viewer's pointer is, at most once a frame
// and only when the place changes. Null means that the pointer left.
export function trackPointer(d: Document, report: (spot: CursorSpot | null) => void) {
  const view = d.defaultView;
  if (!view) return;
  let pointer: { x: number; y: number } | null = null;
  let frame = 0;
  let reported = "";
  const send = () => {
    frame = 0;
    const spot = pointer && cursorSpot(d, pointer.x, pointer.y);
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
  // Content moves under a resting pointer while the page scrolls.
  d.addEventListener("scroll", () => pointer && schedule(), {
    capture: true,
    passive: true,
  });
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
};

export type RemoteCursor = {
  session: string;
  name: string;
  color: string;
  points: CursorPoint[];
};

const SVG_NS = "http://www.w3.org/2000/svg";

// createCursorLayer draws other viewers' cursors over the document frame,
// which fills the bridge window. Viewport coordinates of the document are
// thus coordinates of the layer.
export function createCursorLayer(doc: () => Document | null) {
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText =
    "position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:2147483647;contain:strict";
  document.body.appendChild(layer);
  const cursors = new Map<string, Cursor>();
  const elements = new WeakMap<CursorPoint, Element | undefined>();
  let frame = 0;
  let lastFrame = 0;

  // locate gives a point's place in the document viewport, or null when the
  // point's element is not in this document.
  function locate(point: CursorPoint): { x: number; y: number } | null {
    const d = doc();
    if (!d) return null;
    let el = elements.get(point);
    if (!el?.isConnected) elements.set(point, (el = cursorElement(d, point.path)));
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
    label.style.cssText =
      "position:absolute;left:12px;top:16px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:2px 7px;border-radius:3px 9px 9px 9px;color:#fff;font:500 12px/16px system-ui,-apple-system,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,.2);transform-origin:0 0";
    el.append(svg, label);
    layer.appendChild(el);
    const cursor = { track: newTrack(), el, label, arrow, shown: false, x: 0, y: 0 };
    cursors.set(session, cursor);
    return cursor;
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
      const step = cursor.shown ? smooth : 1;
      cursor.x += (x - cursor.x) * step;
      cursor.y += (y - cursor.y) * step;
      cursor.el.style.transform = `translate3d(${cursor.x - scrollX}px,${cursor.y - scrollY}px,0)`;
      show(cursor, true);
      moving ||=
        !played(cursor.track) ||
        Math.abs(x - cursor.x) > 0.1 ||
        Math.abs(y - cursor.y) > 0.1;
    }
    if (moving) refresh();
    else lastFrame = 0;
  }

  // refresh draws the cursors again on the next frame, for example after the
  // document scrolls or changes size.
  function refresh() {
    frame ||= requestAnimationFrame(tick);
  }

  function receive({ session, name, color, points }: RemoteCursor) {
    const cursor = cursors.get(session) ?? create(session);
    if (cursor.label.textContent !== name) cursor.label.textContent = name;
    cursor.label.style.background = color;
    cursor.arrow.setAttribute("fill", color);
    addPoints(cursor.track, points, performance.now());
    refresh();
  }

  function clear() {
    for (const cursor of cursors.values()) cursor.el.remove();
    cursors.clear();
  }

  // follow scrolls the document to put a cursor at the center of the view.
  function follow(session: string) {
    const cursor = cursors.get(session);
    const point = cursor?.track.points.at(-1);
    const place = point && !point.hidden && locate(point);
    const view = doc()?.defaultView;
    if (!cursor || !place || !view) return;
    const reducedMotion = view.matchMedia("(prefers-reduced-motion: reduce)").matches;
    view.scrollBy({
      left: place.x - view.innerWidth / 2,
      top: place.y - view.innerHeight / 2,
      behavior: reducedMotion ? "instant" : "smooth",
    });
    if (!reducedMotion)
      cursor.label.animate(
        [
          { transform: "scale(1)" },
          { transform: "scale(1.25)" },
          { transform: "scale(1)" },
        ],
        { duration: 600, delay: 300, easing: "ease-in-out" },
      );
  }

  return { receive, clear, follow, refresh };
}
