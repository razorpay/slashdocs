import { type FrameLocator, type Page } from "@playwright/test";
import { expect, signedOutPage, test, uniqueName, type SlashdocsAPI } from "./fixtures";

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

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

test("Esc in the doc bar shows the chord, and C opens the comments", async ({
  page,
  slashdocs,
}) => {
  await openEarlier(page, slashdocs);
  await page.getByRole("button", { name: "History" }).focus();
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

test("the install command fades only on the side that hides text", async ({
  browser,
}) => {
  const page = await signedOutPage(browser);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const command = page.locator("pre", { hasText: "install.sh | sh" }).first();
  await expect(command).toBeVisible();
  const mask = () => command.evaluate((el) => el.style.maskImage);
  await expect
    .poll(mask)
    .toBe(
      "linear-gradient(to right, black, black calc(100% - 3.5rem), transparent calc(100% - 2.25rem))",
    );
  await command.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  await expect
    .poll(mask)
    .toBe("linear-gradient(to right, transparent, black 1.5rem, black)");
});
