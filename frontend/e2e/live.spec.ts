import { type Browser, type FrameLocator, type Page } from "@playwright/test";
import {
  APP_ORIGIN,
  continueWithDex,
  expect,
  installAppStorage,
  test,
  uniqueName,
} from "./fixtures";

// Two people read one document: the admin and a reviewer (dev/dex-config.yaml).

function bridge(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Rendered document"]');
}

function renderedDocument(page: Page): FrameLocator {
  return bridge(page).frameLocator("iframe#slashdocs-doc");
}

async function reviewerOn(browser: Browser, path: string): Promise<Page> {
  const context = await browser.newContext({
    baseURL: APP_ORIGIN,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await installAppStorage(page);
  await page.goto(`/login?next=${encodeURIComponent(path)}`);
  await continueWithDex(page, "reviewer@example.com");
  await expect(page).toHaveURL(`${APP_ORIGIN}${path}`);
  return page;
}

function documentHTML(title: string) {
  const sections = Array.from(
    { length: 40 },
    (_, i) =>
      `<section id="s${i}" style="height:400px"><h2>Section ${i}</h2></section>`,
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>${sections}</body></html>`;
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
  const avatar = page.getByRole("button", {
    name: /Go to where reviewer.* is viewing/,
  });
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

  // The context menu of an avatar follows; a click goes there only once.
  await avatar.click({ button: "right" });
  await page.getByRole("menuitem", { name: /Follow reviewer/ }).click();
  const stop = bridge(page).getByRole("button", { name: /Stop following reviewer/ });
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
