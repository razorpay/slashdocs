import {
  APP_ORIGIN,
  expect,
  goInApp,
  hold,
  renderedDocument,
  test,
  uniqueName,
} from "./fixtures";

// A response that comes after the reader moved on (left the page, or opened
// another item) still reaches the reader, for the item that it belongs to,
// and does not move the reader.

test("a document deleted after the reader left names it, and does not move them", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Late delete");
  const document = await slashdocs.createDocument(
    title,
    "<!doctype html><title>Late</title><h1>Late</h1>",
  );
  const release = await hold(page, `**/v1/documents/${document.id}`, "DELETE");
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Delete document" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await goInApp(page, "/app/settings/profile");

  release();
  await expect(page.getByText(`Deleted “${title}”.`)).toBeVisible();
  await expect(page).toHaveURL(/\/app\/settings\/profile$/);
});

test("a folder deleted after the reader opened another names it, and does not move them", async ({
  page,
  slashdocs,
}) => {
  const folder = async (title: string) => {
    const response = await page.request.post("/v1/folders", {
      headers: { Origin: APP_ORIGIN },
      data: { title },
    });
    expect(response.ok()).toBeTruthy();
    const { id } = (await response.json()) as { id: string };
    slashdocs.trackFolder(id);
    return id;
  };
  const doomed = uniqueName("Doomed");
  const doomedId = await folder(doomed);
  const otherId = await folder(uniqueName("Other"));
  const release = await hold(page, `**/v1/folders/${doomedId}`, "DELETE");
  await page.goto(`/app/folders/${doomedId}`);
  await page.getByRole("button", { name: "More folder actions" }).click();
  await page.getByRole("menuitem", { name: "Delete folder" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await goInApp(page, `/app/folders/${otherId}`);
  await expect(page.getByRole("alertdialog")).toBeHidden();

  release();
  await expect(page.getByText(`Deleted folder “${doomed}”.`)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/app/folders/${otherId}$`));
});

test("a Restore that ends after the reader left keeps them where they went", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Late restore");
  const document = await slashdocs.createDocument(
    title,
    "<!doctype html><title>First</title><h1>First</h1>",
  );
  const first = document.current_version_id;
  await slashdocs.pushVersion(
    document.id,
    "<!doctype html><title>Second</title><h1>Second</h1>",
  );
  const release = await hold(
    page,
    `**/v1/documents/${document.id}/versions/${first}/restore`,
    "POST",
  );
  await page.goto(`/app/d/${document.id}?version=${first}`);
  const restore = page.getByRole("button", { name: "Restore", exact: true });
  await restore.click();
  await expect(restore).toHaveAttribute("aria-busy", "true");
  await goInApp(page, "/app/documents");

  release();
  const toast = page.getByText(`Restored an earlier version of “${title}”.`);
  await expect(toast).toBeVisible();
  await expect(page).toHaveURL(/\/app\/documents$/);
  // Undo from Documents undoes it there too.
  await page
    .locator("[data-sonner-toast]", { has: toast })
    .getByRole("button", { name: "Undo" })
    .click();
  await expect(page.getByText(`Undid the restore of “${title}”.`)).toBeVisible();
  await expect(page).toHaveURL(/\/app\/documents$/);
});

test("an upload that ends after the reader opened an earlier version leaves them on it", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Late upload");
  const document = await slashdocs.createDocument(
    title,
    `<!doctype html><title>${title}</title><h1>First</h1>`,
  );
  const first = document.current_version_id;
  await slashdocs.pushVersion(
    document.id,
    `<!doctype html><title>${title}</title><h1>Second</h1>`,
  );
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/v1/documents/${document.id}/versions`, async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await released;
    await route.continue();
  });
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Replace with an HTML file" }).click();
  const sheet = page.getByRole("dialog", { name: "Replace with an HTML file" });
  await sheet.locator('input[type="file"]').setInputFiles({
    name: "third.html",
    mimeType: "text/html",
    buffer: Buffer.from(`<!doctype html><title>${title}</title><h1>Third</h1>`),
  });
  await sheet.getByRole("button", { name: "Upload" }).click();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();

  // The reader opens the first version in the app, as the history does.
  await page.evaluate((to) => {
    history.pushState({}, "", to);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `/app/d/${document.id}?version=${first}`);
  await expect(renderedDocument(page).locator("h1")).toHaveText("First");
  const uploaded = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/documents/${document.id}/versions`) &&
      r.request().method() === "POST",
  );
  release();
  await uploaded;
  await page.waitForTimeout(500);
  await expect(page).toHaveURL(new RegExp(`version=${first}`));
  await expect(renderedDocument(page).locator("h1")).toHaveText("First");
});
