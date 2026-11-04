import { assert, test } from "vitest";

import { isEditableTarget, markSurface } from "../bridge/dom.ts";

// As in Google Docs, the editor's text takes every key only while it has the
// caret. After Esc blurs it, the bridge's shortcuts work again.
test("editable content types only while it has the focus", () => {
  // jsdom has no design mode.
  Object.defineProperty(document, "designMode", { value: "off" });
  document.body.innerHTML = '<div contenteditable="true"><p>Words</p></div>';
  const editor = document.querySelector("div")!;
  const text = document.querySelector("p")!;
  editor.focus();
  assert.isTrue(isEditableTarget(document, text));
  editor.blur();
  assert.isFalse(isEditableTarget(document, text));
});

// The bridge's controls take the colors of the page under them, which can
// differ from the theme of the app.
test.each([
  ["", "", "light"],
  ["#111", "", "dark"],
  ["transparent", "#0b1020", "dark"],
  ["rgba(0, 0, 0, 0.5)", "#fff", "dark"],
  ["#fafafa", "#000", "light"],
])("a body background %s on an html background %s is %s", (body, html, surface) => {
  document.body.style.background = body;
  document.documentElement.style.background = html;
  markSurface(document);
  assert.equal(
    document.documentElement.getAttribute("data-slashdocs-surface"),
    surface,
  );
});
