import { describe, expect, test } from "vitest";
import type { Patch } from "../../bridge/source-pieces.ts";
import { parseSource } from "./source-edits";
import { patchBetween, patchRun, type Code } from "./source-patch";

// patch gives the patches from source to target. It also makes sure that
// the patches make the target: each run of the loaded source that a patch
// names, replaced with the html of the patch.
async function patch(source: string, target: string): Promise<(Patch | Code)[]> {
  const tree = await parseSource(source);
  const result = patchBetween(tree, target);
  if ("reload" in result) throw new Error(`reload: ${result.reload}`);
  const patches = [...result.patches, ...result.codes];
  const runs = patches
    .map((p) => ({ run: patchRun(tree, p), html: p.html }))
    .sort((a, b) => b.run[0] - a.run[0]);
  let html = source;
  for (const { run, html: next } of runs)
    html = html.slice(0, run[0]) + next + html.slice(run[1]);
  expect(html).toBe(target);
  return patches;
}

async function reload(source: string, target: string) {
  const result = patchBetween(await parseSource(source), target);
  return "reload" in result ? result.reload : result.patches;
}

const page = (body: string, head = "<title>T</title>") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
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

  test("patches the start tag of an element whose attribute changed", async () => {
    const body = `<p>one</p><p class="a">two</p><p>three</p>`;
    expect(
      await patch(page(body), page(body.replace(`class="a"`, `class="b"`))),
    ).toEqual([{ tag: at(body, "<p class"), html: `<p class="b">` }]);
    expect(
      await patch(
        page(body),
        page(body.replace(`class="a"`, `class="a" style="color: red"`)),
      ),
    ).toEqual([
      { tag: at(body, "<p class"), html: `<p class="a" style="color: red">` },
    ]);
    expect(await patch(page(body), page(body.replace(` class="a"`, "")))).toEqual([
      { tag: at(body, "<p class"), html: "<p>" },
    ]);
  });

  test("puts an element whose tag name changed in the run of its parent", async () => {
    const body = `<p>one</p><p class="a">two</p><p>three</p>`;
    expect(
      await patch(
        page(body),
        page(body.replace(`<p class="a">two</p>`, `<h2 class="a">two</h2>`)),
      ),
    ).toEqual([
      {
        in: at(body, "<body>"),
        after: at(body, "<p>one"),
        before: at(body, "<p>three"),
        html: `<h2 class="a">two</h2>`,
      },
    ]);
  });

  test("patches the start tag and the text of one element apart", async () => {
    const body = `<p>zero</p><div class="a"><p>one</p></div>`;
    expect(
      await patch(page(body), page(`<p>zero</p><div class="b"><p>one!</p></div>`)),
    ).toEqual([
      { in: at(body, "<p>one"), after: null, before: null, html: "one!" },
      { tag: at(body, "<div"), html: `<div class="b">` },
    ]);
  });

  test("leaves the start tag of an element in a run to the run", async () => {
    const body = `<p>zero</p><div><p class="a">one</p></div>`;
    const next = `<p>zero</p><section><div><p class="b">one</p></div></section>`;
    expect(await patch(page(body), page(next))).toEqual([
      {
        in: at(body, "<body>"),
        after: at(body, "<p>zero"),
        before: null,
        html: `<section><div><p class="b">one</p></div></section>`,
      },
    ]);
  });

  test("patches the text of a style in the head or the body", async () => {
    const head = "<title>T</title><style>p { color: red }</style>";
    const source = page("<p>a</p>", head);
    expect(await patch(source, source.replace("red", "blue"))).toEqual([
      { style: source.indexOf("<style>"), html: "p { color: blue }" },
    ]);
    const body = "<style></style><p>a</p>";
    expect(
      await patch(page(body), page(body.replace("<style>", "<style>p { margin: 0 }"))),
    ).toEqual([{ style: at(body, "<style>"), html: "p { margin: 0 }" }]);
  });

  test("gives the code of each script that changed, in the head or the body", async () => {
    const head = `<title>T</title><script>const title = "One";</script>`;
    const source = page(`<p>a</p><script>go("Two"); go("Three")</script>`, head);
    const target = source.replace("One", "Uno").replace("Three", "Tres");
    expect(await patch(source, target)).toEqual([
      { script: source.indexOf("<script>"), html: `const title = "Uno";` },
      { script: source.lastIndexOf("<script>"), html: `go("Two"); go("Tres")` },
    ]);
  });

  test("brings back what the frame shows and the target does not", async () => {
    const body = `<style>p { color: red }</style><p class="a">one two</p><p>three</p><script>go("x")</script>`;
    const tree = await parseSource(page(body));
    const shows = page(
      body
        .replace(`"a"`, `"b"`)
        .replace("red", "blue")
        .replace("one two", "one new two")
        .replace("<p>three</p>", "<p>three</p><p>four</p>")
        .replace(`"x"`, `"y"`),
    );
    expect(patchBetween(tree, page(body), [], shows)).toEqual({
      patches: [
        { in: at(body, "<p class"), after: null, before: null, html: "one two" },
        {
          in: at(body, "<body>"),
          after: at(body, "<p>three"),
          before: at(body, "<script>"),
          html: "",
        },
        { style: at(body, "<style>"), html: "p { color: red }" },
        { tag: at(body, "<p class"), html: `<p class="a">` },
      ],
      codes: [{ script: at(body, "<script>"), html: `go("x")` }],
      tags: [],
    });
    // A change of the target in the same place is the patch.
    expect(
      patchBetween(tree, page(body.replace(`"a"`, `"c"`)), [], shows),
    ).toMatchObject({
      patches: [{}, {}, { style: at(body, "<style>") }, { html: `<p class="c">` }],
    });
    // The frame shows the loaded source: nothing comes back.
    expect(patchBetween(tree, page(body))).toEqual({
      patches: [],
      codes: [],
      tags: [],
    });
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

  test("gives the start tags of the elements that the patches put in, as the target has them", async () => {
    const body = "<h1>T</h1><p>one</p><p>two</p>";
    const tree = await parseSource(page(body));
    const target = page(`<h1>T</h1><p id="c" class='x'>t<b>wo</b></p>`);
    expect(patchBetween(tree, target)).toMatchObject({
      tags: [`<p id="c" class='x'>`, "<b>"],
    });
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

  test("gives each patch the ranges of its html that other people put in", async () => {
    const body = "<p>one</p><p>two</p><p>three</p>";
    const target = page("<p>one!</p><p>two</p><p>three more</p>");
    const range = (text: string): [number, number] => [
      target.indexOf(text),
      target.indexOf(text) + text.length,
    ];
    const tree = await parseSource(page(body));
    // A range that crosses the edge of a run names no place in one patch.
    const marks = [range("e!"), range("ee more</p>"), range(" more")];
    expect(patchBetween(tree, target, marks)).toEqual({
      patches: [
        {
          in: at(body, "<p>one"),
          after: null,
          before: null,
          html: "one!",
          marks: [[2, 4]],
        },
        {
          in: at(body, "<p>three"),
          after: null,
          before: null,
          html: "three more",
          marks: [[5, 10]],
        },
      ],
      codes: [],
      tags: [],
    });
    // A patch with no range has no marks.
    expect(patchBetween(tree, target, [range("e!")])).toMatchObject({
      patches: [
        { marks: [[2, 4]] },
        expect.not.objectContaining({ marks: expect.anything() }),
      ],
    });
  });

  test("leaves out a patch in an element that an outer patch replaces", async () => {
    const body = `<p>zero</p><div><p>one</p></div>`;
    expect(
      await patch(
        page(body),
        page(`<p>zero</p><section><div><p>one!</p></div></section>`),
      ),
    ).toEqual([
      {
        in: at(body, "<body>"),
        after: at(body, "<p>zero"),
        before: null,
        html: `<section><div><p>one!</p></div></section>`,
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
      "a script in a template",
      page("<template><script>let a = 'x';</script></template>"),
      page("<template><script>let a = 'y';</script></template>"),
      "a change is in <template>",
    ],
    [
      "a new attribute of a script",
      page("<p>a</p><script>let a = 1;</script>"),
      page(`<p>a</p><script type="module">let a = 1;</script>`),
      "a change has <script> in it",
    ],
    [
      "a style in an svg",
      page("<svg><style>a { fill: red }</style></svg>"),
      page("<svg><style>a { fill: blue }</style></svg>"),
      "a change is in <style>",
    ],
    [
      "a new attribute of a style",
      page("<style>p { color: red }</style><p>a</p>"),
      page(`<style media="print">p { color: red }</style><p>a</p>`),
      "a change has <style> in it",
    ],
    [
      "a new event handler on an element",
      page(`<p>a</p><p class="x">b</p>`),
      page(`<p>a</p><p class="x" onclick="x()">b</p>`),
      "a change has an event handler or a script URL in it",
    ],
    [
      "a removed event handler",
      page(`<p>a</p><p onclick="x()">b</p>`),
      page(`<p>a</p><p>b</p>`),
      "a change has an event handler or a script URL in it",
    ],
    [
      "a script URL on an element",
      page(`<p><a href="https://x.dev">a</a></p>`),
      page(`<p><a href=" java\tscript:alert(1)">a</a></p>`),
      "a change has an event handler or a script URL in it",
    ],
    [
      "a new link with a script URL",
      page("<p>a</p>"),
      page(`<p>a <a href="JavaScript:alert(1)">b</a></p>`),
      "a change has an event handler or a script URL in it",
    ],
    [
      "a new tag name",
      page(`<p>a</p><p class="x">b</p>`),
      page(`<p>a</p><h2 onclick="x()">b</h2>`),
      "a change has an event handler or a script URL in it",
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
      "a change has an event handler or a script URL in it",
    ],
    [
      "an event handler on the element that changed",
      page(`<div><p>a</p></div>`),
      page(`<div><p onmouseover="x()">a</p></div>`),
      "a change has an event handler or a script URL in it",
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
      "a new noscript, whose content the frame parses as elements",
      page("<p>a</p>"),
      page(`<p>a</p><noscript><img src=x onerror="x()"></noscript>`),
      "a change has <noscript> in it",
    ],
    [
      "text in a noscript",
      page("<p>a</p><noscript>one</noscript>"),
      page(`<p>a</p><noscript>one<img src=x onerror="x()"></noscript>`),
      "a change is in <noscript>",
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
