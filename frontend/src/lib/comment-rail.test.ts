import { describe, expect, it } from "vitest";
import { commentTicks, layoutCommentRail } from "./comment-rail";

describe("layoutCommentRail", () => {
  it("places unanchored cards at the start before anchored cards", () => {
    const result = layoutCommentRail(
      [
        { id: "anchored", anchorTop: 20, height: 80 },
        { id: "lost", anchorTop: 0, height: 60, atStart: true },
      ],
      600,
    );

    expect(result.map(({ id, y }) => ({ id, y }))).toEqual([
      { id: "lost", y: 12 },
      { id: "anchored", y: 84 },
    ]);
  });

  it("keeps unanchored cards in place as selection moves between them", () => {
    const items = [
      { id: "first", anchorTop: 0, height: 100, atStart: true },
      { id: "second", anchorTop: 0, height: 180, atStart: true },
      { id: "third", anchorTop: 0, height: 80, atStart: true },
      { id: "anchored", anchorTop: 600, height: 100 },
    ];
    const initial = layoutCommentRail(items, 1200);
    for (const priorityId of ["third", "second", "first", "third"]) {
      expect(
        layoutCommentRail(items, 1200, {
          priorityId,
          viewport: { top: 0, height: 400 },
        }),
      ).toEqual(initial);
    }
  });

  it("keeps cards ordered and separated when highlights are close together", () => {
    const result = layoutCommentRail(
      [
        { id: "second", anchorTop: 115, height: 90 },
        { id: "first", anchorTop: 100, height: 80 },
      ],
      800,
    );

    expect(result[0]).toMatchObject({ id: "first", y: 100 });
    expect(result[1]).toMatchObject({ id: "second", y: 192 });
  });

  it("keeps a single card inside the viewport near the bottom", () => {
    const [result] = layoutCommentRail(
      [{ id: "bottom", anchorTop: 590, height: 100 }],
      640,
    );

    expect(result.y).toBe(528);
  });
  it("gives the focused item its anchor and moves colliding earlier cards aside", () => {
    const result = layoutCommentRail(
      [
        { id: "lost", anchorTop: 0, height: 300, atStart: true },
        { id: "existing", anchorTop: 400, height: 400 },
        { id: "composer", anchorTop: 420, height: 220 },
        { id: "later", anchorTop: 450, height: 200 },
      ],
      1800,
      { priorityId: "composer", viewport: { top: 300, height: 600 } },
    );
    expect(result.find((item) => item.id === "composer")?.y).toBe(420);
    for (let i = 1; i < result.length; i++) {
      expect(result[i].y).toBeGreaterThanOrEqual(
        result[i - 1].y + result[i - 1].height + 12,
      );
    }
    expect(result.find((item) => item.id === "existing")!.y).toBeGreaterThan(420);
  });

  it("fits a focused box above the viewport bottom without moving offscreen highlights", () => {
    const items = [{ id: "composer", anchorTop: 850, height: 220 }];
    const [focused] = layoutCommentRail(items, 2000, {
      priorityId: "composer",
      viewport: { top: 300, height: 600 },
    });
    expect(focused.y + focused.height).toBeLessThanOrEqual(888);
    expect(focused.y).toBeLessThanOrEqual(850);
    const [scrolledAway] = layoutCommentRail(items, 2000, {
      priorityId: "composer",
      viewport: { top: 1100, height: 600 },
    });
    expect(scrolledAway.y).toBe(850);
    const [released] = layoutCommentRail(items, 2000);
    expect(released.y).toBe(850);
  });
});

describe("commentTicks", () => {
  const base = { scrollHeight: 1100, viewportHeight: 500, topInset: 100 };
  const positions = new Map([
    ["late", { top: 1100, bottom: 1120 }],
    ["early", { top: 300, bottom: 320 }],
  ]);

  it("places ticks in the rail's coordinates, in document order", () => {
    const ticks = commentTicks({ ...base, ids: ["late", "early"], positions });

    expect(ticks).toEqual([
      { id: "early", y: 0.2 },
      { id: "late", y: 1 },
    ]);
  });

  it("keeps ticks inside the strip and breaks ties by id, like the rail", () => {
    const ticks = commentTicks({
      ...base,
      ids: ["b", "a", "above", "below"],
      positions: new Map([
        ["b", { top: 300, bottom: 320 }],
        ["a", { top: 300, bottom: 320 }],
        ["above", { top: 20, bottom: 40 }],
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
      scrollHeight: 550,
      ids: ["early"],
      positions,
    });

    expect(ticks).toBeNull();
  });
});
