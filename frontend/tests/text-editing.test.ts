import { afterEach, assert, describe, test, vi } from "vitest";
// The editor takes only trusted input, which a test cannot dispatch. jsdom
// keeps the trusted flag on the event behind its wrapper, so the test sets it
// there and dispatches the event as jsdom dispatches its own.
// @ts-expect-error jsdom has no types for its wrappers.
import { implForWrapper } from "jsdom/lib/generated/idl/utils.js";

import { startTextEditing } from "../bridge/text-editing.ts";
import { REFUSED } from "../bridge/structure.ts";
import { applyRegions, parseSource, tagSource } from "../src/lib/source-edits.ts";
import { merge3 } from "../src/lib/source-merge.ts";
import { patchBetween } from "../src/lib/source-patch.ts";

function dispatch<E extends Event>(target: EventTarget, event: E): E {
  const impl = implForWrapper(event);
  impl.isTrusted = true;
  implForWrapper(target)._dispatch(impl);
  return event;
}

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const page = (body: string) =>
  `<!doctype html>\n<html><head><title>T</title></head>\n<body>\n${body}\n</body></html>\n`;

// open renders source as the server does, loads it as the frame's document,
// and starts the editor on it. script changes the document first, as the
// document's own scripts do. A reader who does not edit starts the editor
// not editable.
async function open(body: string, script?: (d: Document) => void, editable = true) {
  const source = page(body);
  const tree = await parseSource(source);
  const tagged = tagSource(tree);
  const parsed = new DOMParser().parseFromString(tagged, "text/html");
  document.replaceChild(
    document.importNode(parsed.documentElement, true),
    document.documentElement,
  );
  script?.(document);
  const refused: string[] = [];
  const dirty: true[] = [];
  const editor = startTextEditing(
    document,
    tagged,
    {
      beforeTouch() {},
      onDirty: () => dirty.push(true),
      onRefused: (reason) => refused.push(reason),
    },
    editable,
  )!;
  stop = editor.stop;
  // saved is the source with the editor's changes written into it. made are
  // the start tags of the elements that patches put in.
  const saved = (made?: Set<string>) => {
    const result = applyRegions(tree, editor.take().regions, [], made);
    if ("refused" in result) assert.fail(result.refused);
    return result.html;
  };
  // expect checks the saved source: the source with each of the changes.
  const expect = (...changes: [string, string][]) =>
    assert.equal(
      saved(),
      changes.reduce((html, [from, to]) => html.replace(from, to), source),
    );
  // patch shows the text of other people as the frame does, for the count
  // of user operations now. A place is the text of a start tag, or null.
  // marks are the ranges of html that other people put in.
  const patch = (
    ...patches: [
      in_: string,
      after: string | null,
      before: string | null,
      html: string,
      marks?: [number, number][],
    ][]
  ) => {
    const offset = (tag: string | null) => (tag === null ? null : source.indexOf(tag));
    return editor.patch(
      patches.map(([parent, after, before, html, marks]) => ({
        in: offset(parent),
        after: offset(after),
        before: offset(before),
        html,
        marks,
      })),
      editor.edits(),
    );
  };
  return { source, saved, expect, refused, dirty, patch, run: editor.run, editor };
}

// at finds a place in the text of the document. "|" marks it in the text of
// one text node.
function at(marked: string): [Text, number] {
  const text = marked.replace("|", "");
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = (n as Text).data.indexOf(text);
    if (i >= 0) return [n as Text, i + marked.indexOf("|")];
  }
  throw new Error(`no text ${text}`);
}

// place puts the caret at "|", or selects from the first "|" to the second.
function place(start: string, end = start) {
  document.body.focus();
  document.getSelection()!.setBaseAndExtent(...at(start), ...at(end));
}

// input sends an input as the browser does before it changes the DOM. When
// the editor lets the browser do it, the test does what the browser would.
function input(inputType: string, data: Record<string, string> = {}) {
  const event = new InputEvent("beforeinput", {
    inputType,
    data: data.text ?? null,
    bubbles: true,
    cancelable: true,
  });
  const range = targetRange(inputType);
  Object.defineProperty(event, "dataTransfer", {
    value: { getData: (t: string) => data[t] ?? "" },
  });
  Object.defineProperty(event, "getTargetRanges", {
    value: () => [new StaticRange(range)],
  });
  dispatch(document.body, event);
  if (event.defaultPrevented) return false;
  if (inputType.startsWith("delete")) range.deleteContents();
  if (inputType === "insertText") {
    range.deleteContents();
    const { startContainer: node, startOffset: offset } = range;
    if (node.nodeType === Node.TEXT_NODE) {
      // The browser types into the text node, and the caret goes after.
      (node as Text).insertData(offset, data.text);
      document.getSelection()!.collapse(node, offset + data.text.length);
    } else range.insertNode(document.createTextNode(data.text));
  }
  dispatch(document.body, new InputEvent("input", { inputType, bubbles: true }));
  return true;
}

// targetRange gives the range that the browser changes for an input: the
// selection, or the character next to a caret for a character delete.
function targetRange(inputType: string): Range {
  const range = document.getSelection()!.getRangeAt(0).cloneRange();
  const { startContainer: node, startOffset: offset } = range;
  if (range.collapsed && node.nodeType === Node.TEXT_NODE) {
    if (inputType === "deleteContentBackward" && offset > 0)
      range.setStart(node, offset - 1);
    if (inputType === "deleteContentForward" && offset < (node as Text).length)
      range.setEnd(node, offset + 1);
  }
  return range;
}

// caret gives the text of the node of the caret, and its offset in it.
const caret = () => {
  const { focusNode, focusOffset } = document.getSelection()!;
  return [(focusNode as Text).data, focusOffset];
};

function key(init: KeyboardEventInit, target: EventTarget = document.body) {
  return dispatch(
    target,
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
  );
}

test("saves keys typed in text of the body before, between and after its elements", async () => {
  for (const body of ["mi<h2>A</h2>", "<h2>A</h2>mi<p>B</p>", "<h2>A</h2>mi"]) {
    const doc = await open(body);
    place("mi|");
    input("insertText", { text: "d" });
    // The white space after </body> stays there, and does not go in again.
    doc.expect(["mi", "mid"]);
  }
});

describe("Enter", () => {
  test("splits a paragraph into two with its attributes, but not its id", async () => {
    const doc = await open('<p id="ttl" class="note">Hello world</p>');
    place("Hello| world");
    input("insertParagraph");
    doc.expect([
      '<p id="ttl" class="note">Hello world</p>',
      '<p id="ttl" class="note">Hello</p><p class="note"> world</p>',
    ]);
  });

  const texts = () => Array.from(document.querySelectorAll("p"), (p) => p.textContent);

  test("keeps the space at the cut, so that text typed at it stays apart", async () => {
    const doc = await open("<p>kilo lima mike november oscar</p>");
    place("mike| november");
    input("insertParagraph");
    // A space at the start of a block does not show, and the browser drops
    // it when the reader types at it. A no-break space shows, as the browser
    // makes it on Enter.
    assert.deepEqual(texts(), ["kilo lima mike", "\u00a0november oscar"]);
    place("|\u00a0november");
    input("insertText", { text: "new para" });
    doc.expect([
      "<p>kilo lima mike november oscar</p>",
      "<p>kilo lima mike</p><p>new para november oscar</p>",
    ]);
  });

  test("keeps the space before the cut", async () => {
    const doc = await open("<p>kilo lima mike november</p>");
    place("mike |november");
    input("insertParagraph");
    assert.deepEqual(texts(), ["kilo lima mike\u00a0", "november"]);
    doc.expect([
      "<p>kilo lima mike november</p>",
      "<p>kilo lima mike </p><p>november</p>",
    ]);
  });

  test("continues bold text in the new paragraph", async () => {
    const doc = await open("<p>Hello <strong>big world</strong></p>");
    place("big| world");
    input("insertParagraph");
    doc.expect([
      "<p>Hello <strong>big world</strong></p>",
      "<p>Hello <strong>big</strong></p><p><strong> world</strong></p>",
    ]);
  });

  test("splits a list item", async () => {
    const doc = await open("<ul><li>One two</li></ul>");
    place("One| two");
    input("insertParagraph");
    doc.expect(["<li>One two</li>", "<li>One</li><li> two</li>"]);
  });

  test("on an empty last item leaves the list", async () => {
    const doc = await open("<ul><li>One</li></ul>");
    place("One|");
    input("insertParagraph");
    input("insertParagraph");
    doc.expect(["<ul><li>One</li></ul>", "<ul><li>One</li></ul><p></p>"]);
  });

  test("on an empty middle item splits the list", async () => {
    const doc = await open('<ul class="steps"><li>One</li><li>Two</li></ul>');
    place("One|");
    input("insertParagraph");
    input("insertParagraph");
    doc.expect([
      '<ul class="steps"><li>One</li><li>Two</li></ul>',
      '<ul class="steps"><li>One</li></ul><p></p><ul class="steps"><li>Two</li></ul>',
    ]);
  });

  test("in a heading puts the rest in a new paragraph", async () => {
    const doc = await open('<h2 class="title">Cache settings</h2>');
    place("Cache| settings");
    input("insertParagraph");
    doc.expect([
      '<h2 class="title">Cache settings</h2>',
      '<h2 class="title">Cache</h2><p> settings</p>',
    ]);
  });

  test("in a table cell adds a line break", async () => {
    const doc = await open("<table><tr><td>Ten minutes</td></tr></table>");
    place("Ten| minutes");
    input("insertParagraph");
    doc.expect(["<td>Ten minutes</td>", "<td>Ten<br> minutes</td>"]);
  });

  test("with Shift at the end of a paragraph keeps the new line", async () => {
    const doc = await open("<p>Ten minutes</p>");
    place("Ten minutes|");
    input("insertLineBreak");
    doc.expect(["<p>Ten minutes</p>", "<p>Ten minutes<br><br></p>"]);
  });

  test("with Shift adds a line break", async () => {
    const doc = await open("<p>Ten minutes</p>");
    place("Ten| minutes");
    input("insertLineBreak");
    doc.expect(["<p>Ten minutes</p>", "<p>Ten<br> minutes</p>"]);
  });
});

describe("Backspace and Delete", () => {
  test("Backspace at the start of a paragraph joins it to the one before", async () => {
    const doc = await open("<p>One</p>\n<p>Two</p>");
    place("|Two");
    input("deleteContentBackward");
    // The white space between the two paragraphs goes with the second one.
    doc.expect(["<p>One</p>\n<p>Two</p>\n", "<p>OneTwo</p>\n"]);
  });

  test("Backspace at the start of the first item makes it a paragraph", async () => {
    const doc = await open("<ul><li>One</li><li>Two</li></ul>");
    place("|One");
    input("deleteContentBackward");
    doc.expect(["<ul><li>One</li>", "<p>One</p><ul>"]);
  });

  test("Delete at the end of a paragraph joins the next one to it", async () => {
    const doc = await open("<p>One</p><p>Two</p>");
    place("One|");
    input("deleteContentForward");
    doc.expect(["<p>One</p><p>Two</p>", "<p>OneTwo</p>"]);
  });

  test("a selection across blocks goes, and its end blocks join", async () => {
    const doc = await open("<p>One two</p><p>Three</p><p>Four five</p>");
    place("One |two", "Four| five");
    input("deleteContentBackward");
    doc.expect(["<p>One two</p><p>Three</p><p>Four five</p>", "<p>One  five</p>"]);
  });

  test("a selection of whole paragraphs leaves the first one empty, with a line for the caret", async () => {
    const doc = await open('<p id="b">One</p><p>Two</p><p id="d">Three</p><p>Four</p>');
    place("|One", "Three|");
    input("deleteContentBackward");
    // A block with no line moves the caret of the browser to the next block.
    const b = document.getElementById("b")!;
    assert.isNotNull(b.querySelector("br"));
    assert.isTrue(b.contains(document.getSelection()!.focusNode));
    input("insertText", { text: "R" });
    doc.expect(['<p id="b">One</p><p>Two</p><p id="d">Three</p>', '<p id="b">R</p>']);
  });

  test("a select-all delete leaves the first block empty, and typing goes in it", async () => {
    const doc = await open(
      "<h1>Title</h1>\n<p>One</p>\n<ul><li>Two</li></ul>\n<p>Three</p>",
    );
    // The browser selects all from the first text to the last.
    place("|Title", "Three|");
    input("deleteContentBackward");
    const h1 = document.querySelector("h1")!;
    assert.equal(document.body.children.length, 1);
    assert.isNotNull(h1.querySelector("br"));
    assert.isTrue(h1.contains(document.getSelection()!.focusNode));
    input("insertText", { text: "R" });
    assert.equal(h1.textContent, "R");
    doc.expect([
      "<h1>Title</h1>\n<p>One</p>\n<ul><li>Two</li></ul>\n<p>Three</p>",
      "<h1>R</h1>",
    ]);
  });

  test("typing over whole paragraphs puts the text in the first one", async () => {
    const doc = await open('<p id="b">One</p><p>Two</p><p id="d">Three</p>');
    place("|One", "Three|");
    input("insertText", { text: "R" });
    doc.expect(['<p id="b">One</p><p>Two</p><p id="d">Three</p>', '<p id="b">R</p>']);
  });

  test("typing over a triple click keeps the next paragraph", async () => {
    const doc = await open("<p>One</p><p>Two</p>");
    const [two] = at("Two");
    document.getSelection()!.setBaseAndExtent(...at("|One"), two.parentNode!, 0);
    input("insertText", { text: "Uno" });
    doc.expect(["<p>One</p>", "<p>Uno</p>"]);
  });

  test("a selection over content that a script owns is refused", async () => {
    const doc = await open('<p>One</p><p id="clock"></p><p>Two</p>', (d) => {
      d.getElementById("clock")!.textContent = "12:00";
    });
    place("O|ne", "T|wo");
    assert.isFalse(input("deleteContentBackward"));
    assert.deepEqual(doc.refused, [REFUSED.crossesScript]);
    assert.equal(doc.saved(), doc.source);
  });
});

