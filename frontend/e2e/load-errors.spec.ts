import { type Page, type Route } from "@playwright/test";
import {
  apiPost,
  expect,
  renderedDocument,
  reviewerOn,
  test,
  uniqueName,
} from "./fixtures";

// A query that fails says that it failed, soon and with Retry, in the place
// of what did not load. It never shows raw JSON in a ready document, an empty
// list, the counts of another version, "No access", a hidden action, or a
// read-only state that it does not know.

const unavailable = { status: 503, json: { error: { message: "unavailable" } } };

const fail =
  (status: number) =>
  (route: Route): Promise<void> =>
    route.fulfill({
      status,
      json: { error: { message: `Injected failure ${status}` } },
    });

// Each way that a read can fail.
const FAILURES: [string, (route: Route) => Promise<void>][] = [
  ["403", fail(403)],
  ["404", fail(404)],
  ["503", fail(503)],
  ["network failure", (route) => route.abort("failed")],
];

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

// A query that fails with 503 retries once before it shows an error. The
// frame waits 3 s after its load for the bridge.
const afterRetries = { timeout: 15_000 };

// A query retries once, so its error shows in about a second.
const soon = { timeout: 5_000 };

const documentHTML = (heading = "Errors") => `<!doctype html>
<html><head><meta charset="utf-8"><title>${heading}</title></head>
<body><h1>${heading}</h1><p>The error test.</p></body></html>`;

test("the share sheet says that access is unknown while its list fails", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(
    uniqueName("Share error"),
    documentHTML(),
  );
  await slashdocs.shareWithAnyone(document.id, "commenter");
  // The doc bar and the sheet share the access list, so it fails from the
  // start: a list that loaded once stays on screen through a failed refresh.
  await answer(page, `**/v1/documents/${document.id}/access`, unavailable);
  await page.goto(`/app/d/${document.id}`);
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
  const inbox = page.getByRole("button", { name: "Inbox did not load" });
  await expect(inbox).toBeVisible(afterRetries);
  await inbox.click();
  await expect(page.getByText("Could not load the inbox.")).toBeVisible();
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
  browser,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(
    uniqueName("Role error"),
    documentHTML(),
  );
  await slashdocs.share(document.id, "reviewer@example.com", "editor");

  const path = `/app/d/${document.id}`;
  const reviewer = await reviewerOn(browser, "/app/documents");
  await reviewer.route(`**/v1/documents/${document.id}/access`, (r) =>
    r.fulfill(unavailable),
  );
  await reviewer.goto(path);
  await expect(reviewer.getByText("Could not check your access")).toBeVisible(
    afterRetries,
  );
  await reviewer.unroute(`**/v1/documents/${document.id}/access`);
  await reviewer.getByRole("button", { name: "Retry" }).click();
  await expect(
    reviewer.getByRole("button", { name: "Edit", exact: true }),
  ).toBeVisible();
  await reviewer.context().close();
});

