import { type FrameLocator, type Page } from "@playwright/test";
import { expect, test, uniqueName } from "./fixtures";

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

function documentHTML(title: string, step = "Write the notes.") {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    <ul><li>Read the brief.</li><li id="step">${step}</li><li>Ship it.</li></ul>
  </body>
</html>`;
}

test("Show changes flashes the list item that changed", async ({ page, slashdocs }) => {
  const title = uniqueName("Change flash");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await expect(doc.locator("#step")).toBeVisible();

  await slashdocs.pushVersion(
    document.id,
    documentHTML(title, "Write the notes again."),
  );
  await page.getByRole("button", { name: "Show changes" }).click();
  await expect(doc.locator("#step")).toHaveText("Write the notes again.");
  await expect(doc.locator(".slashdocs-text-flash")).toHaveCount(1);
});

test("the offer of changes made elsewhere waits for the reader", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Changed elsewhere");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  await expect(renderedDocument(page).locator("#step")).toBeVisible();

  await slashdocs.pushVersion(
    document.id,
    documentHTML(title, "Write the notes again."),
  );
  // The offer waits in the doc bar, and does not go by itself.
  const offer = page.getByRole("button", { name: "Show changes" });
  await expect(offer).toBeVisible();
  await expect(
    page.getByRole("status").getByText("This document changed elsewhere."),
  ).toBeAttached();
  await page.waitForTimeout(5000);
  await expect(offer).toBeVisible();

  await offer.click();
  await expect(offer).toBeHidden();
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
]) {
  test(`at ${viewport.width}px, Esc in a reply gives the focus back to Comments`, async ({
    page,
    slashdocs,
  }) => {
    await page.setViewportSize(viewport);
    const title = uniqueName("Thread focus");
    const document = await slashdocs.createDocument(title, documentHTML(title));
    await slashdocs.createComment(document.id, "Which notes?", {
      quote: "Write the notes.",
    });
    await page.goto(`/app/d/${document.id}`);
    await expect(renderedDocument(page).locator("#step")).toBeVisible();

    const comments = page.getByRole("button", { name: "Comments", exact: true });
    await comments.click();
    const row = page
      .getByRole("dialog", { name: "Comments" })
      .getByRole("button")
      .filter({ hasText: "Which notes?" });
    await row.focus();
    await page.keyboard.press("Enter");
    const thread = page.getByRole("dialog", { name: "Comment thread" });
    await thread.getByPlaceholder("Reply…").fill("Half a reply");
    await page.keyboard.press("Escape");
    await expect(thread).toBeHidden();
    await expect(comments).toBeFocused();
  });
}
