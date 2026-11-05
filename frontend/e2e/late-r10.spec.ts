import { type Page, type Route } from "@playwright/test";
import { expect, test, uniqueName } from "./fixtures";

// A late result always reaches the item that it belongs to, and never moves a
// reader who left the view that started it. A key that shows once waits on
// any page until the reader copies it or chooses to lose it.

// hold keeps each request to a path until the test calls the returned
// release, and then gives the response.
async function hold(page: Page, url: string, method: string, response?: object) {
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(url, async (route: Route) => {
    if (route.request().method() !== method) return route.fallback();
    await released;
    await (response ? route.fulfill(response) : route.continue());
  });
  return release;
}

// goInApp moves the app to a path without a reload, as a link does.
async function goInApp(page: Page, path: string) {
  await page.evaluate((to) => {
    history.pushState({}, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, path);
  await expect(page).toHaveURL(new RegExp(`${path}$`));
}

const BOTS = Array.from({ length: 13 }, (_, i) => ({
  id: `sa_r10_${i}`,
  name: `r10-late-17938699${i}@hearty.review.bot`,
}));

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
      : route.fallback(),
  );
}

// heldKeys holds each New key, and answers each with its own token when the
// test releases it.
async function heldKeys(page: Page) {
  const waiting: (() => void)[] = [];
  let made = 0;
  await page.route("**/v1/service-accounts/*/keys", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const token = `sd_r10_late_token_${++made}`;
    await new Promise<void>((resolve) => waiting.push(resolve));
    await route.fulfill({ status: 201, json: { id: `key_${made}`, token } });
  });
  return waiting;
}

async function newKey(page: Page, name: string) {
  await page.getByPlaceholder("Key name").fill(name);
  await page.getByRole("button", { name: "New key" }).click();
}

test("a key shows on the page the reader went to, and on the next", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(
    uniqueName("R10 late key"),
    "<!doctype html><title>Late</title><h1>Late key</h1>",
  );
  await fakeBots(page);
  const waiting = await heldKeys(page);
  await page.goto("/app/settings/service-accounts");

  await newKey(page, "R10 PROFILE KEY");
  await expect.poll(() => waiting.length).toBe(1);
  await goInApp(page, "/app/settings/profile");
  waiting[0]();
  const onProfile = page.getByRole("dialog", { name: `New key for ${BOTS[0].name}` });
  await expect(
    onProfile.getByText("sd_r10_late_token_1", { exact: true }),
  ).toBeVisible();
  await expect(onProfile.getByText("R10 PROFILE KEY")).toBeVisible();
  await expect(page).toHaveURL(/\/app\/settings\/profile$/);

  // Esc before a copy asks, and Close without a copy ends it on purpose.
  await page.keyboard.press("Escape");
  await expect(onProfile.getByRole("alert")).toContainText("Close without a copy?");
  await onProfile.getByRole("button", { name: "Close without a copy" }).click();
  await expect(onProfile).toBeHidden();

  // Keys of two bots that answer in reverse order, on a document page.
  await goInApp(page, "/app/settings/service-accounts");
  await newKey(page, "R10 FIRST");
  await expect.poll(() => waiting.length).toBe(2);
  await page.getByRole("button", { name: /^r10-late-179386991\b/ }).click();
  await newKey(page, "R10 SECOND");
  await expect.poll(() => waiting.length).toBe(3);
  await goInApp(page, `/app/d/${document.id}`);
  waiting[2]();
  waiting[1]();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("sd_r10_late_token_3", { exact: true })).toBeVisible();
  await expect(dialog).toHaveAccessibleName(`New key for ${BOTS[1].name}`);
  await expect(dialog).toContainText("This is key 1 of 2 to copy.");
  // Neither key is kept in the browser's storage or the address.
  const stored = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage, href: location.href }),
  );
  expect(stored).not.toContain("sd_r10_late_token");
  await dialog.getByRole("button", { name: "Done" }).click();
  await dialog.getByRole("button", { name: "Close without a copy" }).click();
  await expect(dialog.getByText("sd_r10_late_token_2", { exact: true })).toBeVisible();
  await expect(dialog.getByText("R10 FIRST")).toBeVisible();
  await expect(dialog).toHaveAccessibleName(`New key for ${BOTS[0].name}`);
});

