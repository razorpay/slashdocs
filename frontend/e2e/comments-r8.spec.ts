import { type FrameLocator, type Page } from "@playwright/test";
import { APP_ORIGIN, expect, test, uniqueName } from "./fixtures";

// Comments under races: a slow post while the reader types on, and a change
// from another person while a thread or its editor is open.

function bridge(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Rendered document"]');
}

function documentHTML(title: string) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body><h1>${title}</h1><p id="intro">Write the notes.</p><p>Closing words.</p></body>
</html>`;
}

test("words typed while a comment posts wait as a reply to the new thread", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Held post r8");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("button", { name: "Comment on a spot" }).click();
  await bridge(page).frameLocator("iframe#slashdocs-doc").locator("#intro").click();

  // The post waits until the reader typed more.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/v1/documents/${document.id}/comments`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    await released;
    await route.fulfill({ response });
  });
  const field = page
    .getByRole("dialog", { name: "New comment" })
    .getByPlaceholder("Add a comment…");
  await field.fill("Original words");
  await field.press("Enter");
  await field.pressSequentially(" KEEP THE LATER WORDS");
  release();

  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await expect(thread.getByText("Original words", { exact: true })).toBeVisible();
  await expect(thread.getByPlaceholder("Reply…")).toHaveValue("KEEP THE LATER WORDS");
});

test("an edit starts from the live text, and tells of a change made during it", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Live edit r8");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "R8 original", {
    quote: "Write the notes.",
  });
  const patch = (body: string) =>
    page.request.patch(`/v1/documents/${document.id}/comments/${comment.id}`, {
      headers: { Origin: APP_ORIGIN },
      data: { body },
    });
  await page.goto(`/app/d/${document.id}?comment=${comment.id}`);
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await expect(thread.getByText("R8 original", { exact: true })).toBeVisible();

  // Another change shows in the open thread, and the edit starts from it.
  expect((await patch("R8 remote update")).ok()).toBe(true);
  await expect(thread.getByText("R8 remote update", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await thread.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const field = thread.getByRole("combobox", { name: "Edit comment" });
  await expect(field).toHaveValue("R8 remote update");
  await expect(thread.getByRole("button", { name: "Save" })).toBeDisabled();

  // A change during the edit keeps the reader's words and tells of it.
  await field.pressSequentially(" and mine");
  expect((await patch("R8 second update")).ok()).toBe(true);
  const notice = thread
    .getByRole("status")
    .filter({ hasText: "This comment changed while you edited." });
  await expect(notice).toContainText("R8 second update", { timeout: 15_000 });
  await expect(field).toHaveValue("R8 remote update and mine");
  await notice.getByRole("button", { name: "Use the new text" }).click();
  await expect(field).toHaveValue("R8 second update");
  await expect(notice).toBeHidden();
});

test("a thread that another person deletes closes, also during an edit", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Live delete r8");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "R8 to delete", {
    quote: "Write the notes.",
  });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(`/app/d/${document.id}?comment=${comment.id}`);
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await thread.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await thread
    .getByRole("combobox", { name: "Edit comment" })
    .pressSequentially(" now");

  const deleted = await page.request.delete(
    `/v1/documents/${document.id}/comments/${comment.id}`,
    { headers: { Origin: APP_ORIGIN } },
  );
  expect(deleted.ok()).toBe(true);
  await expect(thread).toBeHidden({ timeout: 15_000 });
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await expect(page.getByText("No comments yet")).toBeVisible();
  expect(errors).toEqual([]);
});
