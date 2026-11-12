import { type Page } from "@playwright/test";
import { expect, goInApp, hold, test, uniqueName } from "./fixtures";

// A bot key shows once. It waits on any page until the reader copies it or
// chooses to lose it, under the bot and the name that it was made for, also
// when it comes after the reader moved on. A sign-out in another tab closes
// it.

type Bot = { id: string; name: string };

const BOTS: Bot[] = Array.from({ length: 13 }, (_, i) => ({
  id: `sa_late_${i}`,
  name: `late-17938699${i}@hearty.review.bot`,
}));

// The token that a New key gets, unless the test holds the request.
const TOKEN = "sd_made_token";

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
      : route.fulfill({ status: 201, json: { id: "key_made", token: TOKEN } }),
  );
}

// botRow is the row of a bot in the list. Each row shows the part of the
// address that tells the bots apart.
const botRow = (page: Page, bot: Bot) =>
  page.getByRole("button", { name: new RegExp(`^${bot.name.split("@")[0]}\\b`) });

// A new bot that the server makes, with its first key.
const NEW_BOT = {
  status: 201,
  json: {
    id: "sa_new",
    label: "fresh",
    name: "fresh@bots.bot",
    key: { id: "key_fresh", token: "sd_new_bot_token" },
  },
};

// heldKeys holds each New key, and answers each with its own token when the
// test releases it.
async function heldKeys(page: Page) {
  const waiting: (() => void)[] = [];
  let made = 0;
  await page.route("**/v1/service-accounts/*/keys", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const token = `sd_late_token_${++made}`;
    await new Promise<void>((resolve) => waiting.push(resolve));
    await route.fulfill({ status: 201, json: { id: `key_${made}`, token } });
  });
  return waiting;
}

async function newKey(page: Page, name: string) {
  await page.getByPlaceholder("Key name").fill(name);
  await page.getByRole("button", { name: "New key" }).click();
}

// makeKey makes a key for the first bot, and gives its dialog.
async function makeKey(page: Page, name: string) {
  await page.goto("/app/settings/service-accounts");
  await newKey(page, name);
  return page.getByRole("dialog", { name: /New key for/ });
}

test("the key of a new bot shows when it comes after Cancel", async ({ page }) => {
  await fakeBots(page);
  const release = await hold(page, "**/v1/service-accounts", "POST", NEW_BOT);
  await page.goto("/app/settings/service-accounts");
  await page.getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("fresh");
  await page.getByRole("button", { name: "Create bot" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  release();
  const dialog = page.getByRole("dialog", { name: "Meet fresh@bots.bot" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("sd_new_bot_token").first()).toBeVisible();
  // Done before a copy asks first.
  await dialog.getByRole("button", { name: "Done" }).click();
  await dialog.getByRole("button", { name: "Close without a copy" }).click();
  await expect(dialog).toBeHidden();
});

test("a new key shows under the bot and name that it was made for", async ({
  page,
}) => {
  await fakeBots(page);
  const release = await hold(
    page,
    `**/v1/service-accounts/${BOTS[0].id}/keys`,
    "POST",
    {
      status: 201,
      json: { id: "key_first", token: "sd_first_key_token" },
    },
  );
  await page.goto("/app/settings/service-accounts");
  const field = page.getByPlaceholder("Key name");
  await field.fill("FIRST KEY");
  await page.getByRole("button", { name: "New key" }).click();
  await field.fill("SECOND UNSENT NAME");
  await botRow(page, BOTS[1]).click();

  release();
  const dialog = page.getByRole("dialog", { name: `New key for ${BOTS[0].name}` });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("FIRST KEY")).toBeVisible();
  await expect(dialog.getByText("sd_first_key_token").first()).toBeVisible();
  await expect(dialog).not.toContainText("SECOND UNSENT NAME");
  await expect(dialog).not.toContainText(BOTS[1].name);
});

test("a key shows on the page the reader went to, and on the next", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(
    uniqueName("Late key"),
    "<!doctype html><title>Late</title><h1>Late key</h1>",
  );
  await fakeBots(page);
  const waiting = await heldKeys(page);
  await page.goto("/app/settings/service-accounts");

  await newKey(page, "PROFILE KEY");
  await expect.poll(() => waiting.length).toBe(1);
  await goInApp(page, "/app/settings/profile");
  waiting[0]();
  const onProfile = page.getByRole("dialog", { name: `New key for ${BOTS[0].name}` });
  await expect(onProfile.getByText("sd_late_token_1", { exact: true })).toBeVisible();
  await expect(onProfile.getByText("PROFILE KEY")).toBeVisible();
  await expect(page).toHaveURL(/\/app\/settings\/profile$/);

  // Esc before a copy asks, and Close without a copy ends it on purpose.
  await page.keyboard.press("Escape");
  await expect(onProfile.getByRole("alert")).toContainText("Close without a copy?");
  await onProfile.getByRole("button", { name: "Close without a copy" }).click();
  await expect(onProfile).toBeHidden();

  // Keys of two bots that answer in reverse order, on a document page.
  await goInApp(page, "/app/settings/service-accounts");
  await newKey(page, "FIRST");
  await expect.poll(() => waiting.length).toBe(2);
  await botRow(page, BOTS[1]).click();
  await newKey(page, "SECOND");
  await expect.poll(() => waiting.length).toBe(3);
  await goInApp(page, `/app/d/${document.id}`);
  waiting[2]();
  waiting[1]();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("sd_late_token_3", { exact: true })).toBeVisible();
  await expect(dialog).toHaveAccessibleName(`New key for ${BOTS[1].name}`);
  await expect(dialog).toContainText("This is key 1 of 2 to copy.");
  // Neither key is kept in the browser's storage or the address.
  const stored = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage, href: location.href }),
  );
  expect(stored).not.toContain("sd_late_token");
  await dialog.getByRole("button", { name: "Done" }).click();
  await dialog.getByRole("button", { name: "Close without a copy" }).click();
  await expect(dialog.getByText("sd_late_token_2", { exact: true })).toBeVisible();
  await expect(dialog.getByText("FIRST")).toBeVisible();
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
  await newKey(page, "COPY");
  await expect.poll(() => waiting.length).toBe(1);
  waiting[0]();

  const dialog = page.getByRole("dialog");
  const token = dialog.getByText("sd_late_token_1", { exact: true });
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
    "sd_late_token_1",
  );
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toBeHidden();
});