test("the page that waits for access opens the document when access is granted", async ({
  browser,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Waits"), documentHTML());
  const path = `/app/d/${document.id}`;
  const reviewer = await reviewerOn(browser, "/app/documents");
  await reviewer.goto(path);
  await reviewer.getByRole("button", { name: "Request access" }).click();
  await expect(reviewer.getByRole("button", { name: /Request sent/ })).toBeVisible();

  // Check access while there is no grant says so.
  await reviewer.getByRole("button", { name: "Check access" }).click();
  await expect(reviewer.getByText(/You still don't have access/)).toBeVisible();

  await slashdocs.share(document.id, "reviewer@example.com", "commenter");
  // No reload: the page opens the document by itself.
  await expect(reviewer.locator('iframe[title="Rendered document"]')).toBeVisible({
    timeout: 10_000,
  });
  await reviewer.context().close();
});

test("an older version whose approvals fail shows no counts, and Retry loads them", async ({
  page,
  browser,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(
    uniqueName("Old approvals"),
    documentHTML(),
  );
  await slashdocs.addApprover(document.id, "reviewer@example.com");
  const v1 = document.current_version_id;
  const reviewer = await reviewerOn(browser, "/app/documents");
  await apiPost(reviewer, `/v1/documents/${document.id}/approvals`, {
    version_id: v1,
    decision: "approved",
  });
  await reviewer.context().close();
  await slashdocs.pushVersion(document.id, documentHTML("Errors again"));

  const olderApprovals = (url: URL) =>
    url.pathname === `/v1/documents/${document.id}/approvals` &&
    url.searchParams.get("version") === v1;
  await page.route(olderApprovals, (r) => r.fulfill(unavailable));
  await page.goto(`/app/d/${document.id}?version=${v1}`);

  const chip = page.getByRole("button", { name: "Approvals did not load" });
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
    page.getByRole("button", { name: "Approvals: 1 of 1 approved" }),
  ).toBeVisible();
});

test("the owner is told when the approvers fail, and Remove waits for them", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(
    uniqueName("Approvers"),
    documentHTML(),
  );
  await slashdocs.addApprover(document.id, "reviewer@example.com");
  const approvers = `**/v1/documents/${document.id}/approvers`;
  await page.route(approvers, (r) =>
    r.request().method() === "GET" ? r.fulfill(unavailable) : r.fallback(),
  );
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: /^Approvals: / }).click();

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
  const document = await slashdocs.createDocument(uniqueName("Search"), documentHTML());
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

test("with no approvers, no empty list sits between the status and the field", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Empty"), documentHTML());
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "Request approval" }).click();
  const dialog = page.getByRole("dialog");
  const status = dialog.getByText("No approvers assigned");
  const field = dialog.getByRole("combobox", { name: "Approver" });
  const gap =
    (await field.boundingBox())!.y -
    ((await status.boundingBox())!.y + (await status.boundingBox())!.height);
  expect(gap).toBeLessThan(40);
});

test("Check access during an outage says that the check failed, not that access is missing", async ({
  browser,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(uniqueName("Check"), documentHTML());
  const reviewer = await reviewerOn(browser, "/app/documents");
  await reviewer.goto(`/app/d/${document.id}`);
  await reviewer.getByRole("button", { name: "Request access" }).click();
  await expect(reviewer.getByRole("button", { name: /Request sent/ })).toBeVisible();

  const read = (url: URL) => url.pathname === `/v1/documents/${document.id}`;
  await reviewer.route(read, (r) => r.fulfill(unavailable));
  await slashdocs.share(document.id, "reviewer@example.com", "commenter");
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
  const document = await slashdocs.createDocument(
    uniqueName("Fast error"),
    documentHTML(),
  );
  await page.route(`**/v1/documents/${document.id}/access`, (r) =>
    r.fulfill(unavailable),
  );
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText(/Could not load who has access/),
  ).toBeVisible({ timeout: 4_000 });
});