describe("an inline element that loses all its text", () => {
  test("keeps its tag and attributes for the next typing", async () => {
    const doc = await open('<p>State: <span class="badge">Pending</span></p>');
    place("Pending|");
    for (let i = 0; i < 7; i++) input("deleteContentBackward");
    const badge = document.querySelector(".badge")!;
    assert.isTrue(badge.isConnected);
    assert.isFalse(input("insertText", { text: "Done" }));
    assert.equal(badge.textContent, "Done");
    doc.expect([
      '<span class="badge">Pending</span>',
      '<span class="badge">Done</span>',
    ]);
  });

  test("keeps a link when typing replaces all its text", async () => {
    const doc = await open('<p>See <a href="/docs" class="x">the docs</a>.</p>');
    place("|the docs", "the docs|");
    assert.isFalse(input("insertText", { text: "help" }));
    doc.expect(["the docs", "help"]);
  });

  test("keeps script text and its id when the reader deletes all of it", async () => {
    const doc = await open('<p>Health: <b id="health"></b></p>', (d) => {
      d.getElementById("health")!.textContent = "Green";
    });
    const health = document.getElementById("health")!;
    health.setAttribute("data-slashdocs-script-edit", "");
    health.setAttribute("contenteditable", "true");
    place("Green|");
    for (let i = 0; i < 5; i++) input("deleteContentBackward");
    assert.isFalse(input("insertText", { text: "Amber" }));
    assert.equal(document.getElementById("health"), health);
    assert.equal(health.textContent, "Amber");
    // The app writes script text into the script, not into the regions.
    assert.equal(doc.saved(), doc.source);
  });
});

describe("paste", () => {
  test("plain text makes paragraphs at blank lines and line breaks at new lines", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello| world");
    input("insertFromPaste", { "text/plain": "A\n\nB\nC\n\nD" });
    doc.expect(["<p>Hello world</p>", "<p>HelloA</p><p>B<br>C</p><p>D world</p>"]);
  });

  test("HTML keeps only the allowed elements and safe links", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello |world");
    input("insertFromPaste", {
      "text/html":
        '<meta charset="utf-8"><b class="x" style="color:red" onclick="steal()">Bold</b>' +
        '<script>steal()</script><style>p{}</style><span class="c">span </span>' +
        '<a href="javascript:steal()">bad</a> <a href="https://example.com" onclick="steal()">good</a> ',
      "text/plain": "ignored",
    });
    doc.expect([
      "Hello world",
      'Hello <b>Bold</b>span bad <a href="https://example.com">good</a> world',
    ]);
  });
});

describe("Tab", () => {
  // cell gives the text of the cell that holds the caret.
  const cell = () => document.getSelection()!.focusNode!.textContent;

  test("moves the caret from cell to cell of a table, and stays at the last one", async () => {
    await open(
      "<table><tr><th>Name</th><td>one</td></tr><tr><td>two</td><td>three</td></tr></table>",
    );
    place("o|ne");
    assert.isTrue(key({ key: "Tab" }).defaultPrevented);
    assert.equal(cell(), "two");
    key({ key: "Tab" });
    key({ key: "Tab" });
    assert.equal(cell(), "three");
    key({ key: "Tab", shiftKey: true });
    assert.equal(cell(), "two");
    place("o|ne");
    key({ key: "Tab", shiftKey: true });
    assert.equal(cell(), "Name");
  });

  test("outside a table keeps the focus and the text", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello| world");
    assert.isTrue(key({ key: "Tab" }).defaultPrevented);
    assert.deepEqual(caret(), ["Hello world", 5]);
    assert.equal(doc.saved(), doc.source);
  });
});

describe("formatting", () => {
  test("bold wraps the selection in strong, and again takes it off", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello |world", "Hello world|");
    key({ key: "b", metaKey: true });
    doc.expect(["Hello world", "Hello <strong>world</strong>"]);
    key({ key: "b", metaKey: true });
    assert.equal(doc.saved(), doc.source);
  });

  test("italic wraps the selection in em", async () => {
    const doc = await open("<p>Hello world</p>");
    place("He|llo world", "Hello| world");
    input("formatItalic");
    doc.expect(["Hello world", "He<em>llo</em> world"]);
  });

  test("a link takes the address that the editor types", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello |world", "Hello world|");
    key({ key: "k", ctrlKey: true });
    const field = document.querySelector<HTMLInputElement>(
      ".slashdocs-link-input input",
    )!;
    assert.equal(document.activeElement, field);
    field.value = "example.com/docs";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.isNull(document.querySelector(".slashdocs-link-input"));
    doc.expect(["Hello world", 'Hello <a href="https://example.com/docs">world</a>']);
  });

  test("Esc in the link field changes nothing", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello |world", "Hello world|");
    key({ key: "k", metaKey: true });
    const field = document.querySelector<HTMLInputElement>(
      ".slashdocs-link-input input",
    )!;
    field.value = "https://example.com";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(doc.saved(), doc.source);
  });

  test("paragraphs become a bulleted list, and then a numbered one", async () => {
    const doc = await open("<p>One</p><p>Two</p>");
    place("O|ne", "Tw|o");
    key({ key: "*", code: "Digit8", metaKey: true, shiftKey: true });
    doc.expect(["<p>One</p><p>Two</p>", "<ul><li>One</li><li>Two</li></ul>"]);
    place("O|ne", "Tw|o");
    input("insertOrderedList");
    doc.expect(["<p>One</p><p>Two</p>", "<ol><li>One</li><li>Two</li></ol>"]);
  });
});

describe("undo", () => {
  test("undo puts a split paragraph back, and redo splits it again", async () => {
    const doc = await open('<p class="note">Hello world</p>');
    place("Hello| world");
    input("insertParagraph");
    const split = document.body.innerHTML;
    key({ key: "z", metaKey: true });
    assert.equal(doc.saved(), doc.source);
    assert.equal(document.querySelectorAll("p").length, 1);
    input("historyRedo");
    assert.equal(document.body.innerHTML, split);
    doc.expect([
      '<p class="note">Hello world</p>',
      '<p class="note">Hello</p><p class="note"> world</p>',
    ]);
  });

  test("undo puts back a paragraph that a join removed", async () => {
    const doc = await open("<p>One</p><p>Two</p>");
    place("|Two");
    input("deleteContentBackward");
    doc.expect(["<p>One</p><p>Two</p>", "<p>OneTwo</p>"]);
    input("historyUndo");
    assert.equal(doc.saved(), doc.source);
  });

  test("undo takes back typing too", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello| world");
    input("insertText", { text: "," });
    doc.expect(["Hello world", "Hello, world"]);
    key({ key: "z", ctrlKey: true });
    assert.equal(doc.saved(), doc.source);
  });

  test("typing within one second is one step, and later typing is the next", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const doc = await open("<p>Hello</p>");
    place("Hello|");
    for (const text of [" ", "b", "i", "g"]) {
      input("insertText", { text });
      vi.advanceTimersByTime(200);
    }
    vi.advanceTimersByTime(1000);
    input("insertText", { text: "!" });
    const text = () => document.querySelector("p")!.textContent;
    assert.equal(text(), "Hello big!");
    input("historyUndo");
    assert.equal(text(), "Hello big");
    input("historyUndo");
    assert.equal(text(), "Hello");
    assert.deepEqual(caret(), ["Hello", 5]);
    input("historyUndo");
    assert.equal(doc.saved(), doc.source);
    input("historyRedo");
    input("historyRedo");
    assert.equal(text(), "Hello big!");
    assert.deepEqual(caret(), ["Hello big!", 10]);
    doc.expect(["Hello", "Hello big!"]);
  });

  test("shows the place that it changes when that place is outside the view", async () => {
    await open("<p>One</p>\n<p>Two</p>");
    const shown: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      shown.push(this);
    };
    place("Two|");
    input("insertText", { text: "!" });
    input("historyUndo");
    assert.deepEqual(shown, [], "the place is in the view");
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 5000, 300, 20),
    );
    input("historyRedo");
    assert.deepEqual(shown, [document.querySelectorAll("p")[1]]);
    delete (Element.prototype as Partial<Element>).scrollIntoView;
  });
});

// A select-all delete of another person takes out the paragraphs around
// the one that the person types in. The merge keeps that paragraph, with its
// tags, for the text of the person.
describe("a patch that takes out the paragraphs around the text of the person", () => {
  const body =
    '<h1>Title</h1>\n<p id="b">Before.</p>\n<p id="c">Third here</p>\n<p id="d">After.</p>';

  test("keeps the paragraph of the person, with the caret in it", async () => {
    const doc = await open(body);
    place("Third here|");
    input("insertText", { text: " ty" });
    const p = document.getElementById("c")!;
    const patched = doc.patch(
      ["<h1>", null, null, ""],
      ["<body>", "<h1>", null, '<p id="c"> ty</p>\n'],
    );
    assert.isTrue(patched.ok);
    // The paragraph of the person pairs with the one of the same id, not
    // with the first paragraph.
    assert.equal(document.getElementById("c"), p);
    assert.isNull(document.getElementById("b"));
    assert.deepEqual(caret(), [" ty", 3]);
    input("insertText", { text: "ping" });
    assert.equal(p.textContent, " typing");
    doc.expect([`${body}\n`, '<h1></h1><p id="c"> typing</p>\n']);
  });

  test("writes a paragraph that a patch puts in with its start tag as the patch had it", async () => {
    const doc = await open(body);
    place("|Title", "After.|");
    input("deleteContentBackward");
    const tag = `<p id="c" class='note'>`;
    assert.isTrue(doc.patch(["<body>", "<h1>", null, `${tag}t</p>\n`]).ok);
    // The person types on in the heading that the delete left.
    input("insertText", { text: "fresh" });
    assert.equal(
      doc.saved(new Set([tag])),
      doc.source.replace(`${body}\n`, `<h1>fresh</h1>${tag}t</p>\n`),
    );
  });

  test("writes a table that a patch puts in with no <tbody> tag as the patch had it", async () => {
    const doc = await open("<p>One</p>");
    const table = `<table class="t"><tr><td>cell</td></tr></table>`;
    assert.isTrue(doc.patch(["<body>", "<p>", null, `\n${table}`]).ok);
    place("One|");
    input("insertText", { text: "!" });
    assert.equal(
      doc.saved(new Set([`<table class="t">`, "<tr>", "<td>"])),
      doc.source.replace("<p>One</p>\n", `<p>One!</p>\n${table}`),
    );
  });
});

