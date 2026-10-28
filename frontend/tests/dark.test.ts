import { assert, test } from "vitest";
import { applyDark, DARK_STYLE_ID, isLight, parseColor } from "../bridge/dark.ts";

// The bridge reads computed styles through the document's own window, which
// a parsed document lacks, so the tests use the jsdom page itself.
function documentOf(body: string): Document {
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("style");
  const style = /style="([^"]*)"/.exec(body)?.[1] || "";
  document.body.setAttribute("style", style);
  document.body.textContent = "x";
  return document;
}

test("colors parse from computed rgb and rgba values", () => {
  assert.deepEqual(parseColor("rgb(255, 255, 255)"), [255, 255, 255, 1]);
  assert.deepEqual(parseColor("rgba(0, 0, 0, 0)"), [0, 0, 0, 0]);
  assert.isNull(parseColor("transparent"));
  assert.isTrue(isLight([250, 250, 250]));
  assert.isFalse(isLight([24, 24, 27]));
});

test("a light page is inverted, and turning dark mode off restores it", () => {
  const d = documentOf(`<body style="background-color: rgb(255, 255, 255)">x</body>`);
  assert.isTrue(applyDark(d, true));
  assert.include(d.getElementById(DARK_STYLE_ID)!.textContent, "invert(1)");
  // Applying again replaces the style rather than stacking a second one.
  assert.isTrue(applyDark(d, true));
  assert.lengthOf(d.querySelectorAll(`#${DARK_STYLE_ID}`), 1);
  assert.isFalse(applyDark(d, false));
  assert.isNull(d.getElementById(DARK_STYLE_ID));
});

test("a page that is already dark is left as it is", () => {
  const d = documentOf(`<body style="background-color: rgb(17, 17, 17)">x</body>`);
  assert.isFalse(applyDark(d, true));
  const transparent = documentOf(`<body style="color: rgb(240, 240, 240)">x</body>`);
  assert.isFalse(applyDark(transparent, true));
});

test("a transparent page with dark text is inverted", () => {
  const d = documentOf(`<body style="color: rgb(20, 20, 20)">x</body>`);
  assert.isTrue(applyDark(d, true));
});
