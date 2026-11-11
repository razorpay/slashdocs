import {
  describeAnchor,
  resolveAnchor,
  type CommentAnchor,
} from "./anchoring/index.ts";
import { TextRange } from "./anchoring/text-range.ts";
import {
  elementAtPath,
  MAX_VIEW_FRACTION,
  pathOf,
  scrollerOf,
  sharedElement,
} from "./cursors.ts";
import { covered, holds, scrollBehavior, textLines, viewOf } from "./dom.ts";

// Comment pins: point comments drawn over the document, in the bridge window,
// as live cursors are. A pin names an element and a spot in its box. On each
// frame that the document moves, a pin reads the box of its element, so it
// stays on the same content at any width or scroll, and in a document that
// zooms itself. A pin whose element is gone shows at its spot in the page,
// marked as moved. The frame gets no comment text: only ids, initials, colors
// and points.

// A spot in an element, as repo.AnchorPoint stores it, and in the page.
export type PinPoint = {
  target?: string;
  path?: string;
  label?: string;
  x: number;
  y: number;
  page_x?: number;
  page_y?: number;
  viewport_w?: number;
};
// A point and the start of its element's text, which finds the element again
// when its target and path no longer do.
export type PinAnchor = CommentAnchor & { point: PinPoint };
export type Pin = {
  id: string;
  anchor: PinAnchor;
  initials: string;
  replies: number;
  draft: boolean;
  // This reader may drag the pin to a new spot.
  movable: boolean;
  // The author's color, as their cursor has it.
  color: string;
  // The reader did not read the thread.
  unread: boolean;
};
export type PinRect = { left: number; top: number; width: number; height: number };

const TARGET = /^[A-Za-z0-9_.:-]{1,128}$/;
const PATH = /^(\d{1,5}(\.\d{1,5}){0,63})?$/;
const MAX_PINS = 500;
// The start of an element's text that a pin keeps, as a quote.
const QUOTE_LENGTH = 64;
const MAX_LABEL = 128;
// An element smaller than this on a side takes no pin: its container does.
const MIN_PIN_BOX = 8;
// The page spot of a pin is at most this many pixels into the page.
const MAX_PAGE = 10_000_000;
// A press that moves less than this opens a pin; more drags it.
const PRESS_SLOP = 4;
// Pins closer than this on screen merge into one cluster.
export const CLUSTER_RADIUS = 28;
const PIN_SIZE = 28;
// A face away from its tip is at least GAP and at most REACH from it.
const GAP = 8;
const REACH = PIN_SIZE * 3;
// The rim of a face may lie this far into the box of a line of text, whose
// top and bottom hold little ink.
const SLACK = 4;
// A tip that comes to the edge of the page stays this far in, so its pointer
// shows.
const EDGE = 4;
// While placing, the cursor is a pin of the same size and shape as the pins
// it leaves, whose tip (bottom left) marks the spot, with a crosshair fallback.
const PLACE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><path d="M1 14A13 13 0 0 1 27 14A13 13 0 0 1 14 27H4A3 3 0 0 1 1 24Z" fill="#2563eb" stroke="white" stroke-width="2"/><path d="M14 9.5v9M9.5 14h9" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>',
)}") 1 27, crosshair`;
const SVG_NS = "http://www.w3.org/2000/svg";
// The label of a pin in a page margin starts so, and names the block beside it.
const BESIDE = "Beside ";
// These elements take a pin of their own, though they hold no text.
const MEDIA = /^(img|svg|canvas|video|picture|iframe|object|embed)$/;
// The face of a pin: where its box is from its tip, and its shape. A face
// beside its tip turns from it, with that corner pointed: up and right
// first, then up and left, down and right, and down and left. A face away
// from its tip is round, with a pointer to the tip.
type Face = { x: number; y: number; turn: string };
const TURNS: Face[] = [
  { x: 0, y: -PIN_SIZE, turn: "" },
  { x: -PIN_SIZE, y: -PIN_SIZE, turn: "left" },
  { x: 0, y: 0, turn: "down" },
  { x: -PIN_SIZE, y: 0, turn: "down left" },
];
// The rows of a grid of 4px that faces away from a tip can lie on.
const ROWS = Array.from(
  { length: (PIN_SIZE + REACH * 2) / 4 + 1 },
  (_, i) => i * 4 - PIN_SIZE - REACH,
);

// awayFaces gives the faces away from a tip, at most REACH from it, whose
// tops are at the given rows from it, nearest first, then the higher, then
// the more right.
function awayFaces(rows: number[]): Face[] {
  const faces: (Face & { gap: number })[] = [];
  for (const y of rows)
    for (const x of ROWS) {
      // From the tip to the nearest point of the face.
      const gap = Math.hypot(
        Math.max(x, -x - PIN_SIZE, 0),
        Math.max(y, -y - PIN_SIZE, 0),
      );
      if (gap >= GAP && gap <= REACH) faces.push({ x, y, turn: "away", gap });
    }
  return faces.sort((a, b) => a.gap - b.gap || a.y - b.y || b.x - a.x);
}

// The keys that move the ring of keyboard placing, and which way.
const STEPS: Record<string, number> = {
  ArrowDown: 1,
  ArrowRight: 1,
  ArrowUp: -1,
  ArrowLeft: -1,
};
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
// A label is one line of at most MAX_LABEL characters, without control ones.
const labelText = (s: string) => normalize(s.replace(CONTROL, " ")).slice(0, MAX_LABEL);
const within = (n: unknown, min: number, max: number): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= min && n <= max;
const fraction = (n: unknown): n is number =>
  within(n, -MAX_VIEW_FRACTION, MAX_VIEW_FRACTION);
// fractionOf gives offset as a fraction of size, to four decimals, which is
// below 0 or above 1 outside the size, up to the bound that the server takes.
const fractionOf = (offset: number, size: number) =>
  size > 0
    ? Math.min(
        MAX_VIEW_FRACTION,
        Math.max(-MAX_VIEW_FRACTION, Math.round((offset / size) * 1e4) / 1e4),
      )
    : 0;
const text = (v: unknown, max: number) =>
  typeof v === "string" ? v.slice(0, max) : undefined;

