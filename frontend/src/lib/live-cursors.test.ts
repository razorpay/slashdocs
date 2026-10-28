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

  it("sends the view of a pointer that left, and resends the newest spot", async () => {
    const batches: CursorPoint[][] = [];
    const batch = createCursorBatch(async (points) => {
      batches.push(points);
    });
    const view = { path: "3", x: 0.5, y: -2, z: 0.4 };
    batch.add({ path: "", x: 0, y: 0, hidden: true, v: view });
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0]).toEqual([expect.objectContaining({ hidden: true, v: view })]);

    batch.resend();
    await vi.advanceTimersByTimeAsync(CURSOR_BATCH_INTERVAL);
    expect(batches[1]).toEqual([expect.objectContaining({ hidden: true, v: view })]);
    expect(batches[1][0].t).toBeGreaterThan(batches[0][0].t);
  });
});

describe("parseCursorSpot of a pointer that left", () => {
  it("keeps only a valid view", () => {
    expect(
      parseCursorSpot({
        path: "9.9",
        x: 0.3,
        y: 0.3,
        hidden: true,
        m: "hi",
        v: { path: "1", x: 2, y: 0.5 },
      }),
    ).toEqual({ path: "", x: 0, y: 0, hidden: true, v: { path: "1", x: 2, y: 0.5 } });
    expect(parseCursorSpot({ hidden: true })).toBeNull();
    expect(parseCursorSpot({ hidden: true, v: { path: "x", x: 0, y: 0 } })).toBeNull();
  });
});

describe("createCursorBatch views", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends only the newest view in a batch", async () => {
    const batches: CursorPoint[][] = [];
    let finish = () => {};
    const batch = createCursorBatch((points) => {
      batches.push(points);
      return new Promise<void>((resolve) => (finish = resolve));
    });
    const view = (x: number) => ({ path: "0", x, y: 0.5 });
    batch.add({ ...spot(0), v: view(0) });
    await vi.advanceTimersByTimeAsync(0);
    batch.add({ ...spot(0.25), v: view(0.25) });
    batch.add({ ...spot(0.5), v: view(0.5) });
    batch.add(spot(0.75));
    finish();
    await vi.advanceTimersByTimeAsync(CURSOR_BATCH_INTERVAL);
    expect(batches[1].map((point) => point.v?.x)).toEqual([undefined, 0.5, undefined]);
  });

  it("sends the message only on the newest point", async () => {
    const batches: CursorPoint[][] = [];
    let finish = () => {};
    const batch = createCursorBatch((points) => {
      batches.push(points);
      return new Promise<void>((resolve) => (finish = resolve));
    });
    batch.add({ ...spot(0), m: "h" });
    await vi.advanceTimersByTimeAsync(0);
    batch.add({ ...spot(0), m: "hi" });
    batch.add({ ...spot(0), m: "hi!" });
    finish();
    await vi.advanceTimersByTimeAsync(CURSOR_BATCH_INTERVAL);
    expect(batches[1].map((point) => point.m)).toEqual([undefined, "hi!"]);
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

  it("keeps a valid view and drops an invalid one", () => {
    const view = { path: "0.1", x: 0.5, y: 0.5, z: 2 };
    expect(parseCursorSpot({ ...spot(1), v: view })).toEqual({ ...spot(1), v: view });
    expect(parseCursorSpot({ ...spot(1), v: { path: "0..1", x: 0, y: 0 } })).toEqual(
      spot(1),
    );
  });

  it("keeps a short text message and drops any other", () => {
    expect(parseCursorSpot({ ...spot(1), m: "Look here" })).toEqual({
      ...spot(1),
      m: "Look here",
    });
    for (const m of ["a".repeat(101), "bell\u0007", 5, ""])
      expect(parseCursorSpot({ ...spot(1), m })).toEqual(spot(1));
  });

  it("keeps a valid zoom and drops any other", () => {
    expect(parseCursorSpot({ ...spot(1), z: 2.5 })).toEqual({ ...spot(1), z: 2.5 });
    for (const z of [0, -1, 101, "2", NaN])
      expect(parseCursorSpot({ ...spot(1), z })).toEqual(spot(1));
  });
});
