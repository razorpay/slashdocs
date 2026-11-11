import { type FrameLocator, type Page } from "@playwright/test";
import {
  expect,
  openEditable,
  reviewerOn,
  startEditing,
  test,
  uniqueName,
} from "./fixtures";

// Each document opens in Comment mode. An editor starts Edit mode with E or
// the switch in the bar, and leaves it with C, Done, the switch, or a second
// Esc, once their edits are saved.

function bridge(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Rendered document"]');
}

function renderedDocument(page: Page): FrameLocator {
  return bridge(page).frameLocator("iframe#slashdocs-doc");
}

// A script that changes the page all the time, as a live chart does.
function documentHTML(title: string) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title>
    <style>body{max-width:720px;margin:40px auto;font:16px/1.5 sans-serif}</style>
  </head>
  <body>
    <h1>${title}</h1>
    <p id="intro">Clients retry twice before giving up.</p>
    <p id="tail">The notes say why.</p>
    <p id="clock"></p>
    <script>setInterval(() => (clock.dataset.at = String(Date.now())), 40);</script>
  </body>
</html>`;
}

const mode = (page: Page) => page.getByRole("radiogroup", { name: "Mode" });
const editingText = (page: Page) =>
  expect(renderedDocument(page).locator("body")).toHaveAttribute(
    "contenteditable",
    "true",
  );
const commentingText = (page: Page) =>
  expect(renderedDocument(page).locator("body")).not.toHaveAttribute(
    "contenteditable",
    "true",
  );

test("a document opens in Comment mode, and E and C switch modes from the document", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Modes");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  await expect(mode(page).getByRole("radio", { name: "Comment" })).toBeChecked();
  await commentingText(page);

  // C in Comment mode places a pin, as it did.
  const doc = renderedDocument(page);
  await doc.locator("#tail").click();
  await page.keyboard.press("c");
  await expect(bridge(page).locator(".sd-place-hint")).toBeVisible();
  await page.keyboard.press("Escape");

  // E starts Edit mode, and a click puts the caret at its point.
  await page.keyboard.press("e");
  await editingText(page);
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  await doc.locator("#tail").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Clearly.");
  await expect(doc.locator("#tail")).toHaveText("The notes say why. Clearly.");

  // Esc leaves the text, and C after it goes back to Comment mode.
  await page.keyboard.press("Escape");
  await page.keyboard.press("c");
  await expect(mode(page).getByRole("radio", { name: "Comment" })).toBeChecked();
  await commentingText(page);
  await expect(bridge(page).locator(".sd-place-hint")).toBeHidden();
});

test("E with text selected puts the caret there, and a second Esc leaves Edit mode", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Select edit");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const intro = renderedDocument(page).locator("#intro");
  await intro.click();
  await intro.evaluate((p) => {
    const text = p.firstChild as Text;
    const at = text.data.indexOf("twice");
    p.ownerDocument.getSelection()!.setBaseAndExtent(text, at, text, at + 5);
  });
  await page.keyboard.press("e");
  await editingText(page);
  await page.keyboard.type("three times");
  await expect(intro).toHaveText("Clients retry three times before giving up.");

  await page.keyboard.press("Escape");
  await expect(mode(page).getByRole("radio", { name: "Edit" })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(mode(page).getByRole("radio", { name: "Comment" })).toBeChecked();
});

test("Done saves an edit that waits for its pause before Comment mode", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Done");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await openEditable(page, document.id);
  await renderedDocument(page).locator("#tail").click();
  await page.keyboard.press("End");
  const saved = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/source-edits"),
  );
  await page.keyboard.type(" Now.");
  // Before the pause of typing ends, Done saves at once.
  await page.getByRole("button", { name: "Done", exact: true }).click();
  expect((await saved).status()).toBe(201);
  await expect(mode(page).getByRole("radio", { name: "Comment" })).toBeChecked();
  await expect(page.getByRole("button", { name: "Done", exact: true })).toBeHidden();
  await commentingText(page);

  // Edit mode again keeps the saved edit, and the next save holds both.
  await startEditing(page);
  await renderedDocument(page).locator("#intro").click();
  await page.keyboard.press("End");
  const next = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/source-edits"),
  );
  await page.keyboard.type(" Twice.");
  expect((await next).status()).toBe(201);
  const latest = await page.request.get(`/v1/documents/${document.id}`);
  const { current_version_id } = (await latest.json()) as {
    current_version_id: string;
  };
  const html = await (
    await page.request.get(
      `/v1/documents/${document.id}/versions/${current_version_id}/html`,
    )
  ).text();
  expect(html).toContain("The notes say why. Now.");
  expect(html).toContain("before giving up. Twice.");
});

test("an edit that does not save keeps Edit mode", async ({ page, slashdocs }) => {
  const title = uniqueName("Stay");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await openEditable(page, document.id);
  await page.route("**/source-edits", (route) => route.abort());
  await renderedDocument(page).locator("#tail").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Lost?");
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
  await expect(mode(page).getByRole("radio", { name: "Edit" })).toBeChecked();
  await editingText(page);
});

test("a reader who cannot edit sees no switch, and E does nothing", async ({
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Commenter");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.shareWithAnyone(document.id, "commenter");
  const reviewer = await reviewerOn(browser, `/app/d/${document.id}`);
  await expect(renderedDocument(reviewer).locator("h1")).toBeVisible();
  await expect(reviewer.getByText("Can comment", { exact: true })).toBeVisible();
  await expect(mode(reviewer)).toHaveCount(0);
  await renderedDocument(reviewer).locator("#tail").click();
  await reviewer.keyboard.press("e");
  await commentingText(reviewer);
  await reviewer.context().close();
});

test("a dragged pin shows once, under the pointer, while the page changes, and lands without a jump", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Drag pin");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.createComment(document.id, "Move me", {
    point: { target: "tail", x: 0.1, y: 0.5 },
  });
  await page.goto(`/app/d/${document.id}`);
  const pins = bridge(page).locator(".sd-pin");
  await expect(pins).toHaveCount(1);
  const start = (await pins.boundingBox())!;
  const [x, y] = [start.x + start.width / 2, start.y + start.height / 2];
  // Where the pin is from the pointer, which a drag keeps.
  let offset: { x: number; y: number } | undefined;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    const pointer = { x: x + i * 20, y: y + i * 4 };
    await page.mouse.move(pointer.x, pointer.y);
    // Longer than a change of the page and the frame after it.
    await page.waitForTimeout(120);
    await expect(pins).toHaveCount(1);
    const at = (await pins.boundingBox())!;
    offset ??= { x: at.x - pointer.x, y: at.y - pointer.y };
    expect(Math.abs(at.x - pointer.x - offset.x), `x at step ${i}`).toBeLessThan(1);
    expect(Math.abs(at.y - pointer.y - offset.y), `y at step ${i}`).toBeLessThan(1);
  }
  const held = (await pins.boundingBox())!;
  await page.mouse.up();
  await page.waitForTimeout(300);
  // The pin was larger while held, around its tip. Its face does not move.
  const landed = (await pins.boundingBox())!;
  expect(Math.abs(landed.x - held.x)).toBeLessThan(4);
  expect(Math.abs(landed.y - held.y)).toBeLessThan(4);
});