// parsePins accepts pins from the app and drops anything malformed.
export function parsePins(value: unknown): Pin[] {
  if (!Array.isArray(value)) return [];
  const out: Pin[] = [];
  for (const raw of value.slice(0, 10_000)) {
    const p = raw as Record<string, unknown> | null;
    const a = p?.anchor as Record<string, unknown> | undefined;
    const point = a?.point as Record<string, unknown> | undefined;
    if (!p || typeof p.id !== "string" || !point) continue;
    const {
      target = "",
      path = "",
      label = "",
      x,
      y,
      page_x,
      page_y,
      viewport_w,
    } = point;
    if (typeof target !== "string" || (target && !TARGET.test(target))) continue;
    if (typeof path !== "string" || !PATH.test(path)) continue;
    if (!fraction(x) || !fraction(y)) continue;
    const page = within(page_x, 0, MAX_PAGE) &&
      within(page_y, 0, MAX_PAGE) &&
      within(viewport_w, 0, MAX_PAGE) &&
      viewport_w > 0 && { page_x, page_y, viewport_w };
    out.push({
      id: p.id.slice(0, 200),
      anchor: {
        quote: text(a?.quote, 4096),
        prefix: text(a?.prefix, 256),
        suffix: text(a?.suffix, 256),
        start_offset: typeof a?.start_offset === "number" ? a.start_offset : undefined,
        end_offset: typeof a?.end_offset === "number" ? a.end_offset : undefined,
        point: { target, path, label: text(label, MAX_LABEL), x, y, ...page },
      },
      initials: text(p.initials, 2) ?? "",
      replies: typeof p.replies === "number" ? Math.max(0, Math.floor(p.replies)) : 0,
      draft: p.draft === true,
      movable: p.movable === true,
      unread: p.unread === true,
      color:
        typeof p.color === "string" && /^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : "",
    });
  }
  return out;
}

// clusterPins groups pins whose screen positions are within r of a seed, in
// the given order. Seeds keep their own position, so clusters do not jump.
export function clusterPins<T extends { id: string; x: number; y: number }>(
  pins: T[],
  r: number,
): { seed: T; members: T[] }[] {
  const clusters: { seed: T; members: T[] }[] = [];
  const grid = new Map<string, { seed: T; members: T[] }[]>();
  for (const pin of pins) {
    const cx = Math.floor(pin.x / r);
    const cy = Math.floor(pin.y / r);
    let joined: { seed: T; members: T[] } | undefined;
    for (let dx = -1; dx <= 1 && !joined; dx++)
      for (let dy = -1; dy <= 1 && !joined; dy++)
        joined = grid
          .get(`${cx + dx},${cy + dy}`)
          ?.find((c) => Math.hypot(c.seed.x - pin.x, c.seed.y - pin.y) <= r);
    if (joined) {
      joined.members.push(pin);
      continue;
    }
    const fresh = { seed: pin, members: [pin] };
    clusters.push(fresh);
    const key = `${cx},${cy}`;
    grid.set(key, [...(grid.get(key) ?? []), fresh]);
  }
  return clusters;
}

// pointAt names the spot at a point in the viewport, on el or else on the
// innermost element there: the element by its target and path, fractions of
// its box, a label, and the start of its text, and the spot in the page. A
// spot beside the blocks, as in a page margin, is on the block at its height,
// named as beside it. It is null outside the document.
export function pointAt(
  d: Document,
  x: number,
  y: number,
  at?: Element,
): PinAnchor | null {
  const body = d.body;
  const view = d.defaultView;
  if (!body || !view || !d.elementFromPoint(x, y)) return null;
  const spot = at ?? spotElement(d, x, y);
  const el = (spot === body && blockBeside(d, x, y)) || spot;
  const box = el.getBoundingClientRect();
  const named = el.getAttribute("data-slashdocs-target") || el.id;
  // The body is found by its empty path, and its text start changes often.
  const quote = (el !== body && elementQuote(body, el)) || { quote: "" };
  const name = labelOf(el, !!quote.quote);
  const label = el === spot ? name : labelText(`${BESIDE}“${name || quote.quote}”`);
  return {
    ...quote,
    point: {
      ...(TARGET.test(named) && { target: named }),
      path: pathOf(el),
      ...(label && { label }),
      x: fractionOf(x - box.left, box.width),
      y: fractionOf(y - box.top, box.height),
      page_x: Math.round(Math.max(0, x + view.scrollX) * 10) / 10,
      page_y: Math.round(Math.max(0, y + view.scrollY) * 10) / 10,
      viewport_w: view.innerWidth,
    },
  };
}

// spotElement gives the element that takes a pin at a point in the viewport:
// the innermost one under it whose box holds the point and is at least
// MIN_PIN_BOX on each side, or else the body, also for a spot on the html
// element below a short body. The pin stays at the point, also when that is
// outside the body's box, as in a page margin.
function spotElement(d: Document, x: number, y: number): Element {
  const body = d.body!;
  for (
    let el = sharedElement(d, d.elementFromPoint(x, y));
    el && el !== body && body.contains(el);
    el = el.parentElement
  ) {
    const box = el.getBoundingClientRect();
    if (box.width >= MIN_PIN_BOX && box.height >= MIN_PIN_BOX && inside(box, x, y))
      return el;
  }
  return body;
}

// blockBeside gives the block of d whose height holds y, nearest to x, if
// any.
function blockBeside(d: Document, x: number, y: number): Element | undefined {
  const gap = (el: Element) => {
    const box = el.getBoundingClientRect();
    return box.top <= y && y <= box.bottom
      ? Math.max(box.left - x, x - box.right, 0)
      : Infinity;
  };
  const [nearest] = pinBlocks(d)
    .map((el) => ({ el, gap: gap(el) }))
    .filter((b) => b.gap < Infinity)
    .sort((a, b) => a.gap - b.gap);
  return nearest?.el;
}

// pinBlocks gives the blocks of a document that take a pin from the keyboard,
// in document order: each element laid out as a block, at least MIN_PIN_BOX
// on each side, with text of its own or no other block in it, and each image
// or other media. The bridge's own controls are not blocks.
export function pinBlocks(d: Document): Element[] {
  const view = d.defaultView;
  if (!view || !d.body) return [];
  const block = (el: Element) =>
    !/^(inline|contents|none)$/.test(view.getComputedStyle(el).display);
  const ownText = (el: Element) =>
    Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent!.trim());
  return Array.from(d.body.querySelectorAll("*")).filter((el) => {
    if (el.parentElement?.closest("svg")) return false;
    if (el.closest('[class*="slashdocs-"],[data-slashdocs-injected]')) return false;
    const box = el.getBoundingClientRect();
    if (box.width < MIN_PIN_BOX || box.height < MIN_PIN_BOX) return false;
    if (MEDIA.test(el.localName)) return true;
    if (!block(el) || !el.textContent?.trim()) return false;
    return ownText(el) || !Array.from(el.children).some(block);
  });
}

