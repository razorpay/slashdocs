import { type FrameLocator, type Page } from "@playwright/test";
import { expect, test, uniqueName } from "./fixtures";

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
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
  ).toHaveText("");
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

  const card = page
    .getByRole("button")
    .filter({ hasText: "Anchor survives late rendering." });
  await expect(card).toBeVisible();
  await expect(
    card.getByText("Highlight not currently visible", { exact: true }),
  ).not.toBeVisible();
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

  const card = page
    .getByRole("button")
    .filter({ hasText: "This anchor is about to be orphaned." });
  await expect(card).toBeVisible();
  await expect(
    card.getByText("Highlight not currently visible", { exact: true }),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expect(renderedDocument(page).locator("mark.slashdocs-mark")).toHaveCount(0);
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
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  // A mouse selection focuses the document. selectText alone does not.
  await doc.locator("p").click();
  await doc.locator("p").selectText();
  await page.keyboard.press("c");
  const composer = page.getByPlaceholder("Add a comment…");
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue("");
  await page.getByRole("button", { name: "Cancel comment" }).click();

  await doc.locator("h1").click();
  await page.keyboard.press("?");
  const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(dialog.getByText("Comment on the selected text")).toBeVisible();
  await expect(dialog.getByText("Full screen")).toBeVisible();
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
  await doc.locator("p").click();

  // A key repeats about every 33 ms while it is held.
  await page.keyboard.down("j");
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(33);
    await page.keyboard.down("j");
  }
  await page.keyboard.up("j");
  const held = await scrollY();
  expect(held).toBeGreaterThan(1000);
  await page.waitForTimeout(300);
  expect(await scrollY()).toBe(held);
});

test("a comment started with the comments hidden hides them again when it posts", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Peek");
  const document = await slashdocs.createDocument(
    title,
    documentHTML(title, "<p>Comment on me while the rail is hidden.</p>"),
  );
  await page.goto(`/app/d/${document.id}`);
  await page.getByRole("button", { name: "Hide comments" }).click();
  await renderedDocument(page).locator("p").selectText();
  await postComment(page, document.id, "Posted while hidden");
  await expect(page.getByRole("button", { name: "Show comments" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Show comments" })).toBeVisible();
});
