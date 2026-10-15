import { assert, test } from "vitest";
import { describeAnchor } from "../bridge/anchoring/index.ts";
import { applyEditPreview } from "../bridge/edit-preview.ts";

function anchorIn(body: HTMLElement, quote: string) {
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node as Text).data.indexOf(quote);
    if (at < 0) continue;
    const range = body.ownerDocument.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + quote.length);
    return describeAnchor(body, range)!;
  }
  throw new Error(`no ${quote}`);
}

function body(html: string): HTMLElement {
  return new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
}

test("a preview replaces the anchored text with the edited html", () => {
  const root = body("<p>The quikc brown fox</p>");
  assert.isTrue(applyEditPreview(root, anchorIn(root, "quikc"), "<em>quick</em>"));
  assert.strictEqual(
    root.innerHTML,
    '<p>The <span class="slashdocs-edited"><em>quick</em></span> brown fox</p>',
  );
});

test("a preview grows over a partly selected inline element", () => {
  const root = body("<p>Pay <strong>the bill</strong> today</p>");
  const range = root.ownerDocument.createRange();
  range.setStart(root.querySelector("p")!.firstChild!, 0);
  range.setEnd(root.querySelector("strong")!.firstChild!, 3);
  const anchor = describeAnchor(root, range)!;
  assert.isTrue(applyEditPreview(root, anchor, "Pay <b>the invoice</b>"));
  assert.strictEqual(
    root.innerHTML,
    '<p><span class="slashdocs-edited">Pay <b>the invoice</b></span> today</p>',
  );
});

test("a preview whose text is gone does nothing", () => {
  const root = body("<p>Other text</p>");
  const anchor = { quote: "missing words", start_offset: 0, end_offset: 13 };
  assert.isFalse(applyEditPreview(root, anchor, "x"));
  assert.strictEqual(root.innerHTML, "<p>Other text</p>");
});
