import { type FrameLocator, type Locator, type Page } from "@playwright/test";
import { expect, reviewerOn, test, uniqueName } from "./fixtures";

// Two people edit one document: the admin and a reviewer (dev/dex-config.yaml).

function bridge(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Rendered document"]');
}

function renderedDocument(page: Page): FrameLocator {
  return bridge(page).frameLocator("iframe#slashdocs-doc");
}

function documentHTML(title: string, changed = "") {
  const paragraphs = Array.from(
    { length: 30 },
    (_, i) =>
      `<p id="p${i}">Paragraph ${i}${i === 12 ? changed : ""}. The quick brown fox jumps over the lazy dog.</p>`,
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>${paragraphs}</body></html>`;
}

async function overlaps(a: Locator, b: Locator) {
  const [x, y] = [await a.boundingBox(), await b.boundingBox()];
  return (
    x!.x < y!.x + y!.width &&
    y!.x < x!.x + x!.width &&
    x!.y < y!.y + y!.height &&
    y!.y < x!.y + x!.height
  );
}

test("an editor sees who edits a block, beside it, until they leave the text", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Editing here");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.shareWithAnyone(document.id, "editor");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reviewer = await reviewerOn(browser, path);
  await expect(page.getByRole("button", { name: /^reviewer/ })).toBeVisible();

  const block = renderedDocument(reviewer).locator("#p12");
  await expect(renderedDocument(reviewer).locator("body")).toHaveAttribute(
    "contenteditable",
    "true",
  );
  await block.click();
  await reviewer.keyboard.press("End");
  await reviewer.keyboard.type(" Two");

  const mark = bridge(page).getByText(/^reviewer.* is editing$/);
  await expect(mark).toBeVisible();
  const paragraph = renderedDocument(page).locator("#p12");
  expect(await overlaps(mark, paragraph)).toBe(false);
  const [label, text] = [await mark.boundingBox(), await paragraph.boundingBox()];
  expect(Math.abs(label!.y - text!.y)).toBeLessThan(40);

  // The mark goes when the reviewer leaves the text.
  await reviewer.keyboard.press("Escape");
  await expect(mark).toBeHidden();
  await reviewer.context().close();
});

test("a reader's other tab shows where they edit", async ({ page, slashdocs }) => {
  const title = uniqueName("Other tab");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const other = await page.context().newPage();
  await other.goto(path);
  await expect(renderedDocument(other).locator("body")).toHaveAttribute(
    "contenteditable",
    "true",
  );
  await renderedDocument(other).locator("#p3").click();
  await other.keyboard.type("x");
  await expect(bridge(page).getByText("You are editing in another tab")).toBeVisible();
  await other.close();
});

test("Show changes flashes the blocks that changed elsewhere", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Show changes");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await expect(doc.locator("#p12")).toBeVisible();

  await slashdocs.pushVersion(document.id, documentHTML(title, " changed"));
  await page.getByRole("button", { name: "Show changes", exact: true }).click();
  await expect(doc.locator("#p12")).toContainText("Paragraph 12 changed");
  const flash = doc.locator(".slashdocs-text-flash");
  await expect(flash).toHaveCount(1);
  expect(await overlaps(flash, doc.locator("#p12"))).toBe(true);
});

test("the document stays still while the comment composer opens", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Composer");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await doc.locator("body").evaluate(() => window.scrollTo(0, 37));
  await doc.locator("#p12").selectText();
  const scrollY = () => doc.locator("body").evaluate(() => window.scrollY);
  await doc.getByRole("button", { name: "Comment on selected text" }).click();
  await expect(page.getByPlaceholder("Add a comment…")).toBeFocused();
  // A smooth scroll would have moved by now.
  await page.waitForTimeout(400);
  expect(await scrollY()).toBe(37);
});
