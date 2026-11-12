import { type Locator, type Page } from "@playwright/test";
import {
  APP_ORIGIN,
  bridge,
  expect,
  overlaps,
  renderedDocument,
  reviewerOn,
  signedOutPage,
  startEditing,
  test,
  uniqueName,
} from "./fixtures";

// Two people have one document open: the admin and a reviewer
// (dev/dex-config.yaml). Each one sees where the other reads and edits.

function documentHTML(title: string) {
  const sections = Array.from(
    { length: 40 },
    (_, i) =>
      `<section id="s${i}" style="height:400px"><h2>Section ${i}</h2></section>`,
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>${sections}</body></html>`;
}

// Thirty paragraphs to edit. changed goes after the number of paragraph 12.
function editorsHTML(title: string, changed = "") {
  const paragraphs = Array.from(
    { length: 30 },
    (_, i) =>
      `<p id="p${i}">Paragraph ${i}${i === 12 ? changed : ""}. The quick brown fox jumps over the lazy dog.</p>`,
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>${paragraphs}</body></html>`;
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
    overlaps(box, { ...line, x: block.x + line.x, y: block.y + line.y }),
  );
}

// pointAt moves the pointer over the document, which sends this viewer's
// cursor to the others.
async function pointAt(page: Page, selector: string) {
  const box = await renderedDocument(page).locator(selector).boundingBox();
  await page.mouse.move(box!.x + 40, box!.y + 20);
  await page.mouse.move(box!.x + 60, box!.y + 30);
}

test("chats at the cursor, and follows a viewer until the reader scrolls", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Live");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.shareWithAnyone(document.id, "commenter");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reviewer = await reviewerOn(browser, path);
  const avatar = page.getByRole("button", { name: /^reviewer/ });
  await expect(avatar).toBeVisible();

  // "/" opens the chat at the reviewer's cursor; the admin sees it live.
  await pointAt(reviewer, "#s0 h2");
  await reviewer.keyboard.press("/");
  const field = bridge(reviewer).getByRole("textbox", { name: "Cursor chat message" });
  await expect(field).toBeFocused();
  await field.pressSequentially("Look here");
  await expect(bridge(page).getByText("Look here", { exact: true })).toBeVisible();
  await field.press("Enter");
  await expect(field).toBeHidden();

  // The menu of an avatar follows the viewer, or goes there only once.
  await avatar.click();
  await page.getByRole("menuitem", { name: /Follow reviewer/ }).click();
  const stop = page.getByRole("button", { name: /Stop following reviewer/ });
  await expect(stop).toBeVisible();
  const scrollY = (p: Page) =>
    renderedDocument(p)
      .locator("html")
      .evaluate(() => window.scrollY);
  await renderedDocument(reviewer)
    .locator("#s20")
    .evaluate((el) => el.scrollIntoView());
  await expect.poll(() => scrollY(page), { timeout: 10_000 }).toBeGreaterThan(6000);

  // The reader's own scroll stops following.
  const box = await page.locator('iframe[title="Rendered document"]').boundingBox();
  await page.mouse.move(box!.x + 200, box!.y + 200);
  await page.mouse.wheel(0, -400);
  await expect(stop).toBeHidden();
  await reviewer.context().close();
});

test("a signed-out reader sees cursor chat but cannot send it", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Live public");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.shareWithAnyone(document.id, "commenter");
  const path = `/app/d/${document.id}`;
  const reader = await signedOutPage(browser);
  await reader.goto(path);
  await expect(renderedDocument(reader).locator("h1")).toBeVisible();
  await page.goto(path);

  // The admin chats; the signed-out reader sees it live.
  await pointAt(page, "#s0 h2");
  await page.keyboard.press("/");
  const field = bridge(page).getByRole("textbox", { name: "Cursor chat message" });
  await field.pressSequentially("Hello readers");
  await expect(
    bridge(reader).getByText("Hello readers", { exact: true }),
  ).toBeVisible();

  // The reader's "/" opens no field, and their cursor goes to no one.
  const posts: string[] = [];
  reader.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/cursor"))
      posts.push(request.url());
  });
  await pointAt(reader, "#s0 h2");
  await reader.keyboard.press("/");
  await expect(
    bridge(reader).getByRole("textbox", { name: "Cursor chat message" }),
  ).toBeHidden();
  await reader.waitForTimeout(500);
  expect(posts).toEqual([]);
  await reader.context().close();
});

test("an editor sees the caret, the name and the selection of another editor, until they leave the text", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Editing here");
  const document = await slashdocs.createDocument(title, editorsHTML(title));
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
  expect(overlaps(at, text)).toBe(true);
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
  const document = await slashdocs.createDocument(title, editorsHTML(title));
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
  const document = await slashdocs.createDocument(title, editorsHTML(title));
  await slashdocs.shareWithAnyone(document.id, "viewer");
  await slashdocs.pushVersion(document.id, editorsHTML(title, " again"));
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
  const document = await slashdocs.createDocument(title, editorsHTML(title));
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

test("the doc bar names the followed viewer, and stops following from the keyboard", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Follow in bar");
  const document = await slashdocs.createDocument(title, `<h1>${title}</h1>`);
  await slashdocs.shareWithAnyone(document.id, "viewer");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reviewer = await reviewerOn(browser, path);

  await page.getByRole("button", { name: /^reviewer/ }).click();
  await page.getByRole("menuitem", { name: /Follow reviewer/ }).click();
  const stop = page.getByRole("button", { name: /Stop following reviewer/ });
  await expect(stop).toHaveText(/Following reviewer/);
  // The frame over the document has a border only, over no text.
  const frame = bridge(page).locator(".slashdocs-follow");
  await expect(frame).toHaveAttribute("data-on");
  await expect(frame).toBeEmpty();

  await stop.focus();
  await page.keyboard.press("Enter");
  await expect(stop).toBeHidden();
  await expect(frame).not.toHaveAttribute("data-on");
  await reviewer.context().close();
});