// The journal holds what the person did. A patch brings the text of other
// people into the same nodes, and Undo must take back only the text of the
// person.
describe("undo after the text of other people came in", () => {
  const texts = () =>
    Array.from(document.querySelectorAll("h2,p"), (el) => el.textContent);
  // later makes the next typing a new step of the journal.
  const later = () => vi.advanceTimersByTime(5000);

  test("takes back the typing of the person, and leaves the text before and after it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const doc = await open("<h2>Title</h2>\n<p>Hello world</p>");
    place("Title|");
    input("insertText", { text: "!" });
    later();
    place("Hello| world");
    input("insertText", { text: " big" });
    // Another person typed before the caret and after it, in the same text.
    assert.isTrue(doc.patch(["<p>", null, null, "Oh. Hello big world, and more"]).ok);
    input("historyUndo");
    assert.deepEqual(texts(), ["Title!", "Oh. Hello world, and more"]);
    assert.deepEqual(caret(), ["Oh. Hello world, and more", 9]);
    input("historyRedo");
    assert.deepEqual(texts(), ["Title!", "Oh. Hello big world, and more"]);
    assert.deepEqual(caret(), ["Oh. Hello big world, and more", 13]);
    // The other person types on, at the end of the text of the person.
    doc.patch(["<p>", null, null, "Oh. Hello big wide world, and more"]);
    input("historyUndo");
    assert.deepEqual(texts(), ["Title!", "Oh. Hello wide world, and more"]);
    doc.expect(["Title", "Title!"], ["Hello world", "Oh. Hello wide world, and more"]);
    // The step before is in another block, and still goes back.
    input("historyUndo");
    assert.deepEqual(texts(), ["Title", "Oh. Hello wide world, and more"]);
    input("historyUndo");
    doc.expect(["Hello world", "Oh. Hello wide world, and more"]);
  });

  test("takes back each of two steps in one text after a patch between them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const doc = await open("<p>One two three</p>");
    place("One| two three");
    input("insertText", { text: " A" });
    doc.patch(["<p>", null, null, "Zero. One A two three"]);
    later();
    place("One A two| three");
    input("insertText", { text: " B" });
    doc.patch(["<p>", null, null, "Zero. One A, two B three."]);
    input("historyUndo");
    assert.deepEqual(texts(), ["Zero. One A, two three."]);
    input("historyUndo");
    assert.deepEqual(texts(), ["Zero. One, two three."]);
    input("historyRedo");
    input("historyRedo");
    assert.deepEqual(texts(), ["Zero. One A, two B three."]);
    doc.expect(["One two three", "Zero. One A, two B three."]);
  });

  test("takes back a deletion of the person where the text is now", async () => {
    const doc = await open("<p>One two three</p>");
    place("One |two three", "One two |three");
    input("deleteContentBackward");
    doc.patch(["<p>", null, null, "Zero. One three, four"]);
    input("historyUndo");
    assert.deepEqual(texts(), ["Zero. One two three, four"]);
    doc.expect(["One two three", "Zero. One two three, four"]);
  });

  test("does not put a paragraph twice after Enter and a patch that rewrites it", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const doc = await open("<p>Intro. Second paragraph</p>");
    place("Second paragraph|");
    input("insertText", { text: "." });
    later();
    place("Intro.| Second");
    input("insertParagraph");
    doc.patch(["<body>", "<p>", null, "<p> Second paragraph, rewritten.</p>\n"]);
    // The patch changed the paragraph that Enter made, so Enter does not go
    // back, and the typing before it does not go back out of order.
    key({ key: "z", metaKey: true });
    key({ key: "z", metaKey: true });
    assert.deepEqual(texts(), ["Intro.", "\u00a0Second paragraph, rewritten."]);
  });

  test("takes back Enter after a patch that rewrites another paragraph", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const doc = await open("<p>Intro.</p>\n<p>Second</p>");
    place("Second|");
    input("insertText", { text: "." });
    later();
    place("Intro.|");
    input("insertParagraph");
    assert.equal(document.querySelectorAll("p").length, 3);
    doc.patch(["<p>Second", null, null, "Rewritten by another person"]);
    key({ key: "z", metaKey: true });
    assert.deepEqual(texts(), ["Intro.", "Rewritten by another person"]);
    // The patch took out the text of the step before, so Undo has no more.
    key({ key: "z", metaKey: true });
    assert.deepEqual(texts(), ["Intro.", "Rewritten by another person"]);
    doc.expect(["Second", "Rewritten by another person"]);
  });

  test("does nothing when the patch changed the text that the person typed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const doc = await open("<h2>Title</h2>\n<p>Hello world</p>");
    place("Title|");
    input("insertText", { text: "!" });
    later();
    place("Hello| world");
    input("insertText", { text: " big" });
    doc.patch(["<p>", null, null, "Hello bigger world"]);
    doc.patch(["<p>", null, null, "Hello b-igger world"]);
    // No older step goes back in its place: the person does not look there.
    input("historyUndo");
    input("historyUndo");
    assert.deepEqual(texts(), ["Title!", "Hello b-igger world"]);
    input("historyRedo");
    assert.deepEqual(texts(), ["Title!", "Hello b-igger world"]);
    doc.expect(["Title", "Title!"], ["Hello world", "Hello b-igger world"]);
  });

  test("does nothing after a patch changed a paragraph that the person made", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const doc = await open("<h2>Title</h2>\n<p>Hello world</p>");
    place("Title|");
    input("insertText", { text: "!" });
    later();
    place("Hello| world");
    input("insertParagraph");
    doc.patch(["<body>", "<p>", null, "<p> world of others</p>\n"]);
    input("historyUndo");
    input("historyUndo");
    assert.deepEqual(texts(), ["Title!", "Hello", "\u00a0world of others"]);
  });

  test("takes back a word when the word that another person typed after it ends the same", async () => {
    const doc = await open("<p>All the</p>");
    place("All| the");
    input("insertText", { text: " of" });
    // " if" after " of" is the same change as "f i" in the middle of " of".
    doc.patch(["<p>", null, null, "All of if the"]);
    input("historyUndo");
    assert.deepEqual(texts(), ["All if the"]);
    // A patch takes the last word out, and Redo still puts " of" back.
    doc.patch(["<p>", null, null, "All if"]);
    input("historyRedo");
    assert.deepEqual(texts(), ["All of if"]);
    doc.expect(["All the", "All of if"]);
  });

  test("puts typing back at its place after a patch took out the letter before it", async () => {
    const doc = await open("<p>time</p>");
    place("time|");
    input("insertText", { text: " the" });
    input("historyUndo");
    // " the" after "time" is also "e th" after "tim". The "e" goes.
    doc.patch(["<p>", null, null, "tim"]);
    input("historyRedo");
    assert.deepEqual(texts(), ["tim the"]);
    doc.expect(["time", "tim the"]);
  });

  test("puts typing back with Redo after a patch came between", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello| world");
    input("insertText", { text: " big" });
    input("historyUndo");
    doc.patch(["<p>", null, null, "Oh. Hello world"]);
    input("historyRedo");
    assert.deepEqual(texts(), ["Oh. Hello big world"]);
    input("historyUndo");
    assert.deepEqual(texts(), ["Oh. Hello world"]);
    doc.expect(["Hello world", "Oh. Hello world"]);
  });

  test("never loses or doubles a word of another person, in any order of typing, patches, Undo and Redo", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let seed = 7;
    const random = (below: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed >>> 8) % below;
    };
    let undone = 0;
    for (let run = 0; run < 100; run++) {
      stop?.();
      const doc = await open("<p> a b c</p>");
      const p = document.querySelector("p")!;
      // The text is words with a space before each. The words of the
      // person start with "m". theirs are the other words, as they must be.
      const words = () => p.textContent!.trim().split(" ");
      const theirs = ["a", "b", "c"];
      const mine = (word: string) => word.startsWith("m");
      // Whether no patch took out a word of the person.
      let whole = true;
      for (let step = 0; step < 40; step++) {
        const list = words();
        const i = random(list.length);
        const kind = random(8);
        if (kind < 3) {
          const offset = list.slice(0, i + 1).join(" ").length + 1;
          document.getSelection()!.collapse(p.firstChild, offset);
          input("insertText", { text: ` m${step}` });
          if (random(2)) vi.advanceTimersByTime(2000);
        } else if (kind < 6) {
          // Another person adds a word after word i, or takes word i out.
          const before = list.slice(0, i + 1).filter((word) => !mine(word)).length;
          if (i === 0 || random(3)) {
            list.splice(i + 1, 0, `t${step}`);
            theirs.splice(before, 0, `t${step}`);
          } else {
            if (!mine(list[i])) theirs.splice(before - 1, 1);
            else whole = false;
            list.splice(i, 1);
          }
          assert.isTrue(doc.patch(["<p>", null, null, ` ${list.join(" ")}`]).ok);
        } else {
          const text = p.textContent;
          input(kind === 6 ? "historyUndo" : "historyRedo");
          if (kind === 6 && p.textContent !== text) undone++;
        }
        const now = words();
        const state = `run ${run}, step ${step}: ${p.textContent}`;
        assert.deepEqual(
          now.filter((word) => !mine(word)),
          theirs,
          state,
        );
        assert.equal(new Set(now).size, now.length, state);
      }
      // Undo then takes back all the typing, and only the typing.
      for (let step = 0; whole && step < 40; step++) input("historyUndo");
      if (whole) assert.equal(p.textContent, ` ${theirs.join(" ")}`, `run ${run}`);
    }
    assert.isAbove(undone, 300, "Undo took typing back");
  }, 30_000);

  test("never loses or doubles a word, and keeps the caret, when patches also make words bold and plain", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let seed = 11;
    const random = (below: number) => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed >>> 8) % below;
    };
    let undone = 0;
    for (let run = 0; run < 50; run++) {
      stop?.();
      const doc = await open("<p> a b c</p>");
      const p = document.querySelector("p")!;
      const texts = () => {
        const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
        const nodes: Text[] = [];
        while (walker.nextNode()) nodes.push(walker.currentNode as Text);
        return nodes;
      };
      // The count of the characters of the paragraph before the caret.
      const caretAt = () => {
        const { focusNode, focusOffset } = document.getSelection()!;
        const before = texts().slice(0, texts().indexOf(focusNode as Text));
        return before.reduce((sum, text) => sum + text.length, focusOffset);
      };
      // The words of the paragraph, each with a space before it. A word in
      // a <b> is bold. The words of the person start with "m".
      const read = () =>
        Array.from(p.childNodes).flatMap((node) =>
          node
            .textContent!.split(" ")
            .flatMap((word) =>
              word ? [{ word, bold: node.nodeType === Node.ELEMENT_NODE }] : [],
            ),
        );
      const mine = (word: string) => word.startsWith("m");
      const theirs = ["a", "b", "c"];
      let whole = true;
      for (let step = 0; step < 40; step++) {
        const list = read();
        const i = random(list.length);
        const kind = random(10);
        const state = () => `run ${run}, step ${step}: ${p.innerHTML}`;
        if (kind < 3) {
          // The person types a word at the start of a text that is not bold.
          const plain = texts().filter((text) => text.parentNode === p);
          const text = plain[random(plain.length)];
          document.getSelection()!.collapse(text, 0);
          input("insertText", { text: ` m${step}` });
          if (random(2)) vi.advanceTimersByTime(2000);
        } else if (kind < 8) {
          const before = list.slice(0, i + 1).filter(({ word }) => !mine(word)).length;
          const text = texts()[random(texts().length)];
          document.getSelection()!.collapse(text, random(text.length + 1));
          const caret = caretAt();
          if (kind < 6) {
            // Another person makes word i bold, or plain again.
            list[i].bold = !list[i].bold;
            whole &&= !mine(list[i].word);
          } else if (i === 0 || random(3)) {
            list.splice(i + 1, 0, { word: `t${step}`, bold: false });
            theirs.splice(before, 0, `t${step}`);
          } else {
            if (!mine(list[i].word)) theirs.splice(before - 1, 1);
            else whole = false;
            list.splice(i, 1);
          }
          const html = list.map(({ word, bold }) =>
            bold ? ` <b>${word}</b>` : ` ${word}`,
          );
          assert.isTrue(doc.patch(["<p>", null, null, html.join("")]).ok, state());
          // A patch that only moves text to other nodes leaves the caret at
          // its character.
          if (kind < 6) assert.equal(caretAt(), caret, state());
        } else {
          const text = p.textContent;
          input(kind === 8 ? "historyUndo" : "historyRedo");
          if (kind === 8 && p.textContent !== text) undone++;
        }
        const now = read().map(({ word }) => word);
        assert.deepEqual(
          now.filter((word) => !mine(word)),
          theirs,
          state(),
        );
        assert.equal(new Set(now).size, now.length, state());
      }
      // Undo then takes back all the typing, and only the typing.
      for (let step = 0; whole && step < 40; step++) input("historyUndo");
      if (whole) assert.equal(p.textContent, ` ${theirs.join(" ")}`, `run ${run}`);
    }
    assert.isAbove(undone, 100, "Undo took typing back");
  }, 30_000);

  test("takes back Enter after another person adds or removes a block in the same parent", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const doc = await open("<p>Intro. More</p>\n<p>Second</p>\n<p>Third</p>");
    place("Intro.| More");
    input("insertParagraph");
    assert.deepEqual(texts(), ["Intro.", "\u00a0More", "Second", "Third"]);
    // Another person adds a paragraph at the end of the body, and one more
    // takes out the paragraph after the new one.
    assert.isTrue(doc.patch(["<body>", "<p>Third", null, "\n<p>Fourth</p>\n"]).ok);
    assert.isTrue(doc.patch(["<body>", "<p>Intro", "<p>Third", "<p> More</p>\n"]).ok);
    assert.deepEqual(texts(), ["Intro.", "\u00a0More", "Third", "Fourth"]);
    key({ key: "z", metaKey: true });
    assert.deepEqual(texts(), ["Intro. More", "Third", "Fourth"]);
    key({ key: "z", metaKey: true, shiftKey: true });
    assert.deepEqual(texts(), ["Intro.", "\u00a0More", "Third", "Fourth"]);
  });

  test("puts a joined paragraph back after another person takes out the block after it", async () => {
    const doc = await open("<p>One</p>\n<p>Two</p>\n<p>Three</p>");
    place("|Two");
    input("deleteContentBackward");
    assert.deepEqual(texts(), ["OneTwo", "Three"]);
    assert.isTrue(doc.patch(["<body>", "<p>One", null, "\n"]).ok);
    assert.deepEqual(texts(), ["OneTwo"]);
    key({ key: "z", metaKey: true });
    assert.deepEqual(texts(), ["One", "Two"]);
  });

  test("does not take back Enter after another person takes out the new paragraph", async () => {
    const doc = await open("<p>Intro. More</p>\n<p>Second</p>");
    place("Intro.| More");
    input("insertParagraph");
    assert.isTrue(doc.patch(["<body>", "<p>Intro", "<p>Second", "\n"]).ok);
    key({ key: "z", metaKey: true });
    assert.deepEqual(texts(), ["Intro.", "Second"]);
  });

  test("puts no deleted text back in text that a script set since", async () => {
    await open("<p>Hello big world</p>\n<p>One two</p>");
    place("Hello| big world", "Hello big| world");
    input("deleteContentBackward");
    at("Hello world")[0].data = "All other text";
    input("historyUndo");
    assert.deepEqual(texts(), ["All other text", "One two"]);
    // The text of the script is shorter than the place of the deletion.
    place("One| two", "One two|");
    input("deleteContentBackward");
    at("One")[0].data = "";
    input("historyUndo");
    assert.deepEqual(texts(), ["All other text", ""]);
  });

  test("takes out no text when a script changed the text since", async () => {
    await open("<p>Hello world</p>");
    place("Hello| world");
    input("insertText", { text: " big" });
    at("Hello big world")[0].data = "All other text";
    input("historyUndo");
    assert.deepEqual(texts(), ["All other text"]);
  });
});

