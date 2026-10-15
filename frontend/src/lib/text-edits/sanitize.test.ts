import { assert, test } from "vitest";
import { inlineText, sanitizeInline } from "./sanitize";

test("keeps the allowed inline markup", () => {
  const html =
    "a <strong>b</strong> <b>c</b> <em>d</em> <i>e</i> <code>f</code><br>" +
    '<a href="https://x.test/">g</a> <a href="mailto:a@x.test">h</a>';
  assert.deepEqual(sanitizeInline(html), { html, dropped: false });
});

test("drops scripts, unsafe links, attributes, and other elements", () => {
  const { html, dropped } = sanitizeInline(
    '<span class="k">kept</span> <a href="javascript:alert(1)" onclick="x()">link</a>' +
      '<img src=x onerror="y()"><script>z()</script>',
  );
  assert.strictEqual(html, "kept <a>link</a>");
  assert.isTrue(dropped);
});

test("plain text is escaped", () => {
  assert.deepEqual(sanitizeInline("1 &lt; 2"), { html: "1 &lt; 2", dropped: false });
});

test("inlineText renders br as a space", () => {
  assert.strictEqual(inlineText("one<br>two <b>three</b>"), "one two three");
});
