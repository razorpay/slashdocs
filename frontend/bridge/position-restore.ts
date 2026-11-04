// Waiting for a saved reading position to become restorable. Pure: the
// bridge supplies resolve (find the quote or section in the document as it
// is now) and finish (scroll there and report the method), so this is unit
// tested in tests/position-restore.test.ts.
import type { RestoreMethod } from "./reading.ts";

// A document that has not changed for this long is taken as fully rendered.
export const RESTORE_QUIET_MS = 300;
// A restore never waits longer than this for late content.
export const RESTORE_MAX_MS = 2000;
const STEP_MS = 100;

export type RestoreAttempt = {
  method: RestoreMethod;
  // The page is too short to scroll yet: its body may still be on the way,
  // so a quiet document is not taken as rendered.
  waitForContent?: boolean;
};

// The quote or section may not be in the DOM yet in a chapter that renders
// its body with script after load. A restore that would fall back to the
// scroll share (or fail) waits while the document is still changing, or
// while the page is too short to scroll, and tries again after each change,
// before settling for the fallback.
export function createPositionRestore<T, A extends RestoreAttempt>(deps: {
  resolve: (target: T) => A;
  finish: (attempt: A, target: T) => void;
}): {
  start: (target: T) => void;
  // The document changed: content may have arrived.
  mutated: () => void;
  cancel: () => void;
  pending: () => boolean;
} {
  let state: {
    target: T;
    started: number;
    changed: number;
    dirty: boolean;
    attempt?: A;
  } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const attempt = () => {
    clearTimeout(timer);
    timer = undefined;
    const s = state;
    if (!s) return;
    if (s.dirty || !s.attempt) {
      s.dirty = false;
      s.attempt = deps.resolve(s.target);
    }
    const now = Date.now();
    const found = s.attempt.method === "quote" || s.attempt.method === "section";
    const quiet = now - s.changed >= RESTORE_QUIET_MS && !s.attempt.waitForContent;
    if (found || quiet || now - s.started >= RESTORE_MAX_MS) {
      state = null;
      deps.finish(s.attempt, s.target);
      return;
    }
    timer = setTimeout(attempt, STEP_MS);
  };

  return {
    start(target) {
      const now = Date.now();
      state = { target, started: now, changed: now, dirty: true };
      attempt();
    },
    mutated() {
      if (!state) return;
      state.dirty = true;
      state.changed = Date.now();
    },
    cancel() {
      state = null;
      clearTimeout(timer);
      timer = undefined;
    },
    pending: () => state !== null,
  };
}