describe("Comment mode", () => {
  test("pauses the editor, which keeps the earlier changes in the regions", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello| world");
    input("insertText", { text: "," });
    doc.editor.setEditable(false);
    assert.isFalse(document.body.hasAttribute("contenteditable"));
    assert.isFalse(
      document.documentElement.hasAttribute("data-slashdocs-text-editing"),
    );
    // Its shortcuts change nothing while the reader comments.
    place("|world", "world|");
    key({ key: "b", ctrlKey: true });
    doc.editor.setEditable(true);
    assert.equal(document.body.getAttribute("contenteditable"), "true");
    place("world|");
    input("insertText", { text: "!" });
    doc.expect(["Hello world", "Hello, world!"]);
  });
});

describe("script text", () => {
  test("text that a script shows is not editable", async () => {
    const doc = await open('<p id="status"></p>', (d) => {
      d.getElementById("status")!.textContent = "Ready";
    });
    place("Rea|dy");
    assert.isFalse(input("insertText", { text: "!" }));
    assert.deepEqual(doc.refused, [REFUSED.script]);
  });

  test("script text that the reader may change takes plain text only", async () => {
    const doc = await open('<p id="status"></p>', (d) => {
      d.getElementById("status")!.textContent = "Ready";
    });
    const status = document.getElementById("status")!;
    status.setAttribute("data-slashdocs-script-edit", "");
    status.setAttribute("contenteditable", "true");
    place("Rea|dy");
    assert.isFalse(input("insertParagraph"));
    assert.isFalse(input("formatBold"));
    assert.deepEqual(doc.refused, [REFUSED.plainText, REFUSED.plainText]);
    assert.isTrue(input("insertText", { text: "!" }));
    assert.equal(status.textContent, "Rea!dy");
    // The app writes script text into the script, not into the regions.
    assert.equal(doc.saved(), doc.source);
  });
});

describe("formatting at a caret, links and numbered lists", () => {
  const bold = () => key({ key: "b", metaKey: true });
  const linkField = () =>
    document.querySelector<HTMLInputElement>(".slashdocs-link-input input");

  test("bold at a caret makes the next typed text bold, and typing continues it", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello |world");
    bold();
    assert.isFalse(input("insertText", { text: "big" }));
    assert.isTrue(input("insertText", { text: "!" }));
    doc.expect(["Hello world", "Hello <strong>big!</strong>world"]);
  });

  test("bold twice at a caret types plain text", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello |world");
    bold();
    bold();
    assert.isTrue(input("insertText", { text: "big " }));
    doc.expect(["Hello world", "Hello big world"]);
  });

  test("bold and italic at a caret apply together", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello |world");
    bold();
    input("formatItalic");
    input("insertText", { text: "big" });
    doc.expect(["Hello world", "Hello <strong><em>big</em></strong>world"]);
  });

  test("bold at a caret in bold text types the next text out of it", async () => {
    const doc = await open("<p><strong>Hello world</strong></p>");
    place("Hello| world");
    bold();
    input("insertText", { text: " big" });
    doc.expect([
      "<strong>Hello world</strong>",
      "<strong>Hello</strong> big<strong> world</strong>",
    ]);
  });

  test("bold at a caret stops when the caret moves", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello |world");
    bold();
    place("Hello world|");
    assert.isTrue(input("insertText", { text: "!" }));
    doc.expect(["Hello world", "Hello world!"]);
  });

  test("run does an input as its shortcut does", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello |world", "Hello world|");
    doc.run("formatBold");
    doc.expect(["Hello world", "Hello <strong>world</strong>"]);
    doc.run("insertLink");
    assert.equal(document.activeElement, linkField());
  });

  test("a link field in a link shows its address, and Remove link takes the link off", async () => {
    const doc = await open(
      '<p>See <a href="https://example.com/docs">the docs</a>.</p>',
    );
    place("the |docs");
    key({ key: "k", metaKey: true });
    assert.equal(linkField()!.value, "https://example.com/docs");
    const remove = document.querySelector<HTMLButtonElement>(
      ".slashdocs-link-input button",
    )!;
    assert.equal(remove.textContent, "Remove link");
    remove.click();
    assert.isNull(linkField());
    doc.expect(['<a href="https://example.com/docs">the docs</a>', "the docs"]);
  });

  test("a link field shows the address that the link gets, and refuses a bad one", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello |world", "Hello world|");
    key({ key: "k", metaKey: true });
    const field = linkField()!;
    const note = document.querySelector(".slashdocs-link-input p")!;
    field.value = "example.com";
    field.dispatchEvent(new Event("input"));
    assert.equal(note.textContent, "Links to https://example.com");
    field.value = "javascript:alert(1)";
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    assert.equal(linkField(), field);
    assert.equal(note.textContent, "A link must start with http, https, mailto or #.");
    assert.deepEqual(doc.refused, []);
    assert.equal(doc.saved(), doc.source);
  });

  test("a link field refuses an address with a space or with no dot in its host", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello |world", "Hello world|");
    key({ key: "k", metaKey: true });
    const field = linkField()!;
    const note = document.querySelector(".slashdocs-link-input p")!;
    const enter = () =>
      field.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    for (const value of ["exa mple", "example", "https://example.com/a b"]) {
      field.value = value;
      field.dispatchEvent(new Event("input"));
      assert.notInclude(note.textContent, "Links to");
      enter();
      assert.equal(linkField(), field);
      assert.equal(note.textContent, "This is not a link.");
      assert.isTrue(note.hasAttribute("data-error"));
    }
    field.value = "localhost:3000";
    field.dispatchEvent(new Event("input"));
    assert.equal(note.textContent, "Links to https://localhost:3000");
    assert.isFalse(note.hasAttribute("data-error"));
    enter();
    doc.expect(["Hello world", 'Hello <a href="https://localhost:3000">world</a>']);
  });

  test.each(["192.168.0.1", "mailto:a@example.com", "#intro", "http://[::1]:8080"])(
    "a link field takes %s",
    async (value) => {
      await open("<p>Hello world</p>");
      place("Hello |world", "Hello world|");
      key({ key: "k", metaKey: true });
      linkField()!.value = value;
      linkField()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
      assert.isNull(linkField());
    },
  );

  test("after a link applies, the caret is after it, so the next keys do not type over it", async () => {
    await open("<p>Clients retry twice before giving up.</p>");
    place("retry |twice", "retry twice|");
    key({ key: "k", metaKey: true });
    linkField()!.value = "example.com";
    linkField()!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
    );
    const selection = document.getSelection()!;
    const a = document.querySelector("p a")!;
    assert.isTrue(selection.isCollapsed);
    assert.equal(selection.anchorNode, a.parentNode);
    assert.equal(selection.anchorOffset, [...a.parentNode!.childNodes].indexOf(a) + 1);
  });

  test("a link field marks the words of the link until it closes", async () => {
    const set = new Map<string, unknown>();
    Object.assign(window, {
      CSS: { highlights: set },
      Highlight: class {
        constructor(readonly range: Range) {}
      },
    });
    try {
      await open('<p>See <a href="https://example.com">the docs</a>.</p>');
      place("the |docs");
      key({ key: "k", metaKey: true });
      const { range } = set.get("slashdocs-link") as { range: Range };
      assert.equal(range.toString(), "the docs");
      linkField()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      assert.isFalse(set.has("slashdocs-link"));
    } finally {
      Object.assign(window, { CSS: undefined, Highlight: undefined });
    }
  });

  test("a numbered list that Enter splits continues its numbers", async () => {
    const doc = await open('<ol start="2"><li>One</li><li>Two</li><li>Three</li></ol>');
    place("Two|");
    input("insertParagraph");
    input("insertParagraph");
    doc.expect([
      '<ol start="2"><li>One</li><li>Two</li><li>Three</li></ol>',
      '<ol start="2"><li>One</li><li>Two</li></ol><p></p><ol start="4"><li>Three</li></ol>',
    ]);
  });

  test("a numbered list with no start continues from 1", async () => {
    const doc = await open("<ol><li>One</li><li>Two</li></ol>");
    place("One|");
    input("insertParagraph");
    input("insertParagraph");
    doc.expect([
      "<ol><li>One</li><li>Two</li></ol>",
      '<ol><li>One</li></ol><p></p><ol start="2"><li>Two</li></ol>',
    ]);
  });
});

