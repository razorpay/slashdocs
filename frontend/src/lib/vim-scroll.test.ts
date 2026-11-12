import { describe, expect, it } from "vitest";
import { reduceVimScroll } from "./vim-scroll";

describe("reduceVimScroll", () => {
  it.each([
    ["j", "line-down"],
    ["k", "line-up"],
    ["G", "bottom"],
  ] as const)("maps %s to %s", (key, action) => {
    expect(reduceVimScroll({ key }, false)).toEqual({ action, gArmed: false });
  });

  it("maps gg to the top and a lone g only arms", () => {
    expect(reduceVimScroll({ key: "g" }, false)).toEqual({
      action: null,
      gArmed: true,
    });
    expect(reduceVimScroll({ key: "g" }, true)).toEqual({
      action: "top",
      gArmed: false,
    });
  });

  it("supports Vim half-page scrolling", () => {
    expect(reduceVimScroll({ key: "d", ctrlKey: true }, false).action).toBe(
      "half-page-down",
    );
    expect(reduceVimScroll({ key: "u", ctrlKey: true }, false).action).toBe(
      "half-page-up",
    );
  });

  it("ignores modified and unrelated keys and clears a pending g", () => {
    expect(reduceVimScroll({ key: "j", metaKey: true }, true)).toEqual({
      action: null,
      gArmed: false,
    });
    expect(reduceVimScroll({ key: "x" }, true)).toEqual({
      action: null,
      gArmed: false,
    });
  });
});
