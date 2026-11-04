import { expect, test } from "vitest";

import { blockTexts, changedBlocks } from "../bridge/changed-blocks.ts";

test.each([
  ["no change", ["a", "b", "c"], ["a", "b", "c"], []],
  ["a changed block", ["a", "b", "c"], ["a", "B", "c"], [1]],
  ["an added block", ["a", "c"], ["a", "b", "c"], [1]],
  ["a removed block", ["a", "b", "c"], ["a", "c"], []],
  ["changes far apart", ["a", "b", "c", "d", "e"], ["A", "b", "c", "D", "e"], [0, 3]],
  ["a moved block", ["a", "b", "c"], ["b", "c", "a"], [2]],
  ["a repeated block", ["x", "x"], ["x", "y", "x"], [1]],
  ["all new", [], ["a", "b"], [0, 1]],
])("%s", (_, before, after, changed) => {
  expect(changedBlocks(before, after)).toEqual(changed);
});

test("a block's text is its own, without its inner blocks, code or controls", () => {
  document.body.innerHTML = `<div>Intro <b>bold</b>
    <p>First  line</p><script>var x = 1</script>
    <ul><li>One</li><li>Two<button class="slashdocs-heading-link">#</button></li></ul>
    <p> </p></div>`;
  // jsdom lays out no blocks: say which elements are inline.
  for (const el of document.querySelectorAll("b,button"))
    (el as HTMLElement).style.display = "inline";
  expect(blockTexts(document).map((block) => block.text)).toEqual([
    "Intro bold",
    "First line",
    "One",
    "Two",
  ]);
});
