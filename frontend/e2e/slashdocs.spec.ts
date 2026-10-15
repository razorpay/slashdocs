import { type FrameLocator, type Locator, type Page } from "@playwright/test";
import { APP_ORIGIN, RENDER_ORIGIN, expect, test, uniqueName } from "./fixtures";

function documentHTML(heading: string, body = "Select this sentence for review.") {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${heading}</title></head>
  <body>
    <main>
      <h1 id="e2e-heading">${heading}</h1>
      <p id="comment-target">${body}</p>
    </main>
  </body>
</html>`;
}

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

function entryRow(page: Page, title: string): Locator {
  return page
    .locator("tbody tr")
    .filter({ has: page.getByRole("link", { name: title, exact: true }) });
}

async function dragToDndKit(page: Page, source: Locator, target: Locator) {
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("drag source or target is not visible");

  const sourcePoint = {
    x: sourceBox.x + sourceBox.width / 2,
    y: sourceBox.y + sourceBox.height / 2,
  };
  const targetPoint = {
    x: targetBox.x + targetBox.width / 2,
    y: targetBox.y + targetBox.height / 2,
  };
  await page.mouse.move(sourcePoint.x, sourcePoint.y);
  await page.mouse.down();
  // dnd-kit's PointerSensor activates after eight pixels of movement.
  await page.mouse.move(sourcePoint.x + 12, sourcePoint.y, { steps: 3 });
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 12 });
  await page.mouse.up();
}

test("the saved browser session came from a complete Dex login", async ({ page }) => {
  await page.goto("/app/documents");
  await expect(page).toHaveURL(`${APP_ORIGIN}/app/documents`);
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();

  const response = await page.request.get("/v1/me");
  expect(response.ok()).toBeTruthy();
  const me = (await response.json()) as {
    principal: { email?: string };
    user?: { email?: string };
  };
  expect(me.user?.email ?? me.principal.email).toBe("admin@example.com");
});

test("uploads HTML in the UI and renders it only on the render origin", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Browser upload");
  await page.goto("/app/documents");
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Upload HTML (backup)" }).click();

  const dialog = page.getByRole("dialog", { name: "Upload HTML (backup)" });
  await expect(dialog).toBeVisible();
  // The menu must be gone and the dialog must survive the window losing focus,
  // which is what opening the OS file picker does. A dialog rendered inside
  // the menu disappears here (regression in every release from v0.1.0).
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder("Title").fill(title);
  await expect(dialog.getByRole("button", { name: "Choose HTML file" })).toBeVisible();
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "browser-upload.html",
    mimeType: "text/html",
    buffer: Buffer.from(documentHTML(title)),
  });
  await expect(dialog.getByText("browser-upload.html")).toBeVisible();
  await dialog.getByRole("button", { name: "Upload", exact: true }).click();

  await expect(page).toHaveURL(/\/app\/d\/doc_[^/?]+$/);
  const documentID = new URL(page.url()).pathname.split("/").at(-1);
  expect(documentID).toBeTruthy();
  slashdocs.trackDocument(documentID!);

  const outerFrame = page.locator('iframe[title="Rendered document"]');
  await expect(outerFrame).toBeVisible();
  await expect(outerFrame).toHaveAttribute(
    "src",
    new RegExp(`^${RENDER_ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/v/`),
  );
  await expect(
    renderedDocument(page).getByRole("heading", { name: title }),
  ).toBeVisible();
});

test("creates a structured mention with a clean API body", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Structured mention");
  const document = await slashdocs.createDocument(title, documentHTML(title));

  await page.goto(`/app/d/${document.id}`);
  const selectedText = renderedDocument(page).locator("#comment-target");
  await expect(selectedText).toBeVisible();
  await selectedText.selectText();

  const composer = page.getByPlaceholder("Add a comment…");
  await expect(composer).not.toBeVisible();
  await renderedDocument(page)
    .getByRole("button", { name: "Comment on selected text" })
    .click();
  await expect(composer).toBeVisible();
  await composer.fill("Please review @ad");
  await page.getByRole("option", { name: /admin@example\.com/ }).click();
  await expect(composer).toHaveValue("Please review @admin ");
  // Accepting a suggestion focuses the composer and places the caret after
  // the inserted mention in the same commit (layout effect), so once the
  // value assertion above passes it is safe to keep typing.
  await composer.pressSequentially("when you can");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText(" + pasted text"));
  await composer.press(process.platform === "darwin" ? "Meta+V" : "Control+V");

  const commentResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.pathname === `/v1/documents/${document.id}/comments`
    );
  });
  await page.getByRole("button", { name: "Post comment" }).click();
  const commentResponse = await commentResponsePromise;
  expect(commentResponse.ok()).toBeTruthy();
  const comment = (await commentResponse.json()) as {
    body: string;
    mentions: Array<{
      principal: { type: string; id: string };
      offset: number;
      length: number;
    }>;
  };
  expect(comment.body).toBe("Please review @admin when you can + pasted text");
  expect(comment.body).not.toContain("\u2063");
  expect(comment.mentions).toHaveLength(1);
  expect(
    comment.body.slice(
      comment.mentions[0].offset,
      comment.mentions[0].offset + comment.mentions[0].length,
    ),
  ).toBe("@admin");

  const commentCard = page
    .getByRole("button")
    .filter({ hasText: "Please review" })
    .filter({ hasText: "@admin" });
  const renderedMention = commentCard.getByText("@admin", { exact: true });
  await expect(renderedMention).toBeVisible();
  await expect(renderedMention).toHaveClass(/bg-\[var\(--color-accent-muted\)\]/);
});

test("shares a document through its general access role", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("General access");
  const document = await slashdocs.createDocument(title, documentHTML(title));

  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const shareSheet = page.getByRole("dialog", { name: "Share document" });
  const generalAccess = shareSheet.getByLabel("General access role");
  await generalAccess.selectOption("viewer");
  await expect(generalAccess).toHaveValue("viewer");
  const access = await slashdocs.documentAccess(document.id);
  expect(
    access.some(
      (item) => item.principal.type === "anyone" && item.effective_role === "viewer",
    ),
  ).toBeTruthy();
});

test("moves a document into a folder and returns it to root when deleting the folder", async ({
  page,
  slashdocs,
}) => {
  const documentTitle = uniqueName("Folder document");
  const folderTitle = uniqueName("Browser folder");
  const document = await slashdocs.createDocument(
    documentTitle,
    documentHTML(documentTitle),
  );

  await page.goto("/app/documents");
  await page.getByRole("button", { name: "New folder" }).click();
  const newFolderDialog = page.getByRole("dialog", { name: "New folder" });
  await newFolderDialog.getByPlaceholder("Folder name").fill(folderTitle);
  const createFolderResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/v1/folders";
  });
  await newFolderDialog.getByRole("button", { name: "Create" }).click();
  const createFolderResponse = await createFolderResponsePromise;
  expect(createFolderResponse.ok()).toBeTruthy();
  const createdFolder = (await createFolderResponse.json()) as { id: string };
  expect(createdFolder.id).toMatch(/^fld_/);
  const folderID = createdFolder.id;
  slashdocs.trackFolder(folderID);
  await expect(entryRow(page, folderTitle)).toBeVisible();

  const documentRow = entryRow(page, documentTitle);
  const folderRow = entryRow(page, folderTitle);
  await dragToDndKit(page, documentRow, folderRow);
  await expect(documentRow).toBeHidden();

  await folderRow.getByRole("link", { name: folderTitle, exact: true }).click();
  await expect(page.getByRole("heading", { name: folderTitle })).toBeVisible();
  await expect(entryRow(page, documentTitle)).toBeVisible();

  await page.goto("/app/documents");
  const rootFolderRow = entryRow(page, folderTitle);
  await rootFolderRow.hover();
  await rootFolderRow.getByRole("button", { name: "Delete folder" }).click();
  const deleteDialog = page.getByRole("alertdialog");
  await expect(deleteDialog).toContainText(folderTitle);
  const deleteResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "DELETE" &&
      url.pathname === `/v1/folders/${folderID}`
    );
  });
  await deleteDialog.getByRole("button", { name: "Delete", exact: true }).click();
  const deleteResponse = await deleteResponsePromise;
  expect(deleteResponse.ok()).toBeTruthy();
  slashdocs.untrackFolder(folderID);

  await expect(entryRow(page, folderTitle)).toBeHidden();
  await expect(entryRow(page, documentTitle)).toBeVisible();
  const movedDocument = await slashdocs.getDocument(document.id);
  expect(movedDocument.parent_folder_id).toBeFalsy();
});

test("delivers a KV patch to a second open page through the browser SSE stream", async ({
  page,
  context,
  slashdocs,
}) => {
  const title = uniqueName("Live KV");
  const key = `live_${crypto.randomUUID().replaceAll("-", "")}`;
  const value = uniqueName("received");
  const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    <output id="live-value">waiting</output>
    <script>
      const output = document.getElementById("live-value");
      async function renderValue() {
        const value = await window.slashdocs.kv.get(${JSON.stringify(key)});
        output.textContent = value === undefined ? "ready" : String(value);
      }
      window.slashdocs.on("kvchange", renderValue);
      renderValue();
    </script>
  </body>
</html>`;
  const document = await slashdocs.createDocument(title, html);
  const secondPage = await context.newPage();
  const secondPageStream = secondPage.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.status() === 200 &&
      url.pathname === `/v1/documents/${document.id}/kv/events`
    );
  });

  await page.goto(`/app/d/${document.id}`);
  await secondPage.goto(`/app/d/${document.id}`);
  const firstOutput = renderedDocument(page).locator("#live-value");
  const secondOutput = renderedDocument(secondPage).locator("#live-value");
  await expect(firstOutput).toHaveText("ready");
  await expect(secondOutput).toHaveText("ready");
  await secondPageStream;

  await slashdocs.patchKV(document.id, key, value);
  await expect(secondOutput).toHaveText(value);
});

