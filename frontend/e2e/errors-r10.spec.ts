import { type Page, type Route } from "@playwright/test";
import { expect, test, uniqueName } from "./fixtures";

// A failed read says that it failed, with Retry, in the place of what did not
// load. It is never raw JSON in a ready document, an empty list, or "No
// access" for a part of a page.

const HTML = (heading: string) => `<!doctype html>
<html><head><meta charset="utf-8"><title>${heading}</title></head>
<body><h1>${heading}</h1><p>The render test.</p></body></html>`;

const fail =
  (status: number) =>
  (route: Route): Promise<void> =>
    route.fulfill({ status, json: { error: { message: `R10 failure ${status}` } } });

// Each way that a read can fail.
const FAILURES: [string, (route: Route) => Promise<void>][] = [
  ["403", fail(403)],
  ["404", fail(404)],
  ["503", fail(503)],
  ["network failure", (route) => route.abort("failed")],
];

// A query that fails with 503 retries once before it shows an error. The
// frame waits 3 s after its load for the bridge.
const soon = { timeout: 15_000 };

const documentText = (page: Page, title: string) =>
  page.frameLocator(`iframe[title="${title}"]`).frameLocator("iframe#slashdocs-doc");

for (const [name, failure] of FAILURES) {
  test(`a render URL that fails with ${name} after its token shows an error, and Retry loads it`, async ({
    page,
    slashdocs,
  }) => {
    const document = await slashdocs.createDocument(
      uniqueName("Render"),
      HTML("Render fault"),
    );
    const render = (url: URL) => url.pathname.startsWith(`/v/${document.id}/`);
    await page.route(render, failure);
    await page.goto(`/app/d/${document.id}`);

    await expect(page.getByText("Could not open the document")).toBeVisible(soon);
    await expect(page.getByText(/R10 failure/)).toHaveCount(0);
    await expect(page.getByRole("radio", { name: "Edit" })).toBeHidden();
    const url = page.url();

    await page.unroute(render);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(
      documentText(page, "Rendered document").getByRole("heading", {
        name: "Render fault",
      }),
    ).toBeVisible();
    await expect(page.getByRole("radio", { name: "Edit" })).toBeVisible();
    expect(page.url()).toBe(url);
  });
}

test("a README whose render URL fails keeps the folder, and Retry loads the README", async ({
  page,
  slashdocs,
}) => {
  const readme = await slashdocs.createDocument("README.html", HTML("Folder readme"));
  await page.route("**/v1/folders/fld_r10", (r) =>
    r.fulfill({ json: { id: "fld_r10", title: "R10 guides" } }),
  );
  await page.route("**/v1/folders?folder_id=fld_r10*", (r) =>
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
  await page.goto("/app/folders/fld_r10");

  await expect(page.getByText("Could not render README.html")).toBeVisible(soon);
  await expect(page.getByRole("heading", { name: "R10 guides" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open document" })).toBeVisible();

  await page.unroute(render);
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    documentText(page, "Folder README").getByRole("heading", { name: "Folder readme" }),
  ).toBeVisible();
});

for (const [name, failure] of FAILURES) {
  test(`a search that fails with ${name} shows the shared error, and Retry keeps the query`, async ({
    page,
  }) => {
    const search = (url: URL) =>
      url.pathname === "/v1/documents" && url.searchParams.get("q") === "r10query";
    await page.route(search, failure);
    await page.goto("/app/documents?q=r10query");

    await expect(page.getByText("Could not search documents")).toBeVisible(soon);
    await expect(page.getByText("No matches")).toBeHidden();
    await expect(page.getByText("Something went wrong")).toHaveCount(0);

    await page.unroute(search);
    await page.getByRole("button", { name: "Retry" }).click();
    await expect(page.getByText("No matches")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Search documents" })).toHaveValue(
      "r10query",
    );
  });
}

test("a search that the server cannot read says why, apart from a failure", async ({
  page,
}) => {
  await page.route("**/v1/documents?q=*", (r) =>
    r.fulfill({
      status: 400,
      json: { error: { message: "R10 unknown search operator." } },
    }),
  );
  await page.goto("/app/documents?q=r10bad");
  await expect(page.getByText("Search query not valid")).toBeVisible(soon);
  await expect(page.getByText("R10 unknown search operator.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
});

for (const [name, failure] of FAILURES) {
  test(`a folder whose contents fail with ${name} keeps its header, and is not empty`, async ({
    page,
  }) => {
    await page.route("**/v1/folders/fld_r10c", (r) =>
      r.fulfill({ json: { id: "fld_r10c", title: "R10 contents" } }),
    );
    const contents = "**/v1/folders?folder_id=fld_r10c*";
    await page.route(contents, failure);
    await page.goto("/app/folders/fld_r10c");

    await expect(page.getByText("Could not load what is in this folder")).toBeVisible(
      soon,
    );
    await expect(page.getByRole("heading", { name: "R10 contents" })).toBeVisible();
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

    await expect(page.getByText("Could not load your pins.")).toBeVisible(soon);
    await expect(page.getByText("Could not load the featured documents.")).toBeVisible(
      soon,
    );
    await expect(
      page.getByRole("button", { name: /requests for access did not load/i }),
    ).toBeVisible(soon);

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
