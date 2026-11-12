import { type FrameLocator, type Locator, type Page } from "@playwright/test";
import {
  APP_ORIGIN,
  expect,
  reviewerOn,
  startEditing,
  test,
  uniqueName,
} from "./fixtures";

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

type Box = { x: number; y: number; width: number; height: number };

function overlap(x: Box, y: Box) {
  return (
    x.x < y.x + y.width &&
    y.x < x.x + x.width &&
    x.y < y.y + y.height &&
    y.y < x.y + x.height
  );
}

async function overlaps(a: Locator, b: Locator) {
  return overlap((await a.boundingBox())!, (await b.boundingBox())!);
}

// coversText tells whether a covers a line of the text of b. The lines go
// from the viewport of b's frame to the page by the offset of b.
async function coversText(a: Locator, b: Locator) {
  const [box, block] = [(await a.boundingBox())!, (await b.boundingBox())!];
  const lines = await b.evaluate((el) => {
    const range = el.ownerDocument.createRange();
    range.selectNodeContents(el);
    const { left, top } = el.getBoundingClientRect();
    return [...range.getClientRects()].map((line) => ({
      x: line.left - left,
      y: line.top - top,
      width: line.width,
      height: line.height,
    }));
  });
  return lines.some((line) =>
    overlap(box, { ...line, x: block.x + line.x, y: block.y + line.y }),
  );
}

