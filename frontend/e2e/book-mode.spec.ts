import { type FrameLocator, type Page, type Response } from "@playwright/test";
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

function isPositionSave(response: Response, documentID: string, pastStart: boolean) {
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
}

// Watches for the reader saving a position for the chapter, optionally only
// one past the start. Create it before the action that causes the save.
//
// The reader drops viewport reports that arrive before it has restored the
// saved place (use-reading-position.ts), and only another scroll reports
// again. So wait() calls scrollAgain whenever a save does not come, rather
// than waiting once and hanging until the test times out.
function watchPositionSaves(page: Page, documentID: string, pastStart = false) {
  let saved = false;
  const onResponse = (response: Response) => {
    if (isPositionSave(response, documentID, pastStart)) saved = true;
  };
  page.on("response", onResponse);
  return {
    async wait(scrollAgain: () => Promise<void>) {
      let first = true;
      try {
        await expect(async () => {
          if (!first && !saved) await scrollAgain();
          first = false;
          await expect.poll(() => saved, { timeout: 4_000 }).toBe(true);
        }).toPass({ timeout: 25_000 });
      } finally {
        page.off("response", onResponse);
      }
    },
  };
}

// Scrolls up to one section and back down to another, so the frame reports
// its viewport again.
async function scrollBetween(doc: FrameLocator, up: string, down: string) {
  await doc.locator(`#${up}`).scrollIntoViewIfNeeded();
  await doc.locator(`#${down}`).scrollIntoViewIfNeeded();
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
  // Four document API calls, about eight page loads with nested frames, a
  // second browser context and several throttled position saves.
  test.slow();
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
  const savedAlpha = watchPositionSaves(page, alpha.id, true);
  await doc1.locator("#limits").scrollIntoViewIfNeeded();
  await savedAlpha.wait(() => scrollBetween(doc1, "setup", "limits"));

  // Chapter 2 with the right arrow key.
  await page.getByRole("heading", { name: /^Chapter 1,/ }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page).toHaveURL(chapterPath(bookID, beta.id));
  const doc2 = chapterFrame(page, 2);
  await expect(doc2.locator("#setup")).toBeVisible();
  const savedBeta = watchPositionSaves(page, beta.id, true);
  await doc2.locator("#usage").scrollIntoViewIfNeeded();
  await savedBeta.wait(() => scrollBetween(doc2, "setup", "usage"));

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
  const savedRevisit = watchPositionSaves(page, alpha.id);
  await changes.getByRole("button", { name: "Usage" }).click();
  await seen;
  const revisit = chapterFrame(page, 1);
  await savedRevisit.wait(() => scrollBetween(revisit, "setup", "usage"));
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

  const saved = watchPositionSaves(page, alpha.id, true);
  await doc.locator("#limits").scrollIntoViewIfNeeded();
  await saved.wait(() => scrollBetween(doc, "setup", "limits"));

  await page.reload();
  await expect(chapterFrame(page, 1).locator("#setup")).toBeAttached();
  await expect.poll(() => scrollY(chapterFrame(page, 1))).toBeGreaterThan(0);
});

test("does not mark a chapter that fits on screen read when it opens", async ({
  page,
  slashdocs,
}) => {
  const folder = await slashdocs.createFolder(uniqueName("Short book"));
  const title = uniqueName("Short");
  const short = await slashdocs.createDocument(
    `1 · ${title}`,
    `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body><h1>${title}</h1><p id="only">One short paragraph.</p></body>
</html>`,
  );
  await slashdocs.moveToFolder(folder.id, short.id);
  const book = await slashdocs.createBook(folder.id);

  const ends: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      request.url().endsWith(`/chapters/${short.id}/progress`) &&
      (request.postDataJSON() as { reached_end?: boolean }).reached_end
    ) {
      ends.push(request.url());
    }
  });
  const saved = watchPositionSaves(page, short.id);
  await page.goto(chapterPath(book.book_id, short.id));
  await expect(chapterFrame(page, 1).locator("#only")).toBeVisible();
  // The frame has reported that the chapter fits: the end strip is offered.
  await expect(page.getByRole("region", { name: "End of chapter" })).toBeVisible();
  // The strip shows on any report, even one the reading hook dropped before
  // the restore. A saved position proves the hook took a report, so the
  // window below really exercises the reached-end rule. Nothing scrolls, so
  // there is nothing to do but wait for it.
  await saved.wait(async () => {});
  // Nothing scrolls, so only time on screen (15 s, FITS_READ_MS) marks it
  // read. Opening it alone must not.
  await page.waitForTimeout(3_000);
  expect(ends).toEqual([]);
});
