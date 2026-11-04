import { describe, expect, test } from "vitest";
import type { Region } from "../../bridge/source-pieces.ts";
import {
  applyRegions,
  parseSource,
  replacementsBetween,
  tagSource,
} from "./source-edits";

// apply writes regions into source, or gives the reason it refused.
async function apply(source: string, ...regions: Region[]) {
  const result = applyRegions(await parseSource(source), regions);
  return "html" in result ? result.html : `refused: ${result.refused}`;
}

describe("tagSource", () => {
  // The same cases as the server's tagSource tests in internal/render.
  test.each([
    [
      "<p>a</p><br/>",
      '<p data-slashdocs-source="0">a</p><br data-slashdocs-source="8"/>',
    ],
    [
      "<p>é😀</p><b>x</b>",
      '<p data-slashdocs-source="0">é😀</p><b data-slashdocs-source="10">x</b>',
    ],
    ["\ufeff<p>x</p>", '\ufeff<p data-slashdocs-source="1">x</p>'],
    [
      `<DIV Class="a">x</DIV><img src=x alt='a>b'>`,
      `<DIV data-slashdocs-source="0" Class="a">x</DIV><img data-slashdocs-source="22" src=x alt='a>b'>`,
    ],
    [
      "<!doctype html><!-- <p> --><p>x</p>",
      '<!doctype html><!-- <p> --><p data-slashdocs-source="27">x</p>',
    ],
    [
      `<script>if (a<b) "<p>"</script><title><i></title><p>x</p>`,
      `<script data-slashdocs-source="0">if (a<b) "<p>"</script><title data-slashdocs-source="31"><i></title><p data-slashdocs-source="49">x</p>`,
    ],
    [
      '<svg\n/><input\tvalue="<">',
      '<svg data-slashdocs-source="0"\n/><input data-slashdocs-source="7"\tvalue="<">',
    ],
  ])("tags %j", async (source, tagged) => {
    expect(tagSource(await parseSource(source))).toBe(tagged);
  });

  test("writes the offsets that offsetOf gives", async () => {
    const tree = await parseSource("<p>a</p><i>b</i>");
    expect(tagSource(tree, (at) => at + 100)).toBe(
      '<p data-slashdocs-source="100">a</p><i data-slashdocs-source="108">b</i>',
    );
  });
});

describe("applyRegions", () => {
  test("keeps the source of an element with an implied end tag", async () => {
    const source = "<ul><li>a<li>b &amp; c</ul>";
    expect(
      await apply(source, {
        from: 4,
        to: 9,
        pieces: [
          { keep: 4 },
          { element: 9, children: [{ text: "b & d", was: { parent: 9, index: 0 } }] },
        ],
        removed: [],
      }),
    ).toBe("<ul><li>a<li>b &amp; d</ul>");
  });

  test("keeps the spelling of unchanged character references and line breaks", async () => {
    const source = "<p>&ampx &notin; a\r\nb&#xA0;</p>";
    expect(
      await apply(source, {
        from: 0,
        to: 0,
        pieces: [
          {
            element: 0,
            children: [{ text: "&x ∉ A\nb\u00a0", was: { parent: 0, index: 0 } }],
          },
        ],
        removed: [],
      }),
    ).toBe("<p>&ampx &notin; A\r\nb&#xA0;</p>");
  });

  test("applies regions in any order", async () => {
    const source = "<p>a</p><p>b</p>";
    const text = (at: number, text: string): Region => ({
      from: at,
      to: at,
      pieces: [{ element: at, children: [{ text }] }],
      removed: [],
    });
    expect(await apply(source, text(8, "y"), text(0, "x"))).toBe("<p>x</p><p>y</p>");
  });

  test.each<[string, Region]>([
    ["no element at 5", { from: 5, to: 5, pieces: [], removed: [] }],
    [
      "the region from 3 to 0 is not a run of siblings",
      { from: 3, to: 0, pieces: [], removed: [] },
    ],
    [
      "the region writes <p> at 0 twice",
      { from: 0, to: 0, pieces: [{ keep: 0 }, { keep: 0 }], removed: [] },
    ],
    [
      "the region writes <b> at 3 twice",
      { from: 0, to: 0, pieces: [{ keep: 0 }, { keep: 3 }], removed: [] },
    ],
    ["the region leaves out <p> at 0", { from: 0, to: 0, pieces: [], removed: [] }],
    [
      "<i> at 18 is not in the region",
      { from: 0, to: 0, pieces: [{ keep: 0 }, { keep: 18 }], removed: [] },
    ],
    [
      "no text or comment in the region at child 0 of 15",
      {
        from: 0,
        to: 0,
        pieces: [{ keepChild: { parent: 15, index: 0 } }],
        removed: [0],
      },
    ],
    [
      "new content cannot be <script></script>",
      {
        from: 0,
        to: 0,
        pieces: [{ open: "<script>", close: "</script>", children: [] }],
        removed: [0],
      },
    ],
    [
      "new content cannot have onclick on <p>",
      {
        from: 0,
        to: 0,
        pieces: [{ open: '<p onclick="x">', close: "</p>", children: [] }],
        removed: [0],
      },
    ],
    [
      "new content cannot have href on <a>",
      {
        from: 0,
        to: 0,
        pieces: [{ open: '<a href="javascript:x">', close: "</a>", children: [] }],
        removed: [0],
      },
    ],
  ])("refuses: %s", async (reason, region) => {
    expect(await apply("<p><b>a</b></p><p><i>b</i></p>", region)).toBe(
      `refused: ${reason}`,
    );
  });

  test("refuses regions that overlap", async () => {
    const region: Region = { from: 0, to: 0, pieces: [{ keep: 0 }], removed: [] };
    expect(await apply("<p>a</p>", region, region)).toBe(
      "refused: two regions overlap",
    );
  });

  test("lets new content use the attributes of its tag in the source", async () => {
    const source = '<p class="x">a</p>';
    const open = '<p class="y &amp; &quot;z&quot;">';
    expect(
      await apply(source, {
        from: 0,
        to: 0,
        pieces: [{ keep: 0 }, { open, close: "</p>", children: [{ text: "b" }] }],
        removed: [],
      }),
    ).toBe(source + open + "b</p>");
  });
});

describe("replacementsBetween", () => {
  test("gives nothing for equal sources", () => {
    expect(replacementsBetween("<p>a</p>", "<p>a</p>")).toEqual([]);
  });

  test("gives UTF-8 byte offsets", () => {
    expect(replacementsBetween("é<p>a</p>", "é<p>bc</p>")).toEqual([
      { start: 5, end: 6, old_html: "a", new_html: "bc" },
    ]);
  });

  test("keeps a surrogate pair whole", () => {
    expect(replacementsBetween("<p>😀</p>", "<p>😃</p>")).toEqual([
      { start: 3, end: 7, old_html: "😀", new_html: "😃" },
    ]);
  });
});
