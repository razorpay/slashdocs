import { type FrameLocator, type Page } from "@playwright/test";
import { expect, test, uniqueName } from "./fixtures";

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

function documentHTML(title: string) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    <p id="ttl">Entries live in Redis with a TTL of 10 minutes.</p>
    <p id="retry">Clients retry twice before giving up.</p>
  </body>
</html>`;
}

// selectWord puts the caret over a word of an element in the rendered
// document, as a double click would, so typing replaces it.
async function selectWord(page: Page, selector: string, word: string) {
  await renderedDocument(page)
    .locator(selector)
    .evaluate((element, target) => {
      const text = element.firstChild as Text;
      const start = text.data.indexOf(target);
      const range = element.ownerDocument.createRange();
      range.setStart(text, start);
      range.setEnd(text, start + target.length);
      element.ownerDocument.body.focus();
      const selection = element.ownerDocument.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, word);
}

test("edits words in place and saves only the changed text", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Text editing");
  const html = documentHTML(title);
  const document = await slashdocs.createDocument(title, html);

  await page.goto(`/app/d/${document.id}`);
  await expect(renderedDocument(page).locator("#ttl")).toBeVisible();
  await page.getByRole("button", { name: "Edit text" }).click();
  const editing = page.getByRole("group", { name: "Editing text" });
  await expect(editing).toBeVisible();
  await expect(renderedDocument(page).locator("body")).toHaveAttribute(
    "contenteditable",
    "true",
  );

  await selectWord(page, "#ttl", "10");
  await page.keyboard.type("5");
  await expect(editing.getByText("1 change")).toBeVisible();

  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/v1/documents/${document.id}/edits`,
  );
  await editing.getByRole("button", { name: "Save" }).click();
  const response = await saved;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({
    edits: [{ old_string: "10", new_string: "5" }],
  });
  await expect(page.getByRole("button", { name: "Edit text" })).toBeVisible();

  // Everything but the edited word is byte-for-byte the same.
  const latest = await slashdocs.getDocument(document.id);
  const source = await page.request.get(
    `/v1/documents/${document.id}/versions/${latest.current_version_id}/html`,
  );
  expect(await source.text()).toBe(
    html.replace("TTL of 10 minutes", "TTL of 5 minutes"),
  );
  await expect(renderedDocument(page).locator("#ttl")).toHaveText(
    "Entries live in Redis with a TTL of 5 minutes.",
  );
});

test("typing over a triple-clicked paragraph keeps the next one", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Text editing triple click");
  const html = documentHTML(title);
  const document = await slashdocs.createDocument(title, html);

  await page.goto(`/app/d/${document.id}`);
  await expect(renderedDocument(page).locator("#ttl")).toBeVisible();
  await page.getByRole("button", { name: "Edit text" }).click();
  const editing = page.getByRole("group", { name: "Editing text" });
  await expect(renderedDocument(page).locator("body")).toHaveAttribute(
    "contenteditable",
    "true",
  );

  // A triple click selects up to the start of the next paragraph.
  await renderedDocument(page).locator("#ttl").click({ clickCount: 3 });
  await page.keyboard.type("Entries live in Redis for an hour.");
  await expect(renderedDocument(page).locator("#retry")).toHaveText(
    "Clients retry twice before giving up.",
  );
  await expect(editing.getByText("1 change")).toBeVisible();

  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/v1/documents/${document.id}/edits`,
  );
  await editing.getByRole("button", { name: "Save" }).click();
  expect((await saved).status()).toBe(201);
  const latest = await slashdocs.getDocument(document.id);
  const source = await page.request.get(
    `/v1/documents/${document.id}/versions/${latest.current_version_id}/html`,
  );
  expect(await source.text()).toBe(
    html.replace(
      "Entries live in Redis with a TTL of 10 minutes.",
      "Entries live in Redis for an hour.",
    ),
  );
});

test("refuses joining paragraphs with backspace", async ({ page, slashdocs }) => {
  const title = uniqueName("Text editing join");
  const document = await slashdocs.createDocument(title, documentHTML(title));

  await page.goto(`/app/d/${document.id}`);
  await expect(renderedDocument(page).locator("#retry")).toBeVisible();
  await page.getByRole("button", { name: "Edit text" }).click();
  await expect(renderedDocument(page).locator("body")).toHaveAttribute(
    "contenteditable",
    "true",
  );

  await renderedDocument(page).locator("#retry").click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await expect(
    page.getByText("Only words can be edited here.", { exact: false }),
  ).toBeVisible();
  await expect(renderedDocument(page).locator("p")).toHaveCount(2);
  await expect(renderedDocument(page).locator("#retry")).toHaveText(
    "Clients retry twice before giving up.",
  );
});

test("refuses structural changes and cancel restores the text", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Text editing cancel");
  const document = await slashdocs.createDocument(title, documentHTML(title));

  await page.goto(`/app/d/${document.id}`);
  await expect(renderedDocument(page).locator("#retry")).toBeVisible();
  await page.getByRole("button", { name: "Edit text" }).click();
  await expect(renderedDocument(page).locator("body")).toHaveAttribute(
    "contenteditable",
    "true",
  );

  await selectWord(page, "#retry", "twice");
  await page.keyboard.press("Enter");
  await expect(
    page.getByText("Only words can be edited here.", { exact: false }),
  ).toBeVisible();
  await expect(renderedDocument(page).locator("p")).toHaveCount(2);

  await page.keyboard.type("three times");
  await expect(renderedDocument(page).locator("#retry")).toHaveText(
    "Clients retry three times before giving up.",
  );
  await page
    .getByRole("group", { name: "Editing text" })
    .getByRole("button", { name: "Cancel" })
    .click();

  await expect(renderedDocument(page).locator("#retry")).toHaveText(
    "Clients retry twice before giving up.",
  );
  await expect(renderedDocument(page).locator("body")).not.toHaveAttribute(
    "contenteditable",
    "true",
  );
  const unchanged = await slashdocs.getDocument(document.id);
  expect(unchanged.current_version_id).toBe(document.current_version_id);
});
