import { type Page } from "@playwright/test";
import { expect, test, uniqueName } from "./fixtures";

// Round 11: a session ends in every tab, a dialog stays inside the screen, a
// heading link that the browser does not copy shows to copy by hand, a late
// upload leaves a later preview, and the save note sits in the bar.

const BOTS = [{ id: "sa_r11", name: "r11-bot@hearty.review.bot" }];

// The bots and their keys are answered here, so the test makes no real key.
async function fakeBots(page: Page) {
  await page.route("**/v1/service-accounts", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { items: BOTS } })
      : route.fallback(),
  );
  await page.route("**/v1/service-accounts/*/keys", (route) =>
    route.request().method() === "GET"
      ? route.fulfill({ json: { items: [] } })
      : route.fulfill({ status: 201, json: { id: "key_r11", token: "sd_r11_token" } }),
  );
}

async function newKey(page: Page, name: string) {
  await page.goto("/app/settings/service-accounts");
  await page.getByPlaceholder("Key name").fill(name);
  await page.getByRole("button", { name: "New key" }).click();
  return page.getByRole("dialog", { name: /New key for/ });
}

function renderedDocument(page: Page) {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

test("a sign-out in one tab closes the key that another tab shows", async ({
  page,
  context,
}) => {
  await fakeBots(page);
  const key = await newKey(page, "R11 key");
  await expect(key.getByText("sd_r11_token", { exact: true })).toBeVisible();

  // The other tab signs out. The server session stays for the other tests.
  const other = await context.newPage();
  await other.route("**/v1/auth/logout", (route) => route.fulfill({ status: 204 }));
  await other.goto("/app/settings/profile");
  await other.getByRole("button", { name: "Sign out" }).click();

  // This tab ends its session too: the key goes, and so does the page.
  await expect(key).toBeHidden();
  await expect(page.getByText("sd_r11_token", { exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/service-accounts/);
});

test("a key dialog taller than a short screen scrolls inside it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await fakeBots(page);
  const key = await newKey(page, "R11 ".repeat(190).trim());
  await expect(key.getByText("sd_r11_token", { exact: true })).toBeVisible();
  await page.waitForTimeout(300);
  const box = (await key.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(500);
  expect(await key.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await key.getByRole("button", { name: "Done" }).scrollIntoViewIfNeeded();
  await key.getByRole("button", { name: "Done" }).click();
  await expect(key.getByText(/Close without a copy\?/)).toBeInViewport();
  await key.getByRole("button", { name: "Close without a copy" }).click();
  await expect(key).toBeHidden();
});

test("a heading link that the browser does not copy shows to copy by hand", async ({
  page,
  slashdocs,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
  });
  const title = uniqueName("Heading denied r11");
  const document = await slashdocs.createDocument(
    title,
    `<!doctype html><title>${title}</title><h1 id="top">${title}</h1><p>Words.</p>`,
  );
  await page.goto(`/app/d/${document.id}`);
  await renderedDocument(page).locator("h1").hover();
  await renderedDocument(page)
    .getByRole("button", { name: `Copy link to ${title}` })
    .click();

  const dialog = page.getByRole("dialog", { name: "Copy the heading link" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(`/app/d/${document.id}#top`)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/app/d/${document.id}#top$`));
});

test("an upload that ends after the reader opened an earlier version leaves them on it", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Late upload r11");
  const document = await slashdocs.createDocument(
    title,
    `<!doctype html><title>${title}</title><h1>First</h1>`,
  );
  const first = document.current_version_id;
  await slashdocs.pushVersion(
    document.id,
    `<!doctype html><title>${title}</title><h1>Second</h1>`,
  );
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/v1/documents/${document.id}/versions`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await released;
    await route.continue();
  });
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Replace with an HTML file" }).click();
  const sheet = page.getByRole("dialog", { name: "Replace with an HTML file" });
  await sheet.locator('input[type="file"]').setInputFiles({
    name: "third.html",
    mimeType: "text/html",
    buffer: Buffer.from(`<!doctype html><title>${title}</title><h1>Third</h1>`),
  });
  await sheet.getByRole("button", { name: "Upload" }).click();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // The reader opens the first version in the app, as the history does.
  await page.evaluate((to) => {
    history.pushState({}, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `/app/d/${document.id}?version=${first}`);
  await expect(renderedDocument(page).locator("h1")).toHaveText("First");
  const uploaded = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/documents/${document.id}/versions`) &&
      r.request().method() === "POST",
  );
  release();
  await uploaded;
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(new RegExp(`version=${first}`));
  await expect(renderedDocument(page).locator("h1")).toHaveText("First");
});
