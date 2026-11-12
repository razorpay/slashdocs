import { describe, expect, test } from "vitest";
import cases from "./merge-cases.json";
import { replacementsBetween } from "./source-edits";
import {
  applyOps,
  applyReplacements,
  changesBetween,
  merge3,
  mergeOps,
  sumOf,
} from "./source-merge";

describe("merge3", () => {
  // The server runs the same cases on Merge.
  test.each(cases)("$name", ({ base, ours, theirs, merged }) => {
    expect(merge3(base, ours, theirs)).toBe(merged);
  });

  // The server gives the changes of theirs as replacements at byte offsets,
  // each one at its one place.
  test.each(cases)("$name, with the replacements of theirs", (c) => {
    const bytes = (text: string) => new TextEncoder().encode(text).length;
    const theirs = changesBetween(c.base, c.theirs).map(({ start, end, text }) => ({
      start: bytes(c.base.slice(0, start)),
      end: bytes(c.base.slice(0, end)),
      old_html: c.base.slice(start, end),
      new_html: text,
    }));
    expect(merge3(c.base, c.ours, theirs)).toBe(c.merged);
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
    // Both replace the character, so the two stay, the one of ours first.
    expect(merge3("<p>a😀</p>", "<p>a😁</p>", "<p>a😃</p>")).toBe("<p>a😁😃</p>");
    // A character that comes in before the same character stays whole.
    expect(changesBetween("<p>😀</p>", "<p>😀😀</p>")).toEqual([
      { start: 3, end: 3, text: "😀" },
    ]);
  });

  test("keeps two words whole when two people replace one word key by key", () => {
    // Each person selects "decided" and types a word. The first key takes
    // the place of the word, and each key after it adds a letter.
    const keys = (word: string) => {
      const ops = [];
      let prev = "<p>We decided it.</p>";
      for (let length = 1; length <= word.length; length++) {
        const next = `<p>We ${word.slice(0, length)} it.</p>`;
        ops.push(replacementsBetween(prev, next));
        prev = next;
      }
      return ops;
    };
    expect(
      mergeOps("<p>We decided it.</p>", "<p>We agreed it.</p>", keys("rejected"))
        .source,
    ).toBe("<p>We agreedrejected it.</p>");
  });

  test("gives the text of ours when its changes come one after another", () => {
    // Without a limit, the second change moves back into the first one.
    const base = "<p>two</p><p>a <b>two</b></p>";
    const ours = "<p>two</p><p>two a a</p><p>a <b>xtwo</b></p>";
    expect(merge3(base, ours, base)).toBe(ours);
  });

  test("keeps every change of a side in a word that the two sides replace", () => {
    // The server gives the changes of theirs by character.
    const theirs = [
      { start: 3, end: 4, old_html: "b", new_html: "c" },
      { start: 7, end: 8, old_html: "n", new_html: "ns" },
    ];
    expect(merge3("<p>brown</p>", "<p>frown</p>", theirs)).toBe("<p>frowncrowns</p>");
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

  test("moves two deletions in a long run of one character toward each other in little time", () => {
    // Each step reads the tags only where it passes a "<" or a ">", and
    // the steps stop after PLACE_REACH characters. Else each step reads the
    // whole run.
    const n = 1 << 20;
    const base = `<p>${"a".repeat(n)}</p>`;
    const ours = base.slice(0, 3) + base.slice(3 + n / 2);
    const theirs = [
      {
        start: 3 + n / 4,
        end: 3 + (3 * n) / 4,
        old_html: "a".repeat(n / 2),
        new_html: "",
      },
    ];
    const started = performance.now();
    merge3(base, ours, theirs);
    expect(performance.now() - started).toBeLessThan(1000);
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

  test("gives typed text one place: back while the character before it is its last one", () => {
    // "Alpha. " before "Two." and " Alpha." after "One." are the same text.
    expect(changesBetween("<p>One. Two.</p>", "<p>One. Alpha. Two.</p>")).toEqual([
      { start: 6, end: 6, text: ". Alpha" },
    ]);
    expect(changesBetween("<p>One two</p>", "<p>One red two</p>")).toEqual([
      { start: 6, end: 6, text: " red" },
    ]);
    expect(changesBetween("<p>a b b c</p>", "<p>a b c</p>")).toEqual([
      { start: 4, end: 6, text: "" },
    ]);
  });

  test("puts a change of markup where its text starts with a tag", () => {
    expect(changesBetween("<p>a</p><p>b</p>", "<p>a</p><p>new</p><p>b</p>")).toEqual([
      { start: 8, end: 8, text: "<p>new</p>" },
    ]);
    expect(changesBetween("<p>a</p><p>old</p><p>b</p>", "<p>a</p><p>b</p>")).toEqual([
      { start: 8, end: 18, text: "" },
    ]);
  });

  test("never moves a change before the end of the change before it", () => {
    const prev = "<p>two</p><p>a <b>two</b></p>";
    const next = "<p>two</p><p>two a a</p><p>a <b>xtwo</b></p>";
    let end = 0;
    for (const change of changesBetween(prev, next)) {
      expect(change.start).toBeGreaterThanOrEqual(end);
      end = change.end;
    }
  });

  test("reads each tag one time as it moves a deletion out of a long attribute", () => {
    // A long attribute has no "<" or ">" in it. A read for each step of the
    // move would read it all.
    const value = "a".repeat(2 << 20);
    const base = `<i title="${value}">${"a".repeat(3000)}</i>`;
    const at = '<i title="'.length + value.length - 1500;
    const started = performance.now();
    changesBetween(base, base.slice(0, at) + base.slice(at + 3002));
    expect(performance.now() - started).toBeLessThan(1000);
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

describe("applyOps", () => {
  const op = (prev: string, next: string) => replacementsBetween(prev, next);

  test("applies each operation on the source before it", () => {
    expect(
      applyOps("<p>a</p>", [
        op("<p>a</p>", "<p>a b</p>"),
        op("<p>a b</p>", "<p>a b c</p>"),
      ]),
    ).toBe("<p>a b c</p>");
    expect(applyOps("<p>a</p>", [])).toBe("<p>a</p>");
  });

  test("gives nothing when an operation does not fit", () => {
    expect(applyOps("<p>a</p>", [op("<p>x</p>", "<p>y</p>"), []])).toBeUndefined();
  });
});

describe("mergeOps", () => {
  test("merges ours over operations in order, where one diff of the states would not fit them", () => {
    const base = "<li>one</li><li>one</li>";
    // Another person types in the second item, then in the first.
    const ops = [
      replacementsBetween(base, "<li>one</li><li>one two</li>"),
      replacementsBetween(
        "<li>one</li><li>one two</li>",
        "<li>zero one</li><li>one two</li>",
      ),
    ];
    expect(mergeOps(base, "<li>one</li><li>one!</li>", ops).source).toBe(
      "<li>zero one</li><li>one! two</li>",
    );
    expect(mergeOps(base, base, ops).source).toBe(applyOps(base, ops));
  });

  test("returns for an operation that changes nothing, and keeps the text of ours", () => {
    const base = "<p>b</p>";
    const same = [[{ start: 3, end: 4, old_html: "b", new_html: "b" }]];
    expect(mergeOps(base, "<p>b!</p>", same).source).toBe("<p>b!</p>");
    const empty = [[{ start: 0, end: 0, old_html: "", new_html: "" }]];
    expect(mergeOps(base, "<p>b!</p>", empty).source).toBe("<p>b!</p>");
    // A change that changes nothing next to one that changes text.
    expect(
      merge3("<p>abc</p>", "<p>abc!</p>", [
        { start: 3, end: 4, old_html: "a", new_html: "a" },
        { start: 4, end: 5, old_html: "b", new_html: "B" },
      ]),
    ).toBe("<p>aBc!</p>");
  });

  // The text that the ranges of a merge name.
  const marked = ({ source, marks }: ReturnType<typeof mergeOps>) =>
    marks.map(([start, end]) => source.slice(start, end));
  const insert = (start: number, new_html: string) => [
    { start, end: start, old_html: "", new_html },
  ];

  test("gives the range of text that goes in at the point of the text of ours", () => {
    const base = "<p>here. It</p>";
    // The two people type a sentence after "here.". The text of ours comes
    // first. The server gives the operation at its one place.
    const merged = mergeOps(base, "<p>here. Me too. It</p>", [insert(7, ". Us also")]);
    expect(merged.source).toBe("<p>here. Me too. Us also. It</p>");
    expect(marked(merged)).toEqual([". Us also"]);
  });

  test("gives the exact place of an operation among equal characters, with no text of ours", () => {
    const base = "<p>here.  It</p>";
    // One more space after the first one, and then before it.
    expect(mergeOps(base, base, [insert(9, " ")]).marks).toEqual([[9, 10]]);
    expect(mergeOps(base, base, [insert(8, " ")]).marks).toEqual([[8, 9]]);
  });

  test("keeps an operation at its place among equal characters, also with text of ours", () => {
    // Both people typed a space after "here", and the server put the space
    // of the other person after ours. Then ours typed "R" after its space.
    const merged = mergeOps("<p>here  and</p>", "<p>here R and</p>", [insert(8, " ")]);
    expect(merged.source).toBe("<p>here R  and</p>");
    expect(merged.marks).toEqual([[9, 10]]);
  });

  test("gives the ranges of two operations in a row at their places in the result", () => {
    const base = "<p>one two</p>";
    const ours = "<p>one two!</p>";
    // The second operation is on the source that the first one made.
    const merged = mergeOps(base, ours, [insert(6, " and"), insert(3, "zero ")]);
    expect(merged.source).toBe("<p>zero one and two!</p>");
    expect(marked(merged)).toEqual(["zero ", " and"]);
    // With no text of ours, each range is where its operation has it.
    expect(
      marked(mergeOps(base, base, [insert(6, " and"), insert(3, "zero ")])),
    ).toEqual(["zero ", " and"]);
    // An operation that takes out text of the one before leaves its rest.
    const cut = [{ start: 7, end: 9, old_html: "an", new_html: "" }];
    expect(marked(mergeOps(base, ours, [insert(6, " and"), cut]))).toEqual([" d"]);
  });

  test("gives the range of the new text of a replacement, and none for text that goes out", () => {
    const base = "<p>one two</p>";
    const swap = [{ start: 7, end: 10, old_html: "two", new_html: "three" }];
    const merged = mergeOps(base, "<p>one! two</p>", [swap]);
    expect(merged.source).toBe("<p>one! three</p>");
    expect(marked(merged)).toEqual(["hree"]);
    const out = [{ start: 6, end: 10, old_html: " two", new_html: "" }];
    expect(mergeOps(base, "<p>one! two</p>", [out]).marks).toEqual([]);
    // Two words in place of one: the word of the other person is the range.
    const both = mergeOps(base, "<p>one twin</p>", [swap]);
    expect(both.source).toBe("<p>one twinthree</p>");
    expect(marked(both)).toEqual(["three"]);
  });
});

describe("changesBetween", () => {
  test("moves text back over at most 1024 equal characters, as the server does", () => {
    const run = "a".repeat(2000);
    expect(changesBetween(`<p>${run}</p>`, `<p>${run}a</p>`)).toEqual([
      { start: 3 + 2000 - 1024, end: 3 + 2000 - 1024, text: "a" },
    ]);
  });
});

describe("sumOf", () => {
  test("is the CRC-32 (IEEE) of the UTF-8 bytes", () => {
    expect(sumOf("")).toBe(0);
    expect(sumOf("123456789")).toBe(0xcbf43926);
    expect(sumOf("é")).not.toBe(sumOf("e"));
  });
});
