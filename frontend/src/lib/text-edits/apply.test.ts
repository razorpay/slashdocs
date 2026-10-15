import { assert, test } from "vitest";
import { describeAnchor, type CommentAnchor } from "../../../bridge/anchoring";
import {
  applyEdits,
  locateForEdit,
  reapplyEdits,
  summaryLines,
  type TextEdit,
} from "./apply";

function anchorFor(html: string, quote: string): CommentAnchor {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node as Text).data.indexOf(quote);
    if (at < 0) continue;
    const range = doc.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + quote.length);
    return describeAnchor(doc.body, range)!;
  }
  throw new Error(`no ${quote}`);
}

let ids = 0;
function edit(base: string, edits: TextEdit[], quote: string, html: string): TextEdit {
  const current = applyEdits(base, edits);
  const located = locateForEdit(base, edits, anchorFor(current, quote));
  if (typeof located === "string") throw new Error(located);
  return {
    id: String(++ids),
    start: located.start,
    end: located.end,
    originalHtml: located.html,
    originalText: located.text,
    html,
    text: html.replace(/<[^>]*>/g, ""),
    anchor: located.anchor,
  };
}

const BASE =
  '<!doctype html><html><head><script>var keep = "a  b";</script></head>' +
  "<body>\n  <p>The quikc brown fox</p>\n  <p>jumps over the lazzy dog</p>\n</body></html>";

test("edits splice in any order and change no other byte", () => {
  const first = edit(BASE, [], "quikc", "quick");
  const second = edit(BASE, [first], "lazzy", "<em>lazy</em>");
  const expected = BASE.replace("quikc", "quick").replace("lazzy", "<em>lazy</em>");
  assert.strictEqual(applyEdits(BASE, [first, second]), expected);
  assert.strictEqual(applyEdits(BASE, [second, first]), expected);
});

test("an edit after a longer earlier edit maps back to base offsets", () => {
  const first = edit(BASE, [], "quikc", "very quick indeed");
  const second = edit(BASE, [first], "brown", "red");
  assert.strictEqual(BASE.slice(second.start, second.end), "brown");
  assert.strictEqual(
    applyEdits(BASE, [first, second]),
    BASE.replace("quikc brown", "very quick indeed red"),
  );
});

test("a range that overlaps an unsaved edit is refused", () => {
  const first = edit(BASE, [], "quikc", "quick");
  const current = applyEdits(BASE, [first]);
  assert.strictEqual(
    locateForEdit(BASE, [first], anchorFor(current, "The quick")),
    "overlaps",
  );
});

test("summary lines show old and new text, truncated", () => {
  const first = edit(BASE, [], "quikc", "quick");
  const long = { ...first, text: "x".repeat(100) };
  assert.deepEqual(summaryLines([first]), ['Edited "quikc" → "quick"']);
  assert.match(summaryLines([long])[0], /^Edited "quikc" → "x{59}…"$/);
});

test("a formatting-only edit reads as formatted in the summary", () => {
  const first = edit(BASE, [], "quikc", "<strong>quikc</strong>");
  assert.deepEqual(summaryLines([first]), ['Formatted "quikc"']);
});

test("re-applying to a changed file places edits whose text remains", () => {
  const first = edit(BASE, [], "quikc", "quick");
  const second = edit(BASE, [first], "lazzy", "lazy");
  const newer = BASE.replace("<p>The", "<p>Intro.</p>\n  <p>The").replace(
    "lazzy dog",
    "sleepy dog",
  );
  const [placed, lost] = reapplyEdits(newer, [first, second]);
  assert.isFalse(placed.failed);
  assert.isTrue(lost.failed);
  assert.strictEqual(
    applyEdits(newer, [placed, lost]),
    newer.replace("quikc", "quick"),
  );
});
