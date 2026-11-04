import { type FrameLocator, type Page } from "@playwright/test";
import { expect, test, uniqueName } from "./fixtures";

// What happens to an editor's words when a save cannot go: they stay on
// screen and in storage until the editor copies or discards them.

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

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

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

async function waitEditable(page: Page) {
  await expect(renderedDocument(page).locator("body")).toHaveAttribute(
    "contenteditable",
    "true",
  );
}

async function openEditable(page: Page, id: string) {
  await page.goto(`/app/d/${id}`);
  await waitEditable(page);
}

const SOURCE_EDITS = "**/v1/documents/*/source-edits";

function nextSave(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/source-edits"),
  );
}

async function latestSource(page: Page, id: string): Promise<string> {
  const document = await page.request.get(`/v1/documents/${id}`);
  const { current_version_id } = (await document.json()) as {
    current_version_id: string;
  };
  return (
    await page.request.get(`/v1/documents/${id}/versions/${current_version_id}/html`)
  ).text();
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
  await page.route(SOURCE_EDITS, (route) =>
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
  await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
  // No load takes the text away, and the message stays.
  await page.waitForTimeout(6000);
  await expect(message).toBeVisible();
  const tail = renderedDocument(page).locator("#tail");
  await expect(tail).toContainText("IMPORTANT UNSAVED TEXT");
  expect(await latestSource(page, document.id)).toBe(HTML);

  await copied(page, "giving up. IMPORTANT UNSAVED TEXT");
  await page.getByRole("button", { name: "Discard my change" }).click();
  await expect(tail).toHaveText("Clients retry twice before giving up.");
  await expect(page.getByText("Not saved", { exact: true })).toBeHidden();
});

test("text that a conflict stopped is offered again after Back and a new visit", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Conflict draft");
  const document = await slashdocs.createDocument(title, HTML);
  // The document opens from the list, so that Back is a move in the app.
  await page.goto("/app/documents");
  await page.getByRole("link", { name: title }).first().click();
  await waitEditable(page);
  const other = await page.context().newPage();
  await openEditable(other, document.id);

  const first = nextSave(other);
  await typeOver(other, "#tail", "twice", "three times");
  expect((await first).status()).toBe(201);
  const second = nextSave(page);
  await typeOver(page, "#tail", "twice", "four times");
  expect((await second).status()).toBe(409);
  await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
  await typeOver(page, "#tail", "giving up.", "giving up. KEEP MY LOCAL DRAFT");
  await page.waitForTimeout(300);

  await page.goBack();
  await expect(page.getByRole("button", { name: "Show their version" })).toBeHidden();
  await page.getByRole("link", { name: title }).first().click();
  await waitEditable(page);
  await expect(
    page.getByText("You have text in this document that was not saved."),
  ).toBeVisible();
  await copied(page, "four times before giving up. KEEP MY LOCAL DRAFT");
  await page.getByRole("button", { name: "Discard my change" }).click();
  await expect(
    page.getByText("You have text in this document that was not saved."),
  ).toBeHidden();

  await page.reload();
  await waitEditable(page);
  await expect(renderedDocument(page).locator("#tail")).toContainText("three times");
  await expect(
    page.getByText("You have text in this document that was not saved."),
  ).toBeHidden();
});

test("a save that fails twice counts the attempts and offers a copy", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Failed save"), HTML);
  await openEditable(page, document.id);
  await page.route(SOURCE_EDITS, (route) =>
    route.fulfill({ status: 500, json: { error: { code: "internal", message: "x" } } }),
  );

  await typeOver(page, "#tail", "giving up.", "giving up. Twice failed.");
  await expect(
    page.getByText("Your edits are not saved yet. Trying again (attempt 2)…"),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
  await copied(page, "giving up. Twice failed.");

  await page.unroute(SOURCE_EDITS);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  expect(await latestSource(page, document.id)).toContain("giving up. Twice failed.");
});

test("the first save offers one Undo, in its message", async ({ page, slashdocs }) => {
  const document = await slashdocs.createDocument(uniqueName("One undo"), HTML);
  await openEditable(page, document.id);

  const saved = nextSave(page);
  await typeOver(page, "#tail", "giving up.", "giving up. Oops");
  expect((await saved).status()).toBe(201);
  await expect(page.getByText("Your edit is saved.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(1);

  const undone = nextSave(page);
  await page.getByRole("button", { name: "Undo", exact: true }).click();
  expect((await undone).status()).toBe(201);
  await expect(renderedDocument(page).locator("#tail")).toHaveText(
    "Clients retry twice before giving up.",
  );
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
