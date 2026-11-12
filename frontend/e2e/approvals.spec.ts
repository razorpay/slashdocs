import { type Browser, type Page, type Route } from "@playwright/test";
import {
  APP_ORIGIN,
  expect,
  latestSource,
  renderedDocument,
  reviewerOn,
  startEditing,
  test,
  uniqueName,
  type SlashdocsAPI,
} from "./fixtures";

// The owner asks a person who cannot open the document to approve it, and an
// editor learns before and after an edit that it resets the approval. An
// approval is for the text that the approver saw: a key of another person
// resets it, and a page that is behind cannot give it. In the Approvals
// dialog, the search shows a person who cannot edit the document. A pick
// asks to give them editor access, and then adds them.

const HTML = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Approved</title></head>
  <body>
    <h1>Approved</h1>
    <p id="tail">The light is green.</p>
  </body>
</html>`;

const tail = (page: Page) => renderedDocument(page).locator("#tail");
const chip = (page: Page) => page.getByRole("button", { name: /^Approvals: / });
const approve = (page: Page) =>
  page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true });

// typeAtEnd starts Edit mode and types at the end of the last paragraph.
async function typeAtEnd(page: Page, text: string) {
  await startEditing(page);
  await tail(page).click();
  await page.keyboard.press("End");
  await page.keyboard.type(text);
}

// withReviewer opens a new document for the admin, with the reviewer as its
// approver. The reviewer has a page of their own, on the list of documents.
async function withReviewer(page: Page, browser: Browser, slashdocs: SlashdocsAPI) {
  const document = await slashdocs.createDocument(uniqueName("Approved"), HTML);
  await slashdocs.addApprover(document.id, "reviewer@example.com");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  return { document, path, reviewer: await reviewerOn(browser, "/app/documents") };
}

// approvedCount counts the approvals of the document as it is now.
async function approvedCount(page: Page, id: string): Promise<number> {
  const approvals = await page.request.get(`/v1/documents/${id}/approvals`);
  return (await approvals.json()).summary.approved;
}

test("an edit warns that it resets an approval", async ({
  page,
  browser,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Approved"), HTML);
  const path = `/app/d/${document.id}`;
  await page.goto(path);

  // The reviewer cannot open the document: the dialog asks to give them
  // access.
  await page.getByRole("button", { name: "Request approval" }).click();
  await page.getByRole("combobox", { name: "Approver" }).fill("reviewer@example.com");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByRole("button", { name: "Give access and add" }).click();
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

  await expect(chip(page)).toHaveAccessibleName(/1 of 1 approved/);

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
  await expect(chip(page)).toHaveAccessibleName(/0 of 1 approved/);
});

test("one key of an editor resets an approval, for the approver too", async ({
  page,
  browser,
  slashdocs,
}) => {
  const { document, path, reviewer } = await withReviewer(page, browser, slashdocs);
  await reviewer.goto(path);
  await chip(reviewer).click();
  await approve(reviewer).click();
  await reviewer.keyboard.press("Escape");
  for (const p of [page, reviewer])
    await expect(chip(p)).toHaveAccessibleName(/1 of 1 approved/);

  await typeAtEnd(page, "!");
  await expect(tail(reviewer)).toHaveText("The light is green.!");
  for (const p of [page, reviewer])
    await expect(chip(p)).toHaveAccessibleName(/0 of 1 approved/);
  expect(await approvedCount(page, document.id)).toBe(0);
  // The approver sees that their approval was for the text of before.
  await chip(reviewer).click();
  await expect(
    reviewer.getByRole("dialog").getByText("approved before the latest edits"),
  ).toBeVisible();
  await expect(approve(reviewer)).toBeVisible();
  await reviewer.context().close();
});

test("an approver cannot approve while another person types, or a page that is behind", async ({
  page,
  browser,
  slashdocs,
}) => {
  test.setTimeout(90_000);
  const { document, path, reviewer } = await withReviewer(page, browser, slashdocs);
  // The page of the reviewer does not hear of the next edit: its stream does
  // not open, and its request for the changes waits.
  await reviewer.route("**/kv/events**", () => {});
  const held: Route[] = [];
  await reviewer.route("**/changes?**", (route) => void held.push(route));
  await reviewer.goto(path);
  await expect(tail(reviewer)).toHaveText("The light is green.");

  // The next key of a person who types would reset the approval.
  await typeAtEnd(page, " Or red.");
  await expect
    .poll(() => latestSource(page, document.id))
    .toContain("The light is green. Or red.");
  await chip(reviewer).click();
  await approve(reviewer).click();
  await expect(
    reviewer.getByText("People are editing this document. Decide when they are done."),
  ).toBeVisible();
  expect(await approvedCount(page, document.id)).toBe(0);

  // 10 seconds after the last key, nobody types. The page of the reviewer
  // still shows the text of before, so the approval is not taken.
  await reviewer.waitForTimeout(11_000);
  await approve(reviewer).click();
  await expect(
    reviewer.getByText(
      "This document changed. Review the current document before deciding.",
    ),
  ).toBeVisible();
  await expect(tail(reviewer)).toHaveText("The light is green.");
  expect(await approvedCount(page, document.id)).toBe(0);

  // The page gets the changes and shows them. Then the approval is taken.
  await reviewer.unroute("**/changes?**");
  for (const route of held) await route.continue();
  await expect(tail(reviewer)).toHaveText("The light is green. Or red.");
  await approve(reviewer).click();
  await expect(reviewer.getByRole("dialog").getByText("1 of 1 approved")).toBeVisible();
  expect(await approvedCount(page, document.id)).toBe(1);
  await reviewer.context().close();
});

for (const viewport of [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
]) {
  test(`a pick of a person without access asks, and gives them editor access (${viewport.width} px)`, async ({
    page,
    slashdocs,
  }) => {
    await page.setViewportSize(viewport);
    const document = await slashdocs.createDocument(uniqueName("Approvals"), HTML);
    await page.goto(`/app/d/${document.id}?approvals=1`);
    const dialog = page.getByRole("dialog", { name: "Approvals" });
    const field = dialog.getByRole("combobox", { name: "Approver" });
    await expect(field).toBeFocused();

    await field.fill("rev");
    const option = dialog.getByRole("option", { name: /reviewer/i });
    await expect(option).toContainText("No access");
    await option.click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText(
      "can't open this document. Give them editor access and add them as an approver?",
    );
    // The confirmation fits on the screen, over the approvals.
    const box = (await confirm.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);

    // Cancel gives nothing, and the focus goes back to the search.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(field).toBeFocused();
    await expect(dialog).toBeVisible();

    await field.press("Enter");
    await page.getByRole("button", { name: "Give access and add" }).click();
    await expect(
      page.getByText(/^Gave .+ editor access and added them as approver\.$/),
    ).toBeVisible();
    await expect(dialog.getByText("Pending", { exact: true })).toBeVisible();
    await expect(field).toBeFocused();

    const access = await page.request.get(`/v1/documents/${document.id}/access`, {
      headers: { Origin: APP_ORIGIN },
    });
    const { items } = (await access.json()) as {
      items: { principal: { email?: string }; effective_role: string }[];
    };
    expect(
      items.find((i) => i.principal.email === "reviewer@example.com")?.effective_role,
    ).toBe("editor");
  });
}
