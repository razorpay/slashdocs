import {
  describeAnchor,
  resolveAnchor,
  type CommentAnchor,
} from "./anchoring/index.ts";
import { TextRange } from "./anchoring/text-range.ts";
import {
  elementAtPath,
  pathOf,
  scrollerOf,
  sharedChildren,
  sharedElement,
} from "./cursors.ts";
import { caretRange, scrollBehavior } from "./dom.ts";

// Comment pins: point comments drawn over the document, in the bridge window,
// as live cursors are. A pin names an element and a spot in its box. On each
// frame that the document moves, a pin reads the box of its element, so it
// stays on the same content at any width or scroll, and in a document that
// zooms itself. The frame gets no comment text: only ids, initials, colors
// and points.

// A spot in an element, as repo.AnchorPoint stores it.
export type PinPoint = {
  target?: string;
  path?: string;
  label?: string;
  x: number;
  y: number;
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
};
export type PinRect = { left: number; top: number; width: number; height: number };

const TARGET = /^[A-Za-z0-9_.:-]{1,128}$/;
const PATH = /^(\d{1,5}(\.\d{1,5}){0,63})?$/;
const MAX_PINS = 500;
// The start of an element's text that a pin keeps, as a quote.
const QUOTE_LENGTH = 64;
const MAX_LABEL = 128;
// A press that moves less than this opens a pin; more drags it.
const PRESS_SLOP = 4;
// Pins closer than this on screen merge into one cluster.
export const CLUSTER_RADIUS = 28;
const PIN_SIZE = 28;
// While placing, the cursor is a pin of the same size and shape as the pins
// it leaves, whose tip (bottom left) marks the spot, with a crosshair fallback.
const PLACE_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28"><path d="M1 14A13 13 0 0 1 27 14A13 13 0 0 1 14 27H4A3 3 0 0 1 1 24Z" fill="#2563eb" stroke="white" stroke-width="2"/><path d="M14 9.5v9M9.5 14h9" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>',
)}") 1 27, crosshair`;
const SVG_NS = "http://www.w3.org/2000/svg";
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
const fraction = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
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
    const { target = "", path = "", label = "", x, y } = point;
    if (typeof target !== "string" || (target && !TARGET.test(target))) continue;
    if (typeof path !== "string" || !PATH.test(path)) continue;
    if (!fraction(x) || !fraction(y)) continue;
    out.push({
      id: p.id.slice(0, 200),
      anchor: {
        quote: text(a?.quote, 4096),
        prefix: text(a?.prefix, 256),
        suffix: text(a?.suffix, 256),
        start_offset: typeof a?.start_offset === "number" ? a.start_offset : undefined,
        end_offset: typeof a?.end_offset === "number" ? a.end_offset : undefined,
        point: { target, path, label: text(label, MAX_LABEL), x, y },
      },
      initials: text(p.initials, 2) ?? "",
      replies: typeof p.replies === "number" ? Math.max(0, Math.floor(p.replies)) : 0,
      draft: p.draft === true,
      movable: p.movable === true,
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

// pointAt names the spot under a point in the viewport: the element there,
// by its target and path, fractions of its box, a label, and the start of
// its text. It is null where nothing takes a pin.
export function pointAt(d: Document, x: number, y: number): PinAnchor | null {
  const el = spotElement(d, x, y);
  const box = el?.getBoundingClientRect();
  if (!el || !d.body || !box || !(box.width > 0 && box.height > 0)) return null;
  const clamp = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1e4) / 1e4;
  const named = el.getAttribute("data-slashdocs-target") || el.id;
  const quote = elementQuote(d.body, el) ?? { quote: "" };
  const label = labelOf(el, !!quote.quote);
  return {
    ...quote,
    point: {
      ...(TARGET.test(named) && { target: named }),
      path: pathOf(el),
      ...(label && { label }),
      x: clamp((x - box.left) / box.width),
      y: clamp((y - box.top) / box.height),
    },
  };
}

// spotElement gives the element that takes a pin at a point in the viewport:
// the one under it, or, over the body's own margin, the one at the nearest
// text, or else the nearest child of the body. It is never the body, whose
// box moves when its text reflows. A spot outside the element's box goes to
// its edge.
function spotElement(d: Document, x: number, y: number): Element | null {
  const body = d.body;
  const hit = d.elementFromPoint(x, y);
  if (!body || !hit) return null;
  const under = sharedElement(d, hit);
  if (under !== body) return under;
  const caret = caretRange(d, x, y)?.startContainer;
  const atText = sharedElement(
    d,
    caret?.nodeType === 1 ? (caret as Element) : (caret?.parentElement ?? null),
  );
  if (atText !== body) return atText;
  let nearest: Element | null = null;
  let distance = Infinity;
  for (const child of sharedChildren(body)) {
    const r = child.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) continue;
    const away = Math.hypot(
      Math.max(r.left - x, 0, x - r.right),
      Math.max(r.top - y, 0, y - r.bottom),
    );
    if (away < distance) [nearest, distance] = [child, away];
  }
  return nearest;
}

