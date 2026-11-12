import { type Page } from "@playwright/test";
import {
  APP_ORIGIN,
  expect,
  renderedDocument,
  reviewerOn,
  test,
  uniqueName,
} from "./fixtures";

// Comments under races, and the reading of a commented document. Typed words
// are never lost: a slow post, a change from another person while a thread
// or its editor is open, the same draft in two tabs, and a thread that
// someone deletes. The words of a deleted thread stay in the Drafts of the
// comments list. Unread threads show across two readers, N and Shift+N go
// from thread to thread in document order, Resolve has an Undo, and a link
// pulses its thread.

function documentHTML(title: string) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    <p id="intro">Write the notes.</p>
    <p>First words.</p><p>Second words.</p><p>Third words.</p>
    <p>Closing words.</p>
  </body>
</html>`;
}

async function openThread(page: Page, docId: string, commentId: string, body: string) {
  await page.goto(`/app/d/${docId}?comment=${commentId}`);
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await expect(thread.getByText(body, { exact: true })).toBeVisible();
  return thread;
}

const threadDialog = (page: Page) =>
  page.getByRole("dialog", { name: "Comment thread" });
const commentsButton = (page: Page) =>
  page.getByRole("button", { name: "Comments", exact: true });

test("words typed while a comment posts wait as a reply to the new thread", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Held post");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("button", { name: "Comment on a spot" }).click();
  await renderedDocument(page).locator("#intro").click();

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
  await field.pressSequentially("KEEP THE LATER WORDS");
  release();

  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await expect(thread.getByText("Original words", { exact: true })).toBeVisible();
  await expect(thread.getByPlaceholder("Reply…")).toHaveValue("KEEP THE LATER WORDS");
});

test("an edit starts from the live text, and tells of a change made during it", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Live edit");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "Original", {
    quote: "Write the notes.",
  });
  const patch = (body: string) =>
    page.request.patch(`/v1/documents/${document.id}/comments/${comment.id}`, {
      headers: { Origin: APP_ORIGIN },
      data: { body },
    });
  await page.goto(`/app/d/${document.id}?comment=${comment.id}`);
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await expect(thread.getByText("Original", { exact: true })).toBeVisible();

  // Another change shows in the open thread, and the edit starts from it.
  expect((await patch("Remote update")).ok()).toBe(true);
  await expect(thread.getByText("Remote update", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await thread.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const field = thread.getByRole("combobox", { name: "Edit comment" });
  await expect(field).toHaveValue("Remote update");
  await expect(thread.getByRole("button", { name: "Save" })).toBeDisabled();

  // A change during the edit keeps the reader's words and tells of it.
  await field.pressSequentially(" and mine");
  expect((await patch("Second update")).ok()).toBe(true);
  const notice = thread
    .getByRole("status")
    .filter({ hasText: "This comment changed while you edited." });
  await expect(notice).toContainText("Second update", { timeout: 15_000 });
  await expect(field).toHaveValue("Remote update and mine");
  await notice.getByRole("button", { name: "Use the new text" }).click();
  await expect(field).toHaveValue("Second update");
  await expect(notice).toBeHidden();
});

test("a thread that another person deletes closes, also during an untouched edit", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Live delete");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "To delete", {
    quote: "Write the notes.",
  });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.goto(`/app/d/${document.id}?comment=${comment.id}`);
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await thread.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(thread.getByRole("combobox", { name: "Edit comment" })).toBeVisible();

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

test("a reply draft open in two tabs stays in sync, and a stale tab does not replace newer words", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Two tabs");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "Two tabs", {
    quote: "Write the notes.",
  });
  const tabA = await openThread(page, document.id, comment.id, "Two tabs");
  const other = await page.context().newPage();
  const tabB = await openThread(other, document.id, comment.id, "Two tabs");
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
  const title = uniqueName("Stale edit");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "Original", {
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
  const thread = await openThread(page, document.id, comment.id, "Original");
  await thread.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const field = thread.getByRole("combobox", { name: "Edit comment" });

  const newer = await page.request.patch(commentURL, {
    headers: { Origin: APP_ORIGIN },
    data: { body: "NEWER FROM TAB A" },
  });
  expect(newer.ok()).toBe(true);
  await field.pressSequentially(" STALE TAB B");
  await field.press("Enter");

  const notice = thread
    .getByRole("status")
    .filter({ hasText: "This comment changed while you edited." });
  await expect(notice).toContainText("NEWER FROM TAB A", { timeout: 15_000 });
  await expect(field).toHaveValue("Original STALE TAB B");
  const live = await page.request.get(`/v1/documents/${document.id}/comments`);
  expect(JSON.stringify(await live.json())).toContain("NEWER FROM TAB A");
});

for (const size of [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`a thread that someone deletes keeps the words not sent, with Copy my text, at ${size.width}`, async ({
    page,
    slashdocs,
  }) => {
    const title = uniqueName("Live delete");
    const document = await slashdocs.createDocument(title, documentHTML(title));
    const comment = await slashdocs.createComment(document.id, "To delete", {
      quote: "Write the notes.",
    });
    await page.setViewportSize(size);
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const thread = await openThread(page, document.id, comment.id, "To delete");
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
    await expect(notice).toContainText("To delete IMPORTANT UNSAVED EDIT", {
      timeout: 15_000,
    });
    await expect(notice).toContainText("UNSENT REPLY WORDS");
    await notice.getByRole("button", { name: "Copy my text" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "To delete IMPORTANT UNSAVED EDIT\n\nUNSENT REPLY WORDS",
    );
    await notice.getByRole("button", { name: "Discard" }).click();
    await expect(thread).toBeHidden();
  });
}

test("a reply that someone deletes during its edit keeps the words, in the open thread", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Reply delete");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "Thread stays", {
    quote: "Write the notes.",
  });
  const reply = await page.request.post(
    `/v1/documents/${document.id}/comments/${comment.id}/replies`,
    { headers: { Origin: APP_ORIGIN }, data: { body: "Reply to delete" } },
  );
  const { id: replyId } = (await reply.json()) as { id: string };
  const thread = await openThread(page, document.id, comment.id, "Thread stays");
  await thread.getByText("Reply to delete", { exact: true }).hover();
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
  await expect(notice).toContainText("Reply to delete MINE", { timeout: 15_000 });
  await expect(thread.getByText("Thread stays", { exact: true })).toBeVisible();
});

test("a reply shows as sending while it posts, and a failed one goes back in the field", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Sending");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "Slow replies", {
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
  const thread = await openThread(page, document.id, comment.id, "Slow replies");
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
  const title = uniqueName("Sending comment");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("button", { name: "Comment on a spot" }).click();
  await renderedDocument(page).locator("#intro").click();
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
  await field.fill("Fresh words");
  await field.press("Enter");
  await expect(field).toHaveValue("");
  await expect(
    composer.locator("[aria-busy]").filter({ hasText: "Sending…" }),
  ).toContainText("Fresh words");
  release();
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await expect(thread.getByText("Fresh words", { exact: true })).toBeVisible();
});

test("both texts of a two-tab reply conflict stay after Esc, a new opening and a reload", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Conflict");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "Conflict", {
    quote: "Write the notes.",
  });
  const tabA = await openThread(page, document.id, comment.id, "Conflict");
  const other = await page.context().newPage();
  const tabB = await openThread(other, document.id, comment.id, "Conflict");
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
  const title = uniqueName("Deleted");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "To delete", {
    quote: "Write the notes.",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const thread = await openThread(page, document.id, comment.id, "To delete");
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
      "To delete IMPORTANT DELETED THREAD EDIT",
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
  const title = uniqueName("One click");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.createComment(document.id, "One click", {
    quote: "Write the notes.",
  });
  await page.goto(`/app/d/${document.id}`);
  const mark = renderedDocument(page).locator("mark.slashdocs-mark").first();
  await mark.click();
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await expect(thread.getByText("One click", { exact: true })).toBeVisible();
  expect(
    await mark.evaluate((m) => m.contains(m.ownerDocument.getSelection()!.anchorNode)),
  ).toBe(true);
});

test("a posted comment opens with the focus in Reply, and a sending reply shows its count", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Posted");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("button", { name: "Comment on a spot" }).click();
  await renderedDocument(page).locator("#intro").click();
  const field = page
    .getByRole("dialog", { name: "New comment" })
    .getByPlaceholder("Add a comment…");
  await field.fill("Fresh words");
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
  await page.keyboard.type("Held reply");
  await page.keyboard.press("Enter");
  const count = thread.getByText("1 reply", { exact: true });
  await expect(count).toBeVisible();
  const field0 = await reply.boundingBox();
  release();
  await expect(thread.locator("[aria-busy]")).toBeHidden();
  // Not the 27px of a count that shows only after the send.
  expect(Math.abs((await reply.boundingBox())!.y - field0!.y)).toBeLessThan(2);
});

test("a reply by another reader shows unread until the reader reads it, also after a reload", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Unread");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.shareWithAnyone(document.id, "commenter");
  const comment = await slashdocs.createComment(document.id, "A question", {
    quote: "Second words.",
  });
  const path = `/app/d/${document.id}`;
  const reviewer = await reviewerOn(browser, path);
  const reply = await reviewer.request.post(
    `/v1/documents/${document.id}/comments/${comment.id}/replies`,
    { headers: { Origin: APP_ORIGIN }, data: { body: "An answer" } },
  );
  expect(reply.status()).toBe(201);
  await reviewer.context().close();

  await page.goto(path);
  const mark = renderedDocument(page).locator("mark.slashdocs-mark");
  await expect(mark).toHaveAttribute("data-unread", "");
  const pill = commentsButton(page).locator("span");
  await expect(pill).toHaveText("1");
  await expect(pill).toHaveClass(/bg-\[var\(--color-accent\)\]/);
  await commentsButton(page).click();
  const list = page.getByRole("dialog", { name: "Comments" });
  await expect(list.getByRole("img", { name: "Unread" })).toHaveCount(1);

  await list.getByText("A question").click();
  await expect(threadDialog(page).getByText("An answer")).toBeVisible();
  // It reads after a second in view.
  await expect(mark).not.toHaveAttribute("data-unread", "", { timeout: 5000 });
  await expect(pill).not.toHaveClass(/bg-\[var\(--color-accent\)\]/);

  await page.reload();
  await expect(renderedDocument(page).locator("mark.slashdocs-mark")).toBeVisible();
  await expect(pill).toHaveText("1");
  await expect(pill).not.toHaveClass(/bg-\[var\(--color-accent\)\]/);
  await expect(
    renderedDocument(page).locator("mark.slashdocs-mark[data-unread]"),
  ).toHaveCount(0);
});

test("N and Shift+N go from thread to thread in document order, and the popover never closes between", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Jumps");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  // Made out of document order: the list and the keys follow the document.
  for (const [body, quote] of [
    ["Note: third", "Third words."],
    ["Note: first", "First words."],
    ["Note: second", "Second words."],
  ])
    await slashdocs.createComment(document.id, body, { quote });
  await page.goto(`/app/d/${document.id}`);
  await expect(renderedDocument(page).locator("mark.slashdocs-mark")).toHaveCount(3);

  await commentsButton(page).click();
  const list = page.getByRole("dialog", { name: "Comments" });
  await expect(list.getByText(/^Note: /)).toHaveText([
    "Note: first",
    "Note: second",
    "Note: third",
  ]);
  await list.getByRole("button", { name: "Close comments" }).click();

  await page.keyboard.press("n");
  await expect(threadDialog(page).getByText("Note: first")).toBeVisible();
  // The same popover stays open through every jump.
  await threadDialog(page).evaluate((el) => (el.dataset.kept = "yes"));
  await page.keyboard.press("n");
  await expect(threadDialog(page).getByText("Note: second")).toBeVisible();
  await page.keyboard.press("n");
  await expect(threadDialog(page).getByText("Note: third")).toBeVisible();
  await page.keyboard.press("Shift+N");
  await expect(threadDialog(page).getByText("Note: second")).toBeVisible();
  await page.keyboard.press("Shift+N");
  await expect(threadDialog(page).getByText("Note: first")).toBeVisible();
  await expect(threadDialog(page)).toHaveAttribute("data-kept", "yes");

  // The document forwards the keys, as it does C.
  await page.keyboard.press("Escape");
  await expect(threadDialog(page)).toBeHidden();
  await renderedDocument(page).locator("h1").click();
  await page.keyboard.press("n");
  await expect(threadDialog(page).getByText("Note: first")).toBeVisible();
});

test("Resolve lets the thread go with an Undo that brings it back open", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Resolve");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "Resolve me", {
    quote: "First words.",
  });
  await page.goto(`/app/d/${document.id}?comment=${comment.id}`);
  await expect(threadDialog(page).getByText("Resolve me")).toBeVisible();
  const mark = renderedDocument(page).locator("mark.slashdocs-mark");
  await expect(mark).toHaveCount(1);

  await threadDialog(page).getByRole("button", { name: "Resolve comment" }).click();
  await expect(threadDialog(page)).toBeHidden();
  await expect(mark).toHaveCount(0);
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Resolved" });
  await expect(toast).toBeVisible();

  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(threadDialog(page).getByText("Resolve me")).toBeVisible();
  await expect(
    threadDialog(page).getByRole("button", { name: "Resolve comment" }),
  ).toBeVisible();
  await expect(mark).toHaveCount(1);
  await page.reload();
  await expect(renderedDocument(page).locator("mark.slashdocs-mark")).toHaveCount(1);
});

test("a link pulses its thread once the scroll ends, and tints the linked reply", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Pulse");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "Pulse here", {
    quote: "Third words.",
  });
  const reply = await page.request.post(
    `/v1/documents/${document.id}/comments/${comment.id}/replies`,
    { headers: { Origin: APP_ORIGIN }, data: { body: "Linked reply" } },
  );
  const { id: replyId } = (await reply.json()) as { id: string };

  await page.goto(`/app/d/${document.id}?comment=${replyId}`);
  const pulse = renderedDocument(page).locator(
    '.slashdocs-text-flash[style*="multiply"]',
  );
  await expect(pulse).toHaveCount(1);
  // One time: the overlay goes after 600 ms.
  await expect(pulse).toHaveCount(0);
  const linked = threadDialog(page).locator(`[data-comment-id="${replyId}"]`);
  await expect(linked).toHaveAttribute("data-linked", "");
  await expect(linked).not.toHaveAttribute("data-linked", "", { timeout: 4000 });

  // With reduced motion, the anchor holds a still outline instead.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/app/d/${document.id}?comment=${comment.id}`);
  const outline = renderedDocument(page).locator(
    '.slashdocs-text-flash[style*="box-shadow"]:not([style*="multiply"])',
  );
  await expect(outline).toHaveCount(1);
  await expect(outline).toHaveCount(0, { timeout: 4000 });
});
