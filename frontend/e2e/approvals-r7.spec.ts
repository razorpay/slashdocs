import { type FrameLocator, type Page } from "@playwright/test";
import {
  APP_ORIGIN,
  expect,
  reviewerOn,
  startEditing,
  test,
  uniqueName,
} from "./fixtures";

// The owner asks a person who cannot open the document to approve it, and an
// editor learns before and after an edit that it resets the approval.

const HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Approved</title></head>
  <body>
    <h1>Approved</h1>
    <p id="tail">The light is green.</p>
  </body>
</html>`;

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

test("an edit warns that it resets an approval, and its undo gives it back", async ({
  page,
  browser,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Approved"), HTML);
  const path = `/app/d/${document.id}`;
  await page.goto(path);

  // The reviewer cannot open the document: the dialog says so and shares it.
  await page.getByRole("button", { name: "Request approval" }).click();
  await page.getByRole("combobox", { name: "Approver" }).fill("reviewer@example.com");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "That person can't open this document. Share it with them first.",
  );
  await page.getByRole("button", { name: "Share as viewer and add" }).click();
  await expect(page.getByRole("alert")).toBeHidden();
  await expect(
    page.getByRole("dialog").getByText("Pending", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  const reviewer = await reviewerOn(browser, path);
  const approved = await reviewer.request.post(
    `/v1/documents/${document.id}/approvals`,
    {
      headers: { Origin: APP_ORIGIN },
      data: { version_id: document.current_version_id, decision: "approved" },
    },
  );
  expect(approved.ok()).toBeTruthy();
  await reviewer.context().close();

  const chip = page.getByRole("button", { name: /^Approval .*Open approvals$/ });
  await expect(chip).toHaveAccessibleName(/1 of 1 approved/);

  // Before the first key, the editor learns what an edit does.
  await startEditing(page);
  await renderedDocument(page).getByText("green").click();
  await expect(
    page.getByText(/^Your change asks .+ to approve again\.$/),
  ).toBeVisible();
  await page.keyboard.type("er");
  await expect(page.getByText(/The approval of .+ is reset\.$/)).toBeVisible({
    timeout: 10_000,
  });
  await expect(chip).toHaveAccessibleName(/0 of 1 approved/);

  await page.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(page.getByText(/The approval of .+ is restored\.$/)).toBeVisible({
    timeout: 10_000,
  });
  await expect(chip).toHaveAccessibleName(/1 of 1 approved/);
});
