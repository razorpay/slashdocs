import type { CursorPlace, CursorPoint, CursorSpot } from "@/api";
import { createPersistentStore } from "@/lib/persistent-store";

// Whether this reader sees other viewers' cursors.
export const cursorsShownStore = createPersistentStore<boolean>(
  "slashdocs:cursors-shown",
  true,
);

// A moving pointer sends at most one batch in this time.
export const CURSOR_BATCH_INTERVAL = 80;
// The server takes at most this many points in one batch.
const MAX_BATCH_POINTS = 16;

const HIDDEN: CursorSpot & { hidden: true } = { path: "", x: 0, y: 0, hidden: true };
const SPOT_PATH = /^(\d{1,5}(\.\d{1,5}){0,63})?$/;
// The server takes a zoom up to this.
const MAX_SPOT_ZOOM = 100;

// A view's place may lie outside its element, up to this many times its size.
const MAX_VIEW_FRACTION = 1000;
// The server takes a cursor chat message up to this many characters, without
// control characters.
const MAX_MESSAGE = 100;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function parsePlace(value: unknown, limit = { min: 0, max: 1 }): CursorPlace | null {
  const { path, x, y, z } = (value ?? {}) as Record<string, unknown>;
  const fraction = (n: unknown): n is number =>
    typeof n === "number" && n >= limit.min && n <= limit.max;
  if (!(typeof path === "string" && SPOT_PATH.test(path) && fraction(x) && fraction(y)))
    return null;
  const zoomed = typeof z === "number" && z > 0 && z <= MAX_SPOT_ZOOM;
  return zoomed ? { path, x, y, z } : { path, x, y };
}

// parseCursorSpot accepts a spot from the render frame, which also runs the
// document's own scripts. Anything else means that the pointer left. An
// invalid view or message is dropped. A spot for a pointer that left keeps
// only its view, and is null without one.
export function parseCursorSpot(value: unknown): CursorSpot | null {
  if ((value as { hidden?: unknown } | null)?.hidden === true) {
    const view = parsePlace((value as { v?: unknown }).v, {
      min: -MAX_VIEW_FRACTION,
      max: MAX_VIEW_FRACTION,
    });
    return view && { ...HIDDEN, v: view };
  }
  const spot = parsePlace(value);
  const { m } = (value ?? {}) as { m?: unknown };
  const message =
    typeof m === "string" && m && [...m].length <= MAX_MESSAGE && !CONTROL.test(m)
      ? m
      : undefined;
  const view =
    spot &&
    parsePlace((value as { v?: unknown }).v, {
      min: -MAX_VIEW_FRACTION,
      max: MAX_VIEW_FRACTION,
    });
  return spot && { ...spot, ...(view && { v: view }), ...(message && { m: message }) };
}

// createCursorBatch collects this reader's pointer points and sends them in
// batches, one request at a time and in order. When a request is slow, the
// next batch gets larger. A full batch drops its oldest points.
export function createCursorBatch(send: (points: CursorPoint[]) => Promise<unknown>) {
  let queue: CursorPoint[] = [];
  let hidden = true;
  let last: CursorSpot | null = null;
  let lastPoint = -Infinity;
  let lastSend = -Infinity;
  let sending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush() {
    timer = undefined;
    // Only the newest view and message matter, so the batch keeps those.
    let newestView = -1;
    queue.forEach((point, i) => {
      if (point.v) newestView = i;
    });
    const points = queue.map((point, i) => {
      const copy = { ...point };
      if (i !== newestView) delete copy.v;
      if (i !== queue.length - 1) delete copy.m;
      return copy;
    });
    queue = [];
    sending = true;
    lastSend = performance.now();
    send(points)
      .catch(() => {})
      .finally(() => {
        sending = false;
        schedule();
      });
  }

  function schedule() {
    if (timer !== undefined || sending || !queue.length) return;
    const wait = Math.max(0, lastSend + CURSOR_BATCH_INTERVAL - performance.now());
    timer = setTimeout(flush, wait);
  }

  // add records where the pointer is now. Null means that the pointer left;
  // a hidden spot means the same but still names the view.
  function add(spot: CursorSpot | null) {
    if (!spot && hidden) return;
    last = spot;
    hidden = !spot || !!spot.hidden;
    lastPoint = Math.max(lastPoint + 1, Math.round(performance.now()));
    queue = [...queue, { t: lastPoint, ...(spot ?? HIDDEN) }].slice(-MAX_BATCH_POINTS);
    schedule();
  }

  // resend sends the newest spot again, for viewers who just arrived: cursors
  // are relayed, not stored, so they would see nothing until it moves.
  function resend() {
    if (!last) return;
    lastPoint = Math.max(lastPoint + 1, Math.round(performance.now()));
    queue = [...queue, { t: lastPoint, ...last }].slice(-MAX_BATCH_POINTS);
    schedule();
  }

  function stop() {
    clearTimeout(timer);
    timer = undefined;
    queue = [];
  }

  return { add, resend, stop };
}
