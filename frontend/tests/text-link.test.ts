import { assert, test } from "vitest";
import { parseTextLink, textLinkFragment } from "../bridge/text-link.ts";

test("text links round-trip punctuation, Unicode and duplicate-text context", () => {
  const anchor = {
    quote: "a + b & <em>hello</em> # 你好 🙂 :~:text=",
    prefix: "Second section: ",
    suffix: ". End",
    start_offset: 412,
    end_offset: 456,
  };
  const url = new URL("https://example.test/app/d/doc_1?version=ver_1");
  url.hash = textLinkFragment(anchor)!;
  assert.deepEqual(parseTextLink(url.hash), anchor);
  assert.strictEqual(url.search, "?version=ver_1");
});

test("text links reject empty or oversized input and ignore invalid offsets", () => {
  for (const value of [
    null,
    { quote: 42 },
    { quote: " " },
    { quote: "x".repeat(4097) },
    { quote: "ok", prefix: {} },
  ]) {
    assert.strictEqual(textLinkFragment(value), null);
  }
  assert.strictEqual(parseTextLink("#heading"), null);
  assert.strictEqual(parseTextLink("#text="), null);
  assert.deepEqual(parseTextLink("#text=hello&start=-2&end=NaN"), {
    quote: "hello",
    prefix: undefined,
    suffix: undefined,
  });
});
