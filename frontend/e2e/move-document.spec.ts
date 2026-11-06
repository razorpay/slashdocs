import { expect, test, uniqueName } from "./fixtures";
import type { Page } from "@playwright/test";

function documentHTML(heading: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${heading}</title></head><body><main><h1>${heading}</h1></main></body></html>`;
}

async function createRootFolder(
  page: Page,
  slashdocs: { trackFolder: (id: string) => void },
  title: string,
) {
  await page.getByRole("button", { name: "New folder" }).click();
  const dialog = page.getByRole("dialog", { name: "New folder" });
  await dialog.getByPlaceholder("Folder name").fill(title);
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/v1/folders";
  });
  await dialog.getByRole("button", { name: "Create" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  const folder = (await response.json()) as { id: string };
  expect(folder.id).toMatch(/^fld_/);
  slashdocs.trackFolder(folder.id);
  await expect(page.getByText(title, { exact: true }).first()).toBeVisible();
  return folder.id;
}

async function searchFolders(page: Page, query: string) {
  const input = page.getByRole("combobox", { name: "Search destination folders" });
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "GET" &&
      url.pathname === "/v1/folders" &&
      url.searchParams.get("q") === query &&
      url.searchParams.get("min_role") === "editor"
    );
  });
  await input.fill(query);
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  return input;
}

async function openMoveDialog(page: Page) {
  await page.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Move to folder" }).click();
  const dialog = page.getByRole("dialog", { name: "Move document" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("moves one open document through root, two folders, and back to root", async ({
  page,
  slashdocs,
}) => {
  const documentTitle = uniqueName("Move journey document");
  const folderATitle = uniqueName("Move journey folder A");
  const folderBTitle = uniqueName("Move journey folder B");
  const document = await slashdocs.createDocument(
    documentTitle,
    documentHTML(documentTitle),
  );

  await page.goto("/app/documents");
  const folderAID = await createRootFolder(page, slashdocs, folderATitle);
  const folderBID = await createRootFolder(page, slashdocs, folderBTitle);

  // Root documents cannot be moved to root. The modal still exposes the
  // server-filtered folder list and supports autocomplete search.
  await page.goto(`/app/d/${document.id}`);
  let moveDialog = await openMoveDialog(page);
  await expect(
    moveDialog.getByRole("option", { name: "Workspace root" }),
  ).not.toBeVisible();
  await searchFolders(page, folderATitle);
  const folderAOption = moveDialog.getByRole("option", {
    name: new RegExp(folderATitle),
  });
  await expect(folderAOption).toBeVisible();
  await folderAOption.click();
  const rootToFolderResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.pathname === `/v1/folders/${folderAID}/documents`
    );
  });
  await moveDialog.getByRole("button", { name: "Move", exact: true }).click();
  const rootToFolderResponse = await rootToFolderResponsePromise;
  expect(rootToFolderResponse.ok()).toBeTruthy();
  expect(rootToFolderResponse.request().postDataJSON()).toMatchObject({
    document_id: document.id,
    expected_source: { kind: "root" },
  });
  await expect
    .poll(async () => (await slashdocs.getDocument(document.id)).parent_folder_id)
    .toBe(folderAID);

  // A reload proves the current folder comes from persisted document state.
  await page.reload();
  await expect(
    page.getByRole("link", { name: folderATitle, exact: true }),
  ).toBeVisible();
  moveDialog = await openMoveDialog(page);
  await expect(
    moveDialog.getByRole("option", { name: "Workspace root" }),
  ).toBeVisible();
  await searchFolders(page, folderATitle);
  await expect(
    moveDialog.getByRole("option", { name: new RegExp(folderATitle) }),
  ).toHaveCount(0);
  await searchFolders(page, folderBTitle);
  const folderBOption = moveDialog.getByRole("option", {
    name: new RegExp(folderBTitle),
  });
  await expect(folderBOption).toBeVisible();
  await folderBOption.click();
  const folderToFolderResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.pathname === `/v1/folders/${folderBID}/documents`
    );
  });
  await moveDialog.getByRole("button", { name: "Move", exact: true }).click();
  const folderToFolderResponse = await folderToFolderResponsePromise;
  expect(folderToFolderResponse.ok()).toBeTruthy();
  expect(folderToFolderResponse.request().postDataJSON()).toMatchObject({
    document_id: document.id,
    expected_source: { kind: "folder", folder_id: folderAID },
  });
  await expect
    .poll(async () => (await slashdocs.getDocument(document.id)).parent_folder_id)
    .toBe(folderBID);

  // The source folder is excluded again after the second move, while root is
  // available as the explicit destination for returning the document home.
  await page.reload();
  await expect(
    page.getByRole("link", { name: folderBTitle, exact: true }),
  ).toBeVisible();
  moveDialog = await openMoveDialog(page);
  await expect(
    moveDialog.getByRole("option", { name: "Workspace root" }),
  ).toBeVisible();
  await searchFolders(page, folderBTitle);
  await expect(
    moveDialog.getByRole("option", { name: new RegExp(folderBTitle) }),
  ).toHaveCount(0);
  const rootOption = moveDialog.getByRole("option", { name: "Workspace root" });
  await rootOption.click();
  const folderToRootResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "DELETE" &&
      url.pathname === `/v1/folders/${folderBID}/documents/${document.id}`
    );
  });
  await moveDialog.getByRole("button", { name: "Move", exact: true }).click();
  const folderToRootResponse = await folderToRootResponsePromise;
  expect(folderToRootResponse.status()).toBe(204);
  await expect
    .poll(async () => (await slashdocs.getDocument(document.id)).parent_folder_id)
    .toBeFalsy();

  await page.reload();
  await expect(page.locator(`a[href="/app/folders/${folderBID}"]`)).toHaveCount(0);
});

test("keeps Move to folder reachable from the compact document menu", async ({
  page,
  slashdocs,
}) => {
  await page.setViewportSize({ width: 568, height: 320 });
  const documentTitle = uniqueName("Compact move document");
  const document = await slashdocs.createDocument(
    documentTitle,
    documentHTML(documentTitle),
  );

  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "More" }).click();

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  const moveItem = menu.getByRole("menuitem", { name: "Move to folder" });
  await moveItem.scrollIntoViewIfNeeded();
  await moveItem.click();

  const dialog = page.getByRole("dialog", { name: "Move document" });
  await expect(dialog).toBeVisible();
  await expect(menu).toBeHidden();
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Move", exact: true })).toBeVisible();
});
