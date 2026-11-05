import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createCursorLayer, trackPointer } from "../bridge/cursors.ts";

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no layout: every point is on a tall body.
  document.elementFromPoint = () => document.body;
  vi.spyOn(document.body, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 1000, 4000),
  );
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

test("a follow before the first view keeps waiting, and follows that view", () => {
  const unfollowed = vi.fn();
  const layer = createCursorLayer(() => document, unfollowed);
  const moves: unknown[] = [];
  window.addEventListener("slashdocs:follow", (e) => {
    e.preventDefault();
    moves.push((e as CustomEvent).detail);
  });

  layer.follow("s1", true);
  expect(unfollowed).not.toHaveBeenCalled();
  expect(moves).toHaveLength(0);

  const v = { path: "", x: 0.5, y: 0.9 };
  layer.receive({
    session: "s1",
    name: "Asha",
    color: "#e11d48",
    points: [{ t: 1, path: "", x: 0, y: 0, hidden: true, v }],
  });
  vi.runOnlyPendingTimers();

  expect(moves).toEqual([expect.objectContaining({ x: 500, y: 3600 })]);
  const frame = document.querySelector(".slashdocs-follow");
  expect(frame).toHaveAttribute("data-on");
  // The app's doc bar names whom the view follows: the frame covers no text.
  expect(frame).toBeEmptyDOMElement();
  expect(unfollowed).not.toHaveBeenCalled();
});

test("a viewer sends their view at once, before any pointer move", () => {
  const report = vi.fn();
  trackPointer(document, report);
  vi.runOnlyPendingTimers();
  expect(report).toHaveBeenCalledWith(
    expect.objectContaining({ hidden: true, v: expect.objectContaining({ path: "" }) }),
  );
});
