import { afterEach, assert, describe, test } from "vitest";
// The editor takes only trusted input, which a test cannot dispatch. jsdom
// keeps the trusted flag on the event behind its wrapper, so the test sets it
// there and dispatches the event as jsdom dispatches its own.
// @ts-expect-error jsdom has no types for its wrappers.
import { implForWrapper } from "jsdom/lib/generated/idl/utils.js";

import { startTextEditing } from "../bridge/text-editing.ts";
import { REFUSED } from "../bridge/structure.ts";
import { applyRegions, parseSource, tagSource } from "../src/lib/source-edits.ts";

function dispatch<E extends Event>(target: EventTarget, event: E): E {
  const impl = implForWrapper(event);
  impl.isTrusted = true;
  implForWrapper(target)._dispatch(impl);
  return event;
}

let stop: (() => void) | undefined;
afterEach(() => stop?.());

const page = (body: string) =>
  `<!doctype html>\n<html><head><title>T</title></head>\n<body>\n${body}\n</body></html>\n`;

// open renders source as the server does, loads it as the frame's document,
// and starts the editor on it. script changes the document first, as the
// document's own scripts do.
async function open(body: string, script?: (d: Document) => void) {
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
  const editor = startTextEditing(document, tagged, {
    beforeTouch() {},
    onDirty() {},
    onRefused: (reason) => refused.push(reason),
  })!;
  stop = editor.stop;
  // saved is the source with the editor's changes written into it.
  const saved = () => {
    const result = applyRegions(tree, editor.take().regions);
    if ("refused" in result) assert.fail(result.refused);
    return result.html;
  };
  // expect checks the saved source: the source with each of the changes.
  const expect = (...changes: [string, string][]) =>
    assert.equal(
      saved(),
      changes.reduce((html, [from, to]) => html.replace(from, to), source),
    );
  return { source, saved, expect, refused, run: editor.run };
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
    range.insertNode(document.createTextNode(data.text));
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

function key(init: KeyboardEventInit, target: EventTarget = document.body) {
  return dispatch(
    target,
    new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
  );
}

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
