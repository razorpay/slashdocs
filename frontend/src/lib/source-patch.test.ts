import { describe, expect, test } from "vitest";
import type { Patch } from "../../bridge/source-pieces.ts";
import { parseSource } from "./source-edits";
import { patchBetween, patchRun } from "./source-patch";

// patch gives the patches from source to target. It also makes sure that
// the patches make the target: each run of the loaded source that a patch
// names, replaced with the html of the patch.
async function patch(source: string, target: string): Promise<Patch[]> {
  const tree = await parseSource(source);
  const result = patchBetween(tree, target);
  if ("reload" in result) throw new Error(`reload: ${result.reload}`);
  const runs = result.patches
    .map((p) => ({ run: patchRun(tree, p), html: p.html }))
    .sort((a, b) => b.run[0] - a.run[0]);
  let html = source;
  for (const { run, html: next } of runs)
    html = html.slice(0, run[0]) + next + html.slice(run[1]);
  expect(html).toBe(target);
  return result.patches;
}

async function reload(source: string, target: string) {
  const result = patchBetween(await parseSource(source), target);
  return "reload" in result ? result.reload : result.patches;
}

const page = (body: string) =>
  `<!doctype html><html><head><title>T</title></head><body>${body}</body></html>`;
// The offset of the first place of text in the page.
const at = (body: string, text: string) => page(body).indexOf(text);

