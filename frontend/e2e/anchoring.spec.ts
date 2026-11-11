import { type FrameLocator, type Page } from "@playwright/test";
import { expect, startEditing, test, uniqueName } from "./fixtures";

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

// listedThread finds a thread in the comments list, which the bar opens.
async function listedThread(page: Page, body: string) {
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  return page
    .getByRole("dialog", { name: "Comments" })
    .getByRole("listitem")
    .filter({ hasText: body });
}

function documentHTML(heading: string, body: string) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${heading}</title></head>
  <body>
    <h1>${heading}</h1>
    ${body}
  </body>
</html>`;
}

type CommentRecord = {
  id: string;
  body: string;
  selected_text: string;
  anchor: {
    quote: string;
    prefix: string;
    suffix: string;
    dom_path: string;
    start_offset: number;
    end_offset: number;
  };
};

async function postComment(
  page: Page,
  documentID: string,
  body: string,
): Promise<CommentRecord> {
  const composer = page.getByPlaceholder("Add a comment…");
  await renderedDocument(page)
    .getByRole("button", { name: "Comment on selected text" })
    .click();
  await expect(composer).toBeVisible();
  await composer.fill(body);
  const responsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.pathname === `/v1/documents/${documentID}/comments`
    );
  });
  await page.getByRole("button", { name: "Post comment" }).click();
  const response = await responsePromise;
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as CommentRecord;
}

test("highlights a selection spanning inline markup end to end", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Cross-element anchor");
  const document = await slashdocs.createDocument(
    title,
    documentHTML(
      title,
      '<p id="rich">The gateway returned a <b>stale connection</b> error and the <code>conn_pool</code> metric spiked.</p>',
    ),
  );

  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  const paragraph = doc.locator("#rich");
  await expect(paragraph).toBeVisible();
  await paragraph.selectText();

  const comment = await postComment(
    page,
    document.id,
    "This selection crosses inline elements.",
  );
  expect(comment.anchor.end_offset).toBeGreaterThan(0);
  expect(comment.anchor.end_offset).toBeGreaterThan(comment.anchor.start_offset);
  expect(comment.anchor.quote).toContain("stale connection");

  const marks = doc.locator("mark.slashdocs-mark");
  await expect(marks.first()).toBeVisible();
  const paragraphText = (await paragraph.innerText()).replace(/\s+/g, " ").trim();
  await expect
    .poll(async () =>
      (await marks.allTextContents()).join("").replace(/\s+/g, " ").trim(),
    )
    .toBe(paragraphText);
});

test("copies a text link without opening a comment and reveals the selected occurrence", async ({
  page,
  slashdocs,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const title = uniqueName("Text link");
  const quote = "A linked passage with inline formatting & punctuation.";
  const document = await slashdocs.createDocument(
    title,
    documentHTML(
      title,
      `<p>${quote}</p><div style="height:1400px"></div><details><summary>More</summary><p id="linked">A linked passage with <b>inline formatting</b> &amp; punctuation.</p></details>`,
    ),
  );
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await doc.locator("summary").click();
  await doc.locator("#linked").selectText();
  const copy = doc.getByRole("button", { name: "Copy link to selected text" });
  await expect(copy).toBeVisible();
  await expect(
    doc.getByRole("button", { name: "Comment on selected text" }),
  ).toContainText("Comment");
  await expect(page.getByPlaceholder("Add a comment…")).toBeHidden();
  await copy.click();
  await expect(page.getByText("Link to text copied.", { exact: true })).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(new URL(link).searchParams.get("version")).toBe(document.current_version_id);
  expect(new URLSearchParams(new URL(link).hash.slice(1)).get("text")).toBe(quote);
  await page.goto("/app/documents");
  await page.goto(link);
  await expect(doc.locator("details")).toHaveAttribute("open", "");
  await expect(doc.locator("#linked")).toBeInViewport();
  await expect(doc.locator(".slashdocs-text-flash").first()).toBeVisible();
  await expect(page.getByPlaceholder("Add a comment…")).toBeHidden();
  await expect(doc.locator(".slashdocs-text-flash")).toHaveCount(0, { timeout: 4000 });
});

test("re-anchors a comment on content rendered by script after load", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Late content anchor");
  const document = await slashdocs.createDocument(
    title,
    documentHTML(
      title,
      `<p>Static intro paragraph.</p>
    <script>setTimeout(() => { const p = document.createElement('p'); p.id = 'late'; p.textContent = 'Late content appears after load.'; document.body.appendChild(p); }, 800);</script>`,
    ),
  );

  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  const late = doc.locator("#late");
  // The document's own script inserts this paragraph ~800ms after load.
  await expect(late).toBeVisible({ timeout: 15_000 });
  await late.selectText();
  await postComment(page, document.id, "Anchor survives late rendering.");

  await page.reload();

  // After the reload the paragraph does not exist yet when comments paint;
  // the bridge must re-anchor on its own once the script inserts it.
  const mark = renderedDocument(page)
    .locator("mark.slashdocs-mark")
    .filter({ hasText: "Late content appears after load." });
  await expect(mark.first()).toBeVisible({ timeout: 20_000 });

  const item = await listedThread(page, "Anchor survives late rendering.");
  await expect(item).toBeVisible();
  await expect(item.getByText("Not found in this version")).toHaveCount(0);
});

test("flags a comment whose text vanished from the new version", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Orphaned anchor");
  const document = await slashdocs.createDocument(
    title,
    documentHTML(
      title,
      '<p id="target">The quarterly latency regression traces back to the cache eviction policy.</p>',
    ),
  );

  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  const target = doc.locator("#target");
  await expect(target).toBeVisible();
  await target.selectText();
  await postComment(page, document.id, "This anchor is about to be orphaned.");

  // Replace the document with entirely unrelated prose so not even fuzzy
  // matching can rescue the original quote.
  await slashdocs.pushVersion(
    document.id,
    documentHTML(
      title,
      '<p id="replacement">Bees navigate home by polarized sky light.</p>',
    ),
  );
  await page.reload();

  await expect(renderedDocument(page).locator("#replacement")).toBeVisible();

  const item = await listedThread(page, "This anchor is about to be orphaned.");
  await expect(item.getByText("Not found in this version")).toBeVisible({
    timeout: 20_000,
  });
  await expect(renderedDocument(page).locator("mark.slashdocs-mark")).toHaveCount(0);
  // Its thread still opens, at the top right of the document.
  await item.click();
  await expect(
    page
      .getByRole("dialog", { name: "Comment thread" })
      .getByText("This anchor is about to be orphaned."),
  ).toBeVisible();
});

test("text links wait for a custom panel to be revealed", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Hidden text link");
  const document = await slashdocs.createDocument(
    title,
    documentHTML(
      title,
      `<button onclick="document.getElementById('panel').hidden=false">Reveal</button>` +
        '<div id="panel" hidden><p>Hidden linked passage</p></div>',
    ),
  );
  await page.goto(`/app/d/${document.id}#text=Hidden+linked+passage`);
  const doc = renderedDocument(page);
  await expect(page.getByText(/Linked text isn.t visible yet/)).toBeVisible();
  await doc.getByRole("button", { name: "Reveal", exact: true }).click();
  await expect(doc.locator(".slashdocs-text-flash").first()).toBeVisible();
  await expect(page.getByPlaceholder("Add a comment…")).toBeHidden();
});