async function selectWord(page: Page, word: string) {
  await renderedDocument(page)
    .locator("#comment-target")
    .evaluate((element, text) => {
      const node = element.firstChild as Text;
      const start = node.data.indexOf(text);
      const range = element.ownerDocument.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + text.length);
      const selection = element.ownerDocument.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, word);
}

test("an owner edits text and saves it as a new version", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Text edit");
  const html = documentHTML(title, "The quikc brown fox &amp; friends.");
  const document = await slashdocs.createDocument(title, html);

  await page.goto(`/app/d/${document.id}`);
  await expect(renderedDocument(page).locator("#comment-target")).toBeVisible();
  await selectWord(page, "quikc");
  await renderedDocument(page)
    .getByRole("button", { name: "Edit selected text" })
    .click();

  const editor = page.getByRole("textbox", { name: "Edited text" });
  await expect(editor).toHaveText("quikc");
  await editor.press("ControlOrMeta+a");
  await page.keyboard.type("quick");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(renderedDocument(page).locator("#comment-target")).toHaveText(
    "The quick brown fox & friends.",
  );

  await page.getByRole("button", { name: "Save as version" }).click();
  const dialog = page.getByRole("dialog", { name: "Save edits as a new version" });
  await expect(dialog.getByRole("textbox", { name: "Change summary" })).toHaveValue(
    'Edited "quikc" → "quick"',
  );
  const saved = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.pathname === `/v1/documents/${document.id}/versions`
    );
  });
  await dialog.getByRole("button", { name: "Save version" }).click();
  const response = await saved;
  expect(response.ok()).toBeTruthy();
  const version = (await response.json()) as { id: string; number: number };
  expect(version.number).toBe(2);

  const stored = await page.request.get(
    `/v1/documents/${document.id}/versions/${version.id}/html`,
  );
  expect(await stored.text()).toBe(html.replace("quikc", "quick"));
  await expect(page.getByRole("button", { name: "Save as version" })).toBeHidden();
});

test("a viewer sees no Edit action", async ({ page, slashdocs }) => {
  const title = uniqueName("Viewer edit");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const someoneElse = { type: "user", id: "someone-else", email: "else@example.com" };
  await page.route(`**/v1/documents/${document.id}`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, owner: someoneElse } });
  });
  await page.route(`**/v1/documents/${document.id}/access`, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, current_role: "viewer" } });
  });

  await page.goto(`/app/d/${document.id}`);
  await expect(renderedDocument(page).locator("#comment-target")).toBeVisible();
  await selectWord(page, "sentence");
  await expect(
    renderedDocument(page).getByRole("button", { name: "Comment on selected text" }),
  ).toBeVisible();
  await expect(
    renderedDocument(page).getByRole("button", { name: "Edit selected text" }),
  ).toBeHidden();
});
