import { expect, test, uniqueName } from "./fixtures";

// In the Approvals dialog, the fix for a person without access is the
// primary action and says what it did. One line says who to add, and the
// full rule waits in "Who can approve?".

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Review</title></head>
<body><h1>Review</h1><p>Please approve.</p></body></html>`;

test("Share as viewer and add is the primary action, and confirms the share", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Approvals R8"), HTML);
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "Request approval" }).click();
  const dialog = page.getByRole("dialog");
  const field = dialog.getByRole("combobox", { name: "Approver" });
  await expect(field).toBeFocused();
  await expect(
    dialog.getByText("Add someone who did not edit this document."),
  ).toBeVisible();
  await expect(dialog.getByText(/Anyone who edited it/)).toBeHidden();

  // The rule is one Tab away, in a tooltip. Add is off while the field is
  // empty, so Tab passes it.
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: "Who can approve?" })).toBeFocused();
  await expect(page.getByRole("tooltip")).toContainText(
    "Anyone who edited it, in the browser, by upload, or by an agent",
  );

  await field.fill("reviewer@example.com");
  const add = dialog.getByRole("button", { name: "Add", exact: true });
  await add.click();
  const share = dialog.getByRole("button", { name: "Share as viewer and add" });
  await expect(share).toBeVisible();
  await expect(share).toHaveClass(/bg-\[var\(--color-accent\)\]/);
  await expect(add).not.toHaveClass(/bg-\[var\(--color-accent\)\]/);

  await share.click();
  await expect(
    page.getByText(/^Shared with .+ as viewer and added as approver\.$/),
  ).toBeVisible();
  await expect(dialog.getByText("Pending", { exact: true })).toBeVisible();
});
