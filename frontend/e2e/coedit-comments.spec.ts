import { type FrameLocator, type Page } from "@playwright/test";
import { expect, reviewerOn, startEditing, test, uniqueName } from "./fixtures";

// A comment highlight stays on its own text while another person changes
// that text live, as in Google Docs: it grows with typing in it, and when all
// of its text goes, the comment shows as detached. It never goes to another
// copy of its phrase. The server moves the stored anchor in the same way, so
// a load finds the grown text too.

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

// select selects text in an element, as a drag does. Highlights can cut
// the text into more than one node.
async function select(page: Page, selector: string, text: string) {
  await renderedDocument(page)
    .locator(selector)
    .evaluate((element, text) => {
      const d = element.ownerDocument;
      const start = element.textContent!.indexOf(text);
      const point = (offset: number): [Node, number] => {
        const walker = d.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const length = (node as Text).length;
          if (offset <= length) return [node, offset];
          offset -= length;
        }
        throw new Error(`no text ${text}`);
      };
      d.body.focus();
      d.getSelection()!.setBaseAndExtent(
        ...point(start),
        ...point(start + text.length),
      );
    }, text);
}

const phrase = (n: number) =>
  `<p id="p${n}">Paragraph ${n} alpha bravo kilo lima mike november oscar.</p>`;

test("a highlight on a repeated phrase stays on its text while another person edits it, and detaches when the text goes", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Coedit comments");
  const document = await slashdocs.createDocument(
    title,
    `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    ${[1, 2, 3].map(phrase).join("\n    ")}
  </body>
</html>`,
  );
  await slashdocs.shareWithAnyone(document.id, "editor");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reviewer = await reviewerOn(browser, path);

  // The admin comments on the copy of the phrase in the second paragraph.
  await select(page, "#p2", "kilo lima mike");
  await renderedDocument(page)
    .getByRole("button", { name: "Comment on selected text" })
    .click();
  await page.getByPlaceholder("Add a comment…").fill("Which kilo?");
  await page.getByRole("button", { name: "Post comment" }).click();
  const highlight = renderedDocument(page).locator("mark.slashdocs-mark");
  await expect(highlight).toHaveText("kilo lima mike");
  const paragraph = () => highlight.first().evaluate((el) => el.closest("p")?.id);
  expect(await paragraph()).toBe("p2");

  // The reviewer types in the phrase. The highlight grows, and stays in the
  // second paragraph.
  await startEditing(reviewer);
  await expect(renderedDocument(reviewer).locator("#p2")).toBeVisible();
  await select(reviewer, "#p2", "kilo li");
  await reviewer.keyboard.press("ArrowRight");
  await reviewer.keyboard.type("XX", { delay: 50 });
  await expect(renderedDocument(page).locator("#p2")).toContainText("kilo liXXma mike");
  await expect(highlight).toHaveText("kilo liXXma mike");
  expect(await paragraph()).toBe("p2");

  // After a load, the comment is still on its grown text, in the page and in
  // the panel.
  await page.reload();
  await expect(highlight).toHaveText("kilo liXXma mike");
  expect(await paragraph()).toBe("p2");
  const comments = page.getByRole("button", { name: "Comments", exact: true });
  await comments.click();
  const thread = page
    .getByRole("dialog", { name: "Comments" })
    .getByRole("listitem")
    .filter({ hasText: "Which kilo?" });
  await expect(thread).toContainText("kilo liXXma mike");
  await expect(thread.getByText("Not found in this version")).toHaveCount(0);
  await comments.click();

  // The reviewer deletes the phrase. The comment is detached, and no other
  // copy of the phrase takes its highlight.
  await select(reviewer, "#p2", "kilo liXXma mike ");
  await reviewer.keyboard.press("Backspace");
  await expect(renderedDocument(page).locator("#p2")).toHaveText(
    "Paragraph 2 alpha bravo november oscar.",
  );
  await expect(highlight).toHaveCount(0);
  await comments.click();
  await expect(thread.getByText("Not found in this version")).toBeVisible();
  await reviewer.context().close();
});

// openThread opens the Comments panel and gives the thread with body.
async function openThread(page: Page, body: string) {
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  return page
    .getByRole("dialog", { name: "Comments" })
    .getByRole("listitem")
    .filter({ hasText: body });
}

test("a comment posted while another person types in its words, and a push that changes them, stays on its text after a load", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Coedit comment race");
  const document = await slashdocs.createDocument(
    title,
    `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    ${phrase(1)}
  </body>
</html>`,
  );
  await slashdocs.shareWithAnyone(document.id, "editor");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reviewer = await reviewerOn(browser, path);
  await startEditing(reviewer);
  await expect(renderedDocument(reviewer).locator("#p1")).toBeVisible();

  // The admin selects the phrase and writes a comment. Before it posts, the
  // reviewer types in the phrase.
  await select(page, "#p1", "kilo lima mike");
  await renderedDocument(page)
    .getByRole("button", { name: "Comment on selected text" })
    .click();
  await page.getByPlaceholder("Add a comment…").fill("Which lima?");
  await select(reviewer, "#p1", "kilo li");
  await reviewer.keyboard.press("ArrowRight");
  await reviewer.keyboard.type("XX", { delay: 50 });
  await page.getByRole("button", { name: "Post comment" }).click();
  const highlight = renderedDocument(page).locator("mark.slashdocs-mark");
  await expect(highlight).toHaveText("kilo liXXma mike");

  // The reviewer types more in the phrase after it posts.
  await reviewer.keyboard.type("YY", { delay: 50 });
  await expect(highlight).toHaveText("kilo liXXYYma mike");
  await page.reload();
  await expect(highlight).toHaveText("kilo liXXYYma mike");
  const thread = await openThread(page, "Which lima?");
  await expect(thread).toContainText("kilo liXXYYma mike");
  await expect(thread.getByText("Not found in this version")).toHaveCount(0);
  await page.getByRole("button", { name: "Comments", exact: true }).click();

  // An agent pushes a change of a word in the phrase. After a load, the
  // comment is on the changed text.
  const live = await slashdocs.getDocument(document.id);
  const html = await page.request
    .get(`/v1/documents/${document.id}/versions/${live.current_version_id}/html`)
    .then((r) => r.text());
  await slashdocs.pushVersion(
    document.id,
    html.replace("kilo liXXYYma", "KILO liXXYYma"),
  );
  await expect(highlight).toHaveText("KILO liXXYYma mike");
  await page.reload();
  await expect(highlight).toHaveText("KILO liXXYYma mike");
  await expect(await openThread(page, "Which lima?")).toContainText(
    "KILO liXXYYma mike",
  );
  await reviewer.context().close();
});
