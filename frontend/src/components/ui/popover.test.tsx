import { describe, expect, it } from "vitest";
import { panelPlace } from "./popover";

const rect = (left: number, right: number, bottom = 40) => ({ left, right, bottom });

describe("panelPlace", () => {
  it("aligns the panel's right edge with its trigger when it fits", () => {
    expect(panelPlace(rect(1300, 1336), 352, 1440)).toEqual({ top: 46, right: 104 });
  });

  it("keeps the panel on a phone screen when the trigger is far from the edge", () => {
    // 390 px phone, Aa trigger about 88 px from the right edge.
    const p = panelPlace(rect(266, 302), 352, 390);
    expect(390 - p.right - 352).toBeGreaterThanOrEqual(8);
    expect(p.right).toBeGreaterThanOrEqual(8);
  });

  it("keeps a margin on the right edge too", () => {
    expect(panelPlace(rect(370, 388), 200, 390).right).toBe(8);
  });

  it("pins a panel wider than the screen to the left margin", () => {
    const p = panelPlace(rect(100, 136), 500, 390);
    expect(p.right).toBe(8);
  });
});
