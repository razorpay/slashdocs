import { APP_ORIGIN, expect, reviewerOn, test, uniqueName } from "./fixtures";

// The owner of a document makes it delete itself after a period, from the
// More menu, and takes the expiry away again.

test("the owner sets auto-delete from the More menu, and removes it", async ({
  page,
  slashdocs,
}) => {
  const config = await (await page.request.get("/v1/config")).json();
  test.skip(
    config.document_expiry_enabled !== true,
    "The server has the expiry of documents turned off.",
  );
  const title = uniqueName("Expiry");
  const document = await slashdocs.createDocument(title, `<h1>${title}</h1>`);
  await page.goto(`/app/d/${document.id}`);
  const mark = page.getByRole("button", { name: /^Deletes in/ });
  await expect(page.getByRole("button", { name: "More" })).toBeVisible();
  await expect(mark).toHaveCount(0);

  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Auto-delete…" }).click();
  const dialog = page.getByRole("dialog", { name: "Auto-delete" });
  await expect(
    dialog.getByText("This document is kept until you delete it."),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Save", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("radio", { name: "7 days" }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText("This document is deleted in 7 days.")).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(mark).toContainText("Deletes in 7 days");
  // The server keeps it.
  await page.reload();
  await expect(mark).toContainText("Deletes in 7 days");

  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Auto-delete…" }).click();
  await expect(dialog.getByText(/^This document is deleted on /)).toBeVisible();
  await dialog.getByRole("radio", { name: "Keep" }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();

  await expect(page.getByText("This document is kept.")).toBeVisible();
  await expect(mark).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "More" })).toBeVisible();
  await expect(mark).toHaveCount(0);
});

// An editor cannot delete the document. They see when it goes, and they can
// move that later. They cannot make it sooner, and cannot remove it.
test("an editor sees the expiry and moves it later, and cannot make it sooner", async ({
  page,
  browser,
  slashdocs,
}) => {
  const config = await (await page.request.get("/v1/config")).json();
  test.skip(
    config.document_expiry_enabled !== true,
    "The server has the expiry of documents turned off.",
  );
  const title = uniqueName("Expiry editor");
  const document = await slashdocs.createDocument(title, `<h1>${title}</h1>`);
  await slashdocs.shareWithAnyone(document.id, "editor");
  const set = await page.request.patch(`/v1/documents/${document.id}`, {
    data: { expires_in: "3d" },
    headers: { Origin: APP_ORIGIN },
  });
  expect(set.ok()).toBe(true);

  const reviewer = await reviewerOn(browser, `/app/d/${document.id}`);
  const mark = reviewer.getByRole("button", { name: /^Deletes in/ });
  await expect(mark).toContainText(/Deletes in [23] days/);
  // The server refuses a sooner time, whatever the page offers.
  const sooner = await reviewer.request.patch(`/v1/documents/${document.id}`, {
    data: { expires_in: "1d" },
    headers: { Origin: APP_ORIGIN },
  });
  expect(sooner.status()).toBe(403);
  // An editor does not remove the expiry either.
  const removed = await reviewer.request.patch(`/v1/documents/${document.id}`, {
    data: { expires_at: null },
    headers: { Origin: APP_ORIGIN },
  });
  expect(removed.status()).toBe(403);

  await mark.click();
  const dialog = reviewer.getByRole("dialog", { name: "Auto-delete" });
  await expect(dialog.getByRole("radio", { name: "1 day" })).toBeDisabled();
  await expect(dialog.getByRole("radio", { name: "Keep" })).toBeDisabled();
  await expect(dialog.getByText("Editors can change this 3 more times.")).toBeVisible();
  await dialog.getByRole("radio", { name: "1 month" }).click();
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(mark).toContainText(/Deletes in (30|29) days|Deletes in 1 month/);
  // The owner sees the change.
  await page.goto(`/app/d/${document.id}`);
  await expect(page.getByRole("button", { name: /^Deletes in/ })).not.toContainText(
    /[23] days/,
  );
  await reviewer.context().close();
});