test("comments on a selection with C and lists every shortcut with ?", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Shortcuts");
  const document = await slashdocs.createDocument(
    title,
    documentHTML(title, "<p>Keys beat clicks.</p>"),
  );
  // An earlier version from the history does not change, so C comments.
  await slashdocs.pushVersion(
    document.id,
    documentHTML(title, "<p>Keys beat clicks, again.</p>"),
  );
  await page.goto(`/app/d/${document.id}?version=${document.current_version_id}`);
  const doc = renderedDocument(page);
  // A mouse selection focuses the document. selectText alone does not.
  await doc.locator("p").click();
  await doc.locator("p").selectText();
  await page.keyboard.press("c");
  const composer = page.getByPlaceholder("Add a comment…");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("");
  await page.getByRole("button", { name: "Discard comment" }).click();

  // The owner edits the current document in Edit mode, so in its text C
  // types and Ctrl or Cmd with Alt and M comments.
  await page.goto(`/app/d/${document.id}`);
  await startEditing(page);
  await doc.locator("p").click();
  await doc.locator("p").selectText();
  await page.keyboard.press("ControlOrMeta+Alt+m");
  await expect(composer).toBeFocused();
  await page.getByRole("button", { name: "Discard comment" }).click();
  await expect(doc.locator("p")).toHaveText("Keys beat clicks, again.");

  // Esc leaves the text, so ? lists every shortcut and types nothing.
  await doc.locator("p").click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog.getByText("Comment on the selected text")).toBeVisible();
  await expect(dialog.getByText("Full screen")).toBeVisible();
  await expect(doc.locator("p")).toHaveText("Keys beat clicks, again.");
});

