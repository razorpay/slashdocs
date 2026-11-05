import { type FrameLocator, type Page } from "@playwright/test";
import { APP_ORIGIN, expect, test, uniqueName } from "./fixtures";

// Words that the reader did not send, under changes from elsewhere: the same
// draft in two tabs, an edit that another tab made first, a thread that
// someone deletes, and a slow post.

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

async function openThread(page: Page, docId: string, commentId: string, body: string) {
  await page.goto(`/app/d/${docId}?comment=${commentId}`);
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await expect(thread.getByText(body, { exact: true })).toBeVisible();
  return thread;
}

test("a reply draft open in two tabs stays in sync, and a stale tab does not replace newer words", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Two tabs r9");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "R9 two tabs", {
    quote: "Write the notes.",
  });
  const tabA = await openThread(page, document.id, comment.id, "R9 two tabs");
  const other = await page.context().newPage();
  const tabB = await openThread(other, document.id, comment.id, "R9 two tabs");
  const fieldA = tabA.getByPlaceholder("Reply…");
  const fieldB = tabB.getByPlaceholder("Reply…");

  await fieldA.fill("TAB A INITIAL");
  await expect(fieldB).toHaveValue("TAB A INITIAL");
  await fieldA.fill("TAB A IMPORTANT NEW WORDS");
  await expect(fieldB).toHaveValue("TAB A IMPORTANT NEW WORDS");
  await fieldB.pressSequentially(" AND B");
  await expect(fieldA).toHaveValue("TAB A IMPORTANT NEW WORDS AND B");
  await page.reload();
  await expect(fieldA).toHaveValue("TAB A IMPORTANT NEW WORDS AND B");

  // Both tabs change the draft within the pause before a save. Tab A saves
  // second, so it holds words that storage does not have: it keeps both, and
  // saves nothing until the reader chooses.
  await fieldB.pressSequentially(" FROM B");
  await fieldA.fill("NEWER IN TAB A");
  const notice = tabA
    .getByRole("status")
    .filter({ hasText: "This draft changed in another tab." });
  await expect(notice).toContainText("TAB A IMPORTANT NEW WORDS AND B FROM B");
  await expect(fieldA).toHaveValue("NEWER IN TAB A");
  await expect(fieldB).toHaveValue("TAB A IMPORTANT NEW WORDS AND B FROM B");
  await notice.getByRole("button", { name: "Keep mine" }).click();
  await expect(notice).toBeHidden();
  await expect(fieldB).toHaveValue("NEWER IN TAB A");
  await other.close();
});

test("an edit from a tab that did not see a newer edit is refused, and keeps the reader's words", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Stale edit r9");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "R9 original", {
    quote: "Write the notes.",
  });
  const commentURL = `/v1/documents/${document.id}/comments/${comment.id}`;
  // This tab misses the live update until its own save comes back.
  let stale: string | undefined;
  await page.route(`**/v1/documents/${document.id}/comments`, async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    stale ??= await response.text();
    await route.fulfill({ response, body: stale });
  });
  await page.route(`**${commentURL}`, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const response = await route.fetch();
    await page.unroute(`**/v1/documents/${document.id}/comments`);
    await route.fulfill({ response });
  });
  const thread = await openThread(page, document.id, comment.id, "R9 original");
  await thread.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const field = thread.getByRole("combobox", { name: "Edit comment" });

  const newer = await page.request.patch(commentURL, {
    headers: { Origin: APP_ORIGIN },
    data: { body: "R9 NEWER FROM TAB A" },
  });
  expect(newer.ok()).toBe(true);
  await field.pressSequentially(" STALE TAB B");
  await field.press("Enter");

  const notice = thread
    .getByRole("status")
    .filter({ hasText: "This comment changed while you edited." });
  await expect(notice).toContainText("R9 NEWER FROM TAB A", { timeout: 15_000 });
  await expect(field).toHaveValue("R9 original STALE TAB B");
  const live = await page.request.get(`/v1/documents/${document.id}/comments`);
  expect(JSON.stringify(await live.json())).toContain("R9 NEWER FROM TAB A");
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`a thread that someone deletes keeps the words not sent, with Copy my text, at ${size.width}`, async ({
    page,
    slashdocs,
  }) => {
    const title = uniqueName("Live delete r9");
    const document = await slashdocs.createDocument(title, documentHTML(title));
    const comment = await slashdocs.createComment(document.id, "R9 to delete", {
      quote: "Write the notes.",
    });
    await page.setViewportSize(size);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const thread = await openThread(page, document.id, comment.id, "R9 to delete");
    await thread.getByPlaceholder("Reply…").fill("UNSENT REPLY WORDS");
    await thread.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    await thread
      .getByRole("combobox", { name: "Edit comment" })
      .pressSequentially(" IMPORTANT UNSAVED EDIT");

    const deleted = await page.request.delete(
      `/v1/documents/${document.id}/comments/${comment.id}`,
      { headers: { Origin: APP_ORIGIN } },
    );
    expect(deleted.ok()).toBe(true);
    const notice = thread
      .getByRole("status")
      .filter({ hasText: "This thread was deleted." });
    await expect(notice).toContainText("R9 to delete IMPORTANT UNSAVED EDIT", {
      timeout: 15_000,
    });
    await expect(notice).toContainText("UNSENT REPLY WORDS");
    await notice.getByRole("button", { name: "Copy my text" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "R9 to delete IMPORTANT UNSAVED EDIT\n\nUNSENT REPLY WORDS",
    );
    await notice.getByRole("button", { name: "Discard" }).click();
    await expect(thread).toBeHidden();
  });
}

