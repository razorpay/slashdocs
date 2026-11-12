import { type FrameLocator, type Page } from "@playwright/test";
import {
  expect,
  notSaved,
  openEditable,
  openHistory,
  reviewerOn,
  startEditing,
  test,
  uniqueName,
} from "./fixtures";

// Each document opens in Comment mode. An editor starts Edit mode with E or
// Edit in the bar, and leaves it with C, Done or one Esc, once their edits
// are saved. The edits of one sitting in Edit mode are one History entry.

function bridge(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Rendered document"]');
}

function renderedDocument(page: Page): FrameLocator {
  return bridge(page).frameLocator("iframe#slashdocs-doc");
}

// A script that changes the page all the time, as a live chart does.
function documentHTML(title: string) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title>
    <style>body{max-width:720px;margin:40px auto;font:16px/1.5 sans-serif}</style>
  </head>
  <body>
    <h1>${title}</h1>
    <p id="intro">Clients retry twice before giving up.</p>
    <p id="tail">The notes say why.</p>
    <p id="clock"></p>
    <script>setInterval(() => (clock.dataset.at = String(Date.now())), 40);</script>
  </body>
</html>`;
}

const edit = (page: Page) => page.getByRole("button", { name: "Edit", exact: true });
const done = (page: Page) => page.getByRole("button", { name: "Done", exact: true });
const editingText = (page: Page) =>
  expect(renderedDocument(page).locator("body")).toHaveAttribute(
    "contenteditable",
    "true",
  );
// The live document on the server.
async function latestSource(page: Page, id: string): Promise<string> {
  const { current_version_id } = await (
    await page.request.get(`/v1/documents/${id}`)
  ).json();
  return (
    await page.request.get(`/v1/documents/${id}/versions/${current_version_id}/html`)
  ).text();
}
// The entries of the open History, the newest first.
const historyEntries = (page: Page) =>
  page
    .getByRole("dialog", { name: "History" })
    .getByRole("button")
    .filter({ hasText: /./ });
const savedOps = (page: Page) =>
  page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/ops"),
  );

const commentingText = (page: Page) =>
  expect(renderedDocument(page).locator("body")).not.toHaveAttribute(
    "contenteditable",
    "true",
  );

test("a document opens in Comment mode, and E and C switch modes from the document", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Modes");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  await expect(edit(page)).toBeVisible();
  await commentingText(page);

  // C in Comment mode places a pin, as it did.
  const doc = renderedDocument(page);
  await doc.locator("#tail").click();
  await page.keyboard.press("c");
  await expect(bridge(page).locator(".sd-place-hint")).toBeVisible();
  await page.keyboard.press("Escape");

  // E starts Edit mode, and a click puts the caret at its point.
  await page.keyboard.press("e");
  await editingText(page);
  await expect(done(page)).toBeVisible();
  await doc.locator("#tail").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Clearly.");
  await expect(doc.locator("#tail")).toHaveText("The notes say why. Clearly.");

  // C with the caret out of the text goes back to Comment mode.
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("c");
  await expect(edit(page)).toBeVisible();
  await commentingText(page);
  await expect(bridge(page).locator(".sd-place-hint")).toBeHidden();
});

test("E with text selected puts the caret there, and one Esc in the text leaves Edit mode", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Select edit");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const intro = renderedDocument(page).locator("#intro");
  await intro.click();
  await intro.evaluate((p) => {
    const text = p.firstChild as Text;
    const at = text.data.indexOf("twice");
    p.ownerDocument.getSelection()!.setBaseAndExtent(text, at, text, at + 5);
  });
  await page.keyboard.press("e");
  await editingText(page);
  await page.keyboard.type("three times");
  await expect(intro).toHaveText("Clients retry three times before giving up.");

  // The caret is still in the text. One Esc right after the last key
  // leaves Edit mode with the edit saved, and arms no Esc chord.
  await page.keyboard.press("Escape");
  await expect(edit(page)).toBeVisible();
  await commentingText(page);
  expect(await latestSource(page, document.id)).toContain(
    "Clients retry three times before giving up.",
  );
  await page.keyboard.press("c");
  await expect(page.getByRole("dialog", { name: "Comments" })).toBeHidden();
});

test("Esc in Edit mode leaves it, and keeps following a viewer", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Esc follow");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.shareWithAnyone(document.id, "commenter");
  const reviewer = await reviewerOn(browser, `/app/d/${document.id}`);
  await page.goto(`/app/d/${document.id}`);
  const avatar = page
    .getByRole("group", { name: "People viewing this document" })
    .getByRole("button")
    .first();
  await avatar.click();
  await page.getByRole("menuitem", { name: /^Follow / }).click();
  const following = page.getByRole("button", { name: /^Stop following / });
  await expect(following).toBeVisible();
  await page.keyboard.press("e");
  await expect(done(page)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(edit(page)).toBeVisible();
  await expect(following).toBeVisible();
  // The next Esc stops following.
  await page.keyboard.press("Escape");
  await expect(following).toBeHidden();
  await reviewer.context().close();
});

test("Done right after the last key saves the edit before Comment mode", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Done");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await openEditable(page, document.id);
  await renderedDocument(page).locator("#tail").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Now.");
  await done(page).click();
  await expect(done(page)).toBeHidden();
  await expect(edit(page)).toBeVisible();
  await commentingText(page);
  expect(await latestSource(page, document.id)).toContain("The notes say why. Now.");

  // Edit mode again keeps the saved edit, and the next edit adds to it.
  await startEditing(page);
  await renderedDocument(page).locator("#intro").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Twice.");
  await expect
    .poll(() => latestSource(page, document.id))
    .toContain("before giving up. Twice.");
  expect(await latestSource(page, document.id)).toContain("The notes say why. Now.");
});

test("a sitting in Edit mode is one History entry, which says what changed", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Sitting");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await openEditable(page, document.id);
  const entries = historyEntries(page);
  // typeAtEnd types at the end of a paragraph, with a pause in the middle.
  const typeAtEnd = async (selector: string, first: string, second: string) => {
    await renderedDocument(page).locator(selector).click();
    await page.keyboard.press("End");
    await page.keyboard.type(first);
    await expect.poll(() => latestSource(page, document.id)).toContain(first.trimEnd());
    await page.keyboard.type(second);
    await expect.poll(() => latestSource(page, document.id)).toContain(first + second);
  };
  const closeHistory = async () => {
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "History" })).toBeHidden();
  };

  // Two pauses of typing are one entry, also while the editor types on.
  await typeAtEnd("#tail", " Now", " and then.");
  await openHistory(page);
  await expect(entries).toHaveText([/Added “Now and then.”$/, /Created$/]);
  await closeHistory();

  // Done changes nothing in the History: the editor can come back.
  await done(page).click();
  await expect(edit(page)).toBeVisible();
  await startEditing(page);
  await typeAtEnd("#tail", " Or", " later.");
  await openHistory(page);
  await expect(entries).toHaveText([/Added “Now and then. Or later.”$/, /Created$/]);
  await closeHistory();

  // A push in the middle of the sitting is its own entry. The editor types
  // on, and the sitting stays one entry, the newest, which says what the
  // editor typed and not what the push changed.
  const pushed = (await latestSource(page, document.id)).replace(
    "twice",
    "three times",
  );
  await slashdocs.pushVersion(document.id, pushed);
  await expect(renderedDocument(page).locator("#intro")).toContainText("three times");
  await typeAtEnd("#tail", " Or", " more.");
  await openHistory(page);
  await expect(entries).toHaveText([
    /Added “Now and then. Or later. Or more.”$/,
    /Changed “twice” to “three times”$/,
    /Created$/,
  ]);
});

// A document with two sections.
const sectionsHTML = (title: string) =>
  documentHTML(title).replace(
    '<p id="clock">',
    `<h2>Goals</h2>
    <p id="goals">The team ships the editor in May.</p>
    <h2>Risks</h2>
    <p id="risks">The card network changes its fees in January. The admin opens the page each morning.</p>
    <p id="clock">`,
  );

test("the History line of a sitting names the sections that the editor changed", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Sections");
  const document = await slashdocs.createDocument(title, sectionsHTML(title));
  await openEditable(page, document.id);
  for (const [id, words] of [
    ["goals", " It is late."],
    ["risks", " One week helps."],
  ]) {
    await renderedDocument(page).locator(`#${id}`).click();
    await page.keyboard.press("End");
    await page.keyboard.type(words);
    await expect.poll(() => latestSource(page, document.id)).toContain(words);
  }
  await done(page).click();
  await expect(edit(page)).toBeVisible();
  await openHistory(page);
  await expect(historyEntries(page)).toHaveText([
    /Edited Goals and Risks$/,
    /Created$/,
  ]);
});

