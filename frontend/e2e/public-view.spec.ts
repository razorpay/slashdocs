import { type Browser, type Page } from "@playwright/test";
import {
  APP_ORIGIN,
  continueWithDex,
  expect,
  installAppStorage,
  test,
  uniqueName,
} from "./fixtures";

// A public deployment lets a signed-out reader read a document that is shared
// with anyone. Commenting or editing sends the reader to sign in first.

async function signedOutPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    baseURL: APP_ORIGIN,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await installAppStorage(page);
  return page;
}

function documentHTML(title: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1><p>Anyone with the link can read this paragraph.</p></body></html>`;
}

test("a signed-out reader reads a shared document and signs in to comment", async ({
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Public view");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.shareWithAnyone(document.id, "commenter");

  const page = await signedOutPage(browser);
  const path = `/app/d/${document.id}`;
  await page.goto(path);

  const rendered = page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
  await expect(rendered.getByRole("heading", { name: title })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Comments", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Share" })).toHaveCount(0);

  await rendered.locator("p").selectText();
  await rendered.getByRole("button", { name: "Comment on selected text" }).click();
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(path)}`);

  await continueWithDex(page);
  await expect(page).toHaveURL(path);
  await expect(page.getByRole("button", { name: "Sign in" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Share" })).toBeVisible();
  await page.context().close();
});

test("a signed-out reader goes to sign in to edit document data", async ({
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Public edit");
  const html = documentHTML(title).replace(
    "</body>",
    `<label><input type="checkbox" onchange="slashdocs.kv.set('done', this.checked)"> Done</label></body>`,
  );
  const document = await slashdocs.createDocument(title, html);
  await slashdocs.shareWithAnyone(document.id, "editor");

  const page = await signedOutPage(browser);
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  await page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc")
    .getByRole("checkbox", { name: "Done" })
    .check();
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(path)}`);
  await page.context().close();
});

test("a signed-out reader of a private document goes to sign in", async ({
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Private view");
  const document = await slashdocs.createDocument(title, documentHTML(title));

  const page = await signedOutPage(browser);
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  await expect(page).toHaveURL(`/login?next=${encodeURIComponent(path)}`);
  await page.context().close();
});