test("a reply that someone deletes during its edit keeps the words, in the open thread", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Reply delete r9");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "R9 thread stays", {
    quote: "Write the notes.",
  });
  const reply = await page.request.post(
    `/v1/documents/${document.id}/comments/${comment.id}/replies`,
    { headers: { Origin: APP_ORIGIN }, data: { body: "R9 reply to delete" } },
  );
  const { id: replyId } = (await reply.json()) as { id: string };
  const thread = await openThread(page, document.id, comment.id, "R9 thread stays");
  await thread.getByText("R9 reply to delete", { exact: true }).hover();
  await thread.getByRole("button", { name: "Message actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await thread.getByRole("combobox", { name: "Edit reply" }).pressSequentially(" MINE");

  const deleted = await page.request.delete(
    `/v1/documents/${document.id}/comments/${replyId}`,
    { headers: { Origin: APP_ORIGIN } },
  );
  expect(deleted.ok()).toBe(true);
  const notice = thread
    .getByRole("status")
    .filter({ hasText: "This reply was deleted." });
  await expect(notice).toContainText("R9 reply to delete MINE", { timeout: 15_000 });
  await expect(thread.getByText("R9 thread stays", { exact: true })).toBeVisible();
});

test("a reply shows as sending while it posts, and a failed one goes back in the field", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Sending r9");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "R9 sending", {
    quote: "Write the notes.",
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  let fail = false;
  await page.route(
    `**/v1/documents/${document.id}/comments/*/replies`,
    async (route) => {
      if (fail) return route.fulfill({ status: 503, body: "" });
      // The server gets the reply only on release. A reply that the server
      // already holds comes back by the live stream, and shows as posted.
      await released;
      await route.fulfill({ response: await route.fetch() });
    },
  );
  const thread = await openThread(page, document.id, comment.id, "R9 sending");
  const field = thread.getByPlaceholder("Reply…");
  await field.fill("Double enter");
  await field.press("Enter");
  await expect(field).toHaveValue("");
  const sending = thread.locator("[aria-busy]").filter({ hasText: "Sending…" });
  await expect(sending).toContainText("Double enter");
  await expect(sending).toHaveCSS("opacity", "0.6");
  release();
  await expect(thread.getByText("1 reply")).toBeVisible();
  await expect(sending).toBeHidden();

  fail = true;
  await field.fill("Lost in the network");
  await field.press("Enter");
  await expect(field).toHaveValue("Lost in the network");
  await expect(sending).toBeHidden();
});

test("a new comment shows as sending while it posts", async ({ page, slashdocs }) => {
  const title = uniqueName("Sending comment r9");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("button", { name: "Comment on a spot" }).click();
  await bridge(page).frameLocator("iframe#slashdocs-doc").locator("#intro").click();
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/v1/documents/${document.id}/comments`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const response = await route.fetch();
    await released;
    await route.fulfill({ response });
  });
  const composer = page.getByRole("dialog", { name: "New comment" });
  const field = composer.getByPlaceholder("Add a comment…");
  await field.fill("R9 first words");
  await field.press("Enter");
  await expect(field).toHaveValue("");
  await expect(
    composer.locator("[aria-busy]").filter({ hasText: "Sending…" }),
  ).toContainText("R9 first words");
  release();
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await expect(thread.getByText("R9 first words", { exact: true })).toBeVisible();
});
