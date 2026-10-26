import { describe, expect, it } from "vitest";
import { buildEdits, editFor } from "./text-edits";

describe("editFor", () => {
  it("replaces only the words that changed", () => {
    const source = "<p>Cache TTL of 10 minutes.</p><p>Queue TTL of 30 minutes.</p>";
    expect(
      editFor(source, {
        before: "Cache TTL of 10 minutes.",
        after: "Cache TTL of 5 minutes.",
      }),
    ).toEqual({ old_string: "10", new_string: "5" });
  });

  it("takes in neighbouring words until the text is unique", () => {
    const source = "<p>Retry twice.</p><p>Fail twice.</p>";
    expect(editFor(source, { before: "Retry twice.", after: "Retry thrice." })).toEqual(
      {
        old_string: "Retry twice.",
        new_string: "Retry thrice.",
      },
    );
  });

  it("matches text that the source escapes", () => {
    const source = "<p>R&amp;D &lt;draft&gt;</p>";
    expect(editFor(source, { before: "R&D <draft>", after: "R&D <final>" })).toEqual({
      old_string: "&lt;draft&gt;",
      new_string: "&lt;final&gt;",
    });
  });

  it("escapes typed markup instead of inserting it", () => {
    const source = "<p>Say hello world</p>";
    expect(
      editFor(source, { before: "Say hello world", after: "Say <b>hello</b> world" }),
    ).toEqual({ old_string: "hello", new_string: "&lt;b&gt;hello&lt;/b&gt;" });
  });

  it("turns typed non-breaking spaces into spaces", () => {
    const source = "<p>Done.</p>";
    expect(editFor(source, { before: "Done.", after: "Done. Next\u00a0" })).toEqual({
      old_string: "Done.",
      new_string: "Done. Next ",
    });
  });

  it("handles text typed at the edge of a node", () => {
    const source = "<li>alpha</li><li>beta</li>";
    expect(editFor(source, { before: "beta", after: "beta gamma" })).toEqual({
      old_string: "beta",
      new_string: "beta gamma",
    });
  });

  it("places text the head repeats by the tags around it in the body", () => {
    const source =
      "<html><head><title>Cache plan</title></head><body>\n<h1>Cache plan</h1>\n<p>Cache plan details.</p></body></html>";
    expect(editFor(source, { before: "Cache plan", after: "Cards" })).toEqual({
      old_string: "<h1>Cache plan</h1>",
      new_string: "<h1>Cards</h1>",
    });
    expect(
      editFor("<title>Yes</title><body><p>Yes</p><p>Yes</p>", {
        before: "Yes",
        after: "No",
      }),
    ).toBe("ambiguous");
  });

  it("reports text it cannot place", () => {
    expect(editFor("<p>Yes</p><p>Yes</p>", { before: "Yes", after: "No" })).toBe(
      "ambiguous",
    );
    expect(
      editFor("<p>It&rsquo;s fine</p>", { before: "It’s fine", after: "It’s ok" }),
    ).toEqual({ old_string: "fine", new_string: "ok" });
    expect(editFor("<p>&ldquo;Hi&rdquo;</p>", { before: "“Hi”", after: "" })).toBe(
      "not_found",
    );
  });
});

describe("buildEdits", () => {
  it("matches each change against the source the earlier edits left", () => {
    const source = "<p>one two</p><p>three</p>";
    const { edits, unmatched } = buildEdits(source, [
      { before: "one two", after: "one 2" },
      { before: "three", after: "two" },
      { before: "same", after: "same" },
    ]);
    expect(unmatched).toEqual([]);
    expect(edits).toEqual([
      { old_string: "two", new_string: "2" },
      { old_string: "three", new_string: "two" },
    ]);
  });

  it("keeps going past a change it cannot place", () => {
    const { edits, unmatched } = buildEdits("<p>Yes</p><p>Yes</p><p>Maybe</p>", [
      { before: "Yes", after: "No" },
      { before: "Maybe", after: "Perhaps" },
    ]);
    expect(edits).toEqual([{ old_string: "Maybe", new_string: "Perhaps" }]);
    expect(unmatched).toEqual([{ before: "Yes", after: "No", reason: "ambiguous" }]);
  });
});
