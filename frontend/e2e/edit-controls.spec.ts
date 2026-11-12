import { type Locator, type Page } from "@playwright/test";
import {
  expect,
  openEditable,
  renderedDocument,
  startEditing,
  test,
  uniqueName,
} from "./fixtures";

// The controls at the text that the reader edits: the selection actions, the
// link field and the note of a script string. They cover no text where they
// find room, with room to spare around them. Where they find none, the
// selection actions dock at an edge of the viewport, and the link field and
// the script note stay next to their words and cover none of them.

// Rows of text 40px apart, which leave no room above or below a line for a
// control. A script writes the labels and the count of open rows.
function rowsHTML(tail = "") {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Review board</title>
  <style>.row{margin:0;padding:10px 0;line-height:20px}</style></head>
  <body>
    <h1>Review board</h1>
    <p>Each row shows the state of one review, and the script on the page writes the labels.</p>
    <p class="row"><b class="chip"></b> Payments API${tail}</p>
    <p class="row"><b class="chip"></b> Ledger sync${tail}</p>
    <p class="row">Status: <span id="open"></span>${tail}</p>
    <p class="row"><b class="chip"></b> Refunds${tail}</p>
    <p id="tail">Clients retry twice before giving up, and then Amber marks the row.</p>
    <script>
      const LABEL = "Needs a look";
      const chips = document.querySelectorAll(".chip");
      chips.forEach((chip) => (chip.textContent = LABEL));
      document.getElementById("open").textContent = chips.length + " open";
    </script>
  </body>
</html>`;
}

// A script writes three chips with the same label, one after the other.
function chipsHTML(tail = "") {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Review board</title>
  <style>body{max-width:760px;margin:40px auto;padding:0 16px;font:16px/1.5 sans-serif}.chip{display:inline-block;margin:0 6px 4px 0;padding:2px 6px;border-radius:6px;background:#e0e7ff}</style></head>
  <body>
    <h1>Review board</h1>
    <p id="intro">Plain text with a <a href="https://example.org">guide link</a>. Clients retry twice before giving up.</p>
    <p>Build health: <b>Green</b></p>
    <div id="chips"></div>
    <p>3 open</p>
    ${tail}
    <script>
      const LABEL = "Needs review";
      for (const n of [1, 2, 3]) {
        const chip = document.createElement("b");
        chip.className = "chip";
        chip.textContent = LABEL;
        document.getElementById("chips").appendChild(chip);
      }
    </script>
  </body>
</html>`;
}

// Words with no markup, in one text node.
function plainHTML(title: string) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title>
  <style>body{max-width:760px;margin:40px auto;padding:0 16px;font:16px/1.5 sans-serif}</style></head>
  <body>
    <h1>${title}</h1>
    <p id="intro">Plain text with some words. Clients retry twice before giving up.</p>
    <p>Closing words.</p>
  </body>
</html>`;
}

const SENTENCE = "Clients retry twice before giving up, and the notes say why. ";

// Paragraphs of text from the top to below the bottom of the viewport, with
// no clear room under or over a word.
function denseHTML(title: string) {
  const paragraphs = Array.from(
    { length: 14 },
    (_, i) => `<p id="p${i}">${SENTENCE.repeat(4)}</p>`,
  ).join("");
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title>
    <style>body{max-width:760px;margin:40px auto;padding:0 16px;font:16px/1.5 sans-serif}
    p{margin:8px 0}.badge{padding:1px 6px;border-radius:4px;background:#fef3c7}</style>
  </head>
  <body>
    <h1>${title}</h1>
    <h2 id="steps">Steps</h2>
    <p id="status">Status <span class="badge" id="badge">Pending</span> for review.</p>
    ${paragraphs}
  </body>
</html>`;
}

// selectText selects target in the text of the first element at selector.
async function selectText(page: Page, selector: string, target: string) {
  await renderedDocument(page)
    .locator(selector)
    .first()
    .evaluate((element, target) => {
      const d = element.ownerDocument;
      const walker = d.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const start = (node as Text).data.indexOf(target);
        if (start < 0) continue;
        d.body.focus();
        d.getSelection()!.setBaseAndExtent(node, start, node, start + target.length);
        return;
      }
      throw new Error(`no text ${target}`);
    }, target);
}