test("an editor sees the caret, the name and the selection of another editor, until they leave the text", async ({
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
  await startEditing(reviewer);
  await block.click();
  await reviewer.keyboard.press("End");
  await reviewer.keyboard.type(" Two");

  // A thin caret is where the reviewer types, at the end of the text, with
  // a flag that shows their name only.
  const mark = bridge(page).locator(".slashdocs-edit[data-caret]");
  const [caret, flag, wash] = ["u", "em", "b"].map((tag) => mark.locator(tag));
  await expect(flag).toBeVisible();
  await expect(flag).toHaveText("reviewer");
  await expect(bridge(page).getByText(/is editing$/)).toBeHidden();
  const paragraph = renderedDocument(page).locator("#p12");
  await expect(paragraph).toContainText("lazy dog. Two");
  const textEnd = async () =>
    (await paragraph.boundingBox())!.x +
    (await paragraph.evaluate((el) => {
      const range = el.ownerDocument.createRange();
      range.selectNodeContents(el);
      return range.getBoundingClientRect().right - el.getBoundingClientRect().left;
    }));
  await expect
    .poll(async () => Math.abs((await caret.boundingBox())!.x - (await textEnd())))
    .toBeLessThanOrEqual(3);
  const [at, name, text] = [
    (await caret.boundingBox())!,
    (await flag.boundingBox())!,
    (await paragraph.boundingBox())!,
  ];
  expect(at.width).toBeLessThanOrEqual(2);
  expect(overlap(at, text)).toBe(true);
  // The flag starts at the caret, on top of it, and covers no text.
  expect(Math.abs(name.x - at.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(name.y + name.height - at.y)).toBeLessThanOrEqual(2);
  expect(await coversText(flag, paragraph)).toBe(false);
  expect(await coversText(flag, renderedDocument(page).locator("#p11"))).toBe(false);
  await expect(wash).toHaveCount(0);

  // A light wash is on the word that the reviewer selects, from the end
  // of the text back to the caret.
  for (let i = 0; i < "Two".length; i++)
    await reviewer.keyboard.press("Shift+ArrowLeft");
  await expect(wash).toHaveCount(1);
  const selected = (await wash.boundingBox())!;
  expect(selected.width).toBeGreaterThan(10);
  expect(Math.abs(selected.x + selected.width - (await textEnd()))).toBeLessThanOrEqual(
    3,
  );
  expect(Math.abs(selected.y - at.y)).toBeLessThanOrEqual(3);
  await expect
    .poll(async () => Math.abs((await caret.boundingBox())!.x - selected.x))
    .toBeLessThanOrEqual(3);

  // The wash goes with the selection, and the mark goes when the reviewer
  // leaves the text.
  await reviewer.keyboard.press("ArrowRight");
  await expect(wash).toHaveCount(0);
  await expect(flag).toBeVisible();
  await reviewer.keyboard.press("Escape");
  await expect(mark).toHaveCount(0);
  await expect(bridge(page).locator(".slashdocs-edit")).toHaveCount(0);
  await reviewer.context().close();
});

test("Jump to a person keeps Edit mode, shows their caret in the middle of the view, and typing goes on", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Jump");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.shareWithAnyone(document.id, "editor");
  const path = `/app/d/${document.id}`;
  // The view is short, so the document is much longer than it.
  await page.setViewportSize({ width: 1280, height: 400 });
  await page.goto(path);
  const reviewer = await reviewerOn(browser, path);
  const avatar = page.getByRole("button", { name: /^reviewer/ });
  await expect(avatar).toBeVisible();

  // The admin edits at the top, and the reviewer far below.
  await startEditing(page);
  await renderedDocument(page).locator("#p1").click();
  await page.keyboard.type(" One");
  await startEditing(reviewer);
  const theirs = renderedDocument(reviewer).locator("#p20");
  await theirs.evaluate((el) => el.scrollIntoView());
  await theirs.click();
  await reviewer.keyboard.press("End");
  await reviewer.keyboard.type(" Two");
  const there = renderedDocument(page).locator("#p20");
  await expect(there).toContainText("lazy dog. Two");
  // It is below what the admin sees.
  expect((await there.boundingBox())!.y).toBeGreaterThan(page.viewportSize()!.height);

  await avatar.click();
  await page.getByRole("menuitem", { name: "Jump to reviewer" }).click();
  const caret = bridge(page).locator(".slashdocs-edit[data-caret] u");
  const frame = (await page
    .locator('iframe[title="Rendered document"]')
    .boundingBox())!;
  await expect
    .poll(async () => {
      const at = await caret.boundingBox();
      return at ? Math.abs(at.y + at.height / 2 - (frame.y + frame.height / 2)) : null;
    })
    .toBeLessThan(frame.height / 8);

  // The admin is still in Edit mode, and types beside the reviewer.
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await expect(renderedDocument(page).locator("body")).toHaveAttribute(
    "contenteditable",
    "true",
  );
  await renderedDocument(page).locator("#p19").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Three");
  for (const p of [page, reviewer]) {
    await expect(renderedDocument(p).locator("#p19")).toContainText("lazy dog. Three");
    await expect(renderedDocument(p).locator("#p1")).toContainText("lazy dog. One");
  }
  await reviewer.context().close();
});

test("a restore tells the other people who have the document open who did it", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Restore told");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.shareWithAnyone(document.id, "viewer");
  await slashdocs.pushVersion(document.id, documentHTML(title, " again"));
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reviewer = await reviewerOn(browser, path);
  const changed = renderedDocument(reviewer).locator("#p12");
  await expect(changed).toContainText("Paragraph 12 again.");

  const restored = await page.request.post(
    `/v1/documents/${document.id}/versions/${document.current_version_id}/restore`,
    { headers: { Origin: APP_ORIGIN } },
  );
  expect(restored.ok()).toBe(true);
  await expect(
    reviewer.getByText("admin restored an earlier state of this document."),
  ).toBeVisible();
  // The person who restored gets no such message.
  await expect(page.getByText(/restored an earlier state/)).toHaveCount(0);
  await expect(changed).toContainText("Paragraph 12.");
  await reviewer.context().close();
});

test("a reader's other tab shows where they edit", async ({ page, slashdocs }) => {
  const title = uniqueName("Other tab");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const other = await page.context().newPage();
  await other.goto(path);
  await startEditing(other);
  await renderedDocument(other).locator("#p3").click();
  await other.keyboard.type("x");
  await expect(bridge(page).getByText("You are editing in another tab")).toBeVisible();
  await other.close();
});

test("a small change made elsewhere flashes the block that changed", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Change flash");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await expect(doc.locator("#p12")).toBeVisible();

  // The change goes into the page in place: the reader asks for nothing.
  await slashdocs.pushVersion(document.id, documentHTML(title, " changed"));
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