describe("a patch", () => {
  test("keeps the caret at its character when text comes before, after and at it", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello| world");
    const [text] = at("Hello");
    assert.isTrue(doc.patch(["<p>", null, null, "Hello world, and more"]).ok);
    assert.deepEqual(caret(), ["Hello world, and more", 5]);
    doc.patch(["<p>", null, null, "Oh. Hello world, and more"]);
    assert.deepEqual(caret(), ["Oh. Hello world, and more", 9]);
    doc.patch(["<p>", null, null, "Oh. Hello there world, and more"]);
    assert.deepEqual(caret(), ["Oh. Hello there world, and more", 9]);
    assert.strictEqual(document.getSelection()!.focusNode, text, "the node stays");
    assert.strictEqual(document.activeElement, document.body, "the focus stays");
    doc.expect(["Hello world", "Oh. Hello there world, and more"]);
  });

  test("keeps the caret when one patch brings text before it and after it", async () => {
    const doc = await open("<p>Hello big world</p>");
    place("Hello| big world");
    const [text] = at("Hello");
    doc.patch(["<p>", null, null, "Oh. Hello big wide world, and more"]);
    assert.deepEqual(caret(), ["Oh. Hello big wide world, and more", 9]);
    assert.strictEqual(document.getSelection()!.focusNode, text, "the node stays");
    doc.expect(["Hello big world", "Oh. Hello big wide world, and more"]);
  });

  test("keeps the next keys after the text of the reader when another person removes the text around it", async () => {
    const doc = await open("<p>Filler two Lorem ipsum dolor.</p>");
    place("Lorem| ipsum");
    for (const key of " REVIEW") input("insertText", { text: key });
    // The other person saw " REV" and removed the text of the paragraph.
    // The rest of the text of the reader is all that the paragraph holds.
    assert.isTrue(doc.patch(["<p>", null, null, "IEW"]).ok);
    assert.deepEqual(caret(), ["IEW", 3]);
    for (const key of "ER") input("insertText", { text: key });
    doc.expect(["Filler two Lorem ipsum dolor.", "IEWER"]);
  });

  test("keeps the next keys after the text of the reader when another person removes its paragraph", async () => {
    const doc = await open(
      "<p>Top line.</p>\n<p>Middle line.</p>\n<p>Lower line.</p>\n<p>Bottom line.</p>",
    );
    place("Middle| line");
    for (const key of " typ") input("insertText", { text: key });
    // The other person saw " ty", removed the first three paragraphs and
    // typed "R". The merge puts the rest of the text of the reader in the
    // first paragraph.
    assert.isTrue(
      doc.patch(["<body>", null, "<p>Bottom", "<p>Ryp</p>\n", [[3, 5]]]).ok,
    );
    for (const key of "ing") input("insertText", { text: key });
    doc.expect([
      "\n<p>Top line.</p>\n<p>Middle line.</p>\n<p>Lower line.</p>",
      "<p>Ryping</p>",
    ]);
  });

  test("keeps the next keys after the text of the reader when a patch marks that text as text of other people", async () => {
    const doc = await open("<p>Filler two Lorem ipsum dolor.</p>");
    place("Lorem| ipsum");
    for (const key of " REVIEW") input("insertText", { text: key });
    // The other person removed the text of the paragraph after they saw the
    // rest of the typing of the reader. Their operation puts that rest in
    // again as a whole word, so the merge marks it as their text.
    assert.isTrue(doc.patch(["<p>", null, null, "IEW", [[0, 3]]]).ok);
    assert.deepEqual(caret(), ["IEW", 3]);
    for (const key of "ER") input("insertText", { text: key });
    doc.expect(["Filler two Lorem ipsum dolor.", "IEWER"]);
  });

  test("changes the attributes of an original element that the patch changes", async () => {
    const link = '<a href="https://one.example" title="One">the page</a>';
    const doc = await open(`<p class="a">See ${link}.</p>`, (d) => {
      // The scripts of the document set attributes that the source has not.
      d.querySelector("a")!.className = "on";
      d.querySelector("p")!.setAttribute("data-open", "");
    });
    const attributes = (selector: string) =>
      Array.from(document.querySelector(selector)!.attributes)
        .filter(({ name }) => !name.startsWith("data-slashdocs-"))
        .map(({ name, value }) => `${name}=${value}`);
    const patch = (html: string) => doc.patch(["<body>", null, null, `\n${html}\n`]);
    assert.isTrue(
      patch('<p class="b">See <a href="https://two.example">the page</a>.</p>').ok,
    );
    assert.deepEqual(attributes("a"), ["href=https://two.example", "class=on"]);
    assert.deepEqual(attributes("p"), ["class=b", "data-open="]);
    // A region cannot write an attribute: the app sees that, and loads the
    // frame of an editor again.
    assert.equal(doc.saved(), doc.source);
    // A later patch has the attributes of the source again.
    patch(`<p class="a">See ${link}.</p>`);
    assert.deepEqual(attributes("a"), [
      "href=https://one.example",
      "class=on",
      "title=One",
    ]);
    assert.deepEqual(attributes("p"), ["class=a", "data-open="]);
  });

  test("takes an attribute change out again with a patch that is not kept", async () => {
    const doc = await open('<p><a href="https://one.example">the page</a></p>');
    const patch = (keep: boolean) =>
      doc.editor.patch(
        [
          {
            in: doc.source.indexOf("<p>"),
            after: null,
            before: null,
            html: '<a href="https://two.example">the page</a>',
          },
        ],
        doc.editor.edits(),
        () => () => keep,
      );
    const href = () => document.querySelector("a")!.getAttribute("href");
    assert.isTrue(patch(false).withdrawn);
    assert.equal(href(), "https://one.example");
    assert.isTrue(patch(true).ok);
    assert.equal(href(), "https://two.example");
  });

  test("takes a patch out again when it is not kept, and the regions do not hold it", async () => {
    const doc = await open("<p>One</p>\n<p>Two</p>");
    const patch = { in: doc.source.indexOf("<p>Two"), after: null, before: null };
    const before = document.body.innerHTML;
    place("T|wo", "Tw|o");
    let seen = "";
    const withdrawn = doc.editor.patch(
      [{ ...patch, html: "Other <b>and</b> more" }],
      doc.editor.edits(),
      () => (ranges) => {
        seen = ranges.map(String).join("|");
        return false;
      },
    );
    assert.deepEqual(withdrawn, { ok: false, withdrawn: true });
    // The new content was in the document when it was judged.
    assert.include(seen, "and");
    assert.equal(document.body.innerHTML, before);
    // The selection of the reader is where it was.
    const { anchorOffset, focusNode, focusOffset } = document.getSelection()!;
    assert.deepEqual([anchorOffset, focusNode, focusOffset], [1, at("Two")[0], 2]);
    assert.deepEqual(doc.editor.take().regions, []);
    // A patch that is kept goes in as before.
    assert.isTrue(
      doc.editor.patch(
        [{ ...patch, html: "Two!" }],
        doc.editor.edits(),
        () => () => true,
      ).ok,
    );
    doc.expect(["<p>Two</p>", "<p>Two!</p>"]);
  });

  test("keeps a selection around text that changes inside it", async () => {
    await open("<p>One two three</p>").then((doc) => {
      place("One |two three", "One two| three");
      doc.patch(["<p>", null, null, "One tw-o three"]);
    });
    assert.equal(document.getSelection()!.toString(), "tw-o");
  });

  test("gives text typed in an original paragraph", async () => {
    const doc = await open("<p>One</p>\n<p>Two</p>");
    doc.patch(["<p>Two", null, null, "Two &amp; more"]);
    doc.expect(["<p>Two</p>", "<p>Two &amp; more</p>"]);
  });

  test("gives a new paragraph after an original one", async () => {
    const doc = await open('<p class="a">One</p>\n<p>Two</p>');
    doc.patch(["<body>", '<p class="a">', "<p>Two", '<p class="a">New</p>\n']);
    doc.expect(["</p>\n<p>Two", '</p><p class="a">New</p>\n<p>Two']);
  });

  test("gives a new paragraph on its own line, as an agent writes it", async () => {
    const doc = await open("<p>One</p>\n<p>Two</p>");
    doc.patch(["<body>", "<p>One", "<p>Two", "\n<p>New</p>\n"]);
    doc.expect(["</p>\n<p>Two", "</p>\n<p>New</p>\n<p>Two"]);
  });

  test("gives bold in the middle of a text", async () => {
    const doc = await open("<p>Hello big world</p>");
    place("Hello big wor|ld");
    doc.patch(["<p>", null, null, "Hello <strong>big</strong> world"]);
    doc.expect(["Hello big world", "Hello <strong>big</strong> world"]);
    assert.equal(document.querySelector("strong")!.textContent, "big");
  });

  test("gives a removed original paragraph", async () => {
    const doc = await open("<p>One</p>\n<p>Two</p>\n<p>Three</p>");
    doc.patch(["<body>", "<p>One", "<p>Three", "\n"]);
    doc.expect(["<p>Two</p>\n", ""]);
    assert.equal(document.querySelectorAll("p").length, 2);
  });

  test("gives text between two elements with them, and not with all of their parent", async () => {
    const doc = await open("<div><p>One</p> and <p>Two</p> and <p>Three</p></div>");
    doc.patch(["<div>", "<p>One", "<p>Two", " or "]);
    const { regions } = doc.editor.take();
    assert.deepEqual(
      regions.map(({ from, to }) => [from, to]),
      [[doc.source.indexOf("<p>One"), doc.source.indexOf("<p>Two")]],
    );
    // A script changes the parent. Its text is still not the text of a script.
    document.querySelector("div")!.append(document.createElement("hr"));
    doc.expect(["</p> and <p>Two", "</p> or <p>Two"]);
    assert.isFalse(document.querySelector("div")!.hasAttribute("contenteditable"));
  });

  test("gives text that a patch puts after the last element of the body, and the keys typed in it", async () => {
    const doc = await open("<h1>T</h1>\n<p>Before.</p>");
    // The other person removed the paragraph, and the merge puts the text of
    // the reader after the heading.
    assert.isTrue(doc.patch(["<body>", "<h1>", null, "mi"]).ok);
    doc.expect(["\n<p>Before.</p>\n", "mi"]);
    place("mi|");
    for (const key of "dZ") input("insertText", { text: key });
    doc.expect(["\n<p>Before.</p>\n", "midZ"]);
  });

  test("gives two patches of one request", async () => {
    const doc = await open("<ul><li>One</li><li>Two</li></ul>\n<p>Three</p>");
    doc.patch(
      ["<ul>", "<li>One", "<li>Two", "<li>New</li>"],
      ["<p>", null, null, "Three, <em>four</em>"],
    );
    doc.expect(
      ["</li><li>Two", "</li><li>New</li><li>Two"],
      ["Three", "Three, <em>four</em>"],
    );
  });

  test("gives a later patch on the content of an earlier one", async () => {
    const doc = await open("<p>One</p>\n<p>Two</p>");
    doc.patch(["<body>", "<p>One", "<p>Two", "<p>New</p>\n"]);
    const made = document.querySelectorAll("p")[1];
    doc.patch(["<body>", "<p>One", "<p>Two", "<p>New text</p>\n"]);
    assert.strictEqual(document.querySelectorAll("p")[1], made, "the paragraph stays");
    doc.expect(["</p>\n<p>Two", "</p><p>New text</p>\n<p>Two"]);
    doc.patch(["<body>", "<p>One", "<p>Two", "\n"]);
    assert.equal(doc.saved(), doc.source);
  });

  test("keeps the text that the reader typed in the same block", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello| world");
    input("insertText", { text: " big" });
    // The target is the text of both people.
    assert.isTrue(doc.patch(["<p>", null, null, "Hello big world, for all"]).ok);
    assert.equal(document.querySelector("p")!.textContent, "Hello big world, for all");
    doc.expect(["Hello world", "Hello big world, for all"]);
  });

  test("leaves the space that the browser typed as a no-break space", async () => {
    const doc = await open("<p>Hello</p>\n<p>Two</p>");
    place("Hello|");
    input("insertText", { text: "\u00a0" });
    doc.patch(["<p>Hello", null, null, "Hello "], ["<p>Two", null, null, "Two!"]);
    assert.equal(document.querySelector("p")!.textContent, "Hello\u00a0");
    doc.expect(["Hello", "Hello "], ["Two", "Two!"]);
  });

  test("leaves the nodes of the bridge and of scripts, and an emptied block open", async () => {
    const doc = await open("<h2>Title</h2>\n<p>One</p>", (d) => {
      d.querySelector("h2")!.insertAdjacentHTML(
        "beforeend",
        '<button class="slashdocs-heading-link"></button>',
      );
      d.querySelector("p")!.insertAdjacentHTML(
        "afterend",
        "<aside>By a script</aside>",
      );
    });
    doc.patch(["<h2>", null, null, "A title"], ["<body>", "<p>One", null, "<p></p>\n"]);
    assert.ok(document.querySelector("h2 > .slashdocs-heading-link"));
    assert.ok(document.querySelector("aside"));
    doc.expect(["Title", "A title"], ["<p>One</p>", "<p>One</p><p></p>"]);
    // The reader puts the caret in the empty paragraph, which a <br> keeps open.
    const empty = document.querySelectorAll("p")[1];
    empty.append(document.createElement("br"));
    doc.patch(
      ["<h2>", null, null, "The title"],
      ["<body>", "<p>One", null, "<p></p>\n"],
    );
    assert.ok(empty.querySelector("br"));
  });

  const CHART =
    '<section class="a"><p>Intro</p><div id="chart">Loading</div></section>';
  // A script draws the chart, so the source map sets it not editable.
  const draw = (d: Document) => (d.getElementById("chart")!.textContent = "Drawn");

  test("leaves an original element that a script changed, and does not put it twice", async () => {
    const doc = await open(CHART, draw);
    const push = (html: string) => doc.patch(["<body>", null, null, `\n${html}\n`]);
    assert.isTrue(push(CHART.replace('"a"', '"b"').replace("Intro", "Start")).ok);
    const section = document.querySelector("section")!;
    assert.equal(section.className, "b");
    assert.deepEqual(
      Array.from(section.children, (el) => el.textContent),
      ["Start", "Drawn"],
    );
    // A paragraph comes before the chart, and the chart keeps its pair.
    assert.isTrue(push(CHART.replace("<div", "<p>New</p><div")).ok);
    assert.deepEqual(
      Array.from(section.children, (el) => el.textContent),
      ["Intro", "New", "Drawn"],
    );
  });

  test("fails, and changes nothing, when an element that it leaves has no equal pair", async () => {
    const doc = await open(CHART, draw);
    const before = document.body.innerHTML;
    place("In|tro");
    const push = (html: string) => doc.patch(["<body>", null, null, `\n${html}\n`]);
    // The push changed the source of the chart, or took the chart out.
    for (const html of [
      CHART.replace("Intro", "Start").replace("Loading", "Wait"),
      CHART.replace("Intro", "Start").replace(/<div.*div>/, ""),
    ]) {
      assert.deepEqual(push(html), { ok: false });
      assert.equal(document.body.innerHTML, before);
      assert.deepEqual(caret(), ["Intro", 2]);
    }
    doc.expect();
  });

  test("fails when its run holds a copy that the parser made of an unclosed element", async () => {
    // The parser puts the second paragraph in a copy of the <b>.
    const doc = await open("<p>one <b>bold</p>\n<p>two</p>");
    const before = document.body.innerHTML;
    assert.deepEqual(doc.patch(["<body>", "<p>one", null, "\n<p>two!</p>\n\n"]), {
      ok: false,
    });
    assert.equal(document.body.innerHTML, before);
    // A patch of the text of the paragraph holds no copy, and changes it.
    assert.isTrue(doc.patch(["<p>two", null, null, "two!"]).ok);
    assert.equal(document.body.textContent!.trim(), "one bold\ntwo!");
  });

  test("does not leave a caret between the two halves of a character", async () => {
    const doc = await open("<p>Go \u{1f600} now</p>");
    // The two faces have the same first half.
    place("Go \u{1f600}| now");
    assert.isTrue(doc.patch(["<p>", null, null, "Go \u{1f601} now"]).ok);
    // The caret stays after the character.
    assert.deepEqual(caret(), ["Go \u{1f601} now", 5]);
    doc.expect(["\u{1f600}", "\u{1f601}"]);
  });

  test("changes nothing when it is stale, or when an element is not there", async () => {
    const doc = await open("<p>One</p>\n<p>Two</p>");
    const edits = doc.editor.edits();
    place("One|");
    input("insertText", { text: "!" });
    assert.equal(doc.editor.edits(), edits + 1);
    const patches = [
      { in: doc.source.indexOf("<p>Two"), after: null, before: null, html: "2" },
    ];
    // The view is not measured for a patch that changes nothing.
    const watch = vi.fn();
    assert.deepEqual(doc.editor.patch(patches, edits, watch), {
      ok: false,
      stale: true,
    });
    assert.deepEqual(
      doc.editor.patch([...patches, { ...patches[0], after: 5 }], edits + 1, watch),
      { ok: false },
    );
    assert.equal(watch.mock.calls.length, 0);
    assert.isFalse(doc.patch(["<body>", "<p>Two", "<p>One", ""]).ok, "not in order");
    assert.isFalse(doc.patch(["<p>One", "<p>Two", null, ""]).ok, "not a child");
    // A script takes an element out.
    document.querySelectorAll("p")[1].remove();
    const before = document.body.innerHTML;
    assert.isFalse(doc.patch(["<body>", "<p>Two", null, "<p>New</p>"]).ok);
    assert.equal(document.body.innerHTML, before);
    doc.expect(["One", "One!"]);
  });

  test("waits while an input method composes text, and goes in after", async () => {
    const doc = await open("<p>One</p>\n<p>Two</p>");
    place("One|");
    const compose = (type: string) =>
      document.body.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
    compose("compositionstart");
    const two = () => document.querySelectorAll("p")[1].textContent;
    assert.deepEqual(doc.patch(["<p>Two", null, null, "2"]), {
      ok: false,
      stale: true,
    });
    assert.equal(two(), "Two");
    compose("compositionend");
    assert.isTrue(doc.patch(["<p>Two", null, null, "2"]).ok);
    assert.equal(two(), "2");
  });

  test("gives a collapsed range at each place where content went", async () => {
    const doc = await open("<p>One big two</p>\n<p>Gone</p>\n<p>Three</p>");
    const { ranges } = doc.patch(
      ["<p>One", null, null, "One two"],
      ["<body>", "<p>One", "<p>Three", "\n"],
    );
    const first = document.querySelector("p")!;
    const collapsed = ranges!.filter((range) => range.collapsed);
    // The place of the word in the first paragraph, and the places of the
    // paragraph and of the text between the two.
    assert.deepEqual(
      collapsed.map((range) => range.startContainer),
      [first.firstChild!, document.body, document.body],
    );
    assert.isTrue(collapsed[0].intersectsNode(first));
  });

  test("is not a user operation: not dirty, and not in the journal", async () => {
    const doc = await open("<p>One</p>\n<p>Two</p>");
    const edits = doc.editor.edits();
    doc.patch(["<p>One", null, null, "One more"]);
    assert.equal(doc.editor.edits(), edits);
    assert.deepEqual(doc.dirty, []);
    input("historyUndo");
    assert.equal(document.querySelector("p")!.textContent, "One more");
  });

  test("keeps the undo of another block, and of the same text beside its changes", async () => {
    const doc = await open("<p>One</p>\n<p>Two</p>");
    place("One|");
    input("insertText", { text: " mine" });
    place("Tw|o");
    input("deleteContentBackward");
    doc.patch(["<p>One", null, null, "One mine, theirs"]);
    const texts = () =>
      Array.from(document.querySelectorAll("p"), (p) => p.textContent);
    assert.deepEqual(texts(), ["One mine, theirs", "To"]);
    input("historyUndo");
    assert.deepEqual(texts(), ["One mine, theirs", "Two"]);
    input("historyUndo");
    assert.deepEqual(texts(), ["One, theirs", "Two"]);
    input("historyRedo");
    input("historyRedo");
    assert.deepEqual(texts(), ["One mine, theirs", "To"]);
    doc.expect(["One", "One mine, theirs"], ["Two", "To"]);
  });

  test("shows nothing of the editor to a reader who does not edit", async () => {
    const doc = await open("<p>One</p>", undefined, false);
    const before = document.documentElement.outerHTML;
    assert.isFalse(document.body.hasAttribute("contenteditable"));
    assert.isFalse(
      document.documentElement.hasAttribute("data-slashdocs-text-editing"),
    );
    doc.patch(["<p>", null, null, "One more"]);
    assert.equal(document.documentElement.outerHTML, before.replace("One", "One more"));
    assert.deepEqual(doc.dirty, []);
    doc.expect(["One", "One more"]);
    // An input then belongs to a field of the document: the browser does it.
    place("One| more");
    assert.isTrue(input("insertText", { text: "!" }));
    assert.equal(doc.editor.edits(), 0);
  });
});