test("holding j scrolls faster than tapping it and stops on release", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Glide");
  const document = await slashdocs.createDocument(
    title,
    documentHTML(title, '<p>Top</p><div style="height:20000px"></div>'),
  );
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  const scrollY = () => doc.locator("html").evaluate(() => window.scrollY);
  await expect(doc.locator("p")).toBeVisible();
  // The owner edits the document, so in its text j types. Outside it, j
  // scrolls.
  await page.evaluate(() =>
    (window.document.activeElement as HTMLElement | null)?.blur(),
  );

  // A key repeats about every 33 ms while it is held.
  await page.keyboard.down("j");
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(33);
    await page.keyboard.down("j");
  }
  await page.keyboard.up("j");
  // The key up reaches the document a frame or so later, through the frames
  // between.
  await page.waitForTimeout(100);
  const held = await scrollY();
  expect(held).toBeGreaterThan(1000);
  await page.waitForTimeout(300);
  expect(await scrollY()).toBe(held);
});

test("a posted comment opens beside its text, and Esc closes it", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Popover");
  const document = await slashdocs.createDocument(
    title,
    documentHTML(title, "<p>Comment on me in a popover.</p>"),
  );
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await doc.locator("p").selectText();
  await postComment(page, document.id, "Posted in a popover");
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await expect(thread.getByText("Posted in a popover")).toBeVisible();
  // There is no side panel: the thread floats next to its highlight.
  const mark = await doc.locator("mark.slashdocs-mark").first().boundingBox();
  const box = await thread.boundingBox();
  expect(box && mark && Math.abs(box.y - mark.y)).toBeLessThan(40);

  await thread.press("Escape");
  await expect(thread).toBeHidden();
  // The owner edits the text: one click opens the thread, and leaves the
  // caret in the text.
  await doc.locator("mark.slashdocs-mark").first().click();
  await expect(thread.getByText("Posted in a popover")).toBeVisible();
});

test("Edit in the thread menu opens the message in a field to type in", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Edit in place");
  const document = await slashdocs.createDocument(
    title,
    documentHTML(title, "<p>Change my comment.</p>"),
  );
  await slashdocs.createComment(document.id, "First words", {
    quote: "Change my comment.",
  });
  await page.goto(`/app/d/${document.id}`);
  await (await listedThread(page, "First words")).click();
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await thread.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(thread.getByRole("combobox").first()).toBeFocused();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.type("Better words");
  await page.keyboard.press("Enter");
  await expect(thread.getByText("Better words")).toBeVisible();
  await expect(thread.getByText("edited")).toBeVisible();
});
