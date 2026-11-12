import { type Page } from "@playwright/test";
import {
  expect,
  latestSource,
  notSaved,
  openEditable,
  renderedDocument,
  startEditing,
  test,
  uniqueName,
} from "./fixtures";

// What happens to an editor's words when they cannot reach the server: they
// stay on screen and in storage, under a "Not saved" bar with Retry, until
// the editor copies or discards them.

const HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Recovery</title></head>
  <body>
    <h1>Recovery</h1>
    <p id="tail">Clients retry twice before giving up.</p>
    <div id="labels"></div>
    <script>
      for (const n of [1, 2]) {
        const button = document.createElement("button");
        button.textContent = "Run step";
        document.getElementById("labels").appendChild(button);
      }
    </script>
  </body>
</html>`;

// typeOver selects target in an element of the rendered document, and types
// text in its place.
async function typeOver(page: Page, selector: string, target: string, text: string) {
  await renderedDocument(page)
    .locator(selector)
    .evaluate((element, target) => {
      const walker = element.ownerDocument.createTreeWalker(
        element,
        NodeFilter.SHOW_TEXT,
      );
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = (node as Text).data.indexOf(target);
        if (at < 0) continue;
        element.ownerDocument.body.focus();
        element.ownerDocument
          .getSelection()!
          .setBaseAndExtent(node, at, node, at + target.length);
        return;
      }
      throw new Error(`no text ${target}`);
    }, target);
  await page.keyboard.type(text);
}

const OPS = "**/v1/documents/*/ops";

function nextSave(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith("/ops"),
  );
}

async function copied(page: Page, text: string) {
  await page.getByRole("button", { name: "Copy my text" }).click();
  await expect(page.getByText("Your text is copied.")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(text);
}

test.beforeEach(async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
});

test("a save that the server refuses keeps the text until the editor chooses", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Refused save"), HTML);
  await openEditable(page, document.id);
  await page.route(OPS, (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: "forbidden", message: "forbidden" } },
    }),
  );

  const refused = nextSave(page);
  await typeOver(page, "#tail", "giving up.", "giving up. IMPORTANT UNSAVED TEXT");
  expect((await refused).status()).toBe(403);
  const message = page.getByText(
    "You can no longer edit this document, so your text cannot save.",
  );
  await expect(message).toBeVisible();
  await expect(notSaved(page)).toBeVisible();
  // No load takes the text away, and the message stays.
  await page.waitForTimeout(2000);
  await expect(message).toBeVisible();
  const tail = renderedDocument(page).locator("#tail");
  await expect(tail).toContainText("IMPORTANT UNSAVED TEXT");
  expect(await latestSource(page, document.id)).toBe(HTML);

  // The copy holds the words that came after the refusal too.
  await typeOver(page, "#tail", "twice", "four times");
  await copied(page, "four times before giving up. IMPORTANT UNSAVED TEXT");
  await page.getByRole("button", { name: "Discard my change" }).click();
  await expect(tail).toHaveText("Clients retry twice before giving up.");
  await expect(notSaved(page)).toBeHidden();
});

test("text that a refused save stopped is offered again after Back and a new visit", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Refused draft");
  const document = await slashdocs.createDocument(title, HTML);
  // The document opens from the list, so that Back is a move in the app.
  await page.goto("/app/documents");
  await page.getByRole("link", { name: title }).first().click();
  await startEditing(page);
  await page.route(OPS, (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: "forbidden", message: "forbidden" } },
    }),
  );

  const refused = nextSave(page);
  await typeOver(page, "#tail", "twice", "four times");
  expect((await refused).status()).toBe(403);
  await expect(notSaved(page)).toBeVisible();
  await typeOver(page, "#tail", "giving up.", "giving up. KEEP MY LOCAL DRAFT");
  // The frame sends its draft to the page a moment after the last key.
  await page.waitForTimeout(300);

  await page.goBack();
  await expect(page.getByRole("button", { name: "Discard my change" })).toBeHidden();
  await page.getByRole("link", { name: title }).first().click();
  await startEditing(page);
  const earlier = page.getByText("You have text in this document that was not saved.");
  await expect(earlier).toBeVisible();
  await copied(page, "four times before giving up. KEEP MY LOCAL DRAFT");
  await page.getByRole("button", { name: "Discard my change" }).click();
  await expect(earlier).toBeHidden();

  await page.unroute(OPS);
  await page.reload();
  await startEditing(page);
  await expect(renderedDocument(page).locator("#tail")).toHaveText(
    "Clients retry twice before giving up.",
  );
  await expect(earlier).toBeHidden();
  expect(await latestSource(page, document.id)).toBe(HTML);
});

test("a save that fails for a short time says nothing, and goes again until it saves", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Failed save"), HTML);
  await openEditable(page, document.id);
  let attempts = 0;
  await page.route(OPS, (route) => {
    attempts++;
    return route.fulfill({
      status: 500,
      json: { error: { code: "internal", message: "x" } },
    });
  });

  await typeOver(page, "#tail", "giving up.", "giving up. Twice failed.");
  // The page sends the text again by itself.
  await expect.poll(() => attempts, { timeout: 15_000 }).toBeGreaterThan(1);
  expect(await latestSource(page, document.id)).toBe(HTML);
  await page.unroute(OPS);
  await expect
    .poll(() => latestSource(page, document.id), { timeout: 10_000 })
    .toBe(HTML.replace("giving up.", "giving up. Twice failed."));
  // A failure that passes soon is nothing that the editor must act on.
  await expect(notSaved(page)).toBeHidden();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

test("a reload right after the last key offers no unsaved text, because the document has it", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Reload"), HTML);
  await openEditable(page, document.id);
  await typeOver(page, "#tail", "twice", "four times");
  // The reload comes as soon as the server has the last key.
  await expect
    .poll(() => latestSource(page, document.id), { intervals: [20] })
    .toBe(HTML.replace("twice", "four times"));
  await page.reload();
  await startEditing(page);

  await expect(renderedDocument(page).locator("#tail")).toHaveText(
    "Clients retry four times before giving up.",
  );
  // The toast of a draft would come with Edit mode.
  await page.waitForTimeout(1000);
  await expect(
    page.getByText("You have text in this document that was not saved."),
  ).toBeHidden();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

test("script text that cannot be checked offers to try again", async ({
  page,
  slashdocs,
}) => {
  // A new context has no cache, so the parser chunk must load now.
  const document = await slashdocs.createDocument(uniqueName("Parser fails"), HTML);
  await page.route(/\/acorn-[\w-]+\.js$/, (route) => route.abort());
  await openEditable(page, document.id);

  const label = renderedDocument(page).locator("#labels button").first();
  await label.click();
  await expect(
    renderedDocument(page).getByText("Could not check this text."),
  ).toBeVisible();
  const again = renderedDocument(page).getByRole("button", { name: "Try again" });
  await expect(again).toBeVisible();

  await page.unroute(/\/acorn-[\w-]+\.js$/);
  await again.click();
  await expect(label).toHaveAttribute("contenteditable", "true");
});