// coveredText gives the words of the document within 2px of control.
function coveredText(control: Locator): Promise<string[]> {
  return control.evaluate((el) => {
    const d = el.ownerDocument;
    const box = el.getBoundingClientRect();
    const words = d.createRange();
    const covered: string[] = [];
    const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (el.contains(node) || !node.textContent!.trim()) continue;
      words.selectNodeContents(node);
      for (const line of words.getClientRects())
        if (
          line.width &&
          line.left < box.right + 2 &&
          box.left - 2 < line.right &&
          line.top < box.bottom + 2 &&
          box.top - 2 < line.bottom
        )
          covered.push(node.textContent!.trim());
    }
    return covered;
  });
}

for (const [width, height] of [
  [1280, 800],
  [390, 844],
]) {
  test.describe(`at ${width}x${height}`, () => {
    test.use({ viewport: { width, height } });

    test("the script note covers none of its text between rows 40px apart", async ({
      page,
      slashdocs,
    }) => {
      // At 390px, long rows leave no room beside the text either.
      const html = rowsHTML(width < 400 ? ", owned by the platform team" : "");
      const document = await slashdocs.createDocument(uniqueName("Rows"), html);

      await openEditable(page, document.id);
      await renderedDocument(page).locator("#open").click();
      const hint = renderedDocument(page).locator(".slashdocs-script-hint");
      await expect(hint).toContainText("A script on the page writes this text.");
      expect(await coveredText(hint)).not.toContain("3 open");
    });

    test("the selection actions sit next to the selection, cover none of it, and keep one row", async ({
      page,
      slashdocs,
    }) => {
      const row = "Each row of the board shows the state of one review. ";
      const prose = `<p id="prose">${row.repeat(6)}This is the middle word. ${row.repeat(6)}</p>`;
      const document = await slashdocs.createDocument(
        uniqueName("Rows"),
        rowsHTML() + prose,
      );

      await openEditable(page, document.id);
      for (const [selector, word] of [
        ["#tail", "twice"],
        [".row", "Payments"],
        // A word in the middle of a paragraph has text above, below and
        // after it, and the actions still sit next to it.
        ["#prose", "middle"],
      ]) {
        await selectText(page, selector, word);
        const actions = renderedDocument(page).locator(".slashdocs-selection-action");
        await expect(actions.getByRole("button", { name: "Bold" })).toBeVisible();
        // The space between the actions and the selection. The actions move
        // after the selection changes.
        const apart = () =>
          actions.evaluate((el) => {
            const box = el.getBoundingClientRect();
            const selected = el.ownerDocument
              .getSelection()!
              .getRangeAt(0)
              .getBoundingClientRect();
            return Math.max(selected.top - box.bottom, box.top - selected.bottom);
          });
        await expect.poll(apart).toBeLessThanOrEqual(12);
        expect(await apart()).toBeGreaterThanOrEqual(0);
        const comment = actions.getByRole("button", {
          name: "Comment on selected text",
        });
        expect((await actions.boundingBox())!.height).toBeLessThan(
          (await comment.boundingBox())!.height * 1.5,
        );
      }
    });

    test("the link field covers none of its words after its note grows a line", async ({
      page,
      slashdocs,
    }) => {
      const document = await slashdocs.createDocument(uniqueName("Rows"), rowsHTML());

      await openEditable(page, document.id);
      await selectText(page, ".row", "Payments");
      await page.keyboard.press("ControlOrMeta+k");
      const field = renderedDocument(page).getByRole("textbox", {
        name: "Link address",
      });
      await field.fill(`example.com/${"a-long-path/".repeat(8)}`);
      const card = renderedDocument(page).locator(".slashdocs-link-input > div");
      await expect(card).toContainText("Links to https://example.com/");
      await expect
        .poll(() => coveredText(card))
        .not.toContainEqual(expect.stringContaining("Payments"));
    });
  });
}

