import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CursorPoint } from "@/api";
import {
  CURSOR_BATCH_INTERVAL,
  createCursorBatch,
  parseCursorSpot,
} from "./live-cursors";

const spot = (x: number) => ({ path: "1.2", x, y: 0.5 });

describe("createCursorBatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends one request at a time, in order, at most once an interval", async () => {
    const batches: CursorPoint[][] = [];
    let finish = () => {};
    const batch = createCursorBatch((points) => {
      batches.push(points);
      return new Promise<void>((resolve) => (finish = resolve));
    });

    batch.add(spot(0));
    await vi.advanceTimersByTimeAsync(0);
    expect(batches.map((points) => points.map((point) => point.x))).toEqual([[0]]);

    batch.add(spot(0.25));
    batch.add(spot(0.5));
    await vi.advanceTimersByTimeAsync(CURSOR_BATCH_INTERVAL * 3);
    expect(batches).toHaveLength(1);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[1].map((point) => point.x)).toEqual([0.25, 0.5]);
    expect(batches[1][0].t).toBeLessThan(batches[1][1].t);
  });

  it("sends a hidden point once, after a shown point, and keeps the newest 16", async () => {
    const batches: CursorPoint[][] = [];
    const batch = createCursorBatch(async (points) => {
      batches.push(points);
    });
    batch.add(null);
    await vi.advanceTimersByTimeAsync(CURSOR_BATCH_INTERVAL);
    expect(batches).toEqual([]);

    for (let i = 0; i < 20; i++) batch.add(spot(i / 20));
    batch.add(null);
    batch.add(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0]).toHaveLength(16);
    expect(batches[0].at(-1)).toMatchObject({ hidden: true });
    expect(batches[0].filter((point) => point.hidden)).toHaveLength(1);
  });
});

describe("parseCursorSpot", () => {
  it("accepts only a valid spot", () => {
    expect(parseCursorSpot(spot(1))).toEqual(spot(1));
    expect(parseCursorSpot({ path: "", x: 0, y: 0 })).toEqual({ path: "", x: 0, y: 0 });
    for (const value of [
      null,
      { path: "1..2", x: 0, y: 0 },
      { path: "1", x: 2, y: 0 },
      { path: "1", x: "0", y: 0 },
    ])
      expect(parseCursorSpot(value)).toBeNull();
  });
});
