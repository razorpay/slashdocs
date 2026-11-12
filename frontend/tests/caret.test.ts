import { expect, test } from "vitest";
import { caretOf, isCaret, placeCaret } from "../bridge/caret.ts";

// select puts the selection from the first "|" to the second, or the caret
// at one "|", or at the start, in the text of the body.
function select(html: string) {
  document.body.innerHTML = html.replaceAll("|", "");
  const text = html.replace(/<[^>]*>/g, "");
  const [from = 0, to = from] = [...text.matchAll(/\|/g)].map((m, i) => m.index - i);
  const at = (offset: number): [Node, number] => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const length = (n as Text).length;
      if (offset <= length) return [n, offset];
      offset -= length;
    }
    throw new Error("no text there");
  };
  document.getSelection()!.setBaseAndExtent(...at(from), ...at(to));
}

// shown gives the text of the body with "|" at the ends of the selection.
function shown() {
  const range = document.getSelection()!.getRangeAt(0);
  const mark = (node: Node, offset: number) => {
    const text = node as Text;
    text.insertData(offset, "|");
  };
  mark(range.endContainer, range.endOffset);
  if (!range.collapsed) mark(range.startContainer, range.startOffset);
  return document.body.textContent;
}

test("puts the caret back at its characters in a new document", () => {
  select("<p>One two</p><p>Thr|ee</p>");
  const caret = caretOf(document)!;
  expect(isCaret(JSON.parse(JSON.stringify(caret)))).toBe(true);
  select("<p>One two</p><p>Three</p>");
  placeCaret(document, caret);
  expect(shown()).toBe("One twoThr|ee");
});

test("finds the text of a selection that moved, when it is there once", () => {
  select("<p>Intro</p><p>One |two| three</p>");
  const caret = caretOf(document)!;
  select("<p>Intro</p><p>A new paragraph</p><p>One two three</p>");
  placeCaret(document, caret);
  expect(shown()).toBe("IntroA new paragraphOne |two| three");
});

test("leaves the selection when its text is not there, or is there twice", () => {
  select("<p>One |two</p>");
  const caret = caretOf(document)!;
  for (const html of ["<p>Ot|her</p>", "<p>Ot|her</p><p>One two</p><p>One two</p>"]) {
    select(html);
    placeCaret(document, caret);
    expect(shown()).toContain("Ot|her");
  }
  expect(isCaret({ start: 1, end: "2", at: 0, text: "x" })).toBe(false);
});