// labelOf names an element for a reader: by its accessible name, or a
// container, such as a section, a card or the body, by its first heading, or
// the body by the start of its text, or an element without text, such as an
// image, by its tag.
function labelOf(el: Element, hasText: boolean): string {
  const text = (node: Element | null) => normalize(node?.textContent ?? "");
  const label =
    el.getAttribute("aria-label") ||
    el.getAttribute("alt") ||
    el.getAttribute("title") ||
    text(el.querySelector("h1,h2,h3,h4,h5,h6")) ||
    (hasText
      ? ""
      : (el === el.ownerDocument.body && text(el).slice(0, QUOTE_LENGTH)) ||
        el.localName);
  return labelText(label);
}

// elementQuote describes the start of an element's text as a text anchor.
function elementQuote(body: HTMLElement, el: Element): CommentAnchor | null {
  const range = el.ownerDocument.createRange();
  range.selectNodeContents(el);
  try {
    const { start, end } = TextRange.fromRange(range).relativeTo(body);
    const raw = el.textContent ?? "";
    const from = start.offset + raw.length - raw.trimStart().length;
    const to = Math.min(end.offset, from + QUOTE_LENGTH);
    return to > from
      ? describeAnchor(body, TextRange.fromOffsets(body, from, to).toRange())
      : null;
  } catch {
    return null;
  }
}

// pinElement finds a pin's element: by its target, else by its path while
// the element there still starts with the quote, or, for an element without
// text, still has its label, else by the quote. Among the elements that
// start with a found quote, it takes the one as deep as the path, else the
// innermost. A pin with neither target nor path is on the body.
export function pinElement(d: Document, a: PinAnchor): Element | null {
  const { target, path = "" } = a.point;
  if (!target && !path) return d.body;
  if (target)
    for (const el of [
      d.querySelector(`[data-slashdocs-target="${target}"]`),
      d.getElementById(target),
    ])
      if (el) return el;
  const quote = normalize(a.quote ?? "");
  const startsWithQuote = (el: Element) =>
    normalize(el.textContent ?? "").startsWith(quote);
  const atPath = path || !target ? elementAtPath(d, path) : undefined;
  const same = (el: Element) =>
    quote ? startsWithQuote(el) : labelOf(el, false) === (a.point.label ?? "");
  if (atPath && same(atPath)) return atPath;
  const body = d.body;
  const range = quote && body ? resolveAnchor(body, a) : null;
  if (!body || !range) return null;
  // From the start: an end on a node boundary resolves into the next node.
  const node = range.startContainer;
  const candidates: Element[] = [];
  for (
    let el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    el && el !== body && body.contains(el);
    el = el.parentElement
  )
    if (startsWithQuote(el)) candidates.push(el);
  const depth = path ? path.split(".").length : 0;
  return (
    candidates.find((el) => pathOf(el).split(".").length === depth) ??
    candidates[0] ??
    null
  );
}

// One shape for pins and clusters: a 28px bubble with its tip at the corner
// that its face turns from, or round with a pointer when its face is away
// from its tip, a 2px white rim, a 24px face. The pointer ends in an open
// ring on the tip, so that the letter under the tip shows. A touch screen
// gets a 40px hit area around it. A cluster wears its first pin's color,
// with a second rim behind it for the others. An open moved pin wears one
// ring: the active one, dashed. Glyphs are centred on their cap height
// (text-box), so initials, digits and "+" sit in the optical middle.
// Pins sit on the document, not on the app, so they keep this light frame in
// both app themes.
const FOCUS_RING = "outline:2px solid #2563eb;outline-offset:2px";
const SHADOW =
  "0 0 0 .5px rgba(0,0,0,.14),0 1px 2px rgba(0,0,0,.12),0 3px 8px rgba(0,0,0,.1)";
