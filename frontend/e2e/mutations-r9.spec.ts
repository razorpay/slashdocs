import { type Page, type Route } from "@playwright/test";
import { APP_ORIGIN, expect, test, uniqueName } from "./fixtures";

// A response that comes after the reader moved on (closed the form, selected
// another item, or left the page) still reaches the reader, for the item
// that it belongs to, and does not move the reader.

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

const BOTS = [
  { id: "sa_r9a", name: "r9-alpha@bots.bot" },
  { id: "sa_r9b", name: "r9-beta@bots.bot" },
];

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

test("the key of a new bot shows when it comes after Cancel", async ({ page }) => {
  await fakeBots(page);
  const release = await hold(page, "**/v1/service-accounts", "POST", {
    status: 201,
    json: {
      id: "sa_r9new",
      label: "r9-new",
      name: "r9-new@bots.bot",
      key: { id: "key_r9", token: "sd_r9_new_bot_token" },
    },
  });
  await page.goto("/app/settings/service-accounts");
  await page.getByRole("button", { name: "New bot" }).click();
  await page.getByRole("textbox", { name: "Name" }).fill("r9-new");
  await page.getByRole("button", { name: "Create bot" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  release();
  const dialog = page.getByRole("dialog", { name: "Meet r9-new@bots.bot" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("sd_r9_new_bot_token").first()).toBeVisible();
  // Done before a copy asks first.
  await dialog.getByRole("button", { name: "Done" }).click();
  await dialog.getByRole("button", { name: "Close without a copy" }).click();
  await expect(dialog).toBeHidden();
});

test("a new key shows under the bot and name that it was made for", async ({
  page,
}) => {
  await fakeBots(page);
  const release = await hold(page, "**/v1/service-accounts/sa_r9a/keys", "POST", {
    status: 201,
    json: { id: "key_r9a", token: "sd_r9_first_key_token" },
  });
  await page.goto("/app/settings/service-accounts");
  const field = page.getByPlaceholder("Key name");
  await field.fill("R9 FIRST KEY");
  await page.getByRole("button", { name: "New key" }).click();
  await field.fill("R9 SECOND UNSENT NAME");
  await page.getByRole("button", { name: /^r9-beta\b/ }).click();

  release();
  const dialog = page.getByRole("dialog", { name: "New key for r9-alpha@bots.bot" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("R9 FIRST KEY")).toBeVisible();
  await expect(dialog.getByText("sd_r9_first_key_token").first()).toBeVisible();
  await expect(dialog).not.toContainText("R9 SECOND UNSENT NAME");
  await expect(dialog).not.toContainText("r9-beta@bots.bot");
});

test("a document deleted after the reader left names it, and does not move them", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("R9 late delete");
  const document = await slashdocs.createDocument(
    title,
    "<!doctype html><title>Late</title><h1>Late</h1>",
  );
  const release = await hold(page, `**/v1/documents/${document.id}`, "DELETE");
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete document" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await goInApp(page, "/app/settings/profile");

  release();
  await expect(page.getByText(`Deleted “${title}”.`)).toBeVisible();
  await expect(page).toHaveURL(/\/app\/settings\/profile$/);
});

test("a folder deleted after the reader opened another names it, and does not move them", async ({
  page,
  slashdocs,
}) => {
  const folder = async (title: string) => {
    const response = await page.request.post("/v1/folders", {
      headers: { Origin: APP_ORIGIN },
      data: { title },
    });
    expect(response.ok()).toBeTruthy();
    const { id } = (await response.json()) as { id: string };
    slashdocs.trackFolder(id);
    return id;
  };
  const doomed = uniqueName("R9 doomed");
  const doomedId = await folder(doomed);
  const otherId = await folder(uniqueName("R9 other"));
  const release = await hold(page, `**/v1/folders/${doomedId}`, "DELETE");
  await page.goto(`/app/folders/${doomedId}`);
  await page.getByRole("button", { name: "More folder actions" }).click();
  await page.getByRole("menuitem", { name: "Delete folder" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await goInApp(page, `/app/folders/${otherId}`);
  await expect(page.getByRole("alertdialog")).toBeHidden();

  release();
  await expect(page.getByText(`Deleted folder “${doomed}”.`)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/app/folders/${otherId}$`));
});