// Another person can change the elements around the caret of the reader:
// the characters then go to other text nodes, and the caret goes with them.
describe("a patch that moves text to other nodes", () => {
  const paragraphs = () =>
    Array.from(document.querySelectorAll("p"), (p) =>
      p.innerHTML.replace(/ data-slashdocs-source="\d+"/g, ""),
    );
  type Push = Parameters<Awaited<ReturnType<typeof open>>["patch"]>[0];
  // Each case is a document, the patch of another person, and carets: where
  // the reader has the caret, and the paragraphs after the reader then types
  // a "?".
  const cases: [string, string, Push, [string, string[]][]][] = [
    [
      "a new inline element that splits a text",
      "<p>Hello big world!</p>",
      ["<p>", null, null, "Hello <b>big</b> world!"],
      [
        ["He|llo big", ["He?llo <b>big</b> world!"]],
        ["Hello |big", ["Hello ?<b>big</b> world!"]],
        ["Hello bi|g", ["Hello <b>bi?g</b> world!"]],
        ["Hello big| world", ["Hello <b>big?</b> world!"]],
        ["Hello big wor|ld!", ["Hello <b>big</b> wor?ld!"]],
        ["Hello big world!|", ["Hello <b>big</b> world!?"]],
      ],
    ],
    [
      "a link that splits a text, with new text before it",
      "<p>Hello big world!</p>",
      ["<p>", null, null, 'Oh. Hello <a href="https://a.example">big</a> wide world!'],
      [
        ["He|llo big", ['Oh. He?llo <a href="https://a.example">big</a> wide world!']],
        ["Hello b|ig", ['Oh. Hello <a href="https://a.example">b?ig</a> wide world!']],
        ["big world!|", ['Oh. Hello <a href="https://a.example">big</a> wide world!?']],
      ],
    ],
    [
      "an inline element that goes, and joins two texts",
      "<p>Hello <b>big</b> world!</p>",
      ["<p>", null, null, "Hello big world!"],
      [
        ["He|llo ", ["He?llo big world!"]],
        ["b|ig", ["Hello b?ig world!"]],
        ["big|", ["Hello big? world!"]],
        ["| world!", ["Hello big? world!"]],
        [" wor|ld!", ["Hello big wor?ld!"]],
        [" world!|", ["Hello big world!?"]],
      ],
    ],
    [
      "a paragraph that splits",
      "<p>One two three</p>",
      ["<body>", null, null, "\n<p>One</p>\n<p>two three</p>\n"],
      [
        ["O|ne two", ["O?ne", "two three"]],
        ["One| two", ["One?", "two three"]],
        ["One |two", ["One", "?two three"]],
        ["One two thr|ee", ["One", "two thr?ee"]],
        ["One two three|", ["One", "two three?"]],
      ],
    ],
    [
      "two paragraphs that join",
      "<p>One</p>\n<p>two three</p>",
      ["<body>", null, null, "\n<p>One two three</p>\n"],
      [
        ["O|ne", ["O?ne two three"]],
        ["One|", ["One? two three"]],
        ["|two three", ["One ?two three"]],
        ["two th|ree", ["One two th?ree"]],
        ["two three|", ["One two three?"]],
      ],
    ],
  ];
  for (const [name, body, push, carets] of cases) {
    test(`keeps the caret at its character through ${name}`, async () => {
      for (const [caretAt, typed] of carets) {
        const doc = await open(body);
        place(caretAt);
        assert.isTrue(doc.patch(push).ok, caretAt);
        input("insertText", { text: "?" });
        assert.deepEqual(paragraphs(), typed, caretAt);
        stop?.();
      }
    });
  }

  test("keeps each end of a selection at its character", async () => {
    const doc = await open("<p>Hello big world!</p>\n<p>Two</p>");
    place("H|ello", "wor|ld!");
    doc.patch(["<p>", null, null, "Hello <b>big</b> world!"]);
    assert.equal(document.getSelection()!.toString(), "ello big wor");
    // An end in a paragraph that splits goes to the new paragraph. The other
    // end is not in the run of the patch, and stays.
    place("T|wo", "wor|ld!");
    doc.patch([
      "<body>",
      null,
      "<p>Two",
      "\n<p>Hello <b>big</b></p>\n<p> world!</p>\n",
    ]);
    const { anchorNode, focusNode, focusOffset } = document.getSelection()!;
    assert.deepEqual(
      [(anchorNode as Text).data, (focusNode as Text).data, focusOffset],
      ["Two", " world!", 4],
    );
    assert.equal(focusNode!.parentElement, document.querySelectorAll("p")[1]);
  });

  test("puts the caret back when the patch is not kept", async () => {
    const doc = await open("<p>Hello big world!</p>");
    place("Hello big world!|");
    const withdrawn = doc.editor.patch(
      [
        {
          in: doc.source.indexOf("<p>"),
          after: null,
          before: null,
          html: "Hello <b>big</b> world!",
        },
      ],
      doc.editor.edits(),
      () => () => false,
    );
    assert.isTrue(withdrawn.withdrawn);
    assert.deepEqual(caret(), ["Hello big world!", 16]);
  });

  const text = () => document.body.textContent!.trim();

  test("Undo takes back the typing of the reader after a new inline element splits its text", async () => {
    const doc = await open("<p>Hello big world</p>");
    place("Hello big world|");
    input("insertText", { text: "!" });
    assert.isTrue(doc.patch(["<p>", null, null, "Hello <b>big</b> world!"]).ok);
    input("historyUndo");
    assert.deepEqual(paragraphs(), ["Hello <b>big</b> world"]);
    assert.deepEqual(caret(), [" world", 6]);
    doc.expect(["Hello big world", "Hello <b>big</b> world"]);
    input("historyRedo");
    assert.deepEqual(paragraphs(), ["Hello <b>big</b> world!"]);
    // A later patch joins the texts again, and Undo still finds the typing.
    assert.isTrue(doc.patch(["<p>", null, null, "Oh. Hello big world!"]).ok);
    input("historyUndo");
    assert.deepEqual(paragraphs(), ["Oh. Hello big world"]);
    doc.expect(["Hello big world", "Oh. Hello big world"]);
  });

  test("Undo takes back typing that is now in the new inline element", async () => {
    const doc = await open("<p>Hello bg world</p>");
    place("Hello b|g");
    input("insertText", { text: "i" });
    doc.patch(["<p>", null, null, "Hello <b>big</b> world"]);
    input("historyUndo");
    assert.deepEqual(paragraphs(), ["Hello <b>bg</b> world"]);
    assert.deepEqual(caret(), ["bg", 1]);
  });

  test("Undo takes back each step of the reader after an inline element goes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const doc = await open("<p>Hello <b>big</b> world</p>");
    place("Hello|");
    input("insertText", { text: "," });
    vi.advanceTimersByTime(5000);
    place(" world|");
    input("insertText", { text: "!" });
    vi.advanceTimersByTime(5000);
    place("bi|g");
    input("deleteContentBackward");
    assert.equal(text(), "Hello, bg world!");
    assert.isTrue(doc.patch(["<p>", null, null, "Hello, bg world! More."]).ok);
    assert.equal(document.querySelector("p")!.childNodes.length, 1);
    input("historyUndo");
    assert.equal(text(), "Hello, big world! More.");
    input("historyUndo");
    assert.equal(text(), "Hello, big world More.");
    input("historyUndo");
    assert.equal(text(), "Hello big world More.");
    input("historyRedo");
    input("historyRedo");
    input("historyRedo");
    assert.equal(text(), "Hello, bg world! More.");
    doc.expect(["Hello <b>big</b> world", "Hello, bg world! More."]);
  });

  test("Undo takes back typing after its paragraph splits, and after two paragraphs join", async () => {
    const doc = await open("<p>One two three</p>");
    place("One two three|");
    input("insertText", { text: "!" });
    assert.isTrue(
      doc.patch(["<body>", null, null, "\n<p>One</p>\n<p>two three!</p>\n"]).ok,
    );
    assert.isTrue(doc.patch(["<body>", null, null, "\n<p>One, two three!</p>\n"]).ok);
    assert.isTrue(
      doc.patch(["<body>", null, null, "\n<p>One, two</p>\n<p>three!</p>\n"]).ok,
    );
    input("historyUndo");
    assert.deepEqual(paragraphs(), ["One, two", "three"]);
    input("historyRedo");
    assert.deepEqual(paragraphs(), ["One, two", "three!"]);
  });

  test("Undo does nothing when the patch put one typed text in two nodes", async () => {
    const doc = await open("<p>Hello world</p>");
    place("Hello |world");
    input("insertText", { text: "abc " });
    doc.patch(["<p>", null, null, "Hello a<b>b</b>c world"]);
    input("historyUndo");
    assert.deepEqual(paragraphs(), ["Hello a<b>b</b>c world"]);
    doc.expect(["Hello world", "Hello a<b>b</b>c world"]);
  });

  test("Undo stops at text that the patch took out with its node", async () => {
    const doc = await open("<p>Hello <b>big</b> world</p>");
    place("bi|g");
    input("insertText", { text: "X" });
    doc.patch(["<p>", null, null, "Hello world"]);
    input("historyUndo");
    assert.equal(text(), "Hello world");
  });
});

