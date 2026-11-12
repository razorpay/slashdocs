import { type FrameLocator, type Page } from "@playwright/test";
import { APP_ORIGIN, expect, reviewerOn, test, uniqueName } from "./fixtures";

// Reading a commented document: unread threads across two readers, J and K
// from thread to thread in document order with no popover flicker, resolve
// with Undo, and the pulse after a link.

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

function documentHTML(title: string) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body><h1>${title}</h1><p>First words.</p><p>Second words.</p><p>Third words.</p></body>
</html>`;
}

const thread = (page: Page) => page.getByRole("dialog", { name: "Comment thread" });
const commentsButton = (page: Page) =>
  page.getByRole("button", { name: "Comments", exact: true });

test("a reply by another reader shows unread until the reader reads it, also after a reload", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Unread r12");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.shareWithAnyone(document.id, "commenter");
  const comment = await slashdocs.createComment(document.id, "R12 ask", {
    quote: "Second words.",
  });
  const path = `/app/d/${document.id}`;
  const reviewer = await reviewerOn(browser, path);
  const reply = await reviewer.request.post(
    `/v1/documents/${document.id}/comments/${comment.id}/replies`,
    { headers: { Origin: APP_ORIGIN }, data: { body: "R12 answer" } },
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

  await list.getByText("R12 ask").click();
  await expect(thread(page).getByText("R12 answer")).toBeVisible();
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

test("J and K go from thread to thread in document order, and the popover never closes between", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Jumps r12");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  // Made out of document order: the list and the keys follow the document.
  for (const [body, quote] of [
    ["R12 third", "Third words."],
    ["R12 first", "First words."],
    ["R12 second", "Second words."],
  ])
    await slashdocs.createComment(document.id, body, { quote });
  await page.goto(`/app/d/${document.id}`);
  await expect(renderedDocument(page).locator("mark.slashdocs-mark")).toHaveCount(3);

  await commentsButton(page).click();
  const list = page.getByRole("dialog", { name: "Comments" });
  await expect(list.getByText(/^R12 /)).toHaveText([
    "R12 first",
    "R12 second",
    "R12 third",
  ]);
  await list.getByRole("button", { name: "Close comments" }).click();

  await page.keyboard.press("j");
  await expect(thread(page).getByText("R12 first")).toBeVisible();
  // The same popover stays open through every jump.
  await thread(page).evaluate((el) => (el.dataset.kept = "yes"));
  await page.keyboard.press("j");
  await expect(thread(page).getByText("R12 second")).toBeVisible();
  await page.keyboard.press("n");
  await expect(thread(page).getByText("R12 third")).toBeVisible();
  await page.keyboard.press("k");
  await expect(thread(page).getByText("R12 second")).toBeVisible();
  await page.keyboard.press("p");
  await expect(thread(page).getByText("R12 first")).toBeVisible();
  await expect(thread(page)).toHaveAttribute("data-kept", "yes");

  // The document forwards the keys, as it does C.
  await page.keyboard.press("Escape");
  await expect(thread(page)).toBeHidden();
  await renderedDocument(page).locator("h1").click();
  await page.keyboard.press("j");
  await expect(thread(page).getByText("R12 first")).toBeVisible();
});

test("Resolve lets the thread go with an Undo that brings it back open", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Resolve r12");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "R12 resolve me", {
    quote: "First words.",
  });
  await page.goto(`/app/d/${document.id}?comment=${comment.id}`);
  await expect(thread(page).getByText("R12 resolve me")).toBeVisible();
  const mark = renderedDocument(page).locator("mark.slashdocs-mark");
  await expect(mark).toHaveCount(1);

  await thread(page).getByRole("button", { name: "Resolve comment" }).click();
  await expect(thread(page)).toBeHidden();
  await expect(mark).toHaveCount(0);
  const toast = page.locator("[data-sonner-toast]").filter({ hasText: "Resolved" });
  await expect(toast).toBeVisible();

  await toast.getByRole("button", { name: "Undo" }).click();
  await expect(thread(page).getByText("R12 resolve me")).toBeVisible();
  await expect(
    thread(page).getByRole("button", { name: "Resolve comment" }),
  ).toBeVisible();
  await expect(mark).toHaveCount(1);
  await page.reload();
  await expect(renderedDocument(page).locator("mark.slashdocs-mark")).toHaveCount(1);
});

test("a link pulses its thread once the scroll ends, and tints the linked reply", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Pulse r12");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "R12 pulse", {
    quote: "Third words.",
  });
  const reply = await page.request.post(
    `/v1/documents/${document.id}/comments/${comment.id}/replies`,
    { headers: { Origin: APP_ORIGIN }, data: { body: "R12 linked reply" } },
  );
  const { id: replyId } = (await reply.json()) as { id: string };

  await page.goto(`/app/d/${document.id}?comment=${replyId}`);
  const pulse = renderedDocument(page).locator(
    '.slashdocs-text-flash[style*="multiply"]',
  );
  await expect(pulse).toHaveCount(1);
  // One time: the overlay goes after 600 ms.
  await expect(pulse).toHaveCount(0);
  const linked = thread(page).locator(`[data-comment-id="${replyId}"]`);
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
