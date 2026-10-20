// Canvas mode: comment pins on a document that pans and zooms by itself. A
// document opts in with
//
//   <meta name="slashdocs:canvas" content="viewport=#vp; world=#world">
//
// viewport is the element that clips the canvas, world the element that
// carries its pan and zoom transform with transform-origin 0 0. Elements that
// take pins carry data-slashdocs-target="<id>". A canvas may handle the
// "slashdocs:canvas-focus" event to bring a rect of its world into view.
//
// Pins live in the bridge window, over the document frame, like live cursors.
// They follow the world's on-screen box every frame while the camera moves,
// and nothing is written into the document except a cursor style while
// placing.

export type CanvasConfig = { viewport: string; world: string };
export type PinPoint = { target: string; x: number; y: number };
export type CanvasPin = {
  id: string;
  point: PinPoint;
  initials: string;
  replies: number;
  resolved: boolean;
  draft: boolean;
  // This reader may drag the pin to a new spot.
  movable: boolean;
};

const MAX_SELECTOR = 256;
const TARGET_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
// A press that moves less than this places a pin; more pans.
const PLACE_SLOP = 4;
// Pins closer than this on screen merge into one cluster.
export const CLUSTER_RADIUS = 28;
// A cluster click fits its pins with this much room around them.
const CLUSTER_PADDING = 80;
const MAX_PINS = 500;
const PIN_SIZE = 32;

// parseCanvasMeta reads the opt-in tag. Unknown keys are ignored; a missing
// or oversized selector turns canvas mode off.
export function parseCanvasMeta(
  content: string | null | undefined,
): CanvasConfig | null {
  if (!content) return null;
  const pairs = new Map<string, string>();
  for (const part of content.split(";")) {
    const at = part.indexOf("=");
    if (at < 0) continue;
    pairs.set(part.slice(0, at).trim(), part.slice(at + 1).trim());
  }
  const viewport = pairs.get("viewport") ?? "";
  const world = pairs.get("world") ?? "";
  const ok = (s: string) => s.length > 0 && s.length <= MAX_SELECTOR;
  return ok(viewport) && ok(world) ? { viewport, world } : null;
}

// parsePins accepts pins from the app and drops anything malformed.
export function parsePins(value: unknown): CanvasPin[] {
  if (!Array.isArray(value)) return [];
  const out: CanvasPin[] = [];
  for (const raw of value.slice(0, 10_000)) {
    const p = raw as Record<string, unknown> | null;
    const point = p?.point as Record<string, unknown> | undefined;
    if (!p || typeof p.id !== "string" || !point) continue;
    const { target, x, y } = point;
    const frac = (n: unknown): n is number =>
      typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 1;
    if (typeof target !== "string" || (target && !TARGET_ID.test(target))) continue;
    if (!frac(x) || !frac(y)) continue;
    out.push({
      id: p.id.slice(0, 200),
      point: { target, x, y },
      initials: typeof p.initials === "string" ? p.initials.slice(0, 2) : "",
      replies: typeof p.replies === "number" ? Math.max(0, Math.floor(p.replies)) : 0,
      resolved: p.resolved === true,
      draft: p.draft === true,
      movable: p.movable === true,
    });
  }
  return out;
}

