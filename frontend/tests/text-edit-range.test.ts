import { assert, test } from "vitest";
import { blockOf, expandToWholeInlines } from "../bridge/text-edit-range.ts";

function body(html: string): HTMLElement {
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
}

function textNode(root: Element, text: string): Text {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.includes(text)) return node as Text;
  }
  throw new Error(`no text node with ${text}`);
}

function rangeOf(root: Element, from: string, to: string): Range {
  const start = textNode(root, from);
  const end = textNode(root, to);
  const range = root.ownerDocument.createRange();
  range.setStart(start, start.data.indexOf(from));
  range.setEnd(end, end.data.indexOf(to) + to.length);
  return range;
}

function html(range: Range): string {
  const div = range.startContainer.ownerDocument!.createElement("div");
  div.appendChild(range.cloneContents());
  return div.innerHTML;
}

test("a range inside one text node is unchanged", () => {
  const root = body("<p>Hello brave world</p>");
  const range = expandToWholeInlines(rangeOf(root, "brave", "brave"))!;
  assert.strictEqual(html(range), "brave");
});

test("a range that ends inside an inline element grows to include it", () => {
  const root = body("<p>Pay <strong>the bill</strong> today</p>");
  const range = expandToWholeInlines(rangeOf(root, "Pay", "the"))!;
  assert.strictEqual(html(range), "Pay <strong>the bill</strong>");
});

test("a range that starts inside a link grows to the whole link", () => {
  const root = body('<p>See <a href="/x">the docs</a> now</p>');
  const range = expandToWholeInlines(rangeOf(root, "docs", "now"))!;
  assert.strictEqual(html(range), '<a href="/x">the docs</a> now');
});

test("a range inside nested inlines grows to the outermost partly covered one", () => {
  const root = body("<p>A <b>bold <i>italic</i> run</b> end</p>");
  const range = expandToWholeInlines(rangeOf(root, "italic", "end"))!;
  assert.strictEqual(html(range), "<b>bold <i>italic</i> run</b> end");
});

test("a range fully inside one inline element stays inside it", () => {
  const root = body("<p>A <b>bold run</b> end</p>");
  const range = expandToWholeInlines(rangeOf(root, "bold", "run"))!;
  assert.strictEqual(html(range), "bold run");
});

test("a range across two blocks is refused", () => {
  const root = body("<p>First para</p><p>Second para</p>");
  assert.isNull(expandToWholeInlines(rangeOf(root, "First", "Second")));
});

test("a range that contains a whole block is refused", () => {
  const root = body("<div>Intro <p>Inner para</p> outro</div>");
  assert.isNull(expandToWholeInlines(rangeOf(root, "Intro", "outro")));
  const list = body("<div>Intro <ul><li>item</li></ul> outro</div>");
  assert.isNull(expandToWholeInlines(rangeOf(list, "Intro", "outro")));
});

test("a range that ends where a heading ends stays inside the heading", () => {
  const root = body(
    "<div>\n  <h3>The offer is the last inch</h3>\n  <p>Every card</p>\n</div>",
  );
  const heading = textNode(root, "last inch");
  const range = root.ownerDocument.createRange();
  range.setStart(heading, heading.data.indexOf("is"));
  range.setEnd(heading.parentNode!.nextSibling!, 0);
  const grown = expandToWholeInlines(range)!;
  assert.strictEqual(html(grown), "is the last inch");
  assert.strictEqual(blockOf(grown.endContainer)?.tagName, "H3");
});

test("a range that starts where a block starts stays inside the block", () => {
  const root = body('<div>\n  <div class="card-name">Rewards Credit</div>\n</div>');
  const name = textNode(root, "Rewards");
  const range = root.ownerDocument.createRange();
  range.setStart(name.parentNode!.previousSibling!, 3);
  range.setEnd(name, name.data.length);
  const grown = expandToWholeInlines(range)!;
  assert.strictEqual(html(grown), "Rewards Credit");
});

test("a range that ends where a bold run ends keeps the bold element", () => {
  const root = body("<p>Pay <strong>the bill</strong> today</p>");
  const bill = textNode(root, "the bill");
  const range = root.ownerDocument.createRange();
  range.setStart(bill, 0);
  range.setEnd(textNode(root, "today"), 0);
  assert.strictEqual(html(expandToWholeInlines(range)!), "the bill");
});

test("blockOf finds the nearest block ancestor", () => {
  const root = body("<ul><li>Item <em>one</em></li></ul>");
  assert.strictEqual(blockOf(textNode(root, "one"))?.tagName, "LI");
});