test("the History says in one line what a sitting and each push changed", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Lines");
  const document = await slashdocs.createDocument(title, sectionsHTML(title));
  await openEditable(page, document.id);
  await renderedDocument(page).locator("#goals").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" It is late.");
  await expect.poll(() => latestSource(page, document.id)).toContain(" It is late.");

  // An agent adds a section, and then writes a paragraph again.
  const section = (await latestSource(page, document.id)).replace(
    "<h2>Risks</h2>",
    `<h2>Dates</h2>
    <p id="dates">The review is on the first Monday of June.</p>
    <h2>Risks</h2>`,
  );
  await slashdocs.pushVersion(document.id, section);
  await slashdocs.pushVersion(
    document.id,
    section.replace(
      "The card network changes its fees in January. The admin opens the page each morning.",
      "From the new year on, every payment by card costs more, and the admin page shows the cost of each one.",
    ),
  );
  await openHistory(page);
  await expect(historyEntries(page)).toHaveText([
    /Rewrote a paragraph in “Risks”$/,
    /Added the section “Dates”$/,
    /Added “It is late.”$/,
    /Created$/,
  ]);
});

test("a sole editor who changes tabs and types on makes one History entry", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Tabs");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await openEditable(page, document.id);
  await renderedDocument(page).locator("#tail").click();
  await page.keyboard.press("End");
  // show tells the page that its tab hides or shows, as a change of tabs does.
  const show = (state: "hidden" | "visible") =>
    page.evaluate((state) => {
      Object.defineProperty(window.document, "visibilityState", {
        value: state,
        configurable: true,
      });
      window.document.dispatchEvent(new Event("visibilitychange"));
    }, state);
  for (const words of [" One.", " Two.", " Three."]) {
    await page.keyboard.type(words);
    await expect.poll(() => latestSource(page, document.id)).toContain(words);
    await show("hidden");
    await page.waitForTimeout(500);
    await show("visible");
  }
  await page.keyboard.type(" Four.");
  await expect.poll(() => latestSource(page, document.id)).toContain(" Four.");

  await done(page).click();
  await expect(edit(page)).toBeVisible();
  await openHistory(page);
  await expect(historyEntries(page)).toHaveText([
    /Added “One. Two. Three. Four.”$/,
    /Created$/,
  ]);
});