test("the key Copy shows without a hover, and the key shows whole", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await fakeBots(page);
  const waiting = await heldKeys(page);
  await page.goto("/app/settings/service-accounts");
  await newKey(page, "R10 COPY");
  await expect.poll(() => waiting.length).toBe(1);
  waiting[0]();

  const dialog = page.getByRole("dialog");
  const token = dialog.getByText("sd_r10_late_token_1", { exact: true });
  const block = token.locator("..");
  const copy = block.getByRole("button", { name: "Copy" });
  await page.mouse.move(0, 0);
  await expect(copy).toHaveCSS("opacity", "1");
  // The key wraps in its block, so no fade hides its end.
  await expect(token).toHaveCSS("mask-image", "none");
  const box = (await token.boundingBox())!;
  const blockBox = (await block.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(blockBox.x + blockBox.width);
  await copy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "sd_r10_late_token_1",
  );
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
});

test("a slow Create bot shows that it waits, and its key comes on another page", async ({
  page,
}) => {
  await fakeBots(page);
  const release = await hold(page, "**/v1/service-accounts", "POST", {
    status: 201,
    json: {
      id: "sa_r10new",
      label: "r10-new",
      name: "r10-new@bots.bot",
      key: { id: "key_r10", token: "sd_r10_new_bot_token" },
    },
  });
  await page.goto("/app/settings/service-accounts");
  await page.getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("r10-new");
  const create = page.getByRole("button", { name: "Create bot" });
  await create.click();
  await expect(create).toHaveAttribute("aria-busy", "true");
  await page.getByRole("button", { name: "Cancel" }).click();
  await goInApp(page, "/app/documents");

  release();
  const dialog = page.getByRole("dialog", { name: "Meet r10-new@bots.bot" });
  await expect(dialog.getByText("sd_r10_new_bot_token", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/documents$/);
});

test("at 390, a picked bot brings its detail into view, with New key", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fakeBots(page);
  await page.goto("/app/settings/service-accounts");
  // Each row shows the part of the address that tells the bots apart.
  const row = page.getByRole("button", { name: new RegExp(`^r10-late-179386992\\b`) });
  await expect(row).toHaveAttribute("title", BOTS[2].name);
  await row.click();

  const heading = page.getByText(BOTS[2].name, { exact: true }).first();
  await expect(heading).toBeInViewport();
  await expect(page.locator(":focus")).toContainText(BOTS[2].name);
  await expect(page.getByRole("button", { name: "New key" })).toBeInViewport();
});

test("a Restore that ends after the reader left keeps them where they went", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("R10 late restore");
  const document = await slashdocs.createDocument(
    title,
    "<!doctype html><title>First</title><h1>First</h1>",
  );
  const first = document.current_version_id;
  await slashdocs.pushVersion(
    document.id,
    "<!doctype html><title>Second</title><h1>Second</h1>",
  );
  const release = await hold(
    page,
    `**/v1/documents/${document.id}/versions/${first}/restore`,
    "POST",
  );
  await page.goto(`/app/d/${document.id}?version=${first}`);
  const restore = page.getByRole("button", { name: "Restore", exact: true });
  await restore.click();
  await expect(restore).toHaveAttribute("aria-busy", "true");
  await goInApp(page, "/app/documents");

  release();
  const toast = page.getByText(`Restored an earlier version of “${title}”.`);
  await expect(toast).toBeVisible();
  await expect(page).toHaveURL(/\/app\/documents$/);
  // Undo from Documents undoes it there too.
  await page
    .locator("[data-sonner-toast]", { has: toast })
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(page.getByText(`Undid the restore of “${title}”.`)).toBeVisible();
  await expect(page).toHaveURL(/\/app\/documents$/);
});
