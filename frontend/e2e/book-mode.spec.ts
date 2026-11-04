import { type FrameLocator, type Page } from "@playwright/test";
import {
  APP_ORIGIN,
  AUTH_STATE_PATH,
  expect,
  installAppStorage,
  test,
  type SlashdocsAPI,
  uniqueName,
} from "./fixtures";

// Book mode needs SLASHDOCS_BOOKS_ENABLED=true on the server (docker-compose.yml).

type Section = { id: string; heading: string; text: string };

// A chapter in the repo's sample.html style: headings sized in px, so reader
// text size (CSS zoom) visibly changes their height. The spacer after each
// section makes the chapter scroll.
function chapterHTML(title: string, sections: Section[]) {
  const body = sections
    .map(
      (
        s,
      ) => `<h2 id="${s.id}" style="font-size:18px;margin:32px 0 10px">${s.heading}</h2>
    <p>${s.text}</p>
    <div style="height:900px"></div>`,
    )
    .join("\n    ");
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
    <h1 style="font-size:28px">${title}</h1>
    ${body}
  </body>
</html>`;
}

const SETUP: Section = {
  id: "setup",
  heading: "Setup",
  text: "Install the tool and sign in before anything else.",
};
const USAGE: Section = {
  id: "usage",
  heading: "Usage",
  text: "Run the command once a day and read the summary.",
};
const LIMITS: Section = {
  id: "limits",
  heading: "Limits",
  text: "Each account can hold ten projects at a time.",
};

// The reader titles each chapter's frame "Chapter N, <title>" (chapterName).
function chapterFrame(page: Page, number: number): FrameLocator {
  return page
    .frameLocator(`iframe[title^="Chapter ${number},"]`)
    .frameLocator("iframe#slashdocs-doc");
}

function chapterPath(bookID: string, documentID: string) {
  return `/app/b/${bookID}/c/${documentID}`;
}

// Resolves when the reader saves a position for the chapter, optionally only
// one that is past the start. Create it before the action that causes the save.
function positionSaved(page: Page, documentID: string, pastStart = false) {
  return page.waitForResponse((response) => {
    const request = response.request();
    if (request.method() !== "PUT" || !response.url().endsWith("/position")) {
      return false;
    }
    const body = request.postDataJSON() as {
      document_id: string;
      progression: number;
    };
    return (
      response.ok() &&
      body.document_id === documentID &&
      (!pastStart || body.progression > 0)
    );
  });
}

function scrollY(doc: FrameLocator) {
  return doc.locator("body").evaluate(() => window.scrollY);
}

// Two numbered chapters in a folder, made a book through the API.
async function seedBook(slashdocs: SlashdocsAPI) {
  const folder = await slashdocs.createFolder(uniqueName("Book folder"));
  const alphaTitle = uniqueName("Alpha");
  const betaTitle = uniqueName("Beta");
  const alpha = await slashdocs.createDocument(
    `1 · ${alphaTitle}`,
    chapterHTML(alphaTitle, [SETUP, USAGE, LIMITS]),
  );
  const beta = await slashdocs.createDocument(
    `2 · ${betaTitle}`,
    chapterHTML(betaTitle, [SETUP, USAGE]),
  );
  await slashdocs.moveToFolder(folder.id, alpha.id);
  await slashdocs.moveToFolder(folder.id, beta.id);
  return { folder, alpha, beta, alphaTitle, betaTitle };
}

test("reads a book, sees a chapter update, and resumes on another device", async ({
  page,
  browser,
  slashdocs,
}) => {
  const { folder, alpha, beta, alphaTitle, betaTitle } = await seedBook(slashdocs);

  // Make the folder a book from its page.
  await page.goto(`/app/folders/${folder.id}`);
  await page.getByRole("button", { name: "Make this a book" }).click();
  await expect(page).toHaveURL(/\/app\/b\/[^/]+\/outline$/);
  const bookID = new URL(page.url()).pathname.split("/")[3];

  // Book home offers to start at chapter 1.
  await page.goto(`/app/b/${bookID}`);
  await page.getByRole("link", { name: "Start reading" }).click();
  await expect(page).toHaveURL(chapterPath(bookID, alpha.id));
  await expect(page.getByRole("navigation", { name: "Book contents" })).toBeAttached();

  // Chapter 1: scroll, and wait for the position to be saved.
  const doc1 = chapterFrame(page, 1);
  await expect(doc1.locator("#setup")).toBeVisible();
  const savedAlpha = positionSaved(page, alpha.id, true);
  await doc1.locator("#limits").scrollIntoViewIfNeeded();
  await savedAlpha;

  // Chapter 2 with the right arrow key.
  await page.getByRole("heading", { name: /^Chapter 1,/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(chapterPath(bookID, beta.id));
  const doc2 = chapterFrame(page, 2);
  await expect(doc2.locator("#setup")).toBeVisible();
  const savedBeta = positionSaved(page, beta.id, true);
  await doc2.locator("#usage").scrollIntoViewIfNeeded();
  await savedBeta;

  // The author publishes a new version of chapter 1 that rewrites one section.
  await slashdocs.pushVersion(
    alpha.id,
    chapterHTML(alphaTitle, [
      SETUP,
      { ...USAGE, text: "Run the command twice a day, then compare both summaries." },
      LIMITS,
    ]),
    undefined,
    "Rewrote the usage section.",
  );

  // Book home flags the chapter and shows the author's note.
  await page.goto(`/app/b/${bookID}`);
  const updated = page.getByRole("region", { name: "Updated chapters" });
  await expect(updated.getByText("1 chapter you read has a new version")).toBeVisible();
  await updated.locator("summary").click();
  await expect(updated.getByText("Rewrote the usage section.")).toBeVisible();

  // Chapter 1 shows the update chip; opening a changed section marks it seen.
  await page.goto(chapterPath(bookID, alpha.id));
  const chip = page.getByRole("button", { name: "Updated since you read" });
  await expect(chip).toBeVisible();
  await chip.click();
  const changes = page.getByRole("dialog", { name: "Changes since you read" });
  await expect(changes.getByText("Version 2 · 1 section changed")).toBeVisible();
  const seen = page.waitForResponse(
    (r) =>
      r.request().method() === "POST" && r.url().endsWith(`/chapters/${alpha.id}/seen`),
  );
  // Opening the section also moves the reader, which saves a position in
  // chapter 1, the last chapter visited (A19).
  const savedRevisit = positionSaved(page, alpha.id);
  await changes.getByRole("button", { name: "Usage" }).click();
  await seen;
  await savedRevisit;
  await expect(chip).toBeHidden();

  // The same user on a second device resumes at chapter 1, not chapter 2.
  const other = await browser.newContext({
    baseURL: APP_ORIGIN,
    storageState: AUTH_STATE_PATH,
  });
  try {
    const otherPage = await other.newPage();
    await installAppStorage(otherPage);
    await otherPage.goto(`/app/b/${bookID}`);
    const resume = otherPage.getByRole("region", { name: "Continue reading" });
    await expect(resume).toBeVisible();
    await expect(resume).toContainText(alphaTitle);
    await expect(resume).not.toContainText(betaTitle);
    await expect(resume.getByRole("link", { name: "Continue" })).toHaveAttribute(
      "href",
      new RegExp(`/c/${alpha.id}$`),
    );
  } finally {
    await other.close();
  }
});

test("applies reader text size and paper theme inside the document frame", async ({
  page,
  slashdocs,
}) => {
  const { folder, alpha } = await seedBook(slashdocs);
  const book = await slashdocs.createBook(folder.id);

  await page.goto(chapterPath(book.book_id, alpha.id));
  const doc = chapterFrame(page, 1);
  const heading = doc.locator("#setup");
  await expect(heading).toBeVisible();
  const height = () => heading.evaluate((el) => el.getBoundingClientRect().height);
  const before = await height();
  expect(before).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Reading settings" }).click();
  const settings = page.getByRole("dialog", { name: "Reading settings" });

  // Large zooms the document body, so a px-sized heading grows.
  await settings.getByRole("tab", { name: "Large" }).click();
  await expect(settings.getByRole("tab", { name: "Large" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect.poll(height).toBeGreaterThan(before);

  // Paper forces the document's light theme on a paper-coloured page.
  await settings.getByRole("tab", { name: "Paper" }).click();
  const root = doc.locator("html");
  await expect(root).toHaveAttribute("data-slashdocs-theme", "light");
  await expect
    .poll(() => root.evaluate((el) => getComputedStyle(el).backgroundColor))
    .toBe("rgb(248, 244, 234)");
});

test("restores the saved place after a reload", async ({ page, slashdocs }) => {
  const { folder, alpha } = await seedBook(slashdocs);
  const book = await slashdocs.createBook(folder.id);

  await page.goto(chapterPath(book.book_id, alpha.id));
  const doc = chapterFrame(page, 1);
  await expect(doc.locator("#setup")).toBeVisible();
  expect(await scrollY(doc)).toBe(0);

  const saved = positionSaved(page, alpha.id, true);
  await doc.locator("#limits").scrollIntoViewIfNeeded();
  await saved;

  await page.reload();
  await expect(chapterFrame(page, 1).locator("#setup")).toBeAttached();
  await expect.poll(() => scrollY(chapterFrame(page, 1))).toBeGreaterThan(0);
});
