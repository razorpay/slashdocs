import { type Page } from "@playwright/test";
import { apiPost, APP_ORIGIN, expect, reviewerOn, test, uniqueName } from "./fixtures";

// The inbox in the header holds what waits on the reader: documents to
// approve and threads with a message that they did not read. Each one leaves
// when the reader acts on it.

const html = (title: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1><p>The rollout starts with 1% of merchants.</p></body></html>`;

async function openInbox(page: Page) {
  await page.goto("/app/documents");
  await page.getByRole("button", { name: /^Inbox, / }).click();
}

// expectGone waits until the inbox of the page no longer holds the document.
// The inbox shows only when something waits, so it can be gone too.
async function expectGone(page: Page, documentID: string, title: string) {
  await expect
    .poll(async () => {
      const inbox = await (await page.request.get("/v1/me/inbox")).json();
      return inbox.items.some(
        (i: { document_id: string }) => i.document_id === documentID,
      );
    })
    .toBe(false);
  await page.goto("/app/documents");
  await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  const inbox = page.getByRole("button", { name: /^Inbox, / });
  if (await inbox.isVisible()) {
    await inbox.click();
    await expect(page.getByRole("menuitem", { name: new RegExp(title) })).toHaveCount(
      0,
    );
  }
}

test("a reply to the reader's thread waits in the inbox until the reader reads it", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Inbox thread");
  const document = await slashdocs.createDocument(title, html(title));
  await slashdocs.shareWithAnyone(document.id, "commenter");
  const thread = await slashdocs.createComment(document.id, "Why 1%?", {
    quote: "1% of merchants",
  });
  const reviewer = await reviewerOn(browser, "/app/documents");
  await apiPost(
    reviewer,
    `/v1/documents/${document.id}/comments/${thread.id}/replies`,
    {
      body: "It limits the risk.",
    },
  );
  await reviewer.context().close();

  await openInbox(page);
  const row = page.getByRole("menuitem", { name: new RegExp(`on ${title}`) });
  await expect(row).toContainText("It limits the risk.");
  await row.click();
  await expect(page).toHaveURL(
    `${APP_ORIGIN}/app/d/${document.id}?comment=${thread.id}`,
  );
  await expect(
    page
      .getByRole("dialog", { name: "Comment thread" })
      .getByText("It limits the risk."),
  ).toBeVisible();
  // The thread reads after a second in view.
  await expectGone(page, document.id, title);
});

test("a document to approve waits in the inbox of the approver until they decide", async ({
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Inbox approval");
  const document = await slashdocs.createDocument(title, html(title));
  await slashdocs.addApprover(document.id, "reviewer@example.com");

  const reviewer = await reviewerOn(browser, "/app/documents");
  await openInbox(reviewer);
  await reviewer.getByRole("menuitem", { name: new RegExp(title) }).click();
  await expect(reviewer).toHaveURL(`${APP_ORIGIN}/app/d/${document.id}?approvals=1`);

  await apiPost(reviewer, `/v1/documents/${document.id}/approvals`, {
    version_id: document.current_version_id,
    decision: "approved",
  });
  await expectGone(reviewer, document.id, title);
  await reviewer.context().close();
});
