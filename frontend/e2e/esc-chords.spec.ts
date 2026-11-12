import { type Page } from "@playwright/test";
import {
  bridge,
  expect,
  renderedDocument,
  startEditing,
  test,
  uniqueName,
  type SlashdocsAPI,
} from "./fixtures";

// Esc arms a chord: the next letter runs the chord of that letter only. An
// Esc that closes a thread or leaves the text is not the start of a chord.

function documentHTML(title: string) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    <p id="tail">Clients retry twice before giving up.</p>
  </body>
</html>`;
}

// Opens an earlier version, which takes no typing, so that C places a pin.
async function openEarlier(page: Page, slashdocs: SlashdocsAPI) {
  const title = uniqueName("Esc chord");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.pushVersion(document.id, documentHTML(`${title} again`));
  await page.goto(`/app/d/${document.id}?version=${document.current_version_id}`);
  await expect(renderedDocument(page).locator("h1")).toBeVisible();
}

// The keycast is hidden from screen readers. Its line runs out with the time.
const keycast = (page: Page) => page.locator('[aria-label="Time to press a letter"]');
const placeHint = (page: Page) => bridge(page).locator(".sd-place-hint");

test("Esc in the doc bar shows the chord, and C opens the comments", async ({
  page,
  slashdocs,
}) => {
  await openEarlier(page, slashdocs);
  await page.getByRole("button", { name: "Share" }).focus();
  await page.keyboard.press("Escape");
  await expect(keycast(page)).toBeVisible();
  await page.keyboard.press("c");
  await expect(page.getByRole("dialog", { name: "Comments" })).toBeVisible();
});

test("C opens the comments for as long as the chord shows, also after 800 ms", async ({
  page,
  slashdocs,
}) => {
  await openEarlier(page, slashdocs);
  await renderedDocument(page).locator("h1").click();
  await page.keyboard.press("Escape");
  await expect(keycast(page)).toBeVisible();
  await page.waitForTimeout(850);
  await expect(keycast(page)).toBeVisible();
  await page.keyboard.press("c");
  await expect(page.getByRole("dialog", { name: "Comments" })).toBeVisible();

  // Once the chord is gone, C places a pin: the next click opens a comment.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Comments" })).toBeHidden();
  await expect(keycast(page)).toBeHidden();
  await renderedDocument(page).locator("h1").click();
  await page.keyboard.press("c");
  await renderedDocument(page).locator("#tail").click();
  await expect(page.getByRole("dialog", { name: "New comment" })).toBeVisible();
});

// Each chord letter runs its chord only: C does not also place a pin, from
// the doc bar or from inside the document.
for (const from of ["the doc bar", "the document"] as const) {
  for (const key of ["t", "f", "c", "m", "h"]) {
    test(`Esc then ${key.toUpperCase()} in ${from} runs its chord only`, async ({
      page,
      slashdocs,
    }) => {
      await openEarlier(page, slashdocs);
      if (from === "the doc bar")
        await page.getByRole("button", { name: "Share" }).focus();
      else await renderedDocument(page).locator("h1").click();
      await page.keyboard.press("Escape");
      await page.keyboard.press(key);
      if (key === "h") await expect(page).toHaveURL(/\/app\/documents$/);
      else
        await expect(
          page.locator('[aria-hidden="true"]', { hasText: /^ESC\+/ }),
        ).toContainText(`ESC+${key.toUpperCase()}`);
      await page.waitForTimeout(300);
      await expect(placeHint(page)).toHaveCount(0);
    });
  }
}

// An Esc that closes a thread is the thread's: it arms no chord, so C after
// it places a pin, from the app and from the document.
for (const from of ["the thread", "the document"] as const) {
  test(`Esc that closes a thread from ${from} arms no chord`, async ({
    page,
    slashdocs,
  }) => {
    const title = uniqueName("Esc thread");
    const document = await slashdocs.createDocument(title, documentHTML(title));
    await slashdocs.createComment(document.id, "Why twice?", {
      quote: "retry twice",
    });
    // An earlier version takes no typing.
    await slashdocs.pushVersion(document.id, documentHTML(`${title} again`));
    await page.goto(`/app/d/${document.id}?version=${document.current_version_id}`);
    const doc = renderedDocument(page);
    await expect(doc.locator("h1")).toHaveText(title);

    const thread = page.getByRole("dialog", { name: "Comment thread" });
    const mark = doc.locator("mark.slashdocs-mark").first();
    await mark.click();
    await expect(thread).toBeVisible();
    if (from === "the thread") await thread.focus();
    await page.keyboard.press("Escape");
    await expect(thread).toBeHidden();
    await page.waitForTimeout(200);
    await expect(keycast(page)).toHaveCount(0);

    if (from === "the document") await doc.locator("h1").click();
    await page.keyboard.press("c");
    await expect(placeHint(page)).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Comments" })).toBeHidden();
  });
}

// An Esc in the text leaves Edit mode, and arms no chord. In Comment mode,
// Esc arms the chord.
test("Esc that leaves the text arms no chord", async ({ page, slashdocs }) => {
  const title = uniqueName("Esc text");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await startEditing(page);
  await doc.locator("#tail").click();

  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  await expect(keycast(page)).toHaveCount(0);

  // In Comment mode, Esc, then C opens the comments.
  await page.waitForTimeout(1200);
  await page.keyboard.press("Escape");
  await expect(keycast(page)).toBeVisible();
  await page.keyboard.press("c");
  await expect(page.getByRole("dialog", { name: "Comments" })).toBeVisible();
  await expect(placeHint(page)).toBeHidden();
});
