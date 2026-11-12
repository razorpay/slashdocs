import { describe, expect, test, vi } from "vitest";
import { SOURCE_ATTR } from "../../bridge/source-pieces";
import { parseSource } from "./source-edits";
import {
  checkCodeChange,
  checkScriptChange,
  findLiterals,
  replaceLiteral,
  stringChange,
  type Render,
} from "./script-literals";

// change finds the one string that holds text, writes next into it, and
// makes sure that the result parses with next in one string.
async function change(source: string, text: string, next: string) {
  const found = await findLiterals(source, text);
  expect(found).toHaveLength(1);
  const changed = replaceLiteral(source, found[0], next);
  expect(await findLiterals(changed, next)).toHaveLength(1);
  return changed;
}

test("finds one string literal and keeps its quotes", async () => {
  const source = `<p id="x"></p><script>x.textContent = 'Save';</script>`;
  const [found] = await findLiterals(source, "  Save\n");
  expect(source.slice(found.start, found.end)).toBe("'Save'");
  expect(replaceLiteral(source, found, "Keep")).toBe(
    `<p id="x"></p><script>x.textContent = 'Keep';</script>`,
  );
});

test("finds each copy of a text, so that the app can refuse two", async () => {
  const source = `<script>a.title = "Try it."; b.title = "Try it.";</script>`;
  expect(await findLiterals(source, "Try it.")).toHaveLength(2);
});

test("a literal that a script uses twice is one candidate", async () => {
  const source = `<script>const label = "Try it."; a.textContent = b.textContent = label;</script>`;
  expect(await findLiterals(source, "Try it.")).toHaveLength(1);
});

test("finds templates without expressions, and not templates with them", async () => {
  expect(await change("<script>x.textContent = `Hello`;</script>", "Hello", "Hi")).toBe(
    "<script>x.textContent = `Hi`;</script>",
  );
  const computed = "<script>x.textContent = `Hello ${name}`;</script>";
  expect(await findLiterals(computed, "Hello")).toEqual([]);
  expect(
    await findLiterals("<script>x.textContent = String.raw`Hello`;</script>", "Hello"),
  ).toEqual([]);
});

test("finds JSON values, and not JSON keys", async () => {
  const source = `<script type="application/json">{"Title": "Title", "list": ["A"]}</script>`;
  const found = await findLiterals(source, "Title");
  expect(found).toHaveLength(1);
  expect(found[0].json).toBe(true);
  expect(replaceLiteral(source, found[0], `Say "hi"\\`)).toBe(
    `<script type="application/json">{"Title": "Say \\"hi\\"\\\\", "list": ["A"]}</script>`,
  );
  expect(
    await findLiterals(`<script type="application/json">{"a": </script>`, "a"),
  ).toEqual([]);
});

test("ignores keys, module names and scripts with src", async () => {
  const source = `<script type="module">import "Save"; const o = { Save: 1, "Save": 2 };</script><script src="x.js">"Save"</script>`;
  expect(await findLiterals(source, "Save")).toEqual([]);
});

test("escapes quotes, backslashes, newlines and the end of the script", async () => {
  const source = `<script>a('Old'); b("Old2"); c(\`Old3\`);</script>`;
  expect(await change(source, "Old", `it's \\ </script>\nnext`)).toBe(
    `<script>a('it\\'s \\\\ <\\/script>\\nnext'); b("Old2"); c(\`Old3\`);</script>`,
  );
  expect(await change(source, "Old2", `say "hi"`)).toContain(`b("say \\"hi\\"")`);
  expect(await change(source, "Old3", "`${x}`")).toContain("c(`\\`\\${x}\\``)");
});

test("keeps the white space at the ends of the old value", async () => {
  const source = `<script>a(" Old ");</script>`;
  expect(await change(source, "Old", "New")).toBe(`<script>a(" New ");</script>`);
});

test("finds strings in a module script, at source offsets", async () => {
  const source = `<!doctype html><title>é</title><script type="module">import x from "./x.js";\r\nexport const label = "Ready 🙂";</script>`;
  const [found] = await findLiterals(source, "Ready 🙂");
  expect(source.slice(found.start, found.end)).toBe(`"Ready 🙂"`);
});

test("finds nothing for computed text or text that is not in a script", async () => {
  const source = `<p>Total</p><script>x.textContent = "Tot" + "al"; y.textContent = 3 + 4;</script>`;
  expect(await findLiterals(source, "Total")).toEqual([]);
  expect(await findLiterals(source, "7")).toEqual([]);
  expect(await findLiterals(source, " ")).toEqual([]);
});

