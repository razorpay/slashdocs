import type { CursorPoint, CursorSpot } from "@/api";
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

// parseCursorSpot accepts a spot from the render frame, which also runs the
// document's own scripts. Anything else means that the pointer left.
export function parseCursorSpot(value: unknown): CursorSpot | null {
  const { path, x, y } = (value ?? {}) as Record<string, unknown>;
  const fraction = (n: unknown): n is number =>
    typeof n === "number" && n >= 0 && n <= 1;
  return typeof path === "string" && SPOT_PATH.test(path) && fraction(x) && fraction(y)
    ? { path, x, y }
    : null;
}

// createCursorBatch collects this reader's pointer points and sends them in
// batches, one request at a time and in order. When a request is slow, the
// next batch gets larger. A full batch drops its oldest points.
export function createCursorBatch(send: (points: CursorPoint[]) => Promise<unknown>) {
  let queue: CursorPoint[] = [];
  let hidden = true;
  let lastPoint = -Infinity;
  let lastSend = -Infinity;
  let sending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush() {
    timer = undefined;
    const points = queue;
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

  // add records where the pointer is now. Null means that the pointer left.
  function add(spot: CursorSpot | null) {
    if (!spot && hidden) return;
    hidden = !spot;
    lastPoint = Math.max(lastPoint + 1, Math.round(performance.now()));
    queue = [...queue, { t: lastPoint, ...(spot ?? HIDDEN) }].slice(-MAX_BATCH_POINTS);
    schedule();
  }

  function stop() {
    clearTimeout(timer);
    timer = undefined;
    queue = [];
  }

  return { add, stop };
}
