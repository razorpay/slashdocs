import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Popover, panelPlace } from "./popover";

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

describe("Popover", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // The panel is portalled, and the Portal renders nothing on the commit that
  // opens it, so the panel has to be measured once it exists.
  it("keeps the opened panel on a phone screen", () => {
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(390);
    // Only laid-out panels have a width; the trigger is the Aa button, about
    // 88 px from the right edge.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute("role") === "dialog" && this.isConnected ? 352 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const r =
          this.tagName === "BUTTON"
            ? { left: 266, right: 302, top: 8, bottom: 40 }
            : { left: 0, right: 0, top: 0, bottom: 0 };
        return {
          ...r,
          x: r.left,
          y: r.top,
          width: r.right - r.left,
          height: r.bottom - r.top,
          toJSON: () => r,
        } as DOMRect;
      },
    );
    const ui = (open: boolean) => (
      <Popover
        open={open}
        onOpenChange={() => {}}
        trigger={<button type="button">Aa</button>}
        label="Reading settings"
      >
        <p>Settings</p>
      </Popover>
    );
    const { rerender } = render(ui(false));
    rerender(ui(true));
    const panel = screen.getByRole("dialog", { name: "Reading settings" });
    // 390 − 352 − 8: the panel's left edge stays 8 px from the screen edge.
    expect(panel.style.right).toBe("30px");
    expect(panel.style.top).toBe("46px");
  });
});
