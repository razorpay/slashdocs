import { type FrameLocator, type Page } from "@playwright/test";
import { expect, test, uniqueName } from "./fixtures";

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

// The source holds no random text, so the shortest unique edit of a word is
// the word itself.
function documentHTML() {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Cache settings</title></head>
  <body>
    <h1>Cache settings</h1>
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

// openEditable opens a document as its owner, who edits it by typing.
async function openEditable(page: Page, id: string) {
  await page.goto(`/app/d/${id}`);
  await expect(renderedDocument(page).locator("#ttl")).toBeVisible();
  await expect(renderedDocument(page).locator("body")).toHaveAttribute(
    "contenteditable",
    "true",
  );
}

function nextEdit(page: Page, id: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/v1/documents/${id}/edits`,
  );
}

test("saves edited words as the editor pauses, and only the changed text", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Text editing");
  const html = documentHTML();
  const document = await slashdocs.createDocument(title, html);

  await openEditable(page, document.id);
  await expect(page.getByText("Editing", { exact: true })).toBeVisible();
  await expect(renderedDocument(page).locator(".slashdocs-heading-link")).toBeHidden();

  const saved = nextEdit(page, document.id);
  await selectWord(page, "#ttl", "10");
  await page.keyboard.type("5");
  const response = await saved;
  expect(response.status()).toBe(201);
  expect(response.request().postDataJSON()).toEqual({
    edits: [{ old_string: "10", new_string: "5" }],
  });
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();

  // Everything but the edited word is byte-for-byte the same.
  const latest = await slashdocs.getDocument(document.id);
  const source = await page.request.get(
    `/v1/documents/${document.id}/versions/${latest.current_version_id}/html`,
  );
  expect(await source.text()).toBe(
    html.replace("TTL of 10 minutes", "TTL of 5 minutes"),
  );

  // The frame stays: the next words go on from the caret and save again.
  const again = nextEdit(page, document.id);
  await page.keyboard.type("0");
  const [edit] = (await again).request().postDataJSON().edits;
  expect(edit.new_string).toBe(edit.old_string.replace("5", "50"));
  await expect(renderedDocument(page).locator("#ttl")).toHaveText(
    "Entries live in Redis with a TTL of 50 minutes.",
  );
});

test("typing over a triple-clicked paragraph keeps the next one", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Text editing triple click");
  const html = documentHTML();
  const document = await slashdocs.createDocument(title, html);

  await openEditable(page, document.id);

  // A triple click selects up to the start of the next paragraph.
  const saved = nextEdit(page, document.id);
  await renderedDocument(page).locator("#ttl").click({ clickCount: 3 });
  await page.keyboard.type("Entries live in Redis for an hour.");
  await expect(renderedDocument(page).locator("#retry")).toHaveText(
    "Clients retry twice before giving up.",
  );
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

test("replaces all of a heading's and a paragraph's text", async ({
  page,
  slashdocs,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const title = uniqueName("Text editing replace");
  const html = documentHTML();
  const document = await slashdocs.createDocument(title, html);

  await openEditable(page, document.id);

  // Emptying a node makes the browser type into a new one.
  await renderedDocument(page).locator("h1").click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.keyboard.type("Cache notes");
  await renderedDocument(page).locator("#ttl").click({ clickCount: 3 });
  await page.evaluate(() => navigator.clipboard.writeText("https://example.com/ttl"));
  await page.keyboard.press("ControlOrMeta+v");

  const expected = html
    .replace("<h1>Cache settings</h1>", "<h1>Cache notes</h1>")
    .replace(
      "Entries live in Redis with a TTL of 10 minutes.",
      "https://example.com/ttl",
    );
  await expect
    .poll(async () => {
      const latest = await slashdocs.getDocument(document.id);
      const source = await page.request.get(
        `/v1/documents/${document.id}/versions/${latest.current_version_id}/html`,
      );
      return source.text();
    })
    .toBe(expected);
});

test("refuses joining paragraphs and new paragraphs", async ({ page, slashdocs }) => {
  const title = uniqueName("Text editing structure");
  const document = await slashdocs.createDocument(title, documentHTML());

  await openEditable(page, document.id);

  await renderedDocument(page).locator("#retry").click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await expect(
    page.getByText("Only words can change here.", { exact: false }),
  ).toBeVisible();
  await selectWord(page, "#retry", "twice");
  await page.keyboard.press("Enter");
  await expect(renderedDocument(page).locator("p")).toHaveCount(2);
  await expect(renderedDocument(page).locator("#retry")).toHaveText(
    "Clients retry twice before giving up.",
  );
  const unchanged = await slashdocs.getDocument(document.id);
  expect(unchanged.current_version_id).toBe(document.current_version_id);
});

test("restores an earlier version from the history", async ({ page, slashdocs }) => {
  const title = uniqueName("Text editing history");
  const html = documentHTML();
  const document = await slashdocs.createDocument(title, html);

  await openEditable(page, document.id);
  const saved = nextEdit(page, document.id);
  await selectWord(page, "#retry", "twice");
  await page.keyboard.type("three times");
  await saved;

  // The owner created and edited the document in one sitting: one session.
  await page.getByRole("button", { name: "History" }).click();
  const history = page.getByRole("dialog");
  await history.getByRole("button", { name: "Show all 2 edits" }).click();
  await history.getByRole("button", { name: /Created/ }).click();
  await expect(renderedDocument(page).locator("#retry")).toHaveText(
    "Clients retry twice before giving up.",
  );
  // An earlier version is a preview: it does not change.
  await expect(renderedDocument(page).locator("body")).not.toHaveAttribute(
    "contenteditable",
    "true",
  );
  await expect(page.getByText("This is the document as it was")).toBeVisible();

  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Restored.")).toBeVisible();
  await expect(renderedDocument(page).locator("body")).toHaveAttribute(
    "contenteditable",
    "true",
  );
  const latest = await slashdocs.getDocument(document.id);
  expect(latest.current_version_id).not.toBe(document.current_version_id);
  const source = await page.request.get(
    `/v1/documents/${document.id}/versions/${latest.current_version_id}/html`,
  );
  expect(await source.text()).toBe(html);
});

test("keeps unsaved typing when the same person changes the document elsewhere", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Text editing elsewhere");
  const html = documentHTML();
  const document = await slashdocs.createDocument(title, html);

  await openEditable(page, document.id);
  const saved = nextEdit(page, document.id);
  await selectWord(page, "#retry", "twice");
  await page.keyboard.type("three times");
  // An agent with the editor's own token changes other text before the pause.
  await slashdocs.pushVersion(document.id, html.replace("10 minutes", "15 minutes"));
  await expect(page.getByText("This document changed elsewhere.")).toBeVisible();

  expect((await saved).status()).toBe(201);
  await expect(renderedDocument(page).locator("#retry")).toHaveText(
    "Clients retry three times before giving up.",
  );
  const latest = await slashdocs.getDocument(document.id);
  const source = await page.request.get(
    `/v1/documents/${document.id}/versions/${latest.current_version_id}/html`,
  );
  expect(await source.text()).toBe(
    html.replace("10 minutes", "15 minutes").replace("twice", "three times"),
  );
});

test("saves only the editor's words while a script changes other text", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Text editing script");
  const html = documentHTML().replace(
    "</body>",
    `<p id="clock">0</p>
    <script>
      let ticks = 0;
      setInterval(() => {
        document.getElementById("clock").textContent = String(++ticks);
        document.body.appendChild(document.createElement("span"));
      }, 200);
    </script>
  </body>`,
  );
  const document = await slashdocs.createDocument(title, html);

  await openEditable(page, document.id);
  const saved = nextEdit(page, document.id);
  await selectWord(page, "#ttl", "10");
  await page.keyboard.type("5");
  expect((await saved).request().postDataJSON()).toEqual({
    edits: [{ old_string: "10", new_string: "5" }],
  });
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Only words can change here.", { exact: false }),
  ).toBeHidden();
});