// The app knows where the server put the text of another person. A text
// comparison cannot know it among equal characters.
describe("a patch with marks", () => {
  test("puts a space of another person after the caret of the reader, where the server put it", async () => {
    const doc = await open("<p>Stay here. It</p>");
    // The reader typed a space, as Chrome types it before another space.
    place("here.| It");
    input("insertText", { text: "\u00a0" });
    // The space of the other person is the second of the three.
    assert.isTrue(doc.patch(["<p>", null, null, "Stay here.   It", [[11, 12]]]).ok);
    assert.deepEqual(caret(), ["Stay here.\u00a0  It", 11]);
    for (const key of "Me too.") input("insertText", { text: key });
    assert.equal(
      document.querySelector("p")!.textContent,
      "Stay here.\u00a0Me too.  It",
    );
    // The other person types on, after their space.
    const html = "Stay here. Me too. We agree. It";
    assert.isTrue(doc.patch(["<p>", null, null, html, [[19, 28]]]).ok);
    assert.equal(
      document.querySelector("p")!.textContent,
      html.replace(". M", ".\u00a0M"),
    );
    doc.expect(["Stay here. It", html]);
  });

  test("puts a space of another person before the space that the reader typed", async () => {
    const doc = await open("<p>Stay here. It</p>");
    place("here.| It");
    input("insertText", { text: " " });
    // The space of the other person is the first of the three.
    doc.patch(["<p>", null, null, "Stay here.   It", [[10, 11]]]);
    assert.deepEqual(caret(), ["Stay here.   It", 12]);
  });

  test("puts a letter between equal letters at its exact place", async () => {
    for (const [mark, offset] of [
      [[1, 2], 1],
      [[0, 1], 2],
      [[2, 3], 1],
    ] as [[number, number], number][]) {
      const doc = await open("<p>aa</p>");
      place("a|a");
      doc.patch(["<p>", null, null, "aaa", [mark]]);
      assert.deepEqual(caret(), ["aaa", offset], String(mark));
      stop?.();
    }
  });

  test("puts two marks of one text in, each at its place", async () => {
    const doc = await open("<p>One two</p>");
    place("One |two", "One two|");
    doc.patch([
      "<p>",
      null,
      null,
      "One X two Y",
      [
        [4, 6],
        [9, 11],
      ],
    ]);
    const { anchorOffset, focusOffset } = document.getSelection()!;
    assert.deepEqual([anchorOffset, focusOffset], [4, 9]);
    doc.expect(["One two", "One X two Y"]);
  });

  test("puts the marks in at their places when other text changed too", async () => {
    const doc = await open("<p>aa two</p>");
    place("a|a two");
    doc.patch(["<p>", null, null, "aaa too", [[1, 2]]]);
    assert.deepEqual(caret(), ["aaa too", 1]);
    doc.expect(["aa two", "aaa too"]);
  });

  test("puts a mark next to an inline element in the text that has it", async () => {
    const doc = await open("<p>Hello <b>big</b> world</p>");
    const world = at(" world")[0];
    document.getSelection()!.setBaseAndExtent(world, 0, world, 0);
    doc.patch(["<p>", null, null, "Hello <b>big</b>X world", [[16, 17]]]);
    assert.deepEqual(caret(), ["X world", 0]);
    place("bi|g", "big|");
    doc.patch(["<p>", null, null, "Hello <b>bigY</b>X world", [[12, 13]]]);
    assert.equal(document.getSelection()!.toString(), "g");
    doc.expect(["<b>big</b> world", "<b>bigY</b>X world"]);
  });

  test("counts a mark after a character reference from the text, not from the HTML", async () => {
    const doc = await open("<p>a &amp; aa</p>");
    place("a & a|a");
    doc.patch(["<p>", null, null, "a &amp; aaa", [[9, 10]]]);
    assert.deepEqual(caret(), ["a & aaa", 5]);
  });

  test("uses the text comparison for a mark that is not all in text", async () => {
    const link = (href: string, text: string) =>
      `See <a href="${href}">${text}</a> now`;
    const doc = await open(`<p>${link("https://a.example/", "aa")}</p>`);
    place("a|a");
    // The marks: in an attribute, around a tag, out of order, and past the end.
    const html = link("https://a.example/x", "aaa");
    const marks: [number, number][] = [
      [html.indexOf("x"), html.indexOf("x") + 1],
      [html.indexOf(">aaa"), html.indexOf(">aaa") + 2],
      [2, 3],
      [html.length, html.length + 4],
    ];
    assert.isTrue(doc.patch(["<p>", null, null, html, marks]).ok);
    assert.equal(
      document.querySelector("a")!.getAttribute("href"),
      "https://a.example/x",
    );
    assert.equal(document.querySelector("p")!.textContent, "See aaa now");
  });

  test("Undo takes back the typing of the reader next to marked text", async () => {
    const doc = await open("<p>Stay here. It</p>");
    place("here.| It");
    for (const key of " Me too.") input("insertText", { text: key });
    doc.patch(["<p>", null, null, "Stay here. Me too. We agree. It", [[18, 28]]]);
    input("historyUndo");
    assert.equal(document.querySelector("p")!.textContent, "Stay here. We agree. It");
    input("historyRedo");
    doc.expect(["Stay here. It", "Stay here. Me too. We agree. It"]);
  });

  test("Undo takes back the space of the reader, not the equal space of another person", async () => {
    const doc = await open("<p>Stay here. It</p>");
    place("here.| It");
    input("insertText", { text: " " });
    doc.patch(["<p>", null, null, "Stay here.   It", [[11, 12]]]);
    input("insertText", { text: "M" });
    doc.patch(["<p>", null, null, "Stay here. M We It", [[13, 15]]]);
    input("historyUndo");
    assert.equal(document.querySelector("p")!.textContent, "Stay here. We It");
  });
});

describe("a patch and what a load of the document gives", () => {
  test("drops the newline at the start of a <pre>, as a parse does", async () => {
    const doc = await open("<pre>one\ntwo</pre>");
    assert.isTrue(doc.patch(["<pre>", null, null, "\nzero\none\ntwo", [[1, 6]]]).ok);
    assert.equal(document.querySelector("pre")!.textContent, "zero\none\ntwo");
    // A newline that is not at the start of the element stays.
    const second = await open("<pre><b>one</b>\ntwo</pre>");
    assert.isTrue(second.patch(["<pre>", "<b>", null, "\n\ntwo"]).ok);
    assert.equal(document.querySelector("pre")!.textContent, "one\n\ntwo");
  });

  test("takes out a <br> that an earlier patch made, but not one that keeps a block open", async () => {
    const doc = await open("<p>One</p>");
    doc.patch(["<p>", null, null, "One<br><br>"]);
    assert.equal(document.querySelectorAll("br").length, 2);
    assert.isTrue(doc.patch(["<p>", null, null, "One"]).ok);
    assert.equal(document.querySelectorAll("br").length, 0);
    assert.equal(doc.saved(), doc.source);
    // One <br> at the end of the paragraph is in the source too.
    assert.isTrue(doc.patch(["<p>", null, null, "One<br>"]).ok);
    assert.equal(document.querySelectorAll("br").length, 1);
    doc.expect(["One", "One<br>"]);
    assert.isTrue(doc.patch(["<p>", null, null, "One"]).ok);
    assert.equal(document.querySelectorAll("br").length, 0);
    assert.equal(doc.saved(), doc.source);
  });

  test("takes out a word that another person typed and took out again, and keeps the caret", async () => {
    const doc = await open("<p>Hello world</p>\n<p>Two</p>");
    place("Tw|o");
    assert.isTrue(doc.patch(["<p>", null, null, "Hello brave world"]).ok);
    assert.isTrue(doc.patch(["<p>", null, null, "Hello world"]).ok);
    assert.equal(document.querySelector("p")!.textContent, "Hello world");
    assert.equal(doc.saved(), doc.source);
    assert.deepEqual(caret(), ["Two", 2]);
  });

  test("shows text in an element that a script wrapped, and keeps it in its place", async () => {
    const doc = await open('<p id="a">Hello</p>\n<p>Two</p>', (d) => {
      const wrapper = d.createElement("div");
      d.body.prepend(wrapper);
      wrapper.append(d.getElementById("a")!);
    });
    assert.isTrue(doc.patch(['<p id="a">', null, null, "Hello there"]).ok);
    assert.equal(document.getElementById("a")!.textContent, "Hello there");
    doc.expect(["Hello", "Hello there"]);
  });
});