test("a sitting that ends on the text where it started leaves no History entry", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("No change");
  const html = documentHTML(title);
  const document = await slashdocs.createDocument(title, html);
  await openEditable(page, document.id);
  await renderedDocument(page).locator("#tail").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Maybe");
  await expect
    .poll(() => latestSource(page, document.id))
    .toContain("The notes say why. Maybe");
  for (let i = 0; i < " Maybe".length; i++) await page.keyboard.press("Backspace");
  await expect.poll(() => latestSource(page, document.id)).toBe(html);

  await done(page).click();
  await expect(edit(page)).toBeVisible();
  await expect
    .poll(async () => {
      const versions = await page.request.get(`/v1/documents/${document.id}/versions`);
      return (await versions.json()).items.length;
    })
    .toBe(1);
  await openHistory(page);
  await expect(historyEntries(page)).toHaveText([/Created$/]);
});

test("a reload, Back and a closed tab, each right after typing, stay one History entry with whole words", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Leave");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  // typeAtEnd starts Edit mode and types at the end of the last paragraph.
  const typeAtEnd = async (page: Page, words: string) => {
    await startEditing(page);
    await renderedDocument(page).locator("#tail").click();
    await page.keyboard.press("End");
    await page.keyboard.type(words, { delay: 20 });
  };
  // The document opens from the list, so that Back is a move in the app.
  const open = () => page.getByRole("link", { name: title }).first().click();
  await page.goto("/app/documents");
  await open();
  await typeAtEnd(page, " One reason.");
  await page.goBack();
  await open();
  await typeAtEnd(page, " Two reasons.");
  await page.reload();
  await typeAtEnd(page, " Three reasons.");
  await page.close();

  const again = await page.context().newPage();
  await again.goto(`/app/d/${document.id}`);
  await expect(renderedDocument(again).locator("#tail")).toHaveText(
    "The notes say why. One reason. Two reasons. Three reasons.",
  );
  await openHistory(again);
  await expect(historyEntries(again)).toHaveText([
    /Added “One reason. Two reasons. Three reasons.”$/,
    /Created$/,
  ]);
});

test("an HTML file that the editor uploads from Edit mode replaces the document, after their sitting", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Upload");
  const html = documentHTML(title);
  const document = await slashdocs.createDocument(title, html);
  await openEditable(page, document.id);
  await renderedDocument(page).locator("#tail").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Clearly.");
  await expect
    .poll(() => latestSource(page, document.id))
    .toContain("The notes say why. Clearly.");

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Replace with an HTML file" }).click();
  const sheet = page.getByRole("dialog", { name: "Replace with an HTML file" });
  const uploaded = html.replace("The notes say why.", "The file says why.");
  await sheet.locator('input[type="file"]').setInputFiles({
    name: "uploaded.html",
    mimeType: "text/html",
    buffer: Buffer.from(uploaded),
  });
  await sheet.getByRole("button", { name: "Upload" }).click();
  await expect(
    page.getByText("Uploaded. The previous content is in the history."),
  ).toBeVisible();
  await expect(renderedDocument(page).locator("#tail")).toHaveText(
    "The file says why.",
  );
  expect(await latestSource(page, document.id)).toBe(uploaded);
  // The History holds what the editor typed, and then the file.
  const { items } = await (
    await page.request.get(`/v1/documents/${document.id}/versions`)
  ).json();
  expect(items.map((v: { change_summary: string }) => v.change_summary)).toEqual([
    "",
    "Added “Clearly.”",
    expect.any(String),
  ]);
});