test("the link field refuses an address with a space, and puts the caret after a link", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Rows"), rowsHTML());

  await openEditable(page, document.id);
  await selectText(page, "#tail", "twice");
  await page.keyboard.press("ControlOrMeta+k");
  const field = renderedDocument(page).getByRole("textbox", { name: "Link address" });
  await field.fill("exa mple");
  await field.press("Enter");
  await expect(renderedDocument(page).getByText("This is not a link.")).toBeVisible();
  await expect(field).toBeFocused();

  await field.fill("example.com");
  await field.press("Enter");
  await expect(field).toHaveCount(0);
  await expect(
    renderedDocument(page).locator(".slashdocs-selection-action"),
  ).toHaveCount(0);
  await page.keyboard.type("!");
  await expect(renderedDocument(page).locator("#tail")).toContainText(
    "retry twice! before",
  );
  await expect(renderedDocument(page).locator("#tail a")).toHaveText("twice");
});

test("the copy link action has an icon of its own", async ({ page, slashdocs }) => {
  const document = await slashdocs.createDocument(uniqueName("Rows"), rowsHTML());

  await openEditable(page, document.id);
  await selectText(page, "#tail", "twice");
  const actions = renderedDocument(page).locator(".slashdocs-selection-action");
  const icon = (name: string) =>
    actions
      .getByRole("button", { name, exact: true })
      .locator("path")
      .getAttribute("d");
  expect(await icon("Copy link to selected text")).not.toBe(await icon("Link"));
});

test.describe("on a touch screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the selection actions hide the key chip", async ({ page, slashdocs }) => {
    const document = await slashdocs.createDocument(uniqueName("Rows"), rowsHTML());

    await openEditable(page, document.id);
    await expect(renderedDocument(page).locator("html")).toHaveAttribute(
      "data-slashdocs-pointer",
      "coarse",
    );
    await selectText(page, "#tail", "twice");
    const actions = renderedDocument(page).locator(".slashdocs-selection-action");
    await expect(actions.getByRole("button", { name: "Bold" })).toBeVisible();
    await expect(actions.locator("kbd")).toBeHidden();
  });
});

const NOTE = "This text shows in 3 places. Your change goes to all of them.";

