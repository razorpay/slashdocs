import { type FrameLocator, type Page } from "@playwright/test";
import { APP_ORIGIN, expect, test, uniqueName } from "./fixtures";

// Typed words are never lost: a two-tab conflict outlives Esc, a new
// opening and a reload; the words of a deleted thread stay in the Drafts of
// the comments list; and a thread opens, takes the focus and counts its
// replies in the places where the reader goes on.

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

function documentHTML(title: string) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body><h1>${title}</h1><p id="intro">Write the notes.</p><p>Closing words.</p></body>
</html>`;
}

async function openThread(page: Page, docId: string, commentId: string, body: string) {
  await page.goto(`/app/d/${docId}?comment=${commentId}`);
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await expect(thread.getByText(body, { exact: true })).toBeVisible();
  return thread;
}

test("both texts of a two-tab reply conflict stay after Esc, a new opening and a reload", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Conflict r10");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "R10 conflict", {
    quote: "Write the notes.",
  });
  const tabA = await openThread(page, document.id, comment.id, "R10 conflict");
  const other = await page.context().newPage();
  const tabB = await openThread(other, document.id, comment.id, "R10 conflict");
  const fieldA = tabA.getByPlaceholder("Reply…");
  const fieldB = tabB.getByPlaceholder("Reply…");
  await fieldA.fill("SHARED");
  await expect(fieldB).toHaveValue("SHARED");

  // Both tabs change the draft within the pause before a save.
  await fieldB.pressSequentially(" THE OTHER TAB SAVED");
  await fieldA.fill("IMPORTANT LOCAL CONFLICT WORDS");
  const notice = tabA
    .getByRole("status")
    .filter({ hasText: "This draft changed in another tab." });
  await expect(notice).toContainText("SHARED THE OTHER TAB SAVED");

  await fieldA.press("Escape");
  await expect(tabA).toBeHidden();
  await renderedDocument(page).locator("mark.slashdocs-mark").first().click();
  await expect(fieldA).toHaveValue("IMPORTANT LOCAL CONFLICT WORDS");
  await expect(notice).toContainText("SHARED THE OTHER TAB SAVED");

  await page.reload();
  await expect(fieldA).toHaveValue("IMPORTANT LOCAL CONFLICT WORDS");
  await expect(notice).toContainText("SHARED THE OTHER TAB SAVED");
  await notice.getByRole("button", { name: "Keep mine" }).click();
  await expect(notice).toBeHidden();
  await expect(fieldB).toHaveValue("IMPORTANT LOCAL CONFLICT WORDS");
  await other.close();
});

test("the words of a deleted thread stay beside its words, and in Drafts after Esc and a reload", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Deleted r10");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "R10 to delete", {
    quote: "Write the notes.",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const thread = await openThread(page, document.id, comment.id, "R10 to delete");
  const before = await thread.boundingBox();
  await thread.getByPlaceholder("Reply…").fill("UNSENT REPLY WORDS");
  await thread.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await thread
    .getByRole("combobox", { name: "Edit comment" })
    .pressSequentially(" IMPORTANT DELETED THREAD EDIT");

  const deleted = await page.request.delete(
    `/v1/documents/${document.id}/comments/${comment.id}`,
    { headers: { Origin: APP_ORIGIN } },
  );
  expect(deleted.ok()).toBe(true);
  const notice = thread
    .getByRole("status")
    .filter({ hasText: "This thread was deleted." });
  await expect(notice).toContainText("IMPORTANT DELETED THREAD EDIT", {
    timeout: 15_000,
  });
  // It stays beside its words, with its header and close button.
  await expect(thread.getByText("Thread deleted", { exact: true })).toBeVisible();
  await expect(thread.getByRole("button", { name: "Close" })).toBeVisible();
  const after = await thread.boundingBox();
  expect(Math.abs(after!.y - before!.y)).toBeLessThan(40);

  await page.keyboard.press("Escape");
  await expect(thread).toBeHidden();
  for (const reload of [false, true]) {
    if (reload) await page.goto(`/app/d/${document.id}`);
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    const drafts = page.getByRole("list", { name: "Drafts" });
    const edit = drafts
      .getByRole("listitem")
      .filter({ hasText: "IMPORTANT DELETED THREAD EDIT" });
    await expect(edit).toContainText("Thread deleted");
    await expect(drafts).toContainText("UNSENT REPLY WORDS");
    await edit.getByRole("button", { name: "Copy my text" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "R10 to delete IMPORTANT DELETED THREAD EDIT",
    );
    await edit.getByText("IMPORTANT DELETED THREAD EDIT").click();
    await expect(notice).toContainText("UNSENT REPLY WORDS");
    await page.keyboard.press("Escape");
    await expect(thread).toBeHidden();
  }

  const drafts = page.getByRole("list", { name: "Drafts" });
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await drafts.getByText("UNSENT REPLY WORDS").click();
  await notice.getByRole("button", { name: "Discard" }).click();
  await expect(thread).toBeHidden();
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await expect(drafts).toBeHidden();
});

test("one click on a highlight opens its thread for an editor, and keeps the caret there", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("One click r10");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.createComment(document.id, "R10 one click", {
    quote: "Write the notes.",
  });
  await page.goto(`/app/d/${document.id}`);
  const mark = renderedDocument(page).locator("mark.slashdocs-mark").first();
  await mark.click();
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await expect(thread.getByText("R10 one click", { exact: true })).toBeVisible();
  expect(
    await mark.evaluate((m) => m.contains(m.ownerDocument.getSelection()!.anchorNode)),
  ).toBe(true);
});

test("a posted comment opens with the focus in Reply, and a sending reply shows its count", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Posted r10");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("button", { name: "Comment on a spot" }).click();
  await renderedDocument(page).locator("#intro").click();
  const field = page
    .getByRole("dialog", { name: "New comment" })
    .getByPlaceholder("Add a comment…");
  await field.fill("R10 first words");
  await field.press("Enter");
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  const reply = thread.getByPlaceholder("Reply…");
  await expect(reply).toBeFocused();

  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(
    `**/v1/documents/${document.id}/comments/*/replies`,
    async (route) => {
      const response = await route.fetch();
      await released;
      await route.fulfill({ response });
    },
  );
  await page.keyboard.type("R10 held reply");
  await page.keyboard.press("Enter");
  const count = thread.getByText("1 reply", { exact: true });
  await expect(count).toBeVisible();
  const field0 = await reply.boundingBox();
  release();
  await expect(thread.locator("[aria-busy]")).toBeHidden();
  expect((await reply.boundingBox())!.y).toBeCloseTo(field0!.y, 0);
});
