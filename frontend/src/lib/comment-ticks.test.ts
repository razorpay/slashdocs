import { describe, expect, it } from "vitest";
import { commentTicks } from "./comment-ticks";

describe("commentTicks", () => {
  const base = { scrollHeight: 1000, viewportHeight: 500 };
  const positions = new Map([
    ["late", { top: 1000, bottom: 1020 }],
    ["early", { top: 200, bottom: 220 }],
  ]);

  it("places ticks at their share of the document, in document order", () => {
    const ticks = commentTicks({ ...base, ids: ["late", "early"], positions });

    expect(ticks).toEqual([
      { id: "early", y: 0.2 },
      { id: "late", y: 1 },
    ]);
  });

  it("keeps ticks inside the strip and breaks ties by id", () => {
    const ticks = commentTicks({
      ...base,
      ids: ["b", "a", "above", "below"],
      positions: new Map([
        ["b", { top: 200, bottom: 220 }],
        ["a", { top: 200, bottom: 220 }],
        ["above", { top: -20, bottom: 0 }],
        ["below", { top: 5000, bottom: 5020 }],
      ]),
    });

    expect(ticks).toEqual([
      { id: "above", y: 0 },
      { id: "a", y: 0.2 },
      { id: "b", y: 0.2 },
      { id: "below", y: 1 },
    ]);
  });

  it("skips threads without a position, such as unanchored ones", () => {
    const ticks = commentTicks({ ...base, ids: ["early", "lost"], positions });

    expect(ticks?.map((tick) => tick.id)).toEqual(["early"]);
  });

  it("shows nothing when no thread has a position", () => {
    expect(commentTicks({ ...base, ids: ["lost"], positions })).toBeNull();
  });

  it("shows nothing when the whole document is already on screen", () => {
    const ticks = commentTicks({
      ...base,
      scrollHeight: 450,
      ids: ["early"],
      positions,
    });

    expect(ticks).toBeNull();
  });
});