test.describe("at 1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the selection actions name Comment and its key when they fit", async ({
    page,
    slashdocs,
  }) => {
    const document = await slashdocs.createDocument(uniqueName("Fit"), chipsHTML());

    await openEditable(page, document.id);
    await selectText(page, "#intro", "twice");
    const comment = renderedDocument(page).getByRole("button", {
      name: "Comment on selected text",
    });
    await expect(comment.getByText("Comment", { exact: true })).toBeVisible();
    await expect(comment.locator("kbd")).toBeVisible();
  });

  test("the note of a string in several places is as wide as its lines, and shows on each entry", async ({
    page,
    slashdocs,
  }) => {
    const document = await slashdocs.createDocument(uniqueName("Note"), chipsHTML());

    await openEditable(page, document.id);
    const chips = renderedDocument(page).locator("#chips b");
    await chips.nth(1).click();
    const note = renderedDocument(page).getByRole("note");
    await expect(note).toHaveText(NOTE);
    const room = await note.locator("span").evaluate((text) => {
      const range = text.ownerDocument.createRange();
      range.selectNodeContents(text);
      const widest = Math.max(...[...range.getClientRects()].map((l) => l.width));
      return text.getBoundingClientRect().width - widest;
    });
    expect(room).toBeLessThan(2);

    // The key goes to every place.
    await page.keyboard.type("s");
    await expect(chips).toHaveText(["Needs reviews", "Needs reviews", "Needs reviews"]);
    // Esc leaves Edit mode. Each entry in Edit mode says again where they go.
    await page.keyboard.press("Escape");
    await expect(note).toHaveCount(0);
    await startEditing(page);
    await chips.nth(0).click();
    await expect(note).toHaveText(NOTE);
  });

  test("the link field keeps clear of its words when its note grows a line", async ({
    page,
    slashdocs,
  }) => {
    const document = await slashdocs.createDocument(uniqueName("Link"), chipsHTML());

    await openEditable(page, document.id);
    await selectText(page, "#intro", "twice");
    await page.keyboard.press("ControlOrMeta+k");
    const field = renderedDocument(page).getByRole("textbox", { name: "Link address" });
    const card = renderedDocument(page).locator(".slashdocs-link-input > div");
    for (const address of ["example.com", "This is not a link."]) {
      await field.fill(address);
      if (address.includes(" ")) await field.press("Enter");
      await expect(card.locator("p")).not.toBeEmpty();
      await expect
        .poll(() => coveredText(card))
        .not.toContainEqual(expect.stringContaining("twice"));
    }
  });

  // The link field opens at its words, also where text is all around them,
  // and its note grows with no move of the field.
  test("the link field opens next to its words in a dense paragraph", async ({
    page,
    slashdocs,
  }) => {
    const title = uniqueName("Link place");
    const document = await slashdocs.createDocument(title, denseHTML(title));
    await page.goto(`/app/d/${document.id}`);
    const doc = renderedDocument(page);
    await startEditing(page);
    const card = doc.locator(".slashdocs-link-input > div");
    const field = doc.getByRole("textbox", { name: "Link address" });
    // The card holds its top, or its bottom when it grows up.
    const rect = () =>
      card.evaluate((el) => {
        const { left, right, top, bottom, width } = el.getBoundingClientRect();
        const edge = el.style.top === "auto" ? bottom : top;
        return { left, right, top, bottom, width, edge };
      });

    // The heading, then the first "twice" past a share of the viewport:
    // words high and low in the page, and words near its bottom.
    for (const at of ["steps", 0.2, 0.5, 0.85, 0.88, 0.91, 0.94]) {
      const word = await doc.locator("body").evaluate((body, at) => {
        const d = body.ownerDocument;
        const range = d.createRange();
        const select = (text: Text, start: number, length: number) => {
          range.setStart(text, start);
          range.setEnd(text, start + length);
        };
        // The heading's link sits before or after its words.
        const steps = [...d.getElementById("steps")!.childNodes].find(
          (node) => node.nodeType === Node.TEXT_NODE,
        ) as Text;
        if (at === "steps") select(steps, 0, 5);
        else {
          const texts = [...d.querySelectorAll("p[id^=p]")].map(
            (p) => p.firstChild as Text,
          );
          found: for (const text of texts)
            for (let i = 0; (i = text.data.indexOf("twice", i + 1)) > 0;) {
              select(text, i, 5);
              if (range.getBoundingClientRect().top > innerHeight * Number(at))
                break found;
            }
        }
        body.focus();
        d.getSelection()!.removeAllRanges();
        d.getSelection()!.addRange(range);
        const { left, right, top, bottom } = range.getBoundingClientRect();
        return { left, right, top, bottom };
      }, at);
      await page.keyboard.press("ControlOrMeta+k");
      await expect(field).toBeFocused();
      // The card waits out its entrance before it is measured.
      await page.waitForTimeout(300);
      const box = await rect();
      // Below, above or beside the word, and clear of it.
      const gaps = [
        Math.max(box.left - word.right, word.left - box.right),
        Math.max(box.top - word.bottom, word.top - box.bottom),
      ];
      expect(
        Math.max(...gaps),
        `the field is clear of the word (${at})`,
      ).toBeGreaterThan(0);
      expect(gaps[1], `the field is next to the word (${at})`).toBeLessThan(60);

      // The note grows away from the words, in the viewport, and the field
      // stays still.
      await field.fill("exa mple");
      await field.press("Enter");
      await expect(card.locator("p")).toHaveText("This is not a link.");
      const noted = await rect();
      expect([noted.left, noted.width, noted.edge]).toEqual([
        box.left,
        box.width,
        box.edge,
      ]);
      expect(noted.bottom, `the note is in the viewport (${at})`).toBeLessThanOrEqual(
        await card.evaluate((el) => el.ownerDocument.documentElement.clientHeight),
      );
      await field.press("Escape");
      await expect(card).toHaveCount(0);
    }
  });
});