// clusterPins groups pins whose screen positions are within r of a seed, in
// the given order (newest first). Seeds keep their own position, so clusters
// do not jump while zooming. Pins in keep are never clustered.
export function clusterPins<T extends { id: string; x: number; y: number }>(
  pins: T[],
  r: number,
  keep: ReadonlySet<string> = new Set(),
): { seed: T; members: T[] }[] {
  const clusters: { seed: T; members: T[] }[] = [];
  const grid = new Map<string, { seed: T; members: T[] }[]>();
  const cell = (x: number, y: number) => `${Math.floor(x / r)},${Math.floor(y / r)}`;
  for (const pin of pins) {
    if (keep.has(pin.id)) {
      clusters.push({ seed: pin, members: [pin] });
      continue;
    }
    let joined: { seed: T; members: T[] } | undefined;
    const cx = Math.floor(pin.x / r);
    const cy = Math.floor(pin.y / r);
    for (let dx = -1; dx <= 1 && !joined; dx++)
      for (let dy = -1; dy <= 1 && !joined; dy++)
        for (const c of grid.get(`${cx + dx},${cy + dy}`) ?? [])
          if (Math.hypot(c.seed.x - pin.x, c.seed.y - pin.y) <= r) {
            joined = c;
            break;
          }
    if (joined) {
      joined.members.push(pin);
      continue;
    }
    const fresh = { seed: pin, members: [pin] };
    clusters.push(fresh);
    const key = cell(pin.x, pin.y);
    grid.set(key, [...(grid.get(key) ?? []), fresh]);
  }
  return clusters;
}

const CSS = `
.sd-pins{position:fixed;inset:0;pointer-events:none;z-index:2147483645;overflow:hidden}
.sd-pin{all:unset;position:absolute;left:0;top:0;box-sizing:border-box;width:${PIN_SIZE}px;height:${PIN_SIZE}px;margin-top:-${PIN_SIZE}px;padding:3px;border-radius:50% 50% 50% 4px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.08),0 2px 8px rgba(0,0,0,.18);pointer-events:auto;cursor:pointer;will-change:transform;transform-origin:0 100%;transition:box-shadow 150ms ease}
.sd-pin:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.sd-pin>b{display:flex;align-items:center;justify-content:center;width:100%;height:100%;border-radius:50%;background:#e0e7ff;color:#3730a3;font:600 10px/1 system-ui,-apple-system,sans-serif;letter-spacing:.02em}
.sd-pin[data-active]{box-shadow:0 0 0 2px #2563eb,0 2px 10px rgba(37,99,235,.35)}
.sd-pin[data-resolved]>b{background:#dcfce7;color:#166534}
.sd-pin[data-draft]>b{background:#2563eb;color:#fff;font-size:16px}
.sd-pin>i{position:absolute;right:-5px;top:-5px;min-width:16px;height:16px;padding:0 4px;box-sizing:border-box;border-radius:8px;background:#18181b;color:#fff;font:600 10px/16px system-ui,-apple-system,sans-serif;font-style:normal;text-align:center}
.sd-cluster{all:unset;position:absolute;left:0;top:0;box-sizing:border-box;height:28px;margin-top:-28px;display:flex;align-items:center;gap:0;padding:2px 8px 2px 2px;border-radius:14px 14px 14px 4px;background:#fff;box-shadow:0 0 0 1px rgba(0,0,0,.08),0 2px 8px rgba(0,0,0,.18);pointer-events:auto;cursor:pointer;will-change:transform;transform-origin:0 100%;font:600 11px/1 system-ui,-apple-system,sans-serif;color:#3f3f46}
.sd-cluster:focus-visible{outline:2px solid #2563eb;outline-offset:2px}
.sd-cluster>b{display:flex;align-items:center;justify-content:center;width:24px;height:24px;margin-right:-6px;border-radius:50%;border:2px solid #fff;box-sizing:border-box;background:#e0e7ff;color:#3730a3;font-size:9px}
.sd-cluster>span{margin-left:10px}
.sd-pin[data-pressed],.sd-cluster:active{scale:.96}
.sd-pin[data-dragging]{cursor:grabbing;scale:1.1;transition:none;box-shadow:0 0 0 2px #2563eb,0 10px 24px rgba(0,0,0,.28)}
[data-theme=dark] .sd-pin,[data-theme=dark] .sd-cluster{background:#27272a;box-shadow:0 0 0 1px rgba(255,255,255,.12),0 2px 8px rgba(0,0,0,.5);color:#e4e4e7}
[data-theme=dark] .sd-cluster>b{border-color:#27272a}
@media (prefers-reduced-motion:no-preference){.sd-pin[data-new]{animation:sd-pin-in 160ms cubic-bezier(.23,1,.32,1)}}
@keyframes sd-pin-in{from{opacity:0;scale:.6}}
`;

