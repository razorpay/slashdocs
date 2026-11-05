import { type Locator, type Page } from "@playwright/test";
import { expect, reviewerOn, test, uniqueName } from "./fixtures";

const unavailable = { status: 503, json: { error: { message: "unavailable" } } };

// Answers each request to a path with the response of the moment, and counts
// the requests.
async function answer(page: Page, url: string, response: object) {
  const route = { response, calls: 0 };
  await page.route(url, (r) => {
    route.calls++;
    return r.fulfill(route.response);
  });
  return route;
}

// A query that fails with 503 retries three times before it shows an error.
const afterRetries = { timeout: 15_000 };

test("the bots page offers Retry when the bots do not load", async ({ page }) => {
  const bots = await answer(page, "**/v1/service-accounts", unavailable);
  await page.goto("/app/settings/service-accounts");
  await expect(page.getByText("Could not load bots")).toBeVisible(afterRetries);
  await expect(page.getByText("No bot selected")).toBeHidden();
  bots.response = { json: { items: [] } };
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText(/No bots yet/)).toBeVisible();
});

test("a folder without access says so, and gives its link to send", async ({
  page,
}) => {
  const forbidden = {
    status: 403,
    json: { error: { code: "forbidden", message: "viewer role required" } },
  };
  await answer(page, "**/v1/folders/fld_private", forbidden);
  await answer(page, "**/v1/folders?folder_id=fld_private*", forbidden);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/app/folders/fld_private");

  await expect(page.getByText("You don't have access to this folder")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeHidden();
  await expect(page.getByRole("link", { name: "Go to documents" })).toBeVisible();
  await page.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByText("Folder link copied.")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "/app/folders/fld_private",
  );
});

test("a README that does not render offers Retry", async ({ page }) => {
  const readme = {
    type: "document",
    document: { id: "doc_readme", title: "README.html", current_version_id: "ver_1" },
  };
  await answer(page, "**/v1/folders/fld_readme", {
    json: { id: "fld_readme", title: "Guides" },
  });
  await answer(page, "**/v1/folders?folder_id=fld_readme*", {
    json: { items: [readme], has_more: false },
  });
  const token = await answer(
    page,
    "**/v1/documents/doc_readme/**/render-token",
    unavailable,
  );
  await page.goto("/app/folders/fld_readme");

  await expect(page.getByText("Could not render README.html")).toBeVisible(
    afterRetries,
  );
  const failed = token.calls;
  await expect(page.getByRole("link", { name: "Open document" })).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect.poll(() => token.calls).toBeGreaterThan(failed);
});

const box = async (locator: Locator) => (await locator.boundingBox())!;

test("a phone bar keeps the title, and gives 40px targets", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Phone bar title");
  const document = await slashdocs.createDocument(title, `<h1>${title}</h1>`);
  await slashdocs.shareWithAnyone(document.id, "viewer");
  // The document waits on one approval, so its chip would be in the bar.
  await page.route(`**/v1/documents/${document.id}`, async (route) => {
    const response = await route.fetch();
    const json = {
      ...(await response.json()),
      approval_status: "pending",
      approval_summary: { approved: 0, total: 1, rejected: 0, pending: 1 },
    };
    await route.fulfill({ response, json });
  });
  const path = `/app/d/${document.id}`;
  const reviewer = await reviewerOn(browser, path);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(path);

  const more = page.getByRole("button", { name: "More" });
  await more.click();
  await expect(page.getByRole("menuitem", { name: /Follow reviewer/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Approvals/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "People" })).toBeHidden();
  await expect(page.getByRole("button", { name: /Open approvals/ })).toBeHidden();
  // About 7px a letter: at least 12 letters of the title show.
  expect(
    (await box(page.getByRole("button", { name: /^Rename/ }))).width,
  ).toBeGreaterThan(84);

  const comments = page.getByRole("button", { name: "Comments" });
  for (const target of [page.getByRole("button", { name: "Share" }), comments, more]) {
    const { width, height } = await box(target);
    expect(Math.min(width, height)).toBeGreaterThanOrEqual(40);
  }
  await comments.click();
  const spot = page.getByRole("button", { name: "Comment on a spot" });
  expect((await box(spot)).height).toBeGreaterThanOrEqual(40);
  await reviewer.context().close();
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
  const frame = page
    .frameLocator('iframe[title="Rendered document"]')
    .locator(".slashdocs-follow");
  await expect(frame).toHaveAttribute("data-on");
  await expect(frame).toBeEmpty();

  await stop.focus();
  await page.keyboard.press("Enter");
  await expect(stop).toBeHidden();
  await expect(frame).not.toHaveAttribute("data-on");
  await reviewer.context().close();
});