for (const [name, failure] of FAILURES) {
  test(`a render URL that fails with ${name} after its token shows an error, and Retry loads it`, async ({
    page,
    slashdocs,
  }) => {
    const document = await slashdocs.createDocument(
      uniqueName("Render"),
      documentHTML("Render fault"),
    );
    const render = (url: URL) => url.pathname.startsWith(`/v/${document.id}/`);
    await page.route(render, failure);
    await page.goto(`/app/d/${document.id}`);

    await expect(page.getByText("Could not open the document")).toBeVisible(
      afterRetries,
    );
    await expect(page.getByText(/Injected failure/)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeHidden();
    const url = page.url();

    await page.unroute(render);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(
      renderedDocument(page).getByRole("heading", { name: "Render fault" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
    expect(page.url()).toBe(url);
  });
}

test("a README whose render URL fails keeps the folder, and Retry loads the README", async ({
  page,
  slashdocs,
}) => {
  const readme = await slashdocs.createDocument(
    "README.html",
    documentHTML("Folder readme"),
  );
  await page.route("**/v1/folders/fld_guides", (r) =>
    r.fulfill({ json: { id: "fld_guides", title: "Guides" } }),
  );
  await page.route("**/v1/folders?folder_id=fld_guides*", (r) =>
    r.fulfill({
      json: {
        items: [
          {
            type: "document",
            document: {
              id: readme.id,
              title: "README.html",
              current_version_id: readme.current_version_id,
            },
          },
        ],
        has_more: false,
      },
    }),
  );
  const render = (url: URL) => url.pathname.startsWith(`/v/${readme.id}/`);
  await page.route(render, fail(503));
  await page.goto("/app/folders/fld_guides");

  await expect(page.getByText("Could not render README.html")).toBeVisible(
    afterRetries,
  );
  await expect(page.getByRole("heading", { name: "Guides" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open document" })).toBeVisible();

  await page.unroute(render);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    page
      .frameLocator('iframe[title="Folder README"]')
      .frameLocator("iframe#slashdocs-doc")
      .getByRole("heading", { name: "Folder readme" }),
  ).toBeVisible();
});

for (const [name, failure] of FAILURES) {
  test(`a search that fails with ${name} shows the shared error, and Retry keeps the query`, async ({
    page,
  }) => {
    const search = (url: URL) =>
      url.pathname === "/v1/documents" && url.searchParams.get("q") === "lostquery";
    await page.route(search, failure);
    await page.goto("/app/documents?q=lostquery");

    await expect(page.getByText("Could not search documents")).toBeVisible(
      afterRetries,
    );
    await expect(page.getByText("No matches")).toBeHidden();
    await expect(page.getByText("Something went wrong")).toHaveCount(0);

    await page.unroute(search);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("No matches")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Search documents" })).toHaveValue(
      "lostquery",
    );
  });
}

test("a search that the server cannot read says why, apart from a failure", async ({
  page,
}) => {
  await page.route("**/v1/documents?q=*", (r) =>
    r.fulfill({
      status: 400,
      json: { error: { message: "Unknown search operator." } },
    }),
  );
  await page.goto("/app/documents?q=badquery");
  await expect(page.getByText("Search query not valid")).toBeVisible(afterRetries);
  await expect(page.getByText("Unknown search operator.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
});

for (const [name, failure] of FAILURES) {
  test(`a folder whose contents fail with ${name} keeps its header, and is not empty`, async ({
    page,
  }) => {
    await page.route("**/v1/folders/fld_contents", (r) =>
      r.fulfill({ json: { id: "fld_contents", title: "Contents" } }),
    );
    const contents = "**/v1/folders?folder_id=fld_contents*";
    await page.route(contents, failure);
    await page.goto("/app/folders/fld_contents");

    await expect(page.getByText("Could not load what is in this folder")).toBeVisible(
      afterRetries,
    );
    await expect(page.getByRole("heading", { name: "Contents" })).toBeVisible();
    await expect(page.getByText("Empty folder")).toHaveCount(0);
    await expect(page.getByText("You don't have access to this folder")).toHaveCount(0);

    await page.unroute(contents);
    await page.route(contents, (r) =>
      r.fulfill({ json: { items: [], has_more: false } }),
    );
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("Empty folder")).toBeVisible();
  });
}

for (const [name, failure] of FAILURES) {
  test(`pins, featured and access requests that fail with ${name} each say so on Documents`, async ({
    page,
  }) => {
    for (const path of ["**/v1/pins", "**/v1/featured", "**/v1/access-requests"])
      await page.route(path, failure);
    await page.goto("/app/documents");

    await expect(page.getByText("Could not load your pins.")).toBeVisible(afterRetries);
    await expect(page.getByText("Could not load the featured documents.")).toBeVisible(
      afterRetries,
    );
    await expect(page.getByRole("button", { name: "Inbox did not load" })).toBeVisible(
      afterRetries,
    );

    await page.unrouteAll();
    for (const text of [
      "Could not load your pins.",
      "Could not load the featured documents.",
    ])
      await page
        .getByRole("alert")
        .filter({ hasText: text })
        .getByRole("button", { name: "Retry" })
        .click();
    await expect(page.getByText("Could not load your pins.")).toBeHidden();
    await expect(page.getByText("Could not load the featured documents.")).toBeHidden();
  });
}

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