type Placed = { pin: CanvasPin; wx: number; wy: number };

// onPress runs an action when a pin is pressed, or activated with Enter or
// Space. A press, not a click: the pins sit in the bridge window over the
// document frame, and Chrome can send the release to the frame underneath,
// so a click would never fire.
function onPress(button: HTMLElement, action: () => void) {
  button.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    action();
  });
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.detail === 0) action();
  });
}

export type CanvasHost = {
  doc: () => Document | null;
  post: (message: Record<string, unknown>) => void;
};

// createCanvasLayer runs canvas mode for one bridge. start enters it for a
// document; everything else is a no-op until then.
export function createCanvasLayer(host: CanvasHost) {
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
  const layer = document.createElement("div");
  layer.className = "sd-pins";
  layer.hidden = true;
  document.body.appendChild(layer);
  // A wheel over a pin still pans or zooms the canvas under it. Target ids
  // are limited to [A-Za-z0-9_.:-], so they are safe inside selector quotes.
  layer.addEventListener(
    "wheel",
    (e) => {
      const view = d?.defaultView;
      const under = d?.elementFromPoint(e.clientX, e.clientY);
      if (!view || !under) return;
      e.preventDefault();
      under.dispatchEvent(
        new view.WheelEvent("wheel", {
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaMode: e.deltaMode,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          clientX: e.clientX,
          clientY: e.clientY,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { passive: false },
  );

  let d: Document | null = null;
  let viewport: HTMLElement | null = null;
  let world: HTMLElement | null = null;
  let pins: CanvasPin[] = [];
  let active: string | undefined;
  let placed: Placed[] = [];
  let shown = new Set<string>();
  let frame = 0;
  let stable = 0;
  let lastKey = "";
  let lastSignature = "";
  // The drag in progress, which the app can cancel when the pointer is let
  // go outside the frame, where the frame hears no release.
  let cancelDrag: (() => void) | null = null;
  // The pin the app shows a popover for, and its last reported rect.
  let watched: string | null = null;
  let lastRect = "";
  let placing = false;
  let placeStyle: HTMLStyleElement | null = null;
  let press: { x: number; y: number } | null = null;
  let observer: MutationObserver | null = null;

  const on = () => !!(d && viewport && world);

  // camera gives the world's scale and on-screen origin, read live, so it is
  // right during animated moves too.
  function camera() {
    const r = world!.getBoundingClientRect();
    const s = world!.offsetWidth > 0 ? r.width / world!.offsetWidth : 1;
    return { left: r.left, top: r.top, s };
  }

  // worldPoint finds a pin's spot in untransformed world px, or null when its
  // target is not in this version.
  function worldPoint(p: PinPoint, cam: ReturnType<typeof camera>) {
    if (!p.target)
      return { wx: p.x * world!.offsetWidth, wy: p.y * world!.offsetHeight };
    const el = world!.querySelector(`[data-slashdocs-target="${p.target}"]`);
    if (!el) return null;
    const t = el.getBoundingClientRect();
    return {
      wx: (t.left - cam.left + p.x * t.width) / cam.s,
      wy: (t.top - cam.top + p.y * t.height) / cam.s,
    };
  }

  function layout() {
    if (!on()) return;
    const cam = camera();
    placed = [];
    const results: { id: string; placed: boolean; label?: string }[] = [];
    for (const pin of pins) {
      const at = worldPoint(pin.point, cam);
      results.push({ id: pin.id, placed: !!at, label: targetLabel(pin.point.target) });
      if (at && placed.length < MAX_PINS) placed.push({ pin, ...at });
    }
    host.post({ type: "slashdocs:canvas-pins-result", results });
    lastKey = "";
    schedule();
  }

  function draw() {
    if (!on()) return;
    const cam = camera();
    const vr = viewport!.getBoundingClientRect();
    const view = d!.defaultView!;
    layer.style.clipPath = `inset(${Math.max(0, vr.top)}px ${Math.max(0, view.innerWidth - vr.right)}px ${Math.max(0, view.innerHeight - vr.bottom)}px ${Math.max(0, vr.left)}px)`;
    const key = `${cam.left.toFixed(1)},${cam.top.toFixed(1)},${cam.s.toFixed(4)}`;
    if (key === lastKey) {
      stable++;
      return;
    }
    stable = 0;
    const scaleChanged = !lastKey || lastKey.split(",")[2] !== cam.s.toFixed(4);
    lastKey = key;
    const screen = placed.map((p) => ({
      id: p.pin.id,
      p,
      x: cam.left + p.wx * cam.s,
      y: cam.top + p.wy * cam.s,
    }));
    // Clusters depend on zoom and the pins; regroup when either changes.
    if (scaleChanged || layer.childElementCount === 0) render(screen);
    const byId = new Map(screen.map((at) => [at.id, at]));
    for (const el of Array.from(layer.children) as HTMLElement[]) {
      const at = byId.get(el.dataset.id ?? "");
      if (at) el.style.transform = `translate(${at.x}px,${at.y}px)`;
    }
    reportWatched(byId.get(watched ?? ""), vr);
  }

  function render(screen: { id: string; p: Placed; x: number; y: number }[]) {
    const keep = new Set<string>(pins.filter((p) => p.draft).map((p) => p.id));
    if (active) keep.add(active);
    const clusters = clusterPins(screen, CLUSTER_RADIUS, keep);
    // Keep the buttons when nothing about them changed: replacing one
    // between a press and its release would swallow the click.
    const signature = clusters
      .map(({ members }) =>
        members
          .map(({ p: { pin } }) =>
            [
              pin.id,
              pin.initials,
              pin.replies,
              pin.resolved,
              pin.draft,
              pin.id === active,
            ].join(":"),
          )
          .join("+"),
      )
      .join("|");
    if (signature === lastSignature && layer.childElementCount > 0) return;
    lastSignature = signature;
    const next = new Set<string>();
    layer.replaceChildren(
      ...clusters.map(({ seed, members }) => {
        if (members.length === 1) {
          const { pin } = seed.p;
          next.add(pin.id);
          return pinButton(pin, !shown.has(pin.id));
        }
        return clusterButton(
          seed.id,
          members.map((m) => m.p),
        );
      }),
    );
    shown = next;
  }

  function pinButton(pin: CanvasPin, fresh: boolean) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sd-pin";
    b.dataset.id = pin.id;
    if (pin.id === active) b.dataset.active = "";
    if (pin.resolved) b.dataset.resolved = "";
    if (pin.draft) b.dataset.draft = "";
    if (fresh) b.dataset.new = "";
    const face = document.createElement("b");
    face.textContent = pin.draft ? "+" : pin.initials || "?";
    b.appendChild(face);
    if (pin.replies > 0) {
      const count = document.createElement("i");
      count.textContent = String(pin.replies);
      b.appendChild(count);
    }
    b.addEventListener("pointerenter", () => {
      if (pin.draft) return;
      const r = b.getBoundingClientRect();
      host.post({
        type: "slashdocs:canvas-pin-hover",
        id: pin.id,
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
      });
    });
    b.addEventListener("pointerleave", () =>
      host.post({ type: "slashdocs:canvas-pin-hover", id: null }),
    );
    b.setAttribute(
      "aria-label",
      pin.draft
        ? "Unsent comment"
        : `Comment${pin.resolved ? ", resolved" : ""}${pin.replies ? `, ${pin.replies} ${pin.replies === 1 ? "reply" : "replies"}` : ""}`,
    );
    // A press opens the thread (a draft pin reopens its unsent comment, for
    // example after a reload); a press that moves drags the pin.
    pressOrDrag(b, pin);
    return b;
  }

  function clusterButton(id: string, members: Placed[]) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "sd-cluster";
    b.dataset.id = id;
    for (const m of members.slice(0, 3)) {
      const face = document.createElement("b");
      face.textContent = m.pin.initials || "?";
      b.appendChild(face);
    }
    const count = document.createElement("span");
    count.textContent =
      members.length > 3 ? `+${members.length - 3}` : String(members.length);
    b.appendChild(count);
    b.setAttribute("aria-label", `${members.length} comment threads`);
    onPress(b, () => {
      const xs = members.map((m) => m.wx);
      const ys = members.map((m) => m.wy);
      const pad = CLUSTER_PADDING / Math.max(camera().s, 0.05);
      focusRect({
        x: Math.min(...xs) - pad,
        y: Math.min(...ys) - pad,
        width: Math.max(...xs) - Math.min(...xs) + pad * 2,
        height: Math.max(...ys) - Math.min(...ys) + pad * 2,
      });
    });
    return b;
  }

  // reportWatched tells the app where the watched pin is, once a frame at
  // most and only when it moves, so its popover stays beside it. A pin out
  // of the viewport is hidden.
  function reportWatched(at: { x: number; y: number } | undefined, vr: DOMRect) {
    if (!watched) return;
    const inside =
      at && at.x >= vr.left && at.x <= vr.right && at.y >= vr.top && at.y <= vr.bottom;
    const rect = inside
      ? { left: at.x, top: at.y - PIN_SIZE, width: PIN_SIZE, height: PIN_SIZE }
      : null;
    const key = rect ? `${Math.round(rect.left)},${Math.round(rect.top)}` : "hidden";
    if (key === lastRect) return;
    lastRect = key;
    host.post(
      rect
        ? { type: "slashdocs:canvas-pin-rect", id: watched, rect }
        : { type: "slashdocs:canvas-pin-rect", id: watched, hidden: true },
    );
  }

  // pressOrDrag opens a pin on release, or moves it when the press travels.
  // The pointer is captured, so the release comes back to the pin even
  // though the pin sits over the document frame.
  function pressOrDrag(b: HTMLElement, pin: CanvasPin) {
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      if (e.detail === 0) host.post({ type: "slashdocs:activate", id: pin.id });
    });
    b.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !on()) return;
      e.preventDefault();
      e.stopPropagation();
      b.setPointerCapture(e.pointerId);
      // Pressed look set here, not by :active, which sticks when the release
      // happens outside the frame.
      b.dataset.pressed = "";
      const start = { x: e.clientX, y: e.clientY };
      const from = placed.find((p) => p.pin.id === pin.id);
      const cam = camera();
      const origin = from && {
        x: cam.left + from.wx * cam.s,
        y: cam.top + from.wy * cam.s,
      };
      let to: { x: number; y: number } | null = null;
      let done = false;
      const move = (ev: PointerEvent) => {
        if (!pin.movable || !origin) return;
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (!to && Math.hypot(dx, dy) <= PLACE_SLOP) return;
        if (!to) {
          cancelDrag = () => {
            to = null;
            finish();
            layout();
          };
          host.post({ type: "slashdocs:canvas-dragging", on: true });
        }
        to = { x: origin.x + dx, y: origin.y + dy };
        delete b.dataset.pressed;
        b.dataset.dragging = "";
        b.style.transform = `translate(${to.x}px,${to.y}px)`;
        if (pin.id === watched) {
          lastRect = "";
          host.post({
            type: "slashdocs:canvas-pin-rect",
            id: pin.id,
            rect: {
              left: to.x,
              top: to.y - PIN_SIZE,
              width: PIN_SIZE,
              height: PIN_SIZE,
            },
          });
        }
      };
      const finish = () => {
        if (done) return;
        done = true;
        b.removeEventListener("pointermove", move);
        delete b.dataset.dragging;
        delete b.dataset.pressed;
        if (cancelDrag) {
          cancelDrag = null;
          host.post({ type: "slashdocs:canvas-dragging", on: false });
          if (to) drop(pin, to);
          return;
        }
        host.post({ type: "slashdocs:activate", id: pin.id });
      };
      b.addEventListener("pointermove", move);
      b.addEventListener("pointerup", finish, { once: true });
      b.addEventListener("lostpointercapture", finish, { once: true });
    });
  }

  // drop moves a pin to the spot under its point, or puts it back when that
  // is outside the canvas. The move shows at once; the app saves it.
  function drop(pin: CanvasPin, at: { x: number; y: number }) {
    const vr = viewport!.getBoundingClientRect();
    const inside =
      at.x >= vr.left && at.x <= vr.right && at.y >= vr.top && at.y <= vr.bottom;
    const point = inside ? anchorAt(at.x, at.y, d!.elementFromPoint(at.x, at.y)) : null;
    if (!point) {
      layout();
      return;
    }
    pins = pins.map((p) => (p.id === pin.id ? { ...p, point } : p));
    layout();
    host.post({
      type: "slashdocs:canvas-move",
      id: pin.id,
      point,
      label: targetLabel(point.target),
    });
  }

  function tick() {
    frame = 0;
    draw();
    // Keep following the camera until it rests for two frames.
    if (stable < 2) schedule();
  }

  function schedule() {
    if (!on()) return;
    stable = 0;
    frame ||= requestAnimationFrame(tick);
  }

  // targetLabel names a target for the panel: its aria-label, else its first
  // heading or bold text, else nothing (the panel then uses the id).
  function targetLabel(target: string): string | undefined {
    if (!target || !world) return undefined;
    const el = world.querySelector(`[data-slashdocs-target="${target}"]`);
    const text =
      el?.getAttribute("aria-label") ||
      el?.querySelector("h1,h2,h3,h4,h5,h6,b,strong")?.textContent ||
      "";
    return text.replace(/\s+/g, " ").trim().slice(0, 80) || undefined;
  }

  // focusRect asks the canvas to bring a world rect into view. It tells
  // whether the canvas took the request.
  function focusRect(
    rect: { x: number; y: number; width: number; height: number },
    target?: string,
  ) {
    const view = d?.defaultView;
    if (!view) return false;
    const animate = !view.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const event = new view.CustomEvent("slashdocs:canvas-focus", {
      cancelable: true,
      detail: { target, rect, animate },
    });
    const taken = !view.dispatchEvent(event);
    schedule();
    return taken;
  }

  // focus brings a pin's target, or the spot around a board pin, into view.
  function focus(id: string) {
    if (!on()) return;
    const p = placed.find((x) => x.pin.id === id);
    if (!p) return;
    const target = p.pin.point.target;
    const el = target && world!.querySelector(`[data-slashdocs-target="${target}"]`);
    if (el) {
      const cam = camera();
      const t = el.getBoundingClientRect();
      focusRect(
        {
          x: (t.left - cam.left) / cam.s,
          y: (t.top - cam.top) / cam.s,
          width: t.width / cam.s,
          height: t.height / cam.s,
        },
        target,
      );
      return;
    }
    focusRect({ x: p.wx - 300, y: p.wy - 200, width: 600, height: 400 });
  }

  function setPlacing(next: boolean, tell = true) {
    if (!on() || placing === next) return;
    placing = next;
    placeStyle?.remove();
    placeStyle = null;
    if (placing) {
      placeStyle = d!.createElement("style");
      placeStyle.setAttribute("data-slashdocs-injected", "");
      placeStyle.textContent = `${current!.viewport},${current!.viewport} *{cursor:crosshair!important;user-select:none!important}`;
      d!.head.appendChild(placeStyle);
    }
    if (tell) host.post({ type: "slashdocs:canvas-place-mode", on: placing });
  }

  // anchorAt names the spot under a click: a target and fractions of its
  // box, or fractions of the whole board.
  function anchorAt(x: number, y: number, under: Element | null): PinPoint | null {
    const el = under?.closest?.("[data-slashdocs-target]");
    const id = el?.getAttribute("data-slashdocs-target") ?? "";
    const clamp = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 1e4) / 1e4;
    if (el && world!.contains(el) && TARGET_ID.test(id)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0)
        return {
          target: id,
          x: clamp((x - r.left) / r.width),
          y: clamp((y - r.top) / r.height),
        };
    }
    const w = world!.getBoundingClientRect();
    if (w.width <= 0 || w.height <= 0) return null;
    return {
      target: "",
      x: clamp((x - w.left) / w.width),
      y: clamp((y - w.top) / w.height),
    };
  }

  let current: CanvasConfig | null = null;

  // start enters canvas mode for a document that opts in. It tells whether
  // the document is a canvas.
  function start(doc: Document): boolean {
    stop();
    const meta = doc.querySelector('meta[name="slashdocs:canvas"]');
    const config = parseCanvasMeta(meta?.getAttribute("content"));
    if (!config) return false;
    let vp: HTMLElement | null;
    let wd: HTMLElement | null;
    try {
      vp = doc.querySelector<HTMLElement>(config.viewport);
      wd = doc.querySelector<HTMLElement>(config.world);
    } catch {
      console.warn("slashdocs: the canvas meta tag has an invalid selector");
      return false;
    }
    if (!vp || !wd) {
      console.warn("slashdocs: the canvas meta tag names an element that is not there");
      return false;
    }
    d = doc;
    viewport = vp;
    world = wd;
    current = config;
    layer.hidden = false;
    const view = doc.defaultView!;
    observer = new MutationObserver(schedule);
    observer.observe(wd, { attributes: true, attributeFilter: ["style", "class"] });
    for (const type of ["transitionrun", "transitionend"])
      wd.addEventListener(type, schedule);
    view.addEventListener("resize", layout);
    doc.addEventListener("scroll", schedule, { capture: true, passive: true });
    doc.addEventListener("wheel", schedule, { capture: true, passive: true });
    doc.addEventListener(
      "pointerdown",
      (e) => {
        press = { x: e.clientX, y: e.clientY };
      },
      { capture: true, passive: true },
    );
    doc.addEventListener("pointermove", (e) => e.buttons && schedule(), {
      capture: true,
      passive: true,
    });
    doc.addEventListener(
      "click",
      (e) => {
        if (!placing || !press || d !== doc) return;
        const moved = Math.hypot(e.clientX - press.x, e.clientY - press.y);
        press = null;
        if (moved > PLACE_SLOP) return;
        const point = anchorAt(e.clientX, e.clientY, e.target as Element | null);
        e.preventDefault();
        e.stopImmediatePropagation();
        if (point)
          host.post({
            type: "slashdocs:canvas-place",
            point,
            label: targetLabel(point.target),
          });
      },
      true,
    );
    void doc.fonts?.ready.then(layout);
    host.post({
      type: "slashdocs:canvas",
      version: 1,
      targets: wd.querySelectorAll("[data-slashdocs-target]").length,
    });
    layout();
    return true;
  }

  function stop() {
    observer?.disconnect();
    observer = null;
    placeStyle?.remove();
    placeStyle = null;
    placing = false;
    d = viewport = world = null;
    current = null;
    placed = [];
    layer.replaceChildren();
    layer.hidden = true;
  }

  return {
    start,
    stop,
    isOn: on,
    isPlacing: () => placing,
    setPlacing,
    setPins(next: CanvasPin[], nextActive?: string) {
      const before = new Set(pins.map((p) => p.id));
      pins = next;
      active = nextActive;
      // Pins that were there keep their place; new ones animate in.
      shown = new Set([...shown].filter((id) => before.has(id)));
      layout();
    },
    // releaseOutside puts a dragged pin back when the pointer was let go
    // outside the frame.
    releaseOutside() {
      cancelDrag?.();
    },
    // watch reports where a pin is while the app shows its popover.
    watch(id: string | null) {
      watched = id;
      lastRect = "";
      lastKey = "";
      schedule();
    },
    setTheme(theme: string) {
      layer.setAttribute("data-theme", theme);
    },
    focus,
  };
}