const CSS = `
.sd-pins{position:fixed;inset:0;pointer-events:none;z-index:2147483645;overflow:hidden}
.sd-pin,.sd-cluster{all:unset;position:absolute;left:0;top:0;box-sizing:border-box;width:${PIN_SIZE}px;height:${PIN_SIZE}px;padding:2px;border-radius:${PIN_SIZE / 2}px ${PIN_SIZE / 2}px ${PIN_SIZE / 2}px 3px;background:#fff;box-shadow:${SHADOW};pointer-events:auto;cursor:pointer;will-change:translate;transition:box-shadow 150ms ease,scale 150ms cubic-bezier(.23,1,.32,1),opacity 150ms ease}
:is(.sd-pin,.sd-cluster)[data-turn=left]{border-radius:${PIN_SIZE / 2}px ${PIN_SIZE / 2}px 3px ${PIN_SIZE / 2}px}
:is(.sd-pin,.sd-cluster)[data-turn=down]{border-radius:3px ${PIN_SIZE / 2}px ${PIN_SIZE / 2}px}
:is(.sd-pin,.sd-cluster)[data-turn="down left"]{border-radius:${PIN_SIZE / 2}px 3px ${PIN_SIZE / 2}px ${PIN_SIZE / 2}px}
:is(.sd-pin,.sd-cluster)[data-turn=away]{border-radius:50%}
.sd-pins s{display:none;position:absolute;z-index:-1;left:50%;top:50%;width:calc(var(--len) - 3.5px);height:1.5px;margin-top:-.75px;background:var(--c,#6366f1);transform-origin:0 50%;rotate:var(--angle);pointer-events:none}
.sd-pins [data-turn=away]>s{display:block}
.sd-pins s::after{content:"";position:absolute;right:-7px;top:-2.75px;box-sizing:border-box;width:7px;height:7px;border:1.5px solid var(--c,#6366f1);border-radius:50%;box-shadow:0 0 0 1px #fffc}
@media (pointer:coarse),(max-width:639.98px){.sd-pin::before,.sd-cluster::before{content:"";position:absolute;inset:-6px;border-radius:50%}}
.sd-pin[data-moved]{outline:1.5px dashed var(--c,#6366f1);outline-offset:1.5px}
.sd-pin:focus-visible,.sd-cluster:focus-visible{${FOCUS_RING}}
.sd-pin>b,.sd-cluster>b{display:grid;place-items:center;width:100%;height:100%;border-radius:50%;background:var(--c,#6366f1);color:#fff;font:600 11px/1 system-ui,-apple-system,sans-serif;font-variant-numeric:tabular-nums;text-box:trim-both cap alphabetic}
.sd-cluster{box-shadow:4px -4px 0 -1px #fff,4px -4px 0 0 rgba(0,0,0,.2),${SHADOW}}
.sd-cluster[data-many]>b{font-size:9.5px;letter-spacing:-.02em}
.sd-pin[data-active],.sd-cluster[data-active]{box-shadow:0 0 0 2px #fff,0 0 0 3.5px #2563eb,0 3px 10px rgba(37,99,235,.3)}
.sd-pin[data-moved][data-active]{outline:2px dashed #2563eb;box-shadow:${SHADOW}}
.sd-pin[data-draft]>b{background:#fff;color:var(--c,#2563eb);box-shadow:inset 0 0 0 1.5px currentColor}
.sd-pin>i{position:absolute;right:-5px;top:-4px;display:grid;place-items:center;min-width:14px;height:14px;padding:0 3px;box-sizing:border-box;border-radius:7px;background:#ef4444;color:#fff;font:600 9px/1 system-ui,-apple-system,sans-serif;font-style:normal;font-variant-numeric:tabular-nums;text-box:trim-both cap alphabetic;box-shadow:0 0 0 1.5px #fff}
.sd-pin[data-pressed],.sd-cluster:active{scale:.96}
:is(.sd-pin,.sd-cluster)[data-unread]::after{content:"";position:absolute;right:-2px;top:-2px;width:8px;height:8px;border-radius:50%;background:#2563eb;box-shadow:0 0 0 1.5px #fff}
.sd-pin[data-unread]>i{background:#2563eb}
.sd-pin[data-unread]:has(>i)::after{display:none}
.sd-pin[data-dragging]{cursor:grabbing;scale:1.1;transition:none;box-shadow:0 0 0 2px #fff,0 0 0 3.5px #2563eb,0 10px 22px rgba(0,0,0,.22)}
@media (hover:hover) and (pointer:fine){.sd-pin:not([data-pressed]):not([data-dragging]):hover,.sd-cluster:hover{scale:1.06}}
@media (prefers-reduced-motion:no-preference){.sd-pin[data-new],.sd-cluster[data-new]{animation:sd-pin-in 180ms cubic-bezier(.23,1,.32,1)}}
@media (prefers-reduced-motion:no-preference){.sd-pin[data-bump]{animation:sd-pin-bump 250ms cubic-bezier(.23,1,.32,1)}.sd-pin[data-bump]::after,.sd-pin[data-bump]>i{animation:sd-dot-in 100ms 250ms both}}
@media (prefers-reduced-motion:reduce){.sd-pin,.sd-cluster{transition:none}.sd-pin[data-bump]::after,.sd-pin[data-bump]>i{animation:sd-dot-in 100ms both}}
@keyframes sd-pin-in{from{opacity:0;scale:.9}}
@keyframes sd-pin-bump{50%{scale:1.12}}
@keyframes sd-dot-in{from{opacity:0}}
.sd-place-hint{position:fixed;left:50%;top:12px;z-index:2147483646;translate:-50% 0;padding:6px 12px;border-radius:999px;background:#18181b;color:#fff;font:500 12px/1.4 system-ui,-apple-system,sans-serif;white-space:nowrap;box-shadow:${SHADOW};pointer-events:none}
@media (prefers-reduced-motion:no-preference){.sd-place-hint{animation:sd-place-hint-in 180ms cubic-bezier(.23,1,.32,1)}}
@keyframes sd-place-hint-in{from{opacity:0;translate:-50% -4px}}
.sd-place-ring{position:fixed;left:0;top:0;z-index:2147483644;box-sizing:border-box;border-radius:4px;${FOCUS_RING};pointer-events:none}
@media print{.sd-pins,.sd-place-hint,.sd-place-ring{display:none}}
`;

// plusIcon draws the "+" that an unsent pin shows.
function plusIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "12");
  svg.setAttribute("height", "12");
  svg.setAttribute("viewBox", "0 0 12 12");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M6 1.5v9M1.5 6h9");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.75");
  path.setAttribute("stroke-linecap", "round");
  svg.appendChild(path);
  return svg;
}

// pinLabel names a pin for assistive tech.
function pinLabel(pin: Pin, moved: boolean): string {
  if (pin.draft) return "Unsent comment";
  const on = pin.anchor.point.label || normalize(pin.anchor.quote ?? "").slice(0, 40);
  const label = on.startsWith(BESIDE)
    ? ` beside ${on.slice(BESIDE.length)}`
    : on
      ? ` on ${on}`
      : "";
  const replies = pin.replies === 1 ? "1 reply" : `${pin.replies} replies`;
  return `Comment${label}${moved ? ", moved" : ""}${pin.replies ? `, ${replies}` : ""}${pin.unread ? ", unread" : ""}`;
}

// A pin on screen: its element and the ancestors that clip it, or no element
// when the pin shows at its page spot, where its tip was on the last frame,
// and its face, once it is known for sure.
type Placed = {
  pin: Pin;
  el: Element | null;
  clips: Element[];
  x: number;
  y: number;
  shown: boolean;
  face?: Face;
  sure?: boolean;
};

// spotOf gives where a pin's tip is in the viewport: at its spot in its
// element's box, or else at its page spot, whose x follows the viewport's
// width as the fractions of a box do. A spot off its element or off the page,
// as in a margin that a narrow screen does not have, or below a page that got
// shorter, comes to the nearest edge of the page in view. It is null for a
// pin that has neither.
function spotOf(p: Placed, view: Window): { x: number; y: number } | null {
  const box = p.el?.getBoundingClientRect();
  const { x, y, page_x, page_y, viewport_w } = p.pin.anchor.point;
  const onBox = box && box.width > 0 && box.height > 0;
  const spot = onBox
    ? { x: box.left + x * box.width, y: box.top + y * box.height }
    : page_x !== undefined && page_y !== undefined && viewport_w
      ? {
          x: (page_x * view.innerWidth) / viewport_w - view.scrollX,
          y: page_y - view.scrollY,
        }
      : null;
  if (!spot || (onBox && x >= 0 && x <= 1 && y >= 0 && y <= 1)) return spot;
  const room = roomOf(view.document);
  const clamp = (n: number, min: number, max: number) =>
    Math.min(Math.max(n, min), max);
  return {
    x: clamp(spot.x, room.left + EDGE, room.right - EDGE),
    y: clamp(spot.y, room.top, room.bottom),
  };
}