describe("what a person can edit", () => {
  const noop = () => {};
  // together has a person do mine in a document, while another person does
  // theirs in the same document in their own frame. The frame of the other
  // person then takes the merge of the two as a patch, as the live loop
  // does. It gives the source that the first person saves, and the merge
  // when the other frame shows it in place, or else why that frame loads the
  // document again.
  async function together(
    body: string,
    mine: () => void,
    theirs = noop,
    script?: (d: Document) => void,
  ) {
    const first = await open(body, script);
    mine();
    const saved = first.saved();
    const refused = first.refused;
    stop?.();
    const other = await open(body, script);
    theirs();
    const merged = merge3(other.source, other.saved(), saved);
    const patches = patchBetween(await parseSource(other.source), merged);
    if ("reload" in patches) return { saved, refused, reload: patches.reload };
    if (!other.editor.patch(patches.patches, other.editor.edits()).ok)
      return { saved, refused, reload: "the patch does not fit" };
    assert.equal(other.saved(), merged, "the other frame shows the merge");
    return { saved, refused, merged };
  }
  const type = (where: string, text: string) => () => {
    place(where);
    for (const key of text) input("insertText", { text: key });
  };
  const press = (inputType: string, where: string) => () => {
    place(where);
    input(inputType);
  };

  test("paragraphs and headings take typing, Enter and Backspace", async () => {
    const enter = await together(
      "<h2>Hello world</h2><p>One</p><p>Two</p>",
      press("insertParagraph", "Hello| world"),
      type("One|", "!"),
    );
    assert.equal(
      enter.merged,
      page("<h2>Hello</h2><p> world</p><p>One!</p><p>Two</p>"),
    );
    const join = await together(
      "<p>One</p><p>Two</p>",
      press("deleteContentBackward", "|Two"),
      type("One|", "!"),
    );
    assert.equal(join.merged, page("<p>One!Two</p>"));
  });

  test("inline formatting keeps its tags and attributes", async () => {
    const body =
      '<p>A <b>bold</b> <i>it</i> <code>co</code> <a href="#x">li</a> <span class="k" style="color:red">sp</span></p>';
    const { merged } = await together(
      body,
      () => ["bo|ld", "i|t", "c|o", "l|i", "s|p"].forEach((at) => type(at, "X")()),
      type("A |", "Y"),
    );
    assert.equal(
      merged,
      page(
        '<p>A Y<b>boXld</b> <i>iXt</i> <code>cXo</code> <a href="#x">lXi</a> <span class="k" style="color:red">sXp</span></p>',
      ),
    );
  });

  test("lists take typing, and Enter and Backspace at the edges of items", async () => {
    const list = "<ul><li>one</li><li>two</li></ul>";
    for (const [mine, result] of [
      [press("insertParagraph", "one|"), "<ul><li>one</li><li></li><li>two!</li></ul>"],
      [press("deleteContentBackward", "|two"), "<ul><li>onetwo!</li></ul>"],
      [press("deleteContentBackward", "|one"), "<p>one</p><ul><li>two!</li></ul>"],
    ] as const) {
      const { merged } = await together(list, mine, type("two|", "!"));
      assert.equal(merged, page(result));
    }
  });

  test("table cells take typing, and Enter adds a line in the cell", async () => {
    const table = "<table><tr><td>one</td><td>two</td></tr></table>";
    const { merged } = await together(
      table,
      press("insertParagraph", "on|e"),
      type("two|", "!"),
    );
    assert.equal(merged, page("<table><tr><td>on<br>e</td><td>two!</td></tr></table>"));
  });

  test("preformatted text keeps its white space", async () => {
    const { merged } = await together(
      "<pre><code>a  b\n  c</code></pre>",
      type("a | b", "X"),
      type("  |c", "Y"),
    );
    assert.equal(merged, page("<pre><code>a X b\n  Yc</code></pre>"));
  });

  test("a quote takes typing in its paragraph and in its own text", async () => {
    const { merged } = await together(
      "<blockquote><p>quote one</p>bare quote</blockquote>",
      type("quote| one", "X"),
      type("bare| quote", "Y"),
    );
    assert.equal(merged, page("<blockquote><p>quoteX one</p>bareY quote</blockquote>"));
  });

  test("an element with an event handler keeps it, and its own split loads the other frame again", async () => {
    const body = '<p onclick="go()">Click me</p>';
    const typed = await together(body, type("Click| me", "X"), type("me|", "!"));
    assert.equal(typed.merged, page('<p onclick="go()">ClickX me!</p>'));
    const split = await together(body, press("insertParagraph", "Click| me"));
    assert.equal(
      split.saved,
      page('<p onclick="go()">Click</p><p onclick="go()"> me</p>'),
    );
    assert.match(split.reload!, /event handler/);
  });

  test("text keeps the spelling of its character references", async () => {
    const { merged } = await together(
      "<p>A&amp;B&nbsp;C &lt;x&gt;</p>",
      type("A&B|", "X"),
      type("C <x>|", "!"),
    );
    assert.equal(merged, page("<p>A&amp;BX&nbsp;C &lt;x&gt;!</p>"));
  });

  test("text next to a comment or a template keeps them", async () => {
    const { merged } = await together(
      "<p>before<!-- note -->after</p><template><p>tpl</p></template>",
      type("bef|ore", "X"),
      type("aft|er", "Y"),
    );
    assert.equal(
      merged,
      page("<p>befXore<!-- note -->aftYer</p><template><p>tpl</p></template>"),
    );
  });

  test("the editable field of a widget that a script made is not editable", async () => {
    const doc = await open('<div id="w"></div>', (d) => {
      d.getElementById("w")!.innerHTML = '<p contenteditable="true">Note</p>';
    });
    place("No|te");
    assert.isFalse(input("insertText", { text: "!" }));
    assert.deepEqual(doc.refused, [REFUSED.script]);
  });

  test("a drawing or a formula is not editable, and text around it is", async () => {
    const body =
      '<p>Go <a href="#"><svg><text>icon</text></svg> home</a></p><math><mi>x</mi></math>';
    const doc = await open(body);
    for (const where of ["ic|on", "|x"]) {
      place(where);
      assert.isFalse(input("insertText", { text: "!" }));
    }
    place("G|o", "ho|me");
    assert.isFalse(input("deleteContentBackward"));
    assert.deepEqual(doc.refused, [
      REFUSED.fixed,
      REFUSED.fixed,
      REFUSED.crossesScript,
    ]);
    place("ho|me");
    input("insertText", { text: "!" });
    doc.expect(["home", "ho!me"]);
  });

  test("an element that a script moved is not editable", async () => {
    const doc = await open(
      '<div><p id="m">moved</p></div><div id="to"><p>stays</p></div>',
      (d) => d.getElementById("to")!.prepend(d.getElementById("m")!),
    );
    place("mo|ved");
    assert.isFalse(input("insertText", { text: "!" }));
    // Backspace would join the next paragraph to it.
    place("|stays");
    assert.isFalse(input("deleteContentBackward"));
    assert.deepEqual(doc.refused, [REFUSED.fixed, REFUSED.crossesScript]);
    doc.expect();
  });

  test("a drawing goes with its paragraph when that paragraph joins another", async () => {
    const doc = await open("<p>one</p><p>two <svg><text>icon</text></svg></p>");
    place("|two");
    input("deleteContentBackward");
    doc.expect(["one</p><p>two", "onetwo"]);
  });

  test("a change next to an element that a script took away keeps it in the source", async () => {
    const body = '<div><p>one</p><p id="m">gone</p><p>two</p></div><div id="to"></div>';
    const remove = (d: Document) => d.getElementById("m")!.remove();
    const move = (d: Document) =>
      d.getElementById("to")!.append(d.getElementById("m")!);
    const saved = (html: string) => page(`<div>${html}</div><div id="to"></div>`);
    for (const script of [remove, move]) {
      const split = await together(
        body,
        press("insertParagraph", "one|"),
        noop,
        script,
      );
      assert.equal(split.saved, saved('<p>one</p><p id="m">gone</p><p></p><p>two</p>'));
      const join = await together(
        body,
        press("deleteContentBackward", "|two"),
        noop,
        script,
      );
      assert.equal(join.saved, saved('<p>onetwo</p><p id="m">gone</p>'));
      // The other frame has no place for the element, and loads again.
      assert.equal(join.reload, "the patch does not fit");
    }
  });
});

describe("a patch of a start tag or a style", () => {
  // offset gives the offset of the first place of text in the source.
  const offset = (source: string, text: string) => source.indexOf(text);

  test("gives an element its new attributes, and leaves the caret and those of scripts", async () => {
    const doc = await open('<p class="a" title="t">Hello world</p>', (d) => {
      d.querySelector("p")!.setAttribute("data-open", "");
    });
    place("Hello| world");
    const tag = offset(doc.source, "<p class");
    const result = doc.editor.patch(
      [{ tag, html: '<p class="b" style="color: red">' }],
      doc.editor.edits(),
    );
    assert.isTrue(result.ok);
    const p = document.querySelector("p")!;
    assert.equal(p.className, "b");
    assert.equal(p.getAttribute("style"), "color: red");
    assert.isFalse(p.hasAttribute("title"));
    assert.isTrue(p.hasAttribute("data-open"));
    assert.deepEqual(caret(), ["Hello world", 5]);
    // The regions do not write a start tag: the app keeps the change.
    assert.equal(doc.saved(), doc.source);
  });

  test("changes the text of a style, unless a script changed its text or its rules", async () => {
    const doc = await open("<style>p { color: red }</style><p>One</p>");
    const style = document.querySelector("body style")!;
    const at = offset(doc.source, "<style>");
    assert.isTrue(doc.editor.patch([{ style: at, html: "p { color: blue }" }], 0).ok);
    assert.equal(style.textContent, "p { color: blue }");
    assert.isTrue(doc.editor.patch([{ style: at, html: "p { color: green }" }], 0).ok);
    assert.equal(style.textContent, "p { color: green }");
    // A rule that a script added to the sheet, or changed in it, stays.
    const sheet = (style as HTMLStyleElement).sheet!;
    sheet.insertRule("b { color: red }", 1);
    assert.isFalse(doc.editor.patch([{ style: at, html: "p { color: red }" }], 0).ok);
    sheet.deleteRule(1);
    (sheet.cssRules[0] as CSSStyleRule).style.color = "red";
    assert.isFalse(doc.editor.patch([{ style: at, html: "p { color: red }" }], 0).ok);
    (sheet.cssRules[0] as CSSStyleRule).style.color = "green";
    style.textContent += " b { color: red }";
    assert.isFalse(doc.editor.patch([{ style: at, html: "p { color: red }" }], 0).ok);
    assert.equal(style.textContent, "p { color: green } b { color: red }");
  });

  test.each([
    ["in the body", (d: Document) => d],
    ["in the head", (d: Document) => d.head.append(d.querySelector("style")!)],
  ])(
    "takes a style and a start tag out again when the patch is not kept, with a style %s",
    async (_where, script) => {
      const doc = await open(
        '<style>p { color: red }</style><p class="a">One</p>',
        script,
      );
      const style = Array.from(document.querySelectorAll("style")).find((el) =>
        el.textContent!.startsWith("p "),
      )!;
      const patches = [
        { style: offset(doc.source, "<style>"), html: "p { color: blue }" },
        { tag: offset(doc.source, "<p class"), html: '<p class="b">' },
      ];
      let seen: Range[] = [];
      const patch = (keep: boolean) =>
        doc.editor.patch(patches, 0, () => (ranges) => {
          seen = ranges;
          return keep;
        });
      assert.isTrue(patch(false).withdrawn);
      // A change of looks has no new content.
      assert.deepEqual(seen, []);
      assert.equal(style.textContent, "p { color: red }");
      assert.equal(document.querySelector("p")!.className, "a");
      assert.isTrue(patch(true).ok);
      assert.equal(style.textContent, "p { color: blue }");
      assert.equal(document.querySelector("p")!.className, "b");
    },
  );
});
