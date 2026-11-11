import { describe, expect, test } from "vitest";
import cases from "./merge-cases.json";
import { replacementsBetween } from "./source-edits";
import { applyReplacements, changesBetween, merge3 } from "./source-merge";

describe("merge3", () => {
  // The server runs the same cases on Merge.
  test.each(cases)("$name", ({ base, ours, theirs, merged }) => {
    expect(merge3(base, ours, theirs)).toBe(merged);
  });

  // The server gives the changes of theirs as replacements at byte offsets.
  test.each(cases)("$name, with the replacements of theirs", (c) => {
    expect(merge3(c.base, c.ours, replacementsBetween(c.base, c.theirs))).toBe(
      c.merged,
    );
  });

  test("gives the other side when one side did not change", () => {
    for (const { base, ours, theirs } of cases) {
      expect(merge3(base, base, theirs)).toBe(theirs);
      expect(merge3(base, ours, base)).toBe(ours);
      expect(merge3(base, base, base)).toBe(base);
    }
  });

  test("keeps two changes of ours around one of theirs", () => {
    expect(
      merge3(
        "<p>one two three four five</p>",
        "<p>ONE two three four FIVE</p>",
        "<p>one two 3 four five</p>",
      ),
    ).toBe("<p>ONE two 3 four FIVE</p>");
  });

  test("keeps a paragraph of theirs between two edits of ours", () => {
    expect(
      merge3(
        "<p>alpha</p>\n<p>omega</p>",
        "<p>alpha!</p>\n<p>the omega</p>",
        "<p>alpha</p>\n<p>new</p>\n<p>omega</p>",
      ),
    ).toBe("<p>alpha!</p>\n<p>new</p>\n<p>the omega</p>");
  });

  test("never cuts a surrogate pair that two characters share", () => {
    // 😀 and 😁 have the same first half.
    expect(merge3("<p>😀</p>", "<p>😁</p>", "<p>😀!</p>")).toBe("<p>😁!</p>");
    expect(merge3("<p>a😀</p>", "<p>a😁</p>", "<p>a😃</p>")).toBe("<p>a😁😃</p>");
  });

  test("merges a large text", () => {
    const paragraphs = Array.from(
      { length: 4000 },
      (_, i) => `<p>Paragraph ${i} says a few words about item ${i}.</p>`,
    );
    const edit = (changes: Record<number, string>) =>
      paragraphs.map((p, i) => changes[i] ?? p).join("\n");
    const base = edit({});
    const ours = edit({ 10: "<p>Ours, at the start.</p>", 3990: "<p>Ours, late.</p>" });
    const theirs = edit({ 2000: "<p>Theirs, in the middle.</p>", 3991: "" });
    expect(base.length).toBeGreaterThan(200_000);
    expect(merge3(base, ours, theirs)).toBe(
      edit({
        10: "<p>Ours, at the start.</p>",
        2000: "<p>Theirs, in the middle.</p>",
        3990: "<p>Ours, late.</p>",
        3991: "",
      }),
    );
  });
});

describe("changesBetween", () => {
  test("cuts each change to the characters that differ", () => {
    expect(changesBetween("<p>cat</p>", "<p>cats</p>")).toEqual([
      { start: 6, end: 6, text: "s" },
    ]);
    expect(changesBetween("a 😀 b", "a 😁 b")).toEqual([
      { start: 2, end: 4, text: "😁" },
    ]);
    expect(changesBetween("same", "same")).toEqual([]);
  });
});

describe("applyReplacements", () => {
  test("applies replacements at UTF-8 byte offsets", () => {
    const source = "<p>héllo 😀 wörld</p>";
    const next = "<p>hèllo 😀 wörld, again</p>";
    expect(applyReplacements(source, replacementsBetween(source, next))).toBe(next);
    // é is two bytes and 😀 is four, so wörld starts at byte 15.
    expect(
      applyReplacements(source, [
        { start: 15, end: 21, old_html: "wörld", new_html: "world" },
      ]),
    ).toBe("<p>héllo 😀 world</p>");
    expect(applyReplacements(source, [])).toBe(source);
  });

  test("keeps a byte order mark", () => {
    expect(
      applyReplacements("\ufeff<p>a</p>", [
        { start: 6, end: 7, old_html: "a", new_html: "b" },
      ]),
    ).toBe("\ufeff<p>b</p>");
  });

  test.each([
    ["old_html is not the text", { start: 3, end: 4, old_html: "x", new_html: "y" }],
    [
      "the range ends after the source",
      { start: 3, end: 99, old_html: "é", new_html: "" },
    ],
    [
      "the range starts in a character",
      { start: 4, end: 5, old_html: "", new_html: "x" },
    ],
    [
      "the range ends before it starts",
      { start: 5, end: 3, old_html: "", new_html: "x" },
    ],
  ])("gives undefined when %s", (_, replacement) => {
    expect(applyReplacements("<p>é</p>", [replacement])).toBeUndefined();
  });

  test("gives undefined when a replacement starts before the end of the one before", () => {
    expect(
      applyReplacements("<p>abc</p>", [
        { start: 3, end: 5, old_html: "ab", new_html: "x" },
        { start: 4, end: 6, old_html: "bc", new_html: "y" },
      ]),
    ).toBeUndefined();
  });
});
