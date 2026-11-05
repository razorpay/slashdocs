import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPositionRestore,
  RESTORE_MAX_MS,
  RESTORE_QUIET_MS,
} from "../bridge/position-restore.ts";
import type { RestoreMethod } from "../bridge/reading.ts";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// The document's state as resolve sees it; tests change it to simulate
// content a script inserts after load.
function setup(initial: RestoreMethod, waitForContent = false) {
  let method = initial;
  let empty = waitForContent;
  const resolve = vi.fn(() => ({ method, waitForContent: empty }));
  const finish = vi.fn();
  const restore = createPositionRestore({ resolve, finish });
  return {
    restore,
    resolve,
    finish,
    become: (next: RestoreMethod) => {
      method = next;
      empty = false;
      restore.mutated();
    },
    finished: () => finish.mock.calls.map(([attempt]) => attempt.method),
  };
}

describe("createPositionRestore", () => {
  it("finishes at once when the quote or section is found", () => {
    for (const method of ["quote", "section"] as const) {
      const t = setup(method);
      t.restore.start({});
      expect(t.finished()).toEqual([method]);
      expect(t.restore.pending()).toBe(false);
    }
  });

  it("waits briefly for a static document before falling back", () => {
    const t = setup("progression");
    t.restore.start({});
    expect(t.finished()).toEqual([]);
    vi.advanceTimersByTime(RESTORE_QUIET_MS);
    expect(t.finished()).toEqual(["progression"]);
    // Nothing changed, so the document was resolved only once.
    expect(t.resolve).toHaveBeenCalledTimes(1);
  });

  it("finds a quote that a script renders after load", () => {
    const t = setup("none");
    t.restore.start({});
    vi.advanceTimersByTime(200);
    t.become("progression"); // the body starts arriving
    vi.advanceTimersByTime(200);
    t.become("quote"); // the quoted paragraph arrives
    vi.advanceTimersByTime(100);
    expect(t.finished()).toEqual(["quote"]);
    vi.advanceTimersByTime(RESTORE_MAX_MS);
    expect(t.finish).toHaveBeenCalledTimes(1);
  });

  // A script that fetches and renders the body after a pause makes no
  // changes before it, so quiet alone does not mean rendered.
  it("keeps waiting while the page is too short to scroll", () => {
    const t = setup("none", true);
    t.restore.start({});
    vi.advanceTimersByTime(700);
    expect(t.finished()).toEqual([]);
    t.become("quote");
    vi.advanceTimersByTime(100);
    expect(t.finished()).toEqual(["quote"]);
  });

  it("stops waiting for content at the limit", () => {
    const t = setup("none", true);
    t.restore.start({});
    vi.advanceTimersByTime(RESTORE_MAX_MS - 100);
    expect(t.finished()).toEqual([]);
    vi.advanceTimersByTime(100);
    expect(t.finished()).toEqual(["none"]);
  });

  it("gives up while the document keeps changing", () => {
    const t = setup("none");
    t.restore.start({});
    for (let ms = 0; ms < RESTORE_MAX_MS; ms += 100) {
      t.become("none");
      vi.advanceTimersByTime(100);
    }
    expect(t.finished()).toEqual(["none"]);
  });

  it("drops a restore that a link navigation cancels", () => {
    const t = setup("none");
    t.restore.start({});
    t.restore.cancel();
    vi.advanceTimersByTime(RESTORE_MAX_MS);
    expect(t.finish).not.toHaveBeenCalled();
  });

  it("replaces an earlier restore with a newer one", () => {
    const t = setup("none");
    t.restore.start({ progression: 0.1 });
    t.restore.start({ progression: 0.2 });
    vi.advanceTimersByTime(RESTORE_MAX_MS);
    expect(t.finish).toHaveBeenCalledTimes(1);
    expect(t.finish.mock.calls[0]![1]).toEqual({ progression: 0.2 });
  });
});
