import { type FrameLocator, type Locator, type Page } from "@playwright/test";
import { expect, openEditable, test, uniqueName } from "./fixtures";

// The controls in a document (the selection actions, the link field and the
// script note) cover no text where they find room, with room to spare around
// them. Where they find none, the selection actions dock at an edge of the
// viewport, and the link field and the script note stay next to their words
// and cover none of them.

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

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

    test("the selection actions cover no text, in one row", async ({
      page,
      slashdocs,
    }) => {
      const document = await slashdocs.createDocument(uniqueName("Rows"), rowsHTML());

      await openEditable(page, document.id);
      for (const [selector, word] of [
        ["#tail", "twice"],
        [".row", "Payments"],
      ]) {
        await selectText(page, selector, word);
        const actions = renderedDocument(page).locator(".slashdocs-selection-action");
        await expect(actions.getByRole("button", { name: "Bold" })).toBeVisible();
        expect(await coveredText(actions)).toEqual([]);
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