test("the bar shows no state of a save, only a failure that lasts, and Retry saves", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Stay");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await openEditable(page, document.id);
  const header = page.locator("header");
  await renderedDocument(page).locator("#tail").click();
  await page.keyboard.press("End");
  const saved = savedOps(page);
  await page.keyboard.type(" Kept.");
  expect((await saved).status()).toBe(200);
  for (const text of ["Saved", "Saving", "Editing", "Edited", "Undo"])
    await expect(header.getByText(text)).toHaveCount(0);
  await expect(notSaved(page)).toBeHidden();

  // An edit that cannot reach the server says nothing at first, because a
  // short failure passes by itself. After 10 seconds the bar says so.
  test.setTimeout(60_000);
  const toasts = page.locator("[data-sonner-toast]");
  await page.route("**/ops", (route) => route.abort());
  await page.keyboard.type(" Lost?");
  await page.waitForTimeout(5000);
  await expect(notSaved(page)).toBeHidden();
  await expect(notSaved(page)).toBeVisible({ timeout: 10_000 });
  await expect(toasts).toHaveCount(0);
  // The editor can leave Edit mode, and the bar still says so.
  await done(page).click();
  await expect(edit(page)).toBeVisible();
  await expect(notSaved(page)).toBeVisible();

  // Retry sends at once.
  await page.unroute("**/ops");
  const retried = savedOps(page);
  await notSaved(page).click();
  expect((await retried).status()).toBe(200);
  await expect(notSaved(page)).toBeHidden();
  expect(await latestSource(page, document.id)).toContain(
    "The notes say why. Kept. Lost?",
  );
});

test("a reader who cannot edit sees no Edit, and E does nothing", async ({
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Commenter");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.shareWithAnyone(document.id, "commenter");
  const reviewer = await reviewerOn(browser, `/app/d/${document.id}`);
  await expect(renderedDocument(reviewer).locator("h1")).toBeVisible();
  await expect(reviewer.getByRole("button", { name: "Comments" })).toBeVisible();
  await expect(edit(reviewer)).toHaveCount(0);
  await renderedDocument(reviewer).locator("#tail").click();
  await reviewer.keyboard.press("e");
  await commentingText(reviewer);
  await reviewer.context().close();
});

test("a dragged pin shows once, under the pointer, while the page changes, and lands without a jump", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Drag pin");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.createComment(document.id, "Move me", {
    point: { target: "tail", x: 0.1, y: 0.5 },
  });
  await page.goto(`/app/d/${document.id}`);
  const pins = bridge(page).locator(".sd-pin");
  await expect(pins).toHaveCount(1);
  const start = (await pins.boundingBox())!;
  const [x, y] = [start.x + start.width / 2, start.y + start.height / 2];
  // Where the pin is from the pointer, which a drag keeps.
  let offset: { x: number; y: number } | undefined;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) {
    const pointer = { x: x + i * 20, y: y + i * 4 };
    await page.mouse.move(pointer.x, pointer.y);
    // Longer than a change of the page and the frame after it.
    await page.waitForTimeout(120);
    await expect(pins).toHaveCount(1);
    const at = (await pins.boundingBox())!;
    offset ??= { x: at.x - pointer.x, y: at.y - pointer.y };
    expect(Math.abs(at.x - pointer.x - offset.x), `x at step ${i}`).toBeLessThan(1);
    expect(Math.abs(at.y - pointer.y - offset.y), `y at step ${i}`).toBeLessThan(1);
  }
  const held = (await pins.boundingBox())!;
  await page.mouse.up();
  await page.waitForTimeout(300);
  // The pin was larger while held, around its tip. Its face does not move.
  // The drop and the save draw the pin again as a new button, in one frame,
  // so a measure that meets the swap tries again.
  const off = async () => {
    const landed = await pins.boundingBox();
    return landed && Math.max(Math.abs(landed.x - held.x), Math.abs(landed.y - held.y));
  };
  await expect.poll(off).toBeLessThan(4);
});