// With a finger, the system menu sits by the selection, so the actions keep
// clear of text and dock when no place is clear.
test.describe("at 390x844 with touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("with no clear place near the selection, the actions dock as a bar that covers no text", async ({
    page,
    slashdocs,
  }) => {
    const document = await slashdocs.createDocument(uniqueName("Dock"), chipsHTML());

    await openEditable(page, document.id);
    await selectText(page, "#intro", "giving");
    const actions = renderedDocument(page).locator(".slashdocs-selection-action");
    await expect(actions).toHaveAttribute("data-docked", "bottom");
    expect(await coveredText(actions)).toEqual([]);
    const [box, view] = await actions.evaluate((el) => {
      const root = el.ownerDocument.documentElement;
      return [
        el.getBoundingClientRect().toJSON(),
        [root.clientWidth, root.clientHeight],
      ];
    });
    expect(box.left).toBe(0);
    expect(box.width).toBe(view[0]);
    expect(box.bottom).toBeLessThanOrEqual(view[1]);
  });

  test("a docked bar stays on scroll, and the end of the document scrolls out from under it", async ({
    page,
    slashdocs,
  }) => {
    const long = `<p>${"Each row of the board shows the state of one review. ".repeat(40)}</p><p id="end">The last words.</p>`;
    const document = await slashdocs.createDocument(
      uniqueName("Dock"),
      chipsHTML(long),
    );

    await openEditable(page, document.id);
    await selectText(page, "#intro", "giving");
    const actions = renderedDocument(page).locator(".slashdocs-selection-action");
    await expect(actions).toHaveAttribute("data-docked", "bottom");
    await actions.evaluate((el) => el.ownerDocument.defaultView!.scrollTo(0, 1e6));
    await expect(actions).toBeVisible();
    expect(await coveredText(actions)).toEqual([]);
  });
});

test("the link field keeps its place and its width while the reader types", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Link");
  const document = await slashdocs.createDocument(title, plainHTML(title));
  await openEditable(page, document.id);
  const doc = renderedDocument(page);
  await selectText(page, "#intro", "twice");
  await page.keyboard.press("ControlOrMeta+k");
  const field = doc.getByRole("textbox", { name: "Link address" });
  const card = doc.locator(".slashdocs-link-input > div");
  await expect(field).toBeFocused();
  // The card waits out its entrance before it is measured.
  await page.waitForTimeout(300);
  // Below the words it keeps its top, and above them its bottom.
  const words = (await doc.locator("#intro").boundingBox())!;
  const place = async () => {
    const { x, y, width, height } = (await card.boundingBox())!;
    return { x, width, edge: y >= words.y ? y : y + height };
  };
  const opened = await place();

  // A refused address, then a long one with a preview of two lines.
  await field.fill("exa mple");
  await field.press("Enter");
  await expect(card.locator("p")).toHaveText("This is not a link.");
  expect(await place()).toEqual(opened);
  await field.fill(`example.com/${"a-long-path/".repeat(8)}`);
  await expect(card.locator("p")).toContainText("Links to https://example.com/");
  expect(await place()).toEqual(opened);
});

// The bridge's controls in the document are not its text: Cmd+A does not
// select the actions at the selection.
test("select all leaves the selection actions out", async ({ page, slashdocs }) => {
  const title = uniqueName("Select all");
  const document = await slashdocs.createDocument(title, denseHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await startEditing(page);
  await doc.locator("#p0").click();
  await page.keyboard.press("ControlOrMeta+a");
  const actions = doc.locator(".slashdocs-selection-action");
  await expect(actions).toBeVisible();
  const selected = await actions.evaluate((el) => ({
    held: el.ownerDocument.getSelection()!.containsNode(el, true),
    styles: [
      ...new Set(
        [el, ...el.querySelectorAll("*")].map(
          (each) => getComputedStyle(each).userSelect,
        ),
      ),
    ],
  }));
  expect(selected).toEqual({ held: false, styles: ["none"] });
});
