import { assert, test } from "vitest";

import { isEditableTarget } from "../bridge/dom.ts";

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
