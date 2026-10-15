import { assert, test } from "vitest";
import { describeAnchor, type CommentAnchor } from "../../../bridge/anchoring";
import { locate, type LocatedRange } from "./locate";

// Builds the anchor the bridge would send for `quote` in the document as rendered.
function anchorFor(rendered: string, quote: string): CommentAnchor {
  const doc = new DOMParser().parseFromString(rendered, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let text = "";
  const nodes: { node: Text; start: number }[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push({ node: node as Text, start: text.length });
    text += (node as Text).data;
  }
  const from = text.indexOf(quote);
  const to = from + quote.length;
  const point = (offset: number, end: boolean) => {
    const hit = nodes.find(
      ({ node, start }) =>
        offset >= start &&
        (end ? offset <= start + node.length : offset < start + node.length),
    )!;
    return [hit.node, offset - hit.start] as const;
  };
  const range = doc.createRange();
  range.setStart(...point(from, false));
  range.setEnd(...point(to, true));
  return describeAnchor(doc.body, range)!;
}

function located(html: string, quote: string, rendered = html): LocatedRange {
  const result = locate(html, anchorFor(rendered, quote));
  if (typeof result === "string") throw new Error(result);
  return result;
}

test("a typo inside one text node maps to its exact bytes", () => {
  const html = "<!doctype html><p>The quikc brown fox</p>";
  const range = located(html, "quikc");
  assert.strictEqual(html.slice(range.start, range.end), "quikc");
  assert.strictEqual(range.html, "quikc");
  assert.strictEqual(range.text, "quikc");
});

test("text after character references maps to the right bytes", () => {
  const html = "<p>Tom &amp; Jerry&nbsp;are friends</p>";
  const range = located(html, "Jerry\u00a0are");
  assert.strictEqual(range.html, "Jerry&nbsp;are");
});

test("a selection that ends inside strong grows to the whole element", () => {
  const html = "<p>Please pay <strong>the bill</strong> today</p>";
  const range = located(html, "pay the");
  assert.strictEqual(range.html, "pay <strong>the bill</strong>");
  assert.strictEqual(range.text, "pay the bill");
});

test("a selection across two paragraphs is refused", () => {
  const html = "<p>First para</p>\n<p>Second para</p>";
  assert.strictEqual(locate(html, anchorFor(html, "para\nSecond")), "crosses-blocks");
});

test("text added by a script is refused as generated", () => {
  const html = "<p>Static text</p><p id=x></p>";
  const rendered = "<p>Static text</p><p id=x>Script wrote this</p>";
  assert.strictEqual(locate(html, anchorFor(rendered, "Script wrote")), "generated");
});

test("text a script changed is refused as generated", () => {
  const html = "<p>Total: 10 items</p>";
  const rendered = "<p>Total: 12 items</p>";
  assert.strictEqual(locate(html, anchorFor(rendered, "12 items")), "generated");
});

test("text that runs to the end of a heading stays inside the heading", () => {
  const html =
    "<!doctype html><div>\n  <h3>The offer is the last inch</h3>\n  <p>Every card</p>\n</div>";
  const anchor = {
    quote: "is the last inch",
    prefix: "  \n  The offer ",
    suffix: "\n  Every card\n",
    dom_path: "body",
    start_offset: 13,
    end_offset: 29,
  };
  const result = locate(html, anchor);
  if (typeof result === "string") throw new Error(result);
  assert.strictEqual(html.slice(result.start, result.end), "is the last inch");
});
