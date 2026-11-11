import { assert, test } from "vitest";

import { isEditableTarget, markSurface, placeClear } from "../bridge/dom.ts";

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

// A page of text with no clear room: each place covers text.
function textEverywhere(width: number, height: number) {
  document.body.innerHTML = "<p>Words</p>";
  const words = document.querySelector("p")!.firstChild!;
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: height,
    configurable: true,
  });
  document.caretRangeFromPoint = () => {
    const range = document.createRange();
    range.setStart(words, 0);
    return range;
  };
  Range.prototype.getClientRects = () =>
    [new DOMRect(0, 0, width, height)] as unknown as DOMRectList;
  const el = document.createElement("div");
  Object.defineProperty(el, "offsetWidth", { value: 100 });
  Object.defineProperty(el, "offsetHeight", { value: 40 });
  document.body.append(el);
  return el;
}

const place = (el: HTMLElement) => [el.style.left, el.style.top];

// Near its words, over other text, not at an edge of the viewport. When the
// first place covers the words, the next one takes it.
test.each([
  ["the first place", [[200, 300]]],
  [
    "the first place that covers none of the words",
    [
      [200, 90],
      [200, 300],
    ],
  ],
])("with no clear room, a control goes to %s", (_, places) => {
  const el = textEverywhere(1000, 800);
  try {
    const words = [new DOMRect(200, 100, 60, 20)];
    assert.isNull(placeClear(document, el, words, places));
    assert.deepEqual(place(el), ["200px", "300px"]);
  } finally {
    delete (document as Partial<Document>).caretRangeFromPoint;
    delete (Range.prototype as Partial<Range>).getClientRects;
  }
});

// The actions at a selection, with a mouse, sit at the first place that
// covers none of its words, over other text.
test("over text, a control goes to the first place that covers none of its words", () => {
  const el = textEverywhere(1000, 800);
  try {
    const words = [new DOMRect(200, 100, 60, 20)];
    const places = [
      [200, 90],
      [200, 130],
    ];
    assert.isNull(placeClear(document, el, words, places, { overText: true }));
    assert.deepEqual(place(el), ["200px", "130px"]);
  } finally {
    delete (document as Partial<Document>).caretRangeFromPoint;
    delete (Range.prototype as Partial<Range>).getClientRects;
  }
});

// With a finger, the actions at a selection dock at an edge of the viewport
// instead.
test("with no clear room, a control that docks goes to the bottom of the viewport", () => {
  const el = textEverywhere(1000, 800);
  try {
    const words = [new DOMRect(200, 100, 60, 20)];
    assert.equal(
      placeClear(document, el, words, [[200, 300]], { dock: true }),
      "bottom",
    );
    assert.deepEqual(place(el), ["450px", "752px"]);
  } finally {
    delete (document as Partial<Document>).caretRangeFromPoint;
    delete (Range.prototype as Partial<Range>).getClientRects;
  }
});
