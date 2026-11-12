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

  test("writes text that goes on after </body> only before </body>", async () => {
    // The parser puts "def" after </body> in the last text of the body. A
    // frame that loaded the source shows it, and a frame that a patch
    // changed does not.
    const source = "<html><body><p>a</p>abc</body>def</html>";
    const body = (text: string): Region => ({
      from: 6,
      to: 6,
      pieces: [
        {
          element: 6,
          children: [{ keep: 12 }, { text, was: { parent: 6, index: 1 } }],
        },
      ],
      removed: [],
    });
    expect(await apply(source, body("abXcdef"))).toBe(
      "<html><body><p>a</p>abXc</body>def</html>",
    );
    expect(await apply(source, body("abX"))).toBe(
      "<html><body><p>a</p>abX</body>def</html>",
    );
    expect(await apply(source, body("abcdef!"))).toBe(
      "refused: the text after </body> cannot change",
    );
    expect(await apply(source, body("abcdf"))).toBe(
      "refused: the text after </body> cannot change",
    );
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
    [
      "new content cannot have start on <ol>",
      {
        from: 0,
        to: 0,
        pieces: [{ open: '<ol start="0">', close: "</ol>", children: [] }],
        removed: [0],
      },
    ],
    [
      "new content cannot have start on <p>",
      {
        from: 0,
        to: 0,
        pieces: [{ open: '<p start="2">', close: "</p>", children: [] }],
        removed: [0],
      },
    ],
  ])("refuses: %s", async (reason, region) => {
    expect(await apply("<p><b>a</b></p><p><i>b</i></p>", region)).toBe(
      `refused: ${reason}`,
    );
  });

  // A patch put in <p id="c" class='x'>. The region writes that element
  // with its start tag exactly as the patch had it, and no other tag.
  describe("an element that a patch put in", () => {
    const made = new Set([`<p id="c" class='x'>`]);
    const region = (open: string, close = "</p>"): Region => ({
      from: 0,
      to: 0,
      pieces: [{ open, close, children: [{ text: "t" }] }],
      removed: [0],
    });
    const write = async (piece: Region) => {
      const result = applyRegions(await parseSource("<p>a</p>"), [piece], [], made);
      return "html" in result ? result.html : `refused: ${result.refused}`;
    };

    test("keeps its start tag as the patch had it", async () => {
      expect(await write(region(`<p id="c" class='x'>`))).toBe(
        `<p id="c" class='x'>t</p>`,
      );
    });

    test.each([
      [
        "another id",
        `<p id="d" class='x'>`,
        "</p>",
        `new content cannot be <p id="d" class='x'></p>`,
      ],
      [
        "other quotes",
        `<p id="c" class="x">`,
        "</p>",
        "new content cannot have id on <p>",
      ],
      [
        "another end tag",
        `<p id="c" class='x'>`,
        "</div>",
        `new content cannot be <p id="c" class='x'></div>`,
      ],
    ])("refuses %s", async (_, open, close, reason) => {
      expect(await write(region(open, close))).toBe(`refused: ${reason}`);
    });
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

  test("lets a new numbered list start at a number", async () => {
    const source = "<ol><li>a</li></ol>";
    const open = '<ol start="3">';
    expect(
      await apply(source, {
        from: 0,
        to: 0,
        pieces: [{ keep: 0 }, { open, close: "</ol>", children: [] }],
        removed: [],
      }),
    ).toBe(source + open + "</ol>");
  });

  test("writes the changes outside the regions where the regions copy the source", async () => {
    const source =
      '<style>p{}</style><div class="a"><p>one</p></div><p class="b">two</p>';
    const tree = await parseSource(source);
    const change = (from: string, text: string) => ({
      start: source.indexOf(from),
      end: source.indexOf(from) + from.length,
      text,
    });
    const outside = [
      change("p{}", "p{color:red}"),
      change('<div class="a">', '<div class="c">'),
      change('<p class="b">', "<p>"),
    ];
    const div = source.indexOf("<div");
    const one = source.indexOf("<p>one");
    const region = (at: number, text: string): Region => ({
      from: at,
      to: at,
      pieces: [{ element: at, children: [{ text }] }],
      removed: [],
    });
    expect(applyRegions(tree, [], outside)).toEqual({
      html: '<style>p{color:red}</style><div class="c"><p>one</p></div><p>two</p>',
    });
    // A region copies the start tag of the element that it writes, and each
    // element that it keeps.
    expect(applyRegions(tree, [region(one, "one!")], outside)).toEqual({
      html: '<style>p{color:red}</style><div class="c"><p>one!</p></div><p>two</p>',
    });
    expect(
      applyRegions(
        tree,
        [{ from: div, to: div, pieces: [{ keep: div }, { text: "new" }], removed: [] }],
        outside,
      ),
    ).toEqual({
      html: '<style>p{color:red}</style><div class="c"><p>one</p></div>new<p>two</p>',
    });
    // A change that a region writes over is refused.
    expect(
      applyRegions(tree, [region(one, "one!")], [change("<p>one</p>", "<p>uno</p>")]),
    ).toEqual({ refused: "a change outside the regions is in a region" });
  });
});