describe("checkScriptChange", () => {
  const source = `<body><p id="a"></p><script>for (const p of document.querySelectorAll("p")) p.textContent = "Try it.";</script><p id="b"></p></body>`;
  const after = source.indexOf(`<p id="b">`);
  const change = {
    locator: { at: 6, path: [] },
    before: "Try it.",
    after: "Run it now.",
  };
  const shown = (html: string) => html.match(/textContent = "([^"]*)"/)![1];

  // A render that stands for the probe frame: the script shows its string
  // in the two paragraphs.
  function render(
    show = shown,
    places = 2,
    more: (html: string) => object = () => ({}),
  ) {
    return vi.fn<Render>(async (html, _locator, strings) => ({
      text: show(html),
      counts: strings.map((s) => (shown(html) === s ? places : 0)),
      texts: 4,
      errors: 0,
      ...more(html),
    }));
  }

  async function check(r: Render, c = change, s = source) {
    return checkScriptChange({ source: s, tree: await parseSource(s) }, c, r);
  }

  test("gives the places that show the new text, with loaded offsets in the probe", async () => {
    const r = render();
    expect(await check(r)).toEqual({ places: 2 });
    const [[was, locator, strings], [now]] = r.mock.calls;
    expect(locator).toEqual(change.locator);
    expect(strings).toEqual(["Try it.", "Run it now."]);
    expect(was).toContain(`<p ${SOURCE_ATTR}="${after}" id="b">`);
    expect(now).toContain(`"Run it now."`);
    expect(now).toContain(`<p ${SOURCE_ATTR}="${after}" id="b">`);
  });

  test("refuses a change that the page does not show where the reader typed it", async () => {
    const refused = {
      refused: "The page does not show the new text where you typed it.",
    };
    expect(await check(render(() => "Try it."))).toEqual(refused);
    // The new text shows in two places, but the old text stays in one.
    const uneven = vi.fn<Render>(async (html) => ({
      text: shown(html),
      counts: shown(html) === "Try it." ? [2, 0] : [1, 2],
      texts: 4,
      errors: 0,
    }));
    expect(await check(uneven)).toEqual(refused);
  });

  test("refuses a change after which a script throws, or other text goes", async () => {
    const stops = { refused: "This change stops a script on the page." };
    const changed = (html: string) => shown(html) !== "Try it.";
    expect(
      await check(render(shown, 2, (html) => ({ errors: changed(html) ? 1 : 0 }))),
    ).toEqual(stops);
    expect(
      await check(render(shown, 2, (html) => ({ texts: changed(html) ? 2 : 4 }))),
    ).toEqual(stops);
  });

  test("refuses text that no one string holds, and empty text", async () => {
    const twice = source.replace('<p id="b"></p>', `<script>x = "Try it.";</script>`);
    expect(await check(render(), change, twice)).toEqual({
      refused: "This text does not come from one string in the script.",
    });
    expect(await check(render(), { ...change, after: " " })).toEqual({
      refused: "Script text cannot be empty.",
    });
  });
});

describe("stringChange", () => {
  test("gives the one string that changed, and not a change of other code", async () => {
    const code = `const t = { label: "Save" }; go('Try it.', \`Done\`);`;
    expect(
      await stringChange(undefined, code, code.replace("Try it.", "Run it")),
    ).toEqual({
      from: "Try it.",
      to: "Run it",
    });
    expect(
      await stringChange("module", code, code.replace("`Done`", "`All done`")),
    ).toEqual({ from: "Done", to: "All done" });
    for (const next of [
      code.replace("Save", "Keep").replace("Done", "Over"),
      code.replace("go(", "stop("),
      code.replace("label", "title"),
      code.replace("'Try it.'", "'Try ' + it"),
      code.replace("'Try it.'", '"Try it."'),
      code.replace("'Try it.'", "' '"),
      code.replace("const", "const const"),
    ])
      expect(await stringChange(undefined, code, next)).toBeNull();
  });

  test("reads a JSON block as JSON", async () => {
    const code = `{"title": "One", "items": ["a", "b"]}`;
    expect(
      await stringChange("application/json", code, code.replace('"b"', '"c"')),
    ).toEqual({ from: "b", to: "c" });
    expect(
      await stringChange("application/json", code, code.replace('"title"', '"name"')),
    ).toBeNull();
  });
});

describe("checkCodeChange", () => {
  const source = `<p id="a"></p><script>a.textContent = "One";</script>`;
  const code = `a.textContent = "One";`;
  const range: [number, number] = [
    source.indexOf(code),
    source.indexOf(code) + code.length,
  ];
  const change = { from: "One", to: "Uno" };
  const shown = (html: string) => html.match(/textContent = "([^"]*)"/)![1];
  const render = (counts = (html: string, s: string) => (shown(html) === s ? 1 : 0)) =>
    vi.fn<Render>(async (html, _locator, strings) => ({
      text: null,
      counts: strings.map((s) => counts(html, s)),
      texts: 1,
      errors: 0,
    }));

  test("gives the places that show the new string, from the code that the frame shows", async () => {
    const r = render();
    const next = code.replace("One", "Uno");
    expect(await checkCodeChange(source, range, [code, next], change, r)).toEqual({
      places: 1,
    });
    const [[was], [now]] = r.mock.calls;
    expect(shown(was)).toBe("One");
    expect(shown(now)).toBe("Uno");
    // A change after an earlier one starts from the code that the frame
    // shows.
    const again = await checkCodeChange(
      source,
      range,
      [next, code.replace("One", "Eins")],
      { from: "Uno", to: "Eins" },
      render(),
    );
    expect(again).toEqual({ places: 1 });
  });

  test("refuses a string that the page does not show", async () => {
    const next = code.replace("One", "Uno");
    expect(
      await checkCodeChange(
        source,
        range,
        [code, next],
        change,
        render(() => 0),
      ),
    ).toEqual({
      refused: "The page does not show the new text where you typed it.",
    });
  });
});
