import { expect, it } from "vitest";
import { placeBeside } from "./place-beside";

const bounds = { left: 0, top: 0, width: 1000, height: 800 };
const size = { width: 300, height: 200 };
const pin = (left: number, top: number) => ({ left, top, width: 28, height: 28 });

it("puts the box to the right of its anchor, level with its top", () => {
  expect(placeBeside(pin(100, 300), size, bounds)).toEqual({ x: 136, y: 300 });
});

it("goes to the left near the right edge", () => {
  expect(placeBeside(pin(800, 300), size, bounds)).toEqual({ x: 492, y: 300 });
});

it("goes under a highlight as wide as the page, or over it near the bottom", () => {
  const wide = { left: 20, top: 100, width: 960, height: 40 };
  expect(placeBeside(wide, size, bounds)).toEqual({ x: 20, y: 148 });
  expect(placeBeside({ ...wide, top: 700 }, size, bounds)).toEqual({ x: 20, y: 492 });
});

it("stays inside its bounds when the anchor scrolled out of them", () => {
  expect(placeBeside(pin(100, -500), size, bounds)).toEqual({ x: 136, y: 12 });
  expect(placeBeside(pin(100, 5000), size, bounds)).toEqual({ x: 136, y: 588 });
});
