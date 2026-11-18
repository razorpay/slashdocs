import { expect, test, uniqueName } from "./fixtures";

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
