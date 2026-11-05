import { type Page } from "@playwright/test";
import { APP_ORIGIN, expect, reviewerOn, test, uniqueName } from "./fixtures";

// Every query that fails shows that it failed, with Retry, and never an
// empty list, "No access", or a read-only state that it does not know.

const unavailable = { status: 503, json: { error: { message: "unavailable" } } };

// Answers each request to a path with the response of the moment.
async function answer(page: Page, url: string, response: object) {
  const route = { response };
  await page.route(url, (r) => r.fulfill(route.response));
  return route;
}

// A query that fails with 503 retries three times before it shows an error.
const afterRetries = { timeout: 15_000 };

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Errors</title></head>
<body><h1>Errors</h1><p>The access test.</p></body></html>`;

test("the share sheet says that access is unknown while its list fails", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Share error"), HTML);
  await slashdocs.shareWithAnyone(document.id, "commenter");
  await page.goto(`/app/d/${document.id}`);
  // Answer the access list with 503 only from now: the bar has its role.
  await answer(page, `**/v1/documents/${document.id}/access`, unavailable);
  await page.getByRole("button", { name: "Share", exact: true }).click();

  const sheet = page.getByRole("dialog");
  await expect(sheet.getByText(/Could not load who has access/)).toBeVisible(
    afterRetries,
  );
  await expect(sheet.getByText("Unknown", { exact: true })).toBeVisible();
  await expect(sheet.getByRole("button", { name: /General access role/ })).toBeHidden();

  await page.unroute(`**/v1/documents/${document.id}/access`);
  await sheet.getByRole("button", { name: "Retry" }).click();
  await expect(
    sheet.getByRole("button", { name: "General access role: Commenter" }),
  ).toBeVisible();
  await expect(sheet.getByText("Unknown", { exact: true })).toBeHidden();
});

test("the keys of a bot offer Retry", async ({ page }) => {
  await answer(page, "**/v1/service-accounts", {
    json: { items: [{ id: "sa_err", name: "err-bot@bots.bot" }] },
  });
  const keys = await answer(page, "**/v1/service-accounts/sa_err/keys", unavailable);
  await page.goto("/app/settings/service-accounts");
  await expect(page.getByText("Could not load keys")).toBeVisible(afterRetries);
  keys.response = { json: { items: [{ id: "key_1", name: "Nightly" }] } };
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("button", { name: "Revoke key Nightly" })).toBeVisible();
});

test("the inbox marks requests for access that did not load, and loads them on Retry", async ({
  page,
}) => {
  const requests = await answer(page, "**/v1/access-requests", unavailable);
  await page.goto("/app/documents");
  const inbox = page.getByRole("button", { name: "Requests for access did not load" });
  await expect(inbox).toBeVisible(afterRetries);
  await inbox.click();
  await expect(page.getByText("Could not load the requests for access.")).toBeVisible();
  requests.response = {
    json: {
      items: [
        {
          document_id: "doc_err",
          document_title: "Plan",
          requester: { type: "user", id: "usr_ana", name: "Ana" },
          requested_at: new Date().toISOString(),
        },
      ],
    },
  };
  await page.getByRole("menuitem", { name: "Retry" }).click();
  await expect(page.getByRole("menuitem", { name: /Ana asks for Plan/ })).toBeVisible();
});

test("the workspace and the pins say that they did not load, with Retry", async ({
  page,
}) => {
  await page.route("**/v1/me", (r) => r.fulfill(unavailable));
  await page.goto("/app/documents");
  await expect(page.getByText("Could not load your workspace")).toBeVisible();
  await page.unroute("**/v1/me");

  const pins = await answer(page, "**/v1/pins", unavailable);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  await expect(page.getByText("Could not load your pins.")).toBeVisible(afterRetries);
  pins.response = { json: { items: [] } };
  await page
    .getByRole("alert")
    .filter({ hasText: "Could not load your pins." })
    .getByRole("button", { name: "Retry" })
    .click();
  await expect(page.getByText("Could not load your pins.")).toBeHidden();
});

test("an editor whose access did not load is told so, not that they may only view", async ({
  page,
  browser,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Role error"), HTML);
  const shared = await page.request.post(`/v1/documents/${document.id}/grants`, {
    headers: { Origin: APP_ORIGIN },
    data: { address: "reviewer@example.com", role: "editor" },
  });
  expect(shared.ok()).toBeTruthy();

  const path = `/app/d/${document.id}`;
  const reviewer = await reviewerOn(browser, "/app/documents");
  await reviewer.route(`**/v1/documents/${document.id}/access`, (r) =>
    r.fulfill(unavailable),
  );
  await reviewer.goto(path);
  await expect(reviewer.getByText("Could not check your access")).toBeVisible(
    afterRetries,
  );
  await expect(reviewer.getByText("Can view", { exact: true })).toBeHidden();
  await reviewer.unroute(`**/v1/documents/${document.id}/access`);
  await reviewer.getByRole("button", { name: "Retry" }).click();
  await expect(reviewer.getByText("Can edit", { exact: true })).toBeVisible();
  await reviewer.context().close();
});

test("the page that waits for access opens the document when access is granted", async ({
  page,
  browser,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Waits"), HTML);
  const path = `/app/d/${document.id}`;
  const reviewer = await reviewerOn(browser, "/app/documents");
  await reviewer.goto(path);
  await reviewer.getByRole("button", { name: "Request access" }).click();
  await expect(reviewer.getByRole("button", { name: /Request sent/ })).toBeVisible();

  // Check access while there is no grant says so.
  await reviewer.getByRole("button", { name: "Check access" }).click();
  await expect(reviewer.getByText(/You still don't have access/)).toBeVisible();

  const granted = await page.request.post(`/v1/documents/${document.id}/grants`, {
    headers: { Origin: APP_ORIGIN },
    data: { address: "reviewer@example.com", role: "commenter" },
  });
  expect(granted.ok()).toBeTruthy();
  // No reload: the page opens the document by itself.
  await expect(reviewer.locator('iframe[title="Rendered document"]')).toBeVisible({
    timeout: 10_000,
  });
  await expect(reviewer.getByText("Can comment", { exact: true })).toBeVisible();
  await reviewer.context().close();
});
