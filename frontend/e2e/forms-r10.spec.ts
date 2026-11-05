import { type Page } from "@playwright/test";
import { expect, reviewerOn, test, uniqueName } from "./fixtures";

// Words typed in a form stay until the reader sends or discards them. A form
// that a remote change reaches keeps them, and sends them for new content
// only when the reader says so.

const html = (line: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Review</title></head>
<body><h1>Review</h1><p>${line}</p></body></html>`;

const REASON = "IMPORTANT REJECTION REASON DURING LIVE UPDATE";

async function addReviewer(page: Page) {
  await page.getByRole("button", { name: "Request approval" }).click();
  await page.getByRole("combobox", { name: "Approver" }).fill("reviewer@example.com");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Share as viewer and add" }).click();
  await expect(
    page.getByRole("dialog").getByText("Pending", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
}

async function openReject(page: Page) {
  await page.getByRole("button", { name: /Open approvals$/ }).click();
  await page.getByRole("button", { name: "Reject", exact: true }).click();
  return page.getByRole("dialog", { name: "Reject" });
}

test("a reason survives a new version and a reload, and rejects the new version only by choice", async ({
  page,
  browser,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(
    uniqueName("Forms R10"),
    html("One."),
  );
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  await addReviewer(page);

  const reviewer = await reviewerOn(browser, path);
  let reject = await openReject(reviewer);
  await reject.getByRole("textbox", { name: "Reason" }).fill(REASON);

  // The draft saves after a short pause.
  await expect
    .poll(() =>
      reviewer.evaluate(() => localStorage.getItem("slashdocs.field-drafts.v1")),
    )
    .toContain(REASON);
  await slashdocs.pushVersion(document.id, html("Two."));
  await expect(
    reject.getByText(
      /^(A new version was published\. )?You wrote this reason for version 1\./,
    ),
  ).toBeVisible({ timeout: 10_000 });
  await expect(reject.getByRole("textbox", { name: "Reason" })).toHaveValue(REASON);
  await expect(
    reject.getByRole("button", { name: "Reject", exact: true }),
  ).toBeDisabled();

  // A reload keeps the words, and still says what they were for.
  await reviewer.reload();
  reject = await openReject(reviewer);
  await expect(reject.getByRole("textbox", { name: "Reason" })).toHaveValue(REASON);
  await expect(
    reject.getByText("You wrote this reason for version 1. This is version 2."),
  ).toBeVisible();
  await reject.getByRole("button", { name: "Use it for version 2" }).click();
  await reject.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(reviewer.getByText(/^Rejected “.+”\.$/)).toBeVisible();

  const approvals = await reviewer.request.get(
    `/v1/documents/${document.id}/approvals`,
  );
  const items = (
    (await approvals.json()) as {
      items: { decision: string; note?: string; version_number?: number }[];
    }
  ).items;
  expect(items[0]).toMatchObject({
    decision: "rejected",
    note: REASON,
    version_number: 2,
  });
  await reviewer.context().close();
});

test("the open help of who can approve covers neither the field nor Add, and Add takes the first click", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(
    uniqueName("Forms R10 help"),
    html("One."),
  );
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "Request approval" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Approver" }).fill("reviewer@example.com");
  await dialog.getByRole("button", { name: "Who can approve?" }).click();
  const help = page.getByRole("tooltip");
  await expect(help).toContainText("Anyone who edited it");

  const box = (await page.locator(".icon-tooltip").boundingBox())!;
  const add = dialog.getByRole("button", { name: "Add", exact: true });
  for (const control of [add, dialog.getByRole("combobox", { name: "Approver" })]) {
    const other = (await control.boundingBox())!;
    const overlaps =
      box.x < other.x + other.width &&
      other.x < box.x + box.width &&
      box.y < other.y + other.height &&
      other.y < box.y + box.height;
    expect(overlaps).toBe(false);
  }
  await add.click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "That person can't open this document. Share it with them first.",
  );
  await expect(help).toBeHidden();
});

test("a new folder name survives a reload, and Cancel discards it", async ({
  page,
}) => {
  const name = uniqueName("Forms R10 folder");
  await page.goto("/app/documents");
  await page.getByRole("button", { name: "New folder" }).click();
  await page.getByRole("textbox", { name: "Folder name" }).fill(name);
  // The draft saves after a short pause.
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem("slashdocs.field-drafts.v1")))
    .toContain(name);
  await page.reload();
  await page.getByRole("button", { name: "New folder" }).click();
  await expect(page.getByRole("textbox", { name: "Folder name" })).toHaveValue(name);
  await expect(
    page.getByText("Your folder name from earlier came back."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "New folder" }).click();
  await expect(page.getByRole("textbox", { name: "Folder name" })).toHaveValue("");
});
