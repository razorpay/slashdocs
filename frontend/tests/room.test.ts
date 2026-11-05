import { assert, test, vi } from "vitest";

import { cover, covered, slide } from "../bridge/dom.ts";

const styles = () =>
  Array.from(document.head.querySelectorAll("style"), (s) => s.textContent);

// The room that a comment sheet or a panel leaves goes only after the view
// scrolls back into the page, so that the page does not jump.
test.each([
  [
    "a comment sheet",
    (px: number) => cover(document, px),
    "top",
    /padding-bottom:300px/,
  ],
  [
    "a panel",
    (px: number) => slide(document, px),
    "left",
    /width:calc\(100% \+ 300px\)/,
  ],
])("the room for %s goes after the scroll back", async (_, room, axis, css) => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  room(300);
  assert.match(styles().join(), css);
  scrollTo.mockClear();

  room(0);
  // At once, nothing covers the view, and the view scrolls back.
  assert.strictEqual(covered(document), 0);
  assert.containsAllKeys(scrollTo.mock.calls[0][0], [axis]);
  // The room stays while the view scrolls, and goes after it stops.
  assert.match(styles().join(), css);
  await vi.waitFor(() => assert.notMatch(styles().join(), css));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// A page of 1000px, in a view of 800px, scrolled to its end.
function page(scrollTop: number) {
  const root = document.documentElement;
  const room = () => parseFloat(getComputedStyle(root).paddingBottom) || 0;
  Object.defineProperty(document, "scrollingElement", {
    configurable: true,
    value: root,
  });
  Object.defineProperties(root, {
    clientHeight: { configurable: true, value: 800 },
    scrollHeight: { configurable: true, get: () => 1000 + room() },
    scrollTop: { configurable: true, value: scrollTop },
  });
  vi.stubGlobal("scrollY", scrollTop);
}

// While a sheet stays open, the view keeps the room that it shows. So the
// words above a sheet that shrinks, as when replies go, stay where they are.
test("the room of a sheet that shrinks keeps what the view shows", () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  page(0);
  cover(document, 500);
  // The view shows 400px of the room after the page end.
  page(600);
  cover(document, 150);
  assert.match(styles().join(), /padding-bottom:400px/);
  assert.strictEqual(covered(document), 150);
  assert.strictEqual(scrollTo.mock.calls.length, 0);
  // A sheet that grows again takes more room.
  cover(document, 600);
  assert.match(styles().join(), /padding-bottom:600px/);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