describe("replacementsBetween", () => {
  // Another person typed " on th" at the caret of this one, who now types
  // " o" before it. A diff that matches "on" or a space of the two texts by
  // chance puts the "o" into the word of the other person.
  test("gives text typed next to equal words as one change, at one place", () => {
    const prev = '<p id="a">The plan starts here on th and ends there.</p>';
    const next = '<p id="a">The plan starts here o on th and ends there.</p>';
    const changes = replacementsBetween(prev, next);
    expect(changes).toHaveLength(1);
    expect(changes[0].old_html).toBe("");
    expect(changes[0].new_html).toMatch(/^( o|o )$/);
  });

  test("gives two changes for edits that have a word between them that is there once", () => {
    const prev = "<p>one two three</p><p>the end of the tale</p>";
    const next = "<p>one 2 three</p><p>the end of the story</p>";
    expect(replacementsBetween(prev, next).map((r) => r.new_html)).toEqual([
      "2",
      "story",
    ]);
  });

  test("gives nothing for equal sources", () => {
    expect(replacementsBetween("<p>a</p>", "<p>a</p>")).toEqual([]);
  });

  test("gives UTF-8 byte offsets", () => {
    expect(replacementsBetween("é<p>a</p>", "é<p>bc</p>")).toEqual([
      { start: 5, end: 6, old_html: "a", new_html: "bc" },
    ]);
  });

  test("takes whole words, for the version history", () => {
    expect(
      replacementsBetween("<p>retry twice now</p>", "<p>retry three times now</p>"),
    ).toEqual([{ start: 9, end: 14, old_html: "twice", new_html: "three times" }]);
  });

  test("gives one replacement for each change, so that changes far apart never conflict", () => {
    expect(
      replacementsBetween(
        "<p>For authors.</p><p>Retry twice.</p><p>Read the guide.</p>",
        "<p>For readers.</p><p>Retry twice.</p><p>Read the handbook.</p>",
      ),
    ).toEqual([
      { start: 7, end: 15, old_html: "authors.", new_html: "readers." },
      { start: 50, end: 56, old_html: "guide.", new_html: "handbook." },
    ]);
  });

  test("gives one replacement when more words differ than a diff can follow", () => {
    const words = (n: number, w: string) => Array(n).fill(w).join(" ");
    const [replacement, ...rest] = replacementsBetween(
      `<p>a ${words(600, "x")} b</p>`,
      `<p>a ${words(600, "y")} b</p>`,
    );
    expect(rest).toEqual([]);
    expect(replacement.old_html).toBe(words(600, "x"));
  });

  test("keeps a surrogate pair whole", () => {
    expect(replacementsBetween("<p>😀</p>", "<p>😃</p>")).toEqual([
      { start: 3, end: 7, old_html: "😀", new_html: "😃" },
    ]);
  });
});
