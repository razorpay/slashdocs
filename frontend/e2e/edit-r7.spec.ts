import { type FrameLocator, type Locator, type Page } from "@playwright/test";
import { expect, test, uniqueName } from "./fixtures";

// The controls at the text that the reader edits: the selection actions, the
// link field and the note of a script string in several places.

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
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

async function openEditable(page: Page, id: string) {
  await page.goto(`/app/d/${id}`);
  await expect(renderedDocument(page).locator("h1")).toBeVisible();
  await expect(renderedDocument(page).locator("body")).toHaveAttribute(
    "contenteditable",
    "true",
  );
}

// selectText selects target in the text of the element at selector.
async function selectText(page: Page, selector: string, target: string) {
  await renderedDocument(page)
    .locator(selector)
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

    // A save makes every place take keys. Each entry says again where they go.
    await page.keyboard.type("s");
    await expect(chips).toHaveText(["Needs reviews", "Needs reviews", "Needs reviews"]);
    await page.keyboard.press("Escape");
    await expect(note).toHaveCount(0);
    await chips.nth(0).click();
    await expect(note).toHaveText(NOTE);
  });

  test("the link field moves clear of the chips when its note grows a line", async ({
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
      await expect.poll(() => coveredText(card)).toEqual([]);
    }
  });
});

test.describe("at 390x844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

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
