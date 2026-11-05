import { type Page } from "@playwright/test";
import { APP_ORIGIN, expect, reviewerOn, test, uniqueName } from "./fixtures";

// A failed query says that it failed, soon and with Retry. It never shows the
// counts of another version, "no access", or a hidden action instead.

const unavailable = { status: 503, json: { error: { message: "unavailable" } } };

// A query retries once, so its error shows in about a second.
const soon = { timeout: 5_000 };

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Errors</title></head>
<body><h1>Errors</h1><p>The approvals test.</p></body></html>`;

async function post(page: Page, path: string, data: object) {
  const response = await page.request.post(path, {
    headers: { Origin: APP_ORIGIN },
    data,
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}

// A document that the reviewer may view and approve.
async function withApprover(page: Page, id: string) {
  await post(page, `/v1/documents/${id}/grants`, {
    address: "reviewer@example.com",
    role: "viewer",
  });
  await post(page, `/v1/documents/${id}/approvers`, {
    address: "reviewer@example.com",
  });
}

test("an older version whose approvals fail shows no counts, and Retry loads them", async ({
  page,
  browser,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Old approvals"), HTML);
  await withApprover(page, document.id);
  const v1 = document.current_version_id;
  const reviewer = await reviewerOn(browser, "/app/documents");
  await post(reviewer, `/v1/documents/${document.id}/approvals`, {
    version_id: v1,
    decision: "approved",
  });
  await reviewer.context().close();
  await slashdocs.pushVersion(document.id, HTML.replace("approvals test", "next test"));

  const olderApprovals = (url: URL) =>
    url.pathname === `/v1/documents/${document.id}/approvals` &&
    url.searchParams.get("version") === v1;
  await page.route(olderApprovals, (r) => r.fulfill(unavailable));
  await page.goto(`/app/d/${document.id}?version=${v1}`);

  const chip = page.getByRole("button", {
    name: "Approvals did not load. Open approvals",
  });
  await expect(chip).toBeVisible(soon);
  await expect(page.getByText(/0 of 1 approved/)).toBeHidden();

  await chip.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Could not load approvals")).toBeVisible(soon);
  await page.unroute(olderApprovals);
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.getByText("1 of 1 approved")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: /^Approval approved: 1 of 1 approved/ }),
  ).toBeVisible();
});

test("the owner is told when the approvers fail, and Remove waits for them", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Approvers"), HTML);
  await withApprover(page, document.id);
  const approvers = `**/v1/documents/${document.id}/approvers`;
  await page.route(approvers, (r) =>
    r.request().method() === "GET" ? r.fulfill(unavailable) : r.fallback(),
  );
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: /Open approvals$/ }).click();

  const dialog = page.getByRole("dialog");
  const remove = dialog.getByRole("button", { name: /^Remove .+ as approver$/ });
  await expect(dialog.getByText(/Could not load the approvers/)).toBeVisible(soon);
  await expect(remove).toBeDisabled();

  await page.unroute(approvers);
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(remove).toBeEnabled();
  await expect(dialog.getByText(/Could not load the approvers/)).toBeHidden();
});

test("a failed approver search says so, with Retry, and a full address still adds", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Search"), HTML);
  const search = "**/v1/users?q=*";
  await page.route(search, (r) => r.fulfill(unavailable));
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "Request approval" }).click();

  const dialog = page.getByRole("dialog");
  const field = dialog.getByRole("combobox", { name: "Approver" });
  await field.fill("rev");
  await expect(dialog.getByText(/Could not search people/)).toBeVisible(soon);

  await page.unroute(search);
  await dialog.getByRole("button", { name: "Retry" }).click();
  await expect(dialog.getByText(/Could not search people/)).toBeHidden();
  await field.press("ArrowDown");
  await expect(dialog.getByRole("option", { name: /reviewer/i })).toBeVisible();
});

test("Who can approve? opens on a click, Esc closes only it, and errors do not move it", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Who"), HTML);
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "Request approval" }).click();
  const dialog = page.getByRole("dialog");
  const who = dialog.getByRole("button", { name: "Who can approve?" });

  await who.click();
  await expect(page.getByRole("tooltip")).toContainText("Anyone who edited it");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tooltip")).toBeHidden();
  await expect(dialog).toBeVisible();

  // With no approvers, no empty list sits between the status and the field.
  const status = dialog.getByText("No approvers assigned");
  const hint = dialog.getByText("Add someone who did not edit this document.");
  const gap =
    (await hint.boundingBox())!.y -
    ((await status.boundingBox())!.y + (await status.boundingBox())!.height);
  expect(gap).toBeLessThan(40);

  const before = (await who.boundingBox())!.y;
  await dialog.getByRole("combobox", { name: "Approver" }).fill("reviewer@example.com");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Share as viewer and add" }),
  ).toBeVisible();
  expect((await who.boundingBox())!.y).toBe(before);
});

test("Check access during an outage says that the check failed, not that access is missing", async ({
  page,
  browser,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Check"), HTML);
  const reviewer = await reviewerOn(browser, "/app/documents");
  await reviewer.goto(`/app/d/${document.id}`);
  await reviewer.getByRole("button", { name: "Request access" }).click();
  await expect(reviewer.getByRole("button", { name: /Request sent/ })).toBeVisible();

  const read = (url: URL) => url.pathname === `/v1/documents/${document.id}`;
  await reviewer.route(read, (r) => r.fulfill(unavailable));
  await post(page, `/v1/documents/${document.id}/grants`, {
    address: "reviewer@example.com",
    role: "commenter",
  });
  await reviewer.getByRole("button", { name: "Check access" }).click();
  await expect(reviewer.getByText(/Could not check access/)).toBeVisible();
  await expect(reviewer.getByText(/You still don't have access/)).toBeHidden();

  await reviewer.unroute(read);
  await reviewer.getByRole("button", { name: "Check access" }).click();
  await expect(reviewer.locator('iframe[title="Rendered document"]')).toBeVisible();
  await reviewer.context().close();
});

test("a failed workspace keeps the bar and offers Sign out", async ({ page }) => {
  await page.route("**/v1/me", (r) => r.fulfill(unavailable));
  await page.goto("/app/documents");
  await expect(page.getByText("Could not load your workspace")).toBeVisible();
  await expect(page.getByRole("link", { name: "slashdocs home" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
});

test("a failed access list shows its error in seconds, not after a long skeleton", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Fast error"), HTML);
  await page.route(`**/v1/documents/${document.id}/access`, (r) =>
    r.fulfill(unavailable),
  );
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText(/Could not load who has access/),
  ).toBeVisible({ timeout: 4_000 });
});
