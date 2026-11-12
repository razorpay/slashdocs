import { type Page } from "@playwright/test";
import {
  expect,
  latestSource,
  renderedDocument,
  reviewerOn,
  startEditing,
  test,
  uniqueName,
} from "./fixtures";

// A document whose own script makes some of its text. When another person
// changes a string of that script, an attribute, or a style, the frame of an
// editor shows the change in place: it does not load again, and the caret
// of the editor stays where it was.

function documentHTML(title: string) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title><style>.note { color: rgb(0, 0, 0); }</style></head>
  <body>
    <h1>${title}</h1>
    <p id="notes" class="note">The team writes notes here.</p>
    <div id="labels"></div>
    <script>
      for (const n of [1, 2]) {
        const label = document.createElement("span");
        label.textContent = "Run step";
        document.getElementById("labels").appendChild(label);
      }
    </script>
  </body>
</html>`;
}

// mark leaves a mark on the window of the frame, which a load of the frame
// removes.
const mark = (page: Page) =>
  renderedDocument(page)
    .locator("body")
    .evaluate((body) => {
      (body.ownerDocument.defaultView as unknown as { e2eKept: string }).e2eKept =
        "yes";
    });
const kept = (page: Page) =>
  renderedDocument(page)
    .locator("body")
    .evaluate(
      (body) =>
        (body.ownerDocument.defaultView as unknown as { e2eKept?: string }).e2eKept,
    );

// select selects target in the text of the first element of selector, or
// puts the caret after it with collapse.
async function select(page: Page, selector: string, target: string, collapse = false) {
  await renderedDocument(page)
    .locator(selector)
    .first()
    .evaluate(
      (element, { target, collapse }) => {
        const d = element.ownerDocument;
        const walker = d.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = (node as Text).data.indexOf(target);
          if (at < 0) continue;
          d.body.focus();
          const end = at + target.length;
          d.getSelection()!.setBaseAndExtent(node, collapse ? end : at, node, end);
          return;
        }
        throw new Error(`no text ${target}`);
      },
      { target, collapse },
    );
}

// caret gives the text of the node of the caret, and its offset in it.
const caret = (page: Page) =>
  renderedDocument(page)
    .locator("body")
    .evaluate((body) => {
      const { focusNode, focusOffset } = body.ownerDocument.getSelection()!;
      return [focusNode?.textContent, focusOffset];
    });

test("a script string that one editor changes shows in place for the other, whose caret stays", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Coedit script");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.shareWithAnyone(document.id, "editor");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reviewer = await reviewerOn(browser, path);
  await expect(page.getByRole("button", { name: /^reviewer/ })).toBeVisible();
  await startEditing(page);
  await startEditing(reviewer);
  await mark(reviewer);
  await select(reviewer, "#notes", "writes", true);

  // The admin changes the label that the script shows in two places.
  const labels = renderedDocument(page).locator("#labels span");
  await labels.first().click();
  await expect(labels.first()).toHaveAttribute("contenteditable", "true");
  await select(page, "#labels span", "step");
  await page.keyboard.type("check");
  await expect
    .poll(() => latestSource(page, document.id))
    .toContain('label.textContent = "Run check";');

  await expect(renderedDocument(reviewer).locator("#labels span")).toHaveText([
    "Run check",
    "Run check",
  ]);
  expect(await kept(reviewer)).toBe("yes");
  expect(await caret(reviewer)).toEqual(["The team writes notes here.", 15]);

  // More keys of the reviewer go to the same place, and keep the string.
  await reviewer.keyboard.type(" short");
  await expect(renderedDocument(reviewer).locator("#notes")).toHaveText(
    "The team writes short notes here.",
  );
  await expect
    .poll(() => latestSource(page, document.id))
    .toContain("The team writes short notes here.");
  const source = await latestSource(page, document.id);
  expect(source).toContain('label.textContent = "Run check";');
  await expect(renderedDocument(page).locator("#notes")).toHaveText(
    "The team writes short notes here.",
  );
  await reviewer.context().close();
});

test("a push that changes an attribute, a style and a script string goes in place for an editor, and new code loads with the caret kept", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Coedit push script");
  const html = documentHTML(title);
  const document = await slashdocs.createDocument(title, html);
  await page.goto(`/app/d/${document.id}`);
  await startEditing(page);
  await mark(page);
  await select(page, "#notes", "writes", true);

  await slashdocs.pushVersion(
    document.id,
    html
      .replace('class="note"', 'class="note" title="Notes"')
      .replace("rgb(0, 0, 0)", "rgb(200, 0, 0)")
      .replace('"Run step"', '"Run all"'),
  );
  const notes = renderedDocument(page).locator("#notes");
  await expect(notes).toHaveAttribute("title", "Notes");
  await expect(notes).toHaveCSS("color", "rgb(200, 0, 0)");
  await expect(renderedDocument(page).locator("#labels span")).toHaveText([
    "Run all",
    "Run all",
  ]);
  expect(await kept(page)).toBe("yes");
  expect(await caret(page)).toEqual(["The team writes notes here.", 15]);

  // New script code cannot go in place: the frame loads again, at the same
  // place, with the caret at its characters.
  await slashdocs.pushVersion(
    document.id,
    (await latestSource(page, document.id)).replace(
      "</script>",
      'document.body.dataset.ran = "yes";</script>',
    ),
  );
  await expect(renderedDocument(page).locator("body")).toHaveAttribute(
    "data-ran",
    "yes",
  );
  expect(await kept(page)).toBeUndefined();
  await expect.poll(() => caret(page)).toEqual(["The team writes notes here.", 15]);
  await page.keyboard.type(" short");
  await expect(notes).toHaveText("The team writes short notes here.");
});