// roomOf gives the part of the page of d that a pin stays in: the page across
// the viewport, and all of it down, without the room after it that the app
// asks for.
function roomOf(d: Document): DOMRect {
  const view = d.defaultView!;
  const { scrollWidth, scrollHeight } = d.documentElement;
  const left = Math.max(-view.scrollX, 0);
  const right = Math.min(scrollWidth - view.scrollX, viewOf(d).right);
  return new DOMRect(left, -view.scrollY, right - left, scrollHeight - covered(d));
}

// faceOf gives the face of a pin whose tip is at x, y, in the room of d: the
// first turn that covers no text, else the nearest face away from the tip
// that covers none, else the turn that covers the least. It is sure unless a
// nearer face is off screen, where the text is not known.
function faceOf(d: Document, x: number, y: number): { face: Face; sure: boolean } {
  const screen = viewOf(d);
  const room = roomOf(d);
  const reach = PIN_SIZE + REACH;
  const lines = textLines(d, new DOMRect(x - reach, y - reach, reach * 2, reach * 2));
  const boxOf = (f: Face) => new DOMRect(x + f.x, y + f.y, PIN_SIZE, PIN_SIZE);
  const cover = (f: Face) => {
    const box = boxOf(f);
    return lines.reduce((sum, line) => {
      const w =
        Math.min(box.right - SLACK, line.right) - Math.max(box.left + SLACK, line.left);
      const h =
        Math.min(box.bottom - SLACK, line.bottom) - Math.max(box.top + SLACK, line.top);
      return sum + Math.max(w, 0) * Math.max(h, 0);
    }, 0);
  };
  // Besides the grid, the faces whose rims lie in the slack of a line, as
  // between two paragraphs, where a grid can miss the room.
  const rows = lines.flatMap((line) => [
    line.bottom - SLACK - y,
    line.top + SLACK - PIN_SIZE - y,
  ]);
  let sure = true;
  for (const face of TURNS.concat(awayFaces(ROWS.concat(rows)))) {
    const box = boxOf(face);
    if (!holds(room, box)) continue;
    if (!holds(screen, box)) sure = false;
    else if (!cover(face)) return { face, sure };
  }
  const fits = TURNS.filter((f) => holds(room, boxOf(f)));
  const least = (fits.length ? fits : TURNS).reduce((a, b) =>
    cover(b) < cover(a) ? b : a,
  );
  return { face: least, sure };
}

// faceBox gives the box of a placed pin's face in the viewport.
function faceBox({ x, y, face = TURNS[0] }: { x: number; y: number; face?: Face }) {
  return new DOMRect(x + face.x, y + face.y, PIN_SIZE, PIN_SIZE);
}

// put moves a pin's button so that its face is at face from the tip at x, y,
// with its pointer to the tip, and hover, press and drag scale it around the
// tip.
function put(b: HTMLElement, x: number, y: number, face: Face) {
  b.style.translate = `${x + face.x}px ${y + face.y}px`;
  b.style.transformOrigin = `${-face.x}px ${-face.y}px`;
  b.dataset.turn = face.turn;
  const [dx, dy] = [-face.x - PIN_SIZE / 2, -face.y - PIN_SIZE / 2];
  b.style.setProperty("--len", `${Math.hypot(dx, dy)}px`);
  b.style.setProperty("--angle", `${Math.atan2(dy, dx)}rad`);
}

export type PinHost = {
  doc: () => Document | null;
  post: (message: Record<string, unknown>) => void;
  // laidOut tells the bridge that the pins found their elements again.
  laidOut: () => void;
};