test("a slow Create bot shows that it waits, and its key comes on another page", async ({
  page,
}) => {
  await fakeBots(page);
  const release = await hold(page, "**/v1/service-accounts", "POST", NEW_BOT);
  await page.goto("/app/settings/service-accounts");
  await page.getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("fresh");
  const create = page.getByRole("button", { name: "Create bot" });
  await create.click();
  await expect(create).toHaveAttribute("aria-busy", "true");
  await page.getByRole("button", { name: "Cancel" }).click();
  await goInApp(page, "/app/documents");

  release();
  const dialog = page.getByRole("dialog", { name: "Meet fresh@bots.bot" });
  await expect(dialog.getByText("sd_new_bot_token", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/app\/documents$/);
});

test("at 390, a picked bot brings its detail into view, with New key", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fakeBots(page);
  await page.goto("/app/settings/service-accounts");
  // Each row shows the part of the address that tells the bots apart.
  const row = botRow(page, BOTS[2]);
  await expect(row).toHaveAttribute("title", BOTS[2].name);
  await row.click();

  const heading = page.getByText(BOTS[2].name, { exact: true }).first();
  await expect(heading).toBeInViewport();
  await expect(page.locator(":focus")).toContainText(BOTS[2].name);
  await expect(page.getByRole("button", { name: "New key" })).toBeInViewport();
});

test("a sign-out in one tab closes the key that another tab shows", async ({
  page,
  context,
}) => {
  await fakeBots(page);
  const key = await makeKey(page, "Solo key");
  await expect(key.getByText(TOKEN, { exact: true })).toBeVisible();

  // The other tab signs out. The server session stays for the other tests.
  const other = await context.newPage();
  await other.route("**/v1/auth/logout", (route) => route.fulfill({ status: 204 }));
  await other.goto("/app/settings/profile");
  await other.getByRole("button", { name: "Sign out" }).click();

  // This tab ends its session too: the key goes, and so does the page.
  await expect(key).toBeHidden();
  await expect(page.getByText(TOKEN, { exact: true })).toHaveCount(0);
  await expect(page).not.toHaveURL(/service-accounts/);
});

test("a key dialog taller than a short screen scrolls inside it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 500 });
  await fakeBots(page);
  const key = await makeKey(page, "Key ".repeat(190).trim());
  await expect(key.getByText(TOKEN, { exact: true })).toBeVisible();
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
