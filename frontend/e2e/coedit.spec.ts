import { type Browser, type FrameLocator, type Page } from "@playwright/test";
import {
  expect,
  notSaved,
  openHistory,
  reviewerOn,
  startEditing,
  test,
  uniqueName,
  type SlashdocsAPI,
} from "./fixtures";

// Two people have one document open: the admin and a reviewer
// (dev/dex-config.yaml). What one changes shows for the other in place,
// without a load of the frame.

const SHOTS = process.env.SLASHDOCS_E2E_SHOTS;

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

function documentHTML(title: string, sections = 6) {
  const body = Array.from(
    { length: sections },
    (_, i) =>
      `    <h2>Section ${i + 1}</h2>\n    <p id="s${i + 1}">Section ${i + 1} holds the notes of the team.</p>`,
  ).join("\n");
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    <p id="shared">The plan starts here and ends there.</p>
${body}
  </body>
</html>`;
}

// placeCaret puts the caret after target in the text of an element.
async function placeCaret(page: Page, selector: string, target: string) {
  await renderedDocument(page)
    .locator(selector)
    .evaluate((element, target) => {
      const d = element.ownerDocument;
      const walker = d.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = (node as Text).data.indexOf(target);
        if (at < 0) continue;
        d.body.focus();
        d.getSelection()!.collapse(node, at + target.length);
        return;
      }
      throw new Error(`no text ${target}`);
    }, target);
}

// mark leaves a mark on the frame that a load of the frame removes.
const mark = (page: Page) =>
  renderedDocument(page)
    .locator("body")
    .evaluate((body) => void ((body as HTMLElement).dataset.e2eKept = "yes"));
const kept = (page: Page) =>
  renderedDocument(page).locator("body").getAttribute("data-e2e-kept");

async function latestSource(page: Page, id: string): Promise<string> {
  const { current_version_id } = await (
    await page.request.get(`/v1/documents/${id}`)
  ).json();
  return (
    await page.request.get(`/v1/documents/${id}/versions/${current_version_id}/html`)
  ).text();
}

// shot saves a picture of the page, after its motion ends.
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
};

test("two people type in one paragraph at once, and both texts stay", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Coedit");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.shareWithAnyone(document.id, "editor");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reviewer = await reviewerOn(browser, path);
  await expect(page.getByRole("button", { name: /^reviewer/ })).toBeVisible();
  await startEditing(page);
  await startEditing(reviewer);
  await mark(page);
  await mark(reviewer);

  // Each person types in their own half of the paragraph, key by key, at
  // the same time.
  await placeCaret(page, "#shared", "starts here");
  await placeCaret(reviewer, "#shared", "ends there");
  await Promise.all([
    page.keyboard.type(" with a short list of goals", { delay: 60 }),
    reviewer.keyboard.type(" after the last review", { delay: 60 }),
  ]);

  const merged =
    "The plan starts here with a short list of goals and ends there after the last review.";
  for (const p of [page, reviewer]) {
    await expect(renderedDocument(p).locator("#shared")).toHaveText(merged);
    expect(await kept(p)).toBe("yes");
  }
  await expect
    .poll(() => latestSource(page, document.id))
    .toContain(`<p id="shared">${merged}</p>`);
  await shot(page, "01-two-editors-admin");
  await shot(reviewer, "02-two-editors-reviewer");

  // The caret of each person stayed in their own text, so more typing goes
  // to the same place.
  await Promise.all([
    page.keyboard.type(" for May", { delay: 60 }),
    reviewer.keyboard.type(" in June", { delay: 60 }),
  ]);
  const more =
    "The plan starts here with a short list of goals for May and ends there after the last review in June.";
  for (const p of [page, reviewer]) {
    await expect(renderedDocument(p).locator("#shared")).toHaveText(more);
    expect(await kept(p)).toBe("yes");
  }
  await expect.poll(() => latestSource(page, document.id)).toContain(more);

  // The history shows the burst of both people as one entry.
  await openHistory(page);
  const history = page.getByRole("dialog", { name: "History" });
  await expect(history.getByText(/reviewer/).first()).toBeVisible();
  await expect(history.getByRole("button", { name: /earlier edit/ })).toHaveCount(1);
  await shot(page, "03-history-one-entry");
  await reviewer.context().close();
});

// Both people type fast, with no pause, so each save of one meets saves of
// the other. The words of each person stay whole and in their order. At one
// point, the words of the person who starts later come first: their caret
// stays before the text that came in at it.
const FIRST = " on the first of May, before the summer and the long break";
const LATER = " on the last of June";
for (const [where, mine, theirs, merged] of [
  [
    "at the same point",
    "starts here",
    "starts here",
    `The plan starts here${LATER}${FIRST} and ends there.`,
  ],
  [
    "one word apart",
    "starts",
    "here",
    `The plan starts${FIRST} here${LATER} and ends there.`,
  ],
] as const) {
  test(`two people type fast ${where}, and the words of each stay whole`, async ({
    page,
    browser,
    slashdocs,
  }) => {
    const title = uniqueName("Coedit fast");
    const document = await slashdocs.createDocument(title, documentHTML(title));
    await slashdocs.shareWithAnyone(document.id, "editor");
    const path = `/app/d/${document.id}`;
    await page.goto(path);
    const reviewer = await reviewerOn(browser, path);
    await expect(page.getByRole("button", { name: /^reviewer/ })).toBeVisible();
    await startEditing(page);
    await startEditing(reviewer);
    await mark(page);
    await mark(reviewer);

    await placeCaret(page, "#shared", mine);
    await placeCaret(reviewer, "#shared", theirs);
    // The reviewer starts after the first save of the admin, and types
    // while the admin types on.
    const first = page.keyboard.type(FIRST, { delay: 25 });
    await page.waitForResponse((r) => r.url().endsWith("/source-edits"));
    await Promise.all([first, reviewer.keyboard.type(LATER, { delay: 35 })]);

    for (const p of [page, reviewer]) {
      await expect(renderedDocument(p).locator("#shared")).toHaveText(merged);
      expect(await kept(p)).toBe("yes");
    }
    await expect
      .poll(() => latestSource(page, document.id))
      .toContain(`<p id="shared">${merged}</p>`);
    await reviewer.context().close();
  });
}

test("a reader sees what an editor types, live and in place", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Coedit reader");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.shareWithAnyone(document.id, "viewer");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reader = await reviewerOn(browser, path);
  await expect(renderedDocument(reader).locator("#shared")).toBeVisible();
  await mark(reader);
  // A comment on text below the paragraph keeps its highlight.
  await slashdocs.createComment(document.id, "Which team?", {
    quote: "Section 2 holds the notes of the team.",
  });
  const highlight = renderedDocument(reader).locator("mark.slashdocs-mark");
  await expect(highlight).toHaveText("Section 2 holds the notes of the team.");

  await startEditing(page);
  await placeCaret(page, "#shared", "starts here");
  await page.keyboard.type(", today", { delay: 40 });
  await page.keyboard.press("Enter");
  await page.keyboard.type("A new paragraph from the editor.", { delay: 20 });

  await expect(renderedDocument(reader).locator("#shared")).toHaveText(
    "The plan starts here, today",
  );
  await expect(
    renderedDocument(reader).getByText("A new paragraph from the editor."),
  ).toBeVisible();
  expect(await kept(reader)).toBe("yes");
  await expect(highlight).toHaveText("Section 2 holds the notes of the team.");
  await expect(reader.getByRole("button", { name: "Show the latest" })).toHaveCount(0);
  await shot(reader, "04-reader-live");
  await reader.context().close();
});

test("a small push applies in place, and a large push shows the banner", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Coedit push");
  const html = documentHTML(title, 12);
  const document = await slashdocs.createDocument(title, html);
  await slashdocs.shareWithAnyone(document.id, "viewer");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reader = await reviewerOn(browser, path);
  await expect(renderedDocument(reader).locator("#shared")).toBeVisible();
  await mark(reader);
  const banner = reader.getByRole("button", { name: "Show the latest" });

  // An agent corrects a few words: the reader gets them in place.
  const small = html.replace("ends there", "ends in the third quarter");
  await slashdocs.pushVersion(document.id, small);
  await expect(renderedDocument(reader).locator("#shared")).toHaveText(
    "The plan starts here and ends in the third quarter.",
  );
  expect(await kept(reader)).toBe("yes");
  await expect(banner).toHaveCount(0);
  await shot(reader, "05-small-push-in-place");

  // An agent writes most sections again: the reader stays on their version
  // and the banner offers the new one.
  const large = small.replaceAll(
    "holds the notes of the team.",
    "now lists every open decision, its owner, and the date that the team set for it.",
  );
  await slashdocs.pushVersion(document.id, large);
  await expect(banner).toBeVisible();
  await expect(reader.getByRole("status").filter({ has: banner })).toHaveText(
    "admin updated this document.Show the latest",
  );
  await expect(renderedDocument(reader).locator("#s1")).toHaveText(
    "Section 1 holds the notes of the team.",
  );
  expect(await kept(reader)).toBe("yes");
  await shot(reader, "06-large-push-banner");

  await banner.click();
  await expect(renderedDocument(reader).locator("#s1")).toHaveText(
    "Section 1 now lists every open decision, its owner, and the date that the team set for it.",
  );
  await expect(banner).toHaveCount(0);
  await shot(reader, "07-after-show-latest");
  await reader.context().close();
});

test("an editor who types while an agent pushes keeps the text of both", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Coedit agent");
  const html = documentHTML(title);
  const document = await slashdocs.createDocument(title, html);
  await page.goto(`/app/d/${document.id}`);
  await startEditing(page);
  await mark(page);
  await placeCaret(page, "#shared", "starts here");
  await page.keyboard.type(" on Monday", { delay: 30 });
  // The push starts from the version before the editor typed.
  await slashdocs.pushVersion(
    document.id,
    html.replace("Section 3 holds", "Section 3 now holds"),
    document.current_version_id,
  );
  await page.keyboard.type(" at nine", { delay: 30 });

  await expect(renderedDocument(page).locator("#s3")).toHaveText(
    "Section 3 now holds the notes of the team.",
  );
  await expect(renderedDocument(page).locator("#shared")).toHaveText(
    "The plan starts here on Monday at nine and ends there.",
  );
  expect(await kept(page)).toBe("yes");
  await expect
    .poll(() => latestSource(page, document.id))
    .toBe(
      html
        .replace("starts here", "starts here on Monday at nine")
        .replace("Section 3 holds", "Section 3 now holds"),
    );
});

// together opens a new document for the admin, and for the reviewer with a
// role, each in a browser context of their own.
async function together(
  page: Page,
  browser: Browser,
  slashdocs: SlashdocsAPI,
  role: "viewer" | "editor",
) {
  const title = uniqueName("Coedit");
  const html = documentHTML(title);
  const document = await slashdocs.createDocument(title, html);
  const grant = await slashdocs.shareWithAnyone(document.id, role);
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reviewer = await reviewerOn(browser, path);
  await expect(page.getByRole("button", { name: /^reviewer/ })).toBeVisible();
  return { document, html, grant, reviewer };
}

test("a pin and a highlight stay on their element when another person types above them", async ({
  page,
  browser,
  slashdocs,
}) => {
  const { document, reviewer } = await together(page, browser, slashdocs, "editor");
  await slashdocs.createComment(document.id, "Which notes?", {
    point: { target: "s2", x: 0.5, y: 0.5 },
  });
  await slashdocs.createComment(document.id, "Which team?", {
    quote: "Section 3 holds the notes of the team.",
  });
  const pin = page.frameLocator('iframe[title="Rendered document"]').locator(".sd-pin");
  const pinned = renderedDocument(page).locator("#s2");
  const highlight = renderedDocument(page).locator("mark.slashdocs-mark");
  await expect(pin).toHaveCount(1);
  await expect(highlight).toHaveText("Section 3 holds the notes of the team.");
  // Where the pin is from its element, and where the element is on the page.
  const place = async () => {
    const [at, element] = [(await pin.boundingBox())!, (await pinned.boundingBox())!];
    return { x: at.x - element.x, y: at.y - element.y, top: element.y };
  };
  const before = await place();
  await mark(page);

  await startEditing(reviewer);
  await placeCaret(reviewer, "#shared", "ends there.");
  await reviewer.keyboard.press("Enter");
  await reviewer.keyboard.type("A new paragraph above the pin.", { delay: 20 });

  await expect(
    renderedDocument(page).getByText("A new paragraph above the pin."),
  ).toBeVisible();
  // The element moved down, and the pin moved with it.
  await expect.poll(async () => (await place()).top).toBeGreaterThan(before.top + 10);
  await expect
    .poll(async () => {
      const now = await place();
      return Math.max(Math.abs(now.x - before.x), Math.abs(now.y - before.y));
    })
    .toBeLessThanOrEqual(2);
  await expect(highlight).toHaveText("Section 3 holds the notes of the team.");
  expect(await highlight.evaluate((el) => el.closest("p")?.id)).toBe("s3");
  expect(await kept(page)).toBe("yes");
  await reviewer.context().close();
});

test("an editor who types offline saves on return, and gets the text of the other person", async ({
  page,
  browser,
  slashdocs,
}) => {
  const { document, reviewer } = await together(page, browser, slashdocs, "editor");
  await startEditing(page);
  await startEditing(reviewer);

  await page.context().setOffline(true);
  await placeCaret(page, "#shared", "starts here");
  await page.keyboard.type(" without a network", { delay: 30 });
  await expect(notSaved(page)).toBeVisible({ timeout: 15_000 });
  await placeCaret(reviewer, "#shared", "ends there");
  await reviewer.keyboard.type(" after the last review", { delay: 30 });
  await expect
    .poll(() => latestSource(reviewer, document.id))
    .toContain("The plan starts here and ends there after the last review.");

  await page.context().setOffline(false);
  const merged =
    "The plan starts here without a network and ends there after the last review.";
  for (const p of [page, reviewer])
    await expect(renderedDocument(p).locator("#shared")).toHaveText(merged, {
      timeout: 20_000,
    });
  await expect
    .poll(() => latestSource(reviewer, document.id))
    .toContain(`<p id="shared">${merged}</p>`);
  await expect(notSaved(page)).toBeHidden();
  await reviewer.context().close();
});

test("an editor who got live changes in Comment mode, and then types, saves both texts once", async ({
  page,
  browser,
  slashdocs,
}) => {
  const { document, html, reviewer } = await together(
    page,
    browser,
    slashdocs,
    "editor",
  );
  await mark(page);
  await startEditing(reviewer);
  await placeCaret(reviewer, "#shared", "ends there");
  // Each pause saves, so the reader gets a patch for each group of words.
  let theirs = "ends there";
  for (const words of [" after the review", " of the plan", " in June"]) {
    await reviewer.keyboard.type(words, { delay: 30 });
    theirs += words;
    await expect(renderedDocument(page).locator("#shared")).toContainText(theirs);
  }

  await startEditing(page);
  await placeCaret(page, "#shared", "starts here");
  await page.keyboard.type(" on Monday", { delay: 30 });

  const merged = `The plan starts here on Monday and ${theirs}.`;
  for (const p of [page, reviewer])
    await expect(renderedDocument(p).locator("#shared")).toHaveText(merged);
  expect(await kept(page)).toBe("yes");
  // The source is equal byte for byte, so no text is there twice.
  await expect
    .poll(() => latestSource(page, document.id))
    .toBe(html.replace("The plan starts here and ends there.", merged));
  await reviewer.context().close();
});

test("a viewer whose access goes while the editor types sees the access page", async ({
  page,
  browser,
  slashdocs,
}) => {
  const { document, grant, reviewer } = await together(
    page,
    browser,
    slashdocs,
    "viewer",
  );
  const errors: Error[] = [];
  reviewer.on("pageerror", (error) => errors.push(error));
  await startEditing(page);
  await placeCaret(page, "#shared", "starts here");
  await page.keyboard.type(" on Monday", { delay: 30 });
  await expect(renderedDocument(reviewer).locator("#shared")).toHaveText(
    "The plan starts here on Monday and ends there.",
  );

  await slashdocs.removeGrant(document.id, grant.id);
  await page.keyboard.type(" at nine", { delay: 30 });
  await expect(
    reviewer.getByText("You don't have access to this document"),
  ).toBeVisible({ timeout: 10_000 });
  await expect(reviewer.locator('iframe[title="Rendered document"]')).toHaveCount(0);
  expect(errors).toEqual([]);
  await expect
    .poll(() => latestSource(page, document.id))
    .toContain("The plan starts here on Monday at nine and ends there.");
  await reviewer.context().close();
});

test("Undo takes back the editor's own typing after another person typed elsewhere", async ({
  page,
  browser,
  slashdocs,
}) => {
  const { document, html, reviewer } = await together(
    page,
    browser,
    slashdocs,
    "editor",
  );
  await startEditing(page);
  await startEditing(reviewer);
  await placeCaret(page, "#shared", "starts here");
  await page.keyboard.type(" on Monday", { delay: 30 });
  await expect(renderedDocument(reviewer).locator("#shared")).toHaveText(
    "The plan starts here on Monday and ends there.",
  );
  await placeCaret(reviewer, "#s3", "Section 3 holds");
  await reviewer.keyboard.type(" all", { delay: 30 });
  const theirs = "Section 3 holds all the notes of the team.";
  await expect(renderedDocument(page).locator("#s3")).toHaveText(theirs);

  await page.keyboard.press("ControlOrMeta+z");
  for (const p of [page, reviewer]) {
    await expect(renderedDocument(p).locator("#shared")).toHaveText(
      "The plan starts here and ends there.",
    );
    await expect(renderedDocument(p).locator("#s3")).toHaveText(theirs);
  }
  await expect
    .poll(() => latestSource(page, document.id))
    .toBe(html.replace("Section 3 holds", "Section 3 holds all"));
  await reviewer.context().close();
});