// createPinLayer draws the pins of one bridge, and places new ones.
export function createPinLayer(host: PinHost) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const layer = document.createElement("div");
  layer.className = "sd-pins";
  document.body.appendChild(layer);
  // A wheel over a pin goes to the document under it, which scrolls unless
  // the document takes the wheel itself.
  layer.addEventListener(
    "wheel",
    (e) => {
      const view = d?.defaultView;
      const under = d?.elementFromPoint(e.clientX, e.clientY);
      if (!view || !under) return;
      e.preventDefault();
      const forwarded = new view.WheelEvent("wheel", e);
      if (under.dispatchEvent(forwarded))
        scrollerOf(under).scrollBy(e.deltaX, e.deltaY);
    },
    { passive: false },
  );
  // The keys of placing come to this window when the app gives it the focus.
  window.addEventListener("keydown", (e) => placeKey(e), true);

  let d: Document | null = null;
  let pins: Pin[] = [];
  let active: string | undefined;
  let placed: Placed[] = [];
  let shown = new Set<string>();
  // The button that each pin was in at the last render: its own id, or its
  // cluster's ids.
  let drawnIn = new Map<string, string>();
  let frame = 0;
  let stable = 0;
  // What the layer last drew, or null to draw again.
  let lastSignature: string | null = null;
  let lastPositions: string | null = null;
  let lastResults = "";
  // The pin held down, from press to release. Its button must not be
  // replaced meanwhile, or the capture, the drag and the click are lost.
  let holding: string | null = null;
  // The drag in progress, which the app cancels when the pointer is let go
  // outside the frame, where the frame hears no release.
  let cancelDrag: (() => void) | null = null;
  // Where the dragged pin is, which its popover follows.
  let dragged: { id: string; x: number; y: number; face: Face } | null = null;
  // A pin keeps the face that it was dragged by where it is dropped, until
  // the text moves on a resize.
  const droppedFaces = new Map<string, Face>();
  // The pin pressed last, which is already in view when the app opens it.
  let pressed: string | undefined;
  // The pins that became unread, which bump when they draw next.
  const bumps = new Set<string>();
  let placing = false;
  // The pin that placing moves, or none to place a new one.
  let moving: string | undefined;
  let placeStyle: HTMLStyleElement | null = null;
  let placeHint: HTMLElement | null = null;
  // While placing from the keyboard: the blocks it steps through, the one in
  // its ring, and the ring.
  let blocks: Element[] | null = null;
  let ringed: Element | null = null;
  const ring = document.createElement("div");
  ring.className = "sd-place-ring";
  let observer: MutationObserver | null = null;
  // Listeners on the current document, removed when another one loads.
  let detach = new AbortController();

  // layout finds each pin's element and tells the app which pins are not in
  // this version.
  function layout() {
    if (!d) return;
    const doc = d;
    const before = new Map(placed.map((p) => [p.pin.id, p]));
    placed = [];
    const results: { id: string; placed: boolean; moved: boolean }[] = [];
    for (const pin of pins) {
      const kept = before.get(pin.id);
      const same =
        kept?.el?.isConnected &&
        JSON.stringify(kept.pin.anchor) === JSON.stringify(pin.anchor);
      const el = same ? kept.el : pinElement(doc, pin.anchor);
      // A pin whose element is gone shows at its page spot, as moved.
      const moved = !el && pin.anchor.point.viewport_w !== undefined;
      results.push({ id: pin.id, placed: !!el || moved, moved });
      if ((el || moved) && placed.length < MAX_PINS)
        placed.push(
          same
            ? { ...kept, pin }
            : { pin, el, clips: el ? clipsOf(el) : [], x: 0, y: 0, shown: false },
        );
    }
    const key = JSON.stringify(results);
    if (key !== lastResults) host.post({ type: "slashdocs:pins-result", results });
    lastResults = key;
    lastSignature = null;
    lastPositions = null;
    // Drawn at once, so a new pin shows, and has its spot for its popover,
    // before the next frame.
    draw();
    schedule();
    host.laidOut();
  }

  // draw moves each pin to its spot, and regroups the pins when they moved
  // apart or together.
  function draw() {
    const view = d?.defaultView;
    if (!view) return;
    const screen = viewOf(view.document);
    for (const p of placed) {
      const spot = spotOf(p, view);
      p.x = spot?.x ?? 0;
      p.y = spot?.y ?? 0;
      p.shown =
        !!spot &&
        inside(screen, p.x, p.y) &&
        p.clips.every((clip) => inside(clip.getBoundingClientRect(), p.x, p.y));
      // Measured on screen, where the text around the pin can be found.
      const dropped = droppedFaces.get(p.pin.id);
      if (p.shown && !p.sure)
        ({ face: p.face, sure: p.sure } = dropped
          ? { face: dropped, sure: true }
          : faceOf(view.document, p.x, p.y));
    }
    placeRing();
    const positions = placed
      .map((p) => [p.x.toFixed(1), p.y.toFixed(1), p.face?.x, p.face?.y].join())
      .join(";");
    if (positions === lastPositions) {
      stable++;
      return;
    }
    stable = 0;
    lastPositions = positions;
    render();
    const byId = new Map(placed.map((p) => [p.pin.id, p]));
    for (const el of Array.from(layer.children) as HTMLElement[]) {
      const at = byId.get(el.dataset.id ?? "");
      // A dragged pin is under the pointer, which alone moves it: put back at
      // its spot here, it would show at both until the next pointer move.
      if (at && at.pin.id !== dragged?.id) put(el, at.x, at.y, at.face ?? TURNS[0]);
    }
  }

  function render() {
    if (holding) return;
    // Drafts never join a cluster. The open pin stays in its cluster, which
    // it would cover otherwise.
    const keep = new Set(pins.filter((p) => p.draft).map((p) => p.id));
    const visible = placed.filter((p) => p.shown).map((p) => ({ ...p, id: p.pin.id }));
    const clusters = clusterPins(
      visible.filter((p) => !keep.has(p.id)),
      CLUSTER_RADIUS,
    ).concat(
      visible.filter((p) => keep.has(p.id)).map((p) => ({ seed: p, members: [p] })),
    );
    // Keep the buttons when nothing about them changed: replacing one
    // between a press and its release would swallow the click.
    const signature = clusters
      .map(({ seed, members }) =>
        [
          seed.id,
          ...members.map(({ pin, el }) =>
            [
              pin.id,
              pin.initials,
              pin.replies,
              pin.draft,
              pin.unread,
              pin.id === active,
              !el,
            ].join(":"),
          ),
        ].join("+"),
      )
      .join("|");
    if (signature === lastSignature) return;
    lastSignature = signature;
    const next = new Set<string>();
    // A rebuilt button takes the keyboard focus over from the old one.
    const focused = layer.contains(document.activeElement)
      ? (document.activeElement as HTMLElement).dataset.id
      : undefined;
    // A button pops in when it is new, or when its pins merge into it or
    // split from it.
    const regrouped = (id: string, key: string) =>
      drawnIn.has(id) && drawnIn.get(id) !== key;
    const drawn = new Map<string, string>();
    layer.replaceChildren(
      ...clusters.map(({ seed, members }) => {
        const key = members.map(({ pin }) => pin.id).join("+");
        members.forEach(({ pin }) => drawn.set(pin.id, key));
        if (members.length > 1)
          return clusterButton(
            seed.id,
            members,
            members.some(({ pin }) => regrouped(pin.id, key)),
          );
        next.add(seed.id);
        return pinButton(
          seed.pin,
          !seed.el,
          !shown.has(seed.id) || regrouped(seed.id, key),
        );
      }),
    );
    drawnIn = drawn;
    if (focused)
      (Array.from(layer.children) as HTMLElement[])
        .find((el) => el.dataset.id === focused)
        ?.focus({ preventScroll: true });
    shown = new Set([...shown, ...next]);
  }

  function pinButton(pin: Pin, moved: boolean, fresh: boolean) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sd-pin";
    b.dataset.id = pin.id;
    if (pin.id === active) b.dataset.active = "";
    if (pin.draft) b.dataset.draft = "";
    if (moved) b.dataset.moved = "";
    if (fresh) b.dataset.new = "";
    if (pin.unread) b.dataset.unread = "";
    // A reply came to a closed thread since the last pins.
    if (bumps.delete(pin.id)) b.dataset.bump = "";
    if (pin.color) b.style.setProperty("--c", pin.color);
    const face = document.createElement("b");
    if (pin.draft) face.appendChild(plusIcon());
    else face.textContent = pin.initials || "?";
    b.append(document.createElement("s"), face);
    if (pin.replies > 0) {
      const count = document.createElement("i");
      count.textContent = String(pin.replies);
      b.appendChild(count);
    }
    b.setAttribute("aria-label", pinLabel(pin, moved));
    pressOrDrag(b, pin);
    return b;
  }

  function clusterButton(id: string, members: { pin: Pin }[], fresh: boolean) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sd-cluster";
    b.dataset.id = id;
    if (members.some(({ pin }) => pin.id === active)) b.dataset.active = "";
    if (members.some(({ pin }) => pin.unread)) b.dataset.unread = "";
    if (fresh) b.dataset.new = "";
    if (members[0].pin.color) b.style.setProperty("--c", members[0].pin.color);
    const count = document.createElement("b");
    count.textContent = members.length > 99 ? "99+" : String(members.length);
    if (members.length > 99) b.dataset.many = "";
    b.append(document.createElement("s"), count);
    b.setAttribute("aria-label", `${members.length} comment threads`);
    // The app lists the cluster's threads next to it.
    const open = () =>
      host.post({
        type: "slashdocs:pin-cluster",
        ids: members.map(({ pin }) => pin.id),
        rect: rectOf(b),
      });
    // A press, not a click: the pins sit over the document frame, and the
    // browser can send the release to the frame underneath.
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      open();
    });
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.detail === 0) open();
    });
    return b;
  }

  // pressOrDrag opens a pin on release, or moves it when the press travels.
  // The pointer is captured, so the release comes back to the pin even
  // though the pin sits over the document frame.
  function pressOrDrag(b: HTMLElement, pin: Pin) {
    const activate = () => {
      pressed = pin.id;
      host.post({ type: "slashdocs:activate", id: pin.id });
    };
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.detail === 0) activate();
    });
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !d) return;
      e.preventDefault();
      e.stopPropagation();
      b.setPointerCapture(e.pointerId);
      holding = pin.id;
      // Pressed look set here, not by :active, which sticks when the release
      // happens outside the frame.
      b.dataset.pressed = "";
      const start = { x: e.clientX, y: e.clientY };
      const from = placed.find((p) => p.pin.id === pin.id);
      let to: { x: number; y: number } | null = null;
      let done = false;
      const putBack = () => {
        to = null;
        finish();
      };
      // Esc while dragging puts the pin back.
      const key = (ev: KeyboardEvent) => {
        if (ev.key !== "Escape" || !to) return;
        ev.preventDefault();
        ev.stopPropagation();
        putBack();
      };
      const views = [window, d.defaultView].filter((v) => !!v);
      for (const v of views) v.addEventListener("keydown", key, true);
      const move = (ev: PointerEvent) => {
        if (!pin.movable || !from) return;
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (!to && Math.hypot(dx, dy) <= PRESS_SLOP) return;
        if (!to) {
          cancelDrag = putBack;
          host.post({ type: "slashdocs:pin-dragging", on: true });
        }
        to = { x: from.x + dx, y: from.y + dy };
        delete b.dataset.pressed;
        b.dataset.dragging = "";
        dragged = { id: pin.id, ...to, face: from.face ?? TURNS[0] };
        put(b, to.x, to.y, dragged.face);
      };
      const finish = () => {
        if (done) return;
        done = true;
        const face = dragged?.face;
        for (const v of views) v.removeEventListener("keydown", key, true);
        if (b.hasPointerCapture(e.pointerId)) b.releasePointerCapture(e.pointerId);
        b.removeEventListener("pointermove", move);
        delete b.dataset.dragging;
        delete b.dataset.pressed;
        holding = null;
        dragged = null;
        lastSignature = null;
        lastPositions = null;
        if (!cancelDrag) activate();
        else {
          cancelDrag = null;
          host.post({ type: "slashdocs:pin-dragging", on: false });
          if (to && face) drop(pin, to, face);
        }
        schedule();
      };
      b.addEventListener("pointermove", move);
      b.addEventListener("pointerup", finish, { once: true });
      b.addEventListener("lostpointercapture", finish, { once: true });
    });
  }

  // drop moves a pin to the spot under its tip, with the face that it was
  // dragged by, or puts it back where no element takes it.
  function drop(pin: Pin, at: { x: number; y: number }, face: Face) {
    const anchor = d && pointAt(d, at.x, at.y);
    if (anchor) move(pin.id, anchor, face);
  }

  // move puts a pin at anchor, with the given face or else the one that
  // fits there. The move shows at once; the app saves it.
  function move(id: string, anchor: PinAnchor, face?: Face) {
    if (face) droppedFaces.set(id, face);
    else droppedFaces.delete(id);
    pins = pins.map((p) => (p.id === id ? { ...p, anchor } : p));
    layout();
    host.post({ type: "slashdocs:pin-move", id, anchor });
  }

  function tick() {
    frame = 0;
    draw();
    // Keep following the document until it rests for a few frames, as when
    // it animates.
    if (stable < 3) schedule();
  }

  // The frame is this window's: one asked of a document's window is lost
  // when the document reloads, and the pins would stop drawing.
  function schedule() {
    if (!d) return;
    stable = 0;
    frame ||= requestAnimationFrame(tick);
  }

  // setPlacing starts or stops placing a pin: a new one, or the pin of the
  // id in move.
  function setPlacing(next: boolean, move?: string) {
    const nextMoving = next ? move : undefined;
    if (!d || (placing === next && moving === nextMoving)) return;
    placing = next;
    moving = nextMoving;
    placeStyle?.remove();
    placeHint?.remove();
    ring.remove();
    placeStyle = placeHint = blocks = ringed = null;
    if (placing) {
      placeStyle = d.createElement("style");
      placeStyle.setAttribute("data-slashdocs-injected", "");
      placeStyle.textContent = `html,html *{cursor:${PLACE_CURSOR}!important;user-select:none!important}`;
      d.head.appendChild(placeStyle);
      placeHint = document.createElement("div");
      placeHint.className = "sd-place-hint";
      placeHint.setAttribute("role", "status");
      placeHint.textContent = `Click ${moving ? "the new spot" : "a spot"}, or use Tab and Enter. Esc to cancel.`;
      layer.after(placeHint);
    }
    host.post({ type: "slashdocs:pin-placing", on: placing, move: moving });
  }

  // place ends placing with a pin at anchor: a new one, or the moved one.
  function place(anchor: PinAnchor | null) {
    const id = moving;
    setPlacing(false);
    if (anchor && id) move(id, anchor);
    else if (anchor) host.post({ type: "slashdocs:pin-place", anchor });
  }

  // placeKey places from the keyboard: Tab and the arrow keys move a ring
  // over the blocks that a click could choose, Enter places the pin on the
  // block in the ring, and Esc stops placing.
  function placeKey(ev: KeyboardEvent) {
    if (!placing || !d) return;
    const step = ev.key === "Tab" ? (ev.shiftKey ? -1 : 1) : (STEPS[ev.key] ?? 0);
    if (!step && ev.key !== "Enter" && ev.key !== "Escape") return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    if (ev.key === "Escape") return setPlacing(false);
    if (ev.key === "Enter") {
      if (!ringed) return;
      // At the top left corner, from where the pin's body covers the least
      // of the block.
      const box = ringed.getBoundingClientRect();
      return place(pointAt(d, box.left, box.top, ringed));
    }
    const list = (blocks ??= pinBlocks(d));
    if (!list.length) return;
    // The first step goes to the first block in view, or back to the last.
    const at = ringed ? list.indexOf(ringed) : -1;
    const inView = (el: Element) => el.getBoundingClientRect().bottom > 0;
    const next =
      at >= 0 ? at + step : step > 0 ? Math.max(0, list.findIndex(inView)) : -1;
    ringed = list[(next + list.length) % list.length];
    ringed.scrollIntoView({ block: "nearest", behavior: scrollBehavior(d) });
    layer.after(ring);
    placeRing();
    schedule();
  }

  // placeRing draws the ring around the block it is on.
  function placeRing() {
    if (!ringed) return;
    const box = ringed.getBoundingClientRect();
    ring.style.translate = `${box.left}px ${box.top}px`;
    ring.style.width = `${box.width}px`;
    ring.style.height = `${box.height}px`;
  }

  // start draws the pins of a newly loaded document.
  function start(doc: Document) {
    detach.abort();
    detach = new AbortController();
    const signal = detach.signal;
    observer?.disconnect();
    setPlacing(false);
    d = doc;
    placed = [];
    const view = doc.defaultView;
    // The document changes its content, as a script that renders it does.
    let relayout = 0;
    observer = new MutationObserver(() => {
      relayout ||= window.requestAnimationFrame(() => {
        relayout = 0;
        layout();
      });
    });
    observer.observe(doc.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    const options = { capture: true, passive: true, signal };
    for (const type of ["scroll", "wheel", "transitionend", "animationend"])
      doc.addEventListener(type, schedule, options);
    // Text moves on a resize, so each pin finds its side again.
    view?.addEventListener(
      "resize",
      () => {
        droppedFaces.clear();
        for (const p of placed) p.sure = false;
        lastPositions = null;
        schedule();
      },
      { signal },
    );
    doc.addEventListener("keydown", placeKey, { capture: true, signal });
    void doc.fonts?.ready.then(schedule);
    // While placing, a press is not a click into the document: it neither
    // moves the editor's caret nor starts a selection.
    doc.addEventListener("pointerdown", (e) => placing && e.preventDefault(), {
      capture: true,
      signal,
    });
    doc.addEventListener("mousedown", (e) => placing && e.preventDefault(), {
      capture: true,
      signal,
    });
    doc.addEventListener(
      "click",
      (e) => {
        if (!placing) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        place(pointAt(doc, e.clientX, e.clientY));
      },
      { capture: true, signal },
    );
    layout();
  }

  // reveal brings the face of a pin into the part of the view that the app
  // leaves clear, unless all of it shows there already. It is false for a pin
  // that is not on this version.
  function reveal(id: string | undefined): boolean {
    const p = placed.find((x) => x.pin.id === id);
    const view = d?.defaultView;
    if (!p || !d || !view) return false;
    const clear = viewOf(d, true);
    if (p.shown && holds(clear, faceBox(p))) return true;
    const behavior = scrollBehavior(d);
    // A block taller than the view, as the body, brings its spot into view.
    if (p.el && p.el.getBoundingClientRect().height < clear.height)
      p.el.scrollIntoView({ block: "center", inline: "nearest", behavior });
    else view.scrollBy({ top: p.y - clear.height / 2, behavior });
    return true;
  }

  // rectOf gives an element's box in this window, which the app places
  // popovers by.
  function rectOf(el: Element): PinRect {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  return {
    start,
    isPlacing: () => placing,
    setPlacing,
    // setPins shows the pins, and brings the open one into view when it was
    // opened elsewhere than on its pin, as from the comments list. A new pin
    // is where it was just placed.
    setPins(next: Pin[], nextActive?: string) {
      const opened = nextActive !== active && nextActive !== pressed;
      const read = new Set(pins.flatMap((p) => (p.unread ? [] : [p.id])));
      for (const p of next) if (p.unread && read.has(p.id)) bumps.add(p.id);
      pins = next;
      active = nextActive;
      pressed = undefined;
      layout();
      if (opened && !pins.find((p) => p.id === nextActive)?.draft) reveal(nextActive);
    },
    reveal,
    // tops gives where the spot of each placed pin is, from the top of the
    // document, for the strip of comment ticks.
    tops(): { id: string; top: number }[] {
      const view = d?.defaultView;
      if (!view) return [];
      return placed.flatMap((p) => {
        const spot = spotOf(p, view);
        return spot ? [{ id: p.pin.id, top: spot.y + view.scrollY }] : [];
      });
    },
    // rect gives where a pin's spot is, for its popover, or null when the pin
    // is not in this version.
    rect(id: string): PinRect | null {
      const p = dragged?.id === id ? dragged : placed.find((x) => x.pin.id === id);
      if (!p) return null;
      const { left, top, width, height } = faceBox(p);
      return { left, top, width, height };
    },
    // releaseOutside puts a dragged pin back when the pointer was let go
    // outside the frame.
    releaseOutside() {
      cancelDrag?.();
    },
  };
}

// clipsOf gives the ancestors of an element under the body that clip it, so
// its pin hides when its spot scrolls out of an inner box.
function clipsOf(el: Element): Element[] {
  const d = el.ownerDocument;
  const out: Element[] = [];
  for (
    let node = el.parentElement;
    node && node !== d.body && d.body?.contains(node);
    node = node.parentElement
  )
    if (
      /auto|scroll|hidden|clip|overlay/.test(
        d.defaultView?.getComputedStyle(node).overflow ?? "",
      )
    )
      out.push(node);
  return out;
}

function inside(r: DOMRect, x: number, y: number): boolean {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}
