import { describe, expect, it } from "vitest";
import { layoutCommentRail } from "./comment-rail";

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