// labelOf names an element for a reader: by its accessible name, or, for an
// element without text, such as an image, by its tag.
function labelOf(el: Element, hasText: boolean): string {
  const label =
    el.getAttribute("aria-label") ||
    el.getAttribute("alt") ||
    el.getAttribute("title") ||
    (hasText ? "" : el.localName);
  return normalize(label.replace(CONTROL, " ")).slice(0, MAX_LABEL);
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
// innermost.
export function pinElement(d: Document, a: PinAnchor): Element | null {
  const { target, path = "" } = a.point;
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
    el && el !== body;
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

// One shape for pins and clusters: a 28px bubble with its tip at the bottom
// left, a 2px white rim, a 24px face. Glyphs are centred on their cap height
// (text-box), so initials, digits and "+" sit in the optical middle.
const SHADOW =
  "0 0 0 .5px rgba(0,0,0,.14),0 1px 2px rgba(0,0,0,.12),0 3px 8px rgba(0,0,0,.1)";
const DARK_SHADOW =
  "0 0 0 .5px rgba(255,255,255,.2),0 1px 2px rgba(0,0,0,.4),0 3px 8px rgba(0,0,0,.4)";
const CSS = `
.sd-pins{position:fixed;inset:0;pointer-events:none;z-index:2147483645;overflow:hidden}
.sd-pin,.sd-cluster{all:unset;position:absolute;left:0;top:0;box-sizing:border-box;width:${PIN_SIZE}px;height:${PIN_SIZE}px;margin-top:-${PIN_SIZE}px;padding:2px;border-radius:${PIN_SIZE / 2}px ${PIN_SIZE / 2}px ${PIN_SIZE / 2}px 3px;background:#fff;box-shadow:${SHADOW};pointer-events:auto;cursor:pointer;will-change:translate;transform-origin:0 100%;transition:box-shadow 150ms ease,scale 150ms cubic-bezier(.23,1,.32,1),opacity 150ms ease}
.sd-pin:focus-visible,.sd-cluster:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.sd-pin>b,.sd-cluster>b{display:grid;place-items:center;width:100%;height:100%;border-radius:50%;background:var(--c,#6366f1);color:#fff;font:600 11px/1 system-ui,-apple-system,sans-serif;font-variant-numeric:tabular-nums;text-box:trim-both cap alphabetic}
.sd-cluster>b{background:#18181b}
.sd-cluster[data-many]>b{font-size:9.5px;letter-spacing:-.02em}
.sd-pin[data-active]{box-shadow:0 0 0 2px #fff,0 0 0 3.5px #2563eb,0 3px 10px rgba(37,99,235,.3)}
.sd-pin[data-draft]>b{background:#fff;color:var(--c,#2563eb);box-shadow:inset 0 0 0 1.5px currentColor}
[data-theme=dark] .sd-pin[data-draft]>b{background:#27272a}
.sd-pin>i{position:absolute;right:-5px;top:-4px;display:grid;place-items:center;min-width:14px;height:14px;padding:0 3px;box-sizing:border-box;border-radius:7px;background:#ef4444;color:#fff;font:600 9px/1 system-ui,-apple-system,sans-serif;font-style:normal;font-variant-numeric:tabular-nums;text-box:trim-both cap alphabetic;box-shadow:0 0 0 1.5px #fff}
.sd-pin[data-pressed],.sd-cluster:active{scale:.96}
.sd-pin[data-dragging]{cursor:grabbing;scale:1.1;transition:none;box-shadow:0 0 0 2px #fff,0 0 0 3.5px #2563eb,0 10px 22px rgba(0,0,0,.22)}
@media (hover:hover) and (pointer:fine){.sd-pin:not([data-pressed]):not([data-dragging]):hover,.sd-cluster:hover{scale:1.06}}
[data-theme=dark] .sd-pin,[data-theme=dark] .sd-cluster{background:#27272a;box-shadow:${DARK_SHADOW}}
[data-theme=dark] .sd-cluster>b{background:#e4e4e7;color:#18181b}
[data-theme=dark] .sd-pin[data-active]{box-shadow:0 0 0 2px #27272a,0 0 0 3.5px #60a5fa}
[data-theme=dark] .sd-pin>i{box-shadow:0 0 0 1.5px #27272a}
@media (prefers-reduced-motion:no-preference){.sd-pin[data-new]{animation:sd-pin-in 180ms cubic-bezier(.23,1,.32,1)}}
@media (prefers-reduced-motion:reduce){.sd-pin,.sd-cluster{transition:none}}
@keyframes sd-pin-in{from{opacity:0;scale:.9}}
.sd-place-hint{position:fixed;left:50%;top:12px;z-index:2147483646;translate:-50% 0;padding:6px 12px;border-radius:999px;background:#18181b;color:#fff;font:500 12px/1.4 system-ui,-apple-system,sans-serif;white-space:nowrap;box-shadow:${SHADOW};pointer-events:none}
@media (prefers-reduced-motion:no-preference){.sd-place-hint{animation:sd-place-hint-in 180ms cubic-bezier(.23,1,.32,1)}}
@keyframes sd-place-hint-in{from{opacity:0;translate:-50% -4px}}
@media print{.sd-pins,.sd-place-hint{display:none}}
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
function pinLabel(pin: Pin): string {
  if (pin.draft) return "Unsent comment";
  const on = pin.anchor.point.label || normalize(pin.anchor.quote ?? "").slice(0, 40);
  const label = on ? ` on ${on}` : "";
  const replies = pin.replies === 1 ? "1 reply" : `${pin.replies} replies`;
  return `Comment${label}${pin.replies ? `, ${replies}` : ""}`;
}

// A pin on screen: its element and the ancestors that clip it, and where its
// spot was on the last frame.
type Placed = {
  pin: Pin;
  el: Element;
  clips: Element[];
  x: number;
  y: number;
  shown: boolean;
};

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

  let d: Document | null = null;
  let pins: Pin[] = [];
  let active: string | undefined;
  let placed: Placed[] = [];
  let shown = new Set<string>();
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
  let dragged: { id: string; x: number; y: number } | null = null;
  // The pin pressed last, which is already in view when the app opens it.
  let pressed: string | undefined;
  let placing = false;
  let placeStyle: HTMLStyleElement | null = null;
  let placeHint: HTMLElement | null = null;
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
    const results: { id: string; placed: boolean }[] = [];
    for (const pin of pins) {
      const kept = before.get(pin.id);
      const same =
        kept?.el.isConnected &&
        JSON.stringify(kept.pin.anchor) === JSON.stringify(pin.anchor);
      const el = same ? kept.el : pinElement(doc, pin.anchor);
      results.push({ id: pin.id, placed: !!el });
      if (el && placed.length < MAX_PINS)
        placed.push(
          same
            ? { ...kept, pin }
            : { pin, el, clips: clipsOf(el), x: 0, y: 0, shown: false },
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
    for (const p of placed) {
      const box = p.el.getBoundingClientRect();
      const { x, y } = p.pin.anchor.point;
      p.x = box.left + x * box.width;
      p.y = box.top + y * box.height;
      p.shown =
        box.width > 0 &&
        box.height > 0 &&
        inside(new DOMRect(0, 0, view.innerWidth, view.innerHeight), p.x, p.y) &&
        p.clips.every((clip) => inside(clip.getBoundingClientRect(), p.x, p.y));
    }
    const positions = placed
      .map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`)
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
      // The translate property, not transform: the scale used for hover,
      // press and drag then applies around the pin's tip.
      if (at) el.style.translate = `${at.x}px ${at.y}px`;
    }
  }

  function render() {
    if (holding) return;
    // Drafts and the open pin never join a cluster.
    const keep = new Set(
      pins.filter((p) => p.draft || p.id === active).map((p) => p.id),
    );
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
          ...members.map(({ pin }) =>
            [pin.id, pin.initials, pin.replies, pin.draft, pin.id === active].join(":"),
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
    layer.replaceChildren(
      ...clusters.map(({ seed, members }) => {
        if (members.length > 1) return clusterButton(seed.id, members);
        next.add(seed.id);
        return pinButton(seed.pin, !shown.has(seed.id));
      }),
    );
    if (focused)
      (Array.from(layer.children) as HTMLElement[])
        .find((el) => el.dataset.id === focused)
        ?.focus({ preventScroll: true });
    shown = new Set([...shown, ...next]);
  }

  function pinButton(pin: Pin, fresh: boolean) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sd-pin";
    b.dataset.id = pin.id;
    if (pin.id === active) b.dataset.active = "";
    if (pin.draft) b.dataset.draft = "";
    if (fresh) b.dataset.new = "";
    if (pin.color) b.style.setProperty("--c", pin.color);
    const face = document.createElement("b");
    if (pin.draft) face.appendChild(plusIcon());
    else face.textContent = pin.initials || "?";
    b.appendChild(face);
    if (pin.replies > 0) {
      const count = document.createElement("i");
      count.textContent = String(pin.replies);
      b.appendChild(count);
    }
    b.setAttribute("aria-label", pinLabel(pin));
    pressOrDrag(b, pin);
    return b;
  }

  function clusterButton(id: string, members: { pin: Pin }[]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sd-cluster";
    b.dataset.id = id;
    const count = document.createElement("b");
    count.textContent = members.length > 99 ? "99+" : String(members.length);
    if (members.length > 99) b.dataset.many = "";
    b.appendChild(count);
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
        b.style.translate = `${to.x}px ${to.y}px`;
        dragged = { id: pin.id, ...to };
      };
      const finish = () => {
        if (done) return;
        done = true;
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
          if (to) drop(pin, to);
        }
        schedule();
      };
      b.addEventListener("pointermove", move);
      b.addEventListener("pointerup", finish, { once: true });
      b.addEventListener("lostpointercapture", finish, { once: true });
    });
  }

  // drop moves a pin to the spot under its tip, or puts it back where no
  // element takes it. The move shows at once; the app saves it.
  function drop(pin: Pin, at: { x: number; y: number }) {
    const anchor = d && pointAt(d, at.x, at.y);
    if (!anchor) return;
    pins = pins.map((p) => (p.id === pin.id ? { ...p, anchor } : p));
    layout();
    host.post({ type: "slashdocs:pin-move", id: pin.id, anchor });
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

  function setPlacing(next: boolean) {
    if (!d || placing === next) return;
    placing = next;
    placeStyle?.remove();
    placeHint?.remove();
    placeStyle = placeHint = null;
    if (placing) {
      placeStyle = d.createElement("style");
      placeStyle.setAttribute("data-slashdocs-injected", "");
      placeStyle.textContent = `html,html *{cursor:${PLACE_CURSOR}!important;user-select:none!important}`;
      d.head.appendChild(placeStyle);
      placeHint = document.createElement("div");
      placeHint.className = "sd-place-hint";
      placeHint.setAttribute("role", "status");
      placeHint.textContent = "Click to place a comment. Esc to cancel.";
      layer.after(placeHint);
    }
    host.post({ type: "slashdocs:pin-placing", on: placing });
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
    view?.addEventListener("resize", schedule, { signal });
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
        const anchor = pointAt(doc, e.clientX, e.clientY);
        setPlacing(false);
        if (anchor) host.post({ type: "slashdocs:pin-place", anchor });
      },
      { capture: true, signal },
    );
    layout();
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
      pins = next;
      active = nextActive;
      pressed = undefined;
      layout();
      if (opened)
        placed
          .find((p) => p.pin.id === nextActive && !p.pin.draft)
          ?.el.scrollIntoView({
            block: "center",
            inline: "nearest",
            behavior: scrollBehavior(d),
          });
    },
    // tops gives where the spot of each placed pin is, from the top of the
    // document, for the strip of comment ticks.
    tops(): { id: string; top: number }[] {
      const scrollY = d?.defaultView?.scrollY ?? 0;
      return placed.map(({ pin, el }) => {
        const box = el.getBoundingClientRect();
        return { id: pin.id, top: box.top + pin.anchor.point.y * box.height + scrollY };
      });
    },
    // rect gives where a pin's spot is, for its popover, or null when the pin
    // is not in this version.
    rect(id: string): PinRect | null {
      const p = dragged?.id === id ? dragged : placed.find((x) => x.pin.id === id);
      if (!p) return null;
      return { left: p.x, top: p.y - PIN_SIZE, width: PIN_SIZE, height: PIN_SIZE };
    },
    // releaseOutside puts a dragged pin back when the pointer was let go
    // outside the frame.
    releaseOutside() {
      cancelDrag?.();
    },
    setTheme(theme: string) {
      layer.setAttribute("data-theme", theme);
    },
  };
}

// clipsOf gives the ancestors of an element that clip it, so its pin hides
// when its spot scrolls out of an inner box.
function clipsOf(el: Element): Element[] {
  const d = el.ownerDocument;
  const out: Element[] = [];
  for (let node = el.parentElement; node && node !== d.body; node = node.parentElement)
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
