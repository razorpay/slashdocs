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