describe("patchBetween", () => {
  test("gives no patch for the same source", async () => {
    expect(await patch(page("<p>a</p>"), page("<p>a</p>"))).toEqual([]);
  });

  test("patches text that someone typed in a paragraph", async () => {
    const body = "<h1>Title</h1><p>Hello world</p><p>Bye</p>";
    expect(await patch(page(body), page(body.replace("Hello", "Hello brave")))).toEqual(
      [
        {
          in: at(body, "<p>Hello"),
          after: null,
          before: null,
          html: "Hello brave world",
        },
      ],
    );
  });

  test("patches the innermost element that holds the text", async () => {
    const body = "<p>A <strong>bold</strong> word</p>";
    expect(await patch(page(body), page(body.replace("bold", "very bold")))).toEqual([
      { in: at(body, "<strong>"), after: null, before: null, html: "very bold" },
    ]);
  });

  test("keeps the child elements around the text that changed", async () => {
    const body = "<p>one <b>two</b> three <i>four</i> five</p>";
    expect(await patch(page(body), page(body.replace("three", "3")))).toEqual([
      {
        in: at(body, "<p>"),
        after: at(body, "<b>"),
        before: at(body, "<i>"),
        html: " 3 ",
      },
    ]);
  });

  test("puts text at the edge of a child element outside that element", async () => {
    const body = "<p>one <b>two</b></p>";
    expect(await patch(page(body), page("<p>one <b>two</b>!</p>"))).toEqual([
      { in: at(body, "<p>"), after: at(body, "<b>"), before: null, html: "!" },
    ]);
    expect(await patch(page(body), page("<p>one <b>two!</b></p>"))).toEqual([
      { in: at(body, "<b>"), after: null, before: null, html: "two!" },
    ]);
  });

  test("puts a new paragraph between the two around it", async () => {
    const body = "<div><p>one</p>\n<p>two</p></div>";
    const next = "<div><p>one</p>\n<p>new</p>\n<p>two</p></div>";
    expect(await patch(page(body), page(next))).toEqual([
      {
        in: at(body, "<div>"),
        after: at(body, "<p>one"),
        before: at(body, "<p>two"),
        html: "\n<p>new</p>\n",
      },
    ]);
  });

  test("puts a new paragraph after the last one", async () => {
    const body = "<div><p>one</p></div>";
    expect(await patch(page(body), page("<div><p>one</p><p>two</p></div>"))).toEqual([
      {
        in: at(body, "<div>"),
        after: at(body, "<p>one"),
        before: null,
        html: "<p>two</p>",
      },
    ]);
  });

  test("removes a paragraph", async () => {
    const body = "<p>one</p>\n<p>two</p>\n<p>three</p>";
    expect(await patch(page(body), page("<p>one</p>\n<p>three</p>"))).toEqual([
      {
        in: at(body, "<body>"),
        after: at(body, "<p>one"),
        before: at(body, "<p>three"),
        html: "\n",
      },
    ]);
  });

  test("puts an element whose attribute changed in the run of its parent", async () => {
    const body = `<p>one</p><p class="a">two</p><p>three</p>`;
    expect(
      await patch(page(body), page(body.replace(`class="a"`, `class="b"`))),
    ).toEqual([
      {
        in: at(body, "<body>"),
        after: at(body, "<p>one"),
        before: at(body, "<p>three"),
        html: `<p class="b">two</p>`,
      },
    ]);
  });

  test("puts a paragraph that Enter divided in the run of its parent", async () => {
    const body = "<p>one</p><p>two halves</p><p>three</p>";
    expect(
      await patch(page(body), page(body.replace("two halves", "two</p><p>halves"))),
    ).toEqual([
      {
        in: at(body, "<body>"),
        after: at(body, "<p>one"),
        before: at(body, "<p>three"),
        html: "<p>two</p><p>halves</p>",
      },
    ]);
  });

  test("gives one patch for each paragraph that changed", async () => {
    const body = "<p>one</p><p>two</p><p>three</p>";
    expect(await patch(page(body), page("<p>one!</p><p>two</p><p>three!</p>"))).toEqual(
      [
        { in: at(body, "<p>one"), after: null, before: null, html: "one!" },
        { in: at(body, "<p>three"), after: null, before: null, html: "three!" },
      ],
    );
  });

  test("gives one patch for two changes in one paragraph", async () => {
    const body = "<p>one two three four five</p>";
    expect(await patch(page(body), page("<p>ONE two three four FIVE</p>"))).toEqual([
      {
        in: at(body, "<p>"),
        after: null,
        before: null,
        html: "ONE two three four FIVE",
      },
    ]);
  });

  test("leaves out a patch in an element that an outer patch replaces", async () => {
    const body = `<p>zero</p><div class="a"><p>one</p></div>`;
    expect(
      await patch(page(body), page(`<p>zero</p><div class="b"><p>one!</p></div>`)),
    ).toEqual([
      {
        in: at(body, "<body>"),
        after: at(body, "<p>zero"),
        before: null,
        html: `<div class="b"><p>one!</p></div>`,
      },
    ]);
  });

  test("counts the rows of a table with an implied tbody as its children", async () => {
    const body = "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>";
    expect(await patch(page(body), page(body.replace(">b<", ">bee<")))).toEqual([
      { in: at(body, "<td>b"), after: null, before: null, html: "bee" },
    ]);
    const row = "<tr><td>new</td></tr>";
    expect(
      await patch(page(body), page(body.replace("<tr><td>c", `${row}<tr><td>c`))),
    ).toEqual([
      {
        in: at(body, "<table>"),
        after: at(body, "<tr><td>a"),
        before: at(body, "<tr><td>c"),
        html: row,
      },
    ]);
  });

  test("names a body with no start tag as null", async () => {
    const source = "<h1>Title</h1>\n<p>one</p>\n";
    expect(await patch(source, "<h1>Title</h1>\n<p>one</p>\n<p>two</p>\n")).toEqual([
      { in: null, after: source.indexOf("<p>"), before: null, html: "\n<p>two</p>\n" },
    ]);
    expect(await patch(source, source.replace("one", "one!"))).toEqual([
      { in: source.indexOf("<p>"), after: null, before: null, html: "one!" },
    ]);
    expect(await patch(source, "<p>zero</p>" + source)).toEqual([
      { in: null, after: null, before: 0, html: "<p>zero</p>" },
    ]);
  });

  test("counts offsets as the frame does when multi-byte text comes first", async () => {
    const body = "<p>héllo 😀 wörld</p><p>ünïcode 🙂 text</p>";
    expect(await patch(page(body), page(body.replace("text", "texts")))).toEqual([
      {
        in: at(body, "<p>ünïcode"),
        after: null,
        before: null,
        html: "ünïcode 🙂 texts",
      },
    ]);
  });

  test("keeps a line break that text comes after", async () => {
    const body = "<p>one<br>two</p>";
    expect(await patch(page(body), page("<p>one<br>new two</p>"))).toEqual([
      { in: at(body, "<p>"), after: at(body, "<br>"), before: null, html: "new two" },
    ]);
  });

  test("takes an element with no end tag into the run of its parent", async () => {
    const body = "<div><p>one<p>two</div>";
    expect(await patch(page(body), page("<div><p>one<p>two!</div>"))).toEqual([
      { in: at(body, "<div>"), after: null, before: null, html: "<p>one<p>two!" },
    ]);
  });

  test("patches text in a form", async () => {
    const body = "<form><p>one</p><input name=a></form>";
    expect(await patch(page(body), page(body.replace("one", "one!")))).toEqual([
      { in: at(body, "<p>"), after: null, before: null, html: "one!" },
    ]);
  });

  test.each([
    [
      "the title",
      page("<p>a</p>"),
      page("<p>a</p>").replace("T", "New"),
      "outside the body",
    ],
    [
      "the doctype",
      page("<p>a</p>"),
      page("<p>a</p>").replace("<!doctype html>", ""),
      "outside the body",
    ],
    [
      "an attribute of the body",
      page("<p>a</p>"),
      page("<p>a</p>").replace("<body>", `<body class="x">`),
      "outside the body",
    ],
    [
      "text after the body",
      page("<p>a</p>"),
      page("<p>a</p>") + "<!-- end -->",
      "outside the body",
    ],
    [
      "a script",
      page("<p>a</p><script>let a = 1;</script>"),
      page("<p>a</p><script>let a = 2;</script>"),
      "a change is in <script>",
    ],
    [
      "a style",
      page("<style>p { color: red }</style><p>a</p>"),
      page("<style>p { color: blue }</style><p>a</p>"),
      "a change is in <style>",
    ],
    [
      "a textarea",
      page("<p>a</p><textarea>one</textarea>"),
      page("<p>a</p><textarea>two</textarea>"),
      "a change is in <textarea>",
    ],
    [
      "text in an svg",
      page("<svg><text>one</text></svg>"),
      page("<svg><text>two</text></svg>"),
      "a change is in <svg>",
    ],
    [
      "a new script",
      page("<p>a</p>"),
      page("<p>a</p><script>alert(1)</script>"),
      "a change has <script> in it",
    ],
    [
      "a removed iframe",
      page(`<p>a</p><iframe src="x"></iframe><p>b</p>`),
      page("<p>a</p><p>b</p>"),
      "a change has <iframe> in it",
    ],
    [
      "a new event handler",
      page("<p>a</p>"),
      page(`<p>a</p><p onclick="x()">b</p>`),
      "a change has an event handler in it",
    ],
    [
      "an event handler on the element that changed",
      page(`<div><p>a</p></div>`),
      page(`<div><p onmouseover="x()">a</p></div>`),
      "a change has an event handler in it",
    ],
    [
      "an input next to the text that changed",
      page("<p>one <input name=a> two</p><p>b</p>"),
      page("<p>one <input name=b> two</p><p>b</p>"),
      "a change has <input> in it",
    ],
    [
      "a new select",
      page("<div><p>a</p></div>"),
      page("<div><p>a</p><select><option>x</select></div>"),
      "a change has <select> in it",
    ],
    [
      "a tag that closes too late",
      page("<h2>lead <i>two three</i></h2>"),
      page("<h2>lead <i>two</p><p>three</i></h2>"),
      "a change has markup that the parser moves in it",
    ],
    [
      "a body with no end tag",
      "<html><body><p>a</p>",
      "<html><body><p>ab</p>",
      "outside the body",
    ],
    [
      "a frameset",
      "<frameset><frame src=a></frameset>",
      "<frameset><frame src=b></frameset>",
      "the document has no body",
    ],
  ])("asks for a load for %s", async (_, source, target, reason) => {
    expect(await reload(source, target)).toContain(reason);
  });

  test("does not take text that looks like a tag for active content", async () => {
    const body = "<p>Use &lt;script&gt; with care</p>";
    expect(await patch(page(body), page(body.replace("care", "great care")))).toEqual([
      {
        in: at(body, "<p>"),
        after: null,
        before: null,
        html: "Use &lt;script&gt; with great care",
      },
    ]);
  });
});
