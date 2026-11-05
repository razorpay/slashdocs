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
  <head><meta charset="utf-8"><title>${title}</title>
  <style>body{max-width:760px;margin:40px auto;padding:0 16px;font:16px/1.5 sans-serif}</style></head>
  <body>
    <h1>${title}</h1>
    <p id="intro">Plain text with some words. Clients retry twice before giving up.</p>
    <p>Closing words.</p>
  </body>
</html>`;
}

test("the link field keeps its place and its width while the reader types", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Link");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await expect(doc.locator("body")).toHaveAttribute("contenteditable", "true");
  await doc.locator("#intro").evaluate((element) => {
    const d = element.ownerDocument;
    const text = element.firstChild as Text;
    const start = text.data.indexOf("twice");
    d.body.focus();
    d.getSelection()!.setBaseAndExtent(text, start, text, start + 5);
  });
  await page.keyboard.press("ControlOrMeta+k");
  const field = doc.getByRole("textbox", { name: "Link address" });
  const card = doc.locator(".slashdocs-link-input > div");
  await expect(field).toBeFocused();
  // The card waits out its entrance before it is measured.
  await page.waitForTimeout(300);
  // Below the words it keeps its top, and above them its bottom.
  const words = (await doc.locator("#intro").boundingBox())!;
  const place = async () => {
    const { x, y, width, height } = (await card.boundingBox())!;
    return { x, width, edge: y >= words.y ? y : y + height };
  };
  const opened = await place();

  // A refused address, then a long one with a preview of two lines.
  await field.fill("exa mple");
  await field.press("Enter");
  await expect(card.locator("p")).toHaveText("This is not a link.");
  expect(await place()).toEqual(opened);
  await field.fill(`example.com/${"a-long-path/".repeat(8)}`);
  await expect(card.locator("p")).toContainText("Links to https://example.com/");
  expect(await place()).toEqual(opened);
});
