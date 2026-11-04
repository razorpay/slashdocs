import { type FrameLocator, type Page } from "@playwright/test";
import { expect, test, uniqueName } from "./fixtures";

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

// Four cards start with the same label, so only the position of a label can
// tell them apart.
function documentHTML() {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Getting started</title></head>
  <body>
    <h1>Getting started</h1>
    <p id="intro">Caf&eacute; owners read this guide &amp; keep it.</p>
    <p class="card"><strong>Try it.</strong> Open the first panel.</p>
    <p class="card"><strong>Try it.</strong> Open the second panel.</p>
    <p class="card"><strong>Try it.</strong> Open the third panel.</p>
    <p class="card"><strong>Try it.</strong> Open the fourth panel.</p>
    <ul id="steps">
      <li>Install the tool</li>
      <li>Run the tool</li>
    </ul>
    <p id="tail">Clients retry twice before giving up.</p>
  </body>
</html>`;
}

// placeCaret puts the caret in the text of an element of the rendered
// document: over target, or after it when collapse is set.
async function placeCaret(
  page: Page,
  selector: string,
  target: string,
  options: { nth?: number; collapse?: boolean } = {},
) {
  await renderedDocument(page)
    .locator(selector)
    .nth(options.nth ?? 0)
    .evaluate(
      (element, { target, collapse }) => {
        const walker = element.ownerDocument.createTreeWalker(
          element,
          NodeFilter.SHOW_TEXT,
        );
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const text = node as Text;
          const start = text.data.indexOf(target);
          if (start < 0) continue;
          const range = element.ownerDocument.createRange();
          range.setStart(text, collapse ? start + target.length : start);
          range.setEnd(text, start + target.length);
          element.ownerDocument.body.focus();
          const selection = element.ownerDocument.getSelection()!;
          selection.removeAllRanges();
          selection.addRange(range);
          return;
        }
        throw new Error(`no text ${target}`);
      },
      { target, collapse: options.collapse ?? false },
    );
}

// openEditable opens a document as its owner, who edits it by typing.
async function openEditable(page: Page, id: string) {
  await page.goto(`/app/d/${id}`);
  await expect(renderedDocument(page).locator("h1")).toBeVisible();
  await expect(renderedDocument(page).locator("body")).toHaveAttribute(
    "contenteditable",
    "true",
  );
}

function nextSave(page: Page, id: string) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === `/v1/documents/${id}/source-edits`,
  );
}

async function latestSource(page: Page, id: string): Promise<string> {
  const document = await page.request.get(`/v1/documents/${id}`);
  const { current_version_id } = (await document.json()) as {
    current_version_id: string;
  };
  const source = await page.request.get(
    `/v1/documents/${id}/versions/${current_version_id}/html`,
  );
  return source.text();
}

test("changes only the third of four identical labels", async ({ page, slashdocs }) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("Labels"), html);

  await openEditable(page, document.id);
  const saved = nextSave(page, document.id);
  await placeCaret(page, ".card strong", "Try it.", { nth: 2 });
  await page.keyboard.type("Read it.");
  const response = await saved;
  expect(response.status()).toBe(201);
  const [replacement] = response.request().postDataJSON().replacements;
  expect(replacement.old_html).not.toContain("second");

  await page.reload();
  const labels = renderedDocument(page).locator(".card strong");
  await expect(labels).toHaveText(["Try it.", "Try it.", "Read it.", "Try it."]);
  // Every other byte, the entities too, stays as it was.
  const third = html.indexOf("Try it.", html.indexOf("second"));
  expect(await latestSource(page, document.id)).toBe(
    html.slice(0, third) + "Read it." + html.slice(third + "Try it.".length),
  );
});

test("Enter opens a new paragraph to type in", async ({ page, slashdocs }) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("Enter"), html);

  await openEditable(page, document.id);
  const saved = nextSave(page, document.id);
  await placeCaret(page, "#tail", "giving up.", { collapse: true });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Then they stop.");
  expect((await saved).status()).toBe(201);

  await expect
    .poll(() => latestSource(page, document.id))
    .toBe(html.replace("giving up.</p>", "giving up.</p><p>Then they stop.</p>"));
  await page.reload();
  await expect(renderedDocument(page).locator("#tail + p")).toHaveText(
    "Then they stop.",
  );
});

test("Cmd or Ctrl+B makes the selected words bold", async ({ page, slashdocs }) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("Bold"), html);

  await openEditable(page, document.id);
  const saved = nextSave(page, document.id);
  await placeCaret(page, "#tail", "twice");
  await page.keyboard.press("ControlOrMeta+b");
  expect((await saved).status()).toBe(201);

  expect(await latestSource(page, document.id)).toBe(
    html.replace("retry twice", "retry <strong>twice</strong>"),
  );
});

test("Enter at the end of a list item adds an item", async ({ page, slashdocs }) => {
  const document = await slashdocs.createDocument(uniqueName("List"), documentHTML());

  await openEditable(page, document.id);
  const saved = nextSave(page, document.id);
  await placeCaret(page, "#steps li", "Run the tool", { nth: 1, collapse: true });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Read the report");
  expect((await saved).status()).toBe(201);

  await page.reload();
  await expect(renderedDocument(page).locator("#steps li")).toHaveText([
    "Install the tool",
    "Run the tool",
    "Read the report",
  ]);
});

test("two tabs that edit different text both save", async ({ page, slashdocs }) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("Two tabs"), html);
  const other = await page.context().newPage();

  await openEditable(page, document.id);
  await openEditable(other, document.id);

  const first = nextSave(page, document.id);
  await placeCaret(page, "#tail", "twice");
  await page.keyboard.type("three times");
  expect((await first).status()).toBe(201);

  // The second tab still shows the first version: the server moves its edit
  // onto the newer one.
  const second = nextSave(other, document.id);
  await placeCaret(other, "#intro", "keep it");
  await other.keyboard.type("share it");
  const response = await second;
  expect(response.status()).toBe(201);
  expect((await response.json()).rebased).toBe(true);

  expect(await latestSource(page, document.id)).toBe(
    html.replace("retry twice", "retry three times").replace("keep it", "share it"),
  );
  // The second tab shows both edits once it loads the merged version.
  await expect(renderedDocument(other).locator("#tail")).toHaveText(
    "Clients retry three times before giving up.",
  );
});

test("text from a script offers to ask an agent", async ({ page, slashdocs }) => {
  const html = documentHTML().replace(
    "</body>",
    `<p>Status: <span id="status"></span></p>
    <script>
      // No string in the source equals the text that the script shows.
      const count = [1, 2, 3].length;
      document.getElementById("status").textContent = count + " steps";
    </script>
  </body>`,
  );
  const document = await slashdocs.createDocument(uniqueName("Script text"), html);

  await openEditable(page, document.id);
  await renderedDocument(page).locator("#status").click();
  const hint = renderedDocument(page).getByText("This text comes from a script.");
  await expect(hint).toBeVisible();
  await renderedDocument(page)
    .getByRole("button", { name: "Ask an agent to change this" })
    .click();
  await expect(
    page.getByText("Please change “3 steps” to:", { exact: false }),
  ).toBeVisible();
  const unchanged = await slashdocs.getDocument(document.id);
  expect(unchanged.current_version_id).toBe(document.current_version_id);
});

test("text from one script string changes in every place it shows", async ({
  page,
  slashdocs,
}) => {
  const html = documentHTML().replace(
    "</body>",
    `<div id="labels"></div>
    <script>
      for (const n of [1, 2, 3]) {
        const button = document.createElement("button");
        button.textContent = "Run step";
        document.getElementById("labels").appendChild(button);
      }
    </script>
  </body>`,
  );
  const document = await slashdocs.createDocument(uniqueName("Script string"), html);

  await openEditable(page, document.id);
  await renderedDocument(page).locator("#labels button").first().click();
  await expect(
    renderedDocument(page).locator("#labels button").first(),
  ).toHaveAttribute("contenteditable", "true");
  const saved = nextSave(page, document.id);
  await placeCaret(page, "#labels button", "step");
  await page.keyboard.type("check");
  expect((await saved).status()).toBe(201);
  await expect(page.getByText("Changed in 3 places")).toBeVisible();
  expect(await latestSource(page, document.id)).toBe(
    html.replace('"Run step"', '"Run check"'),
  );
  await expect(renderedDocument(page).locator("#labels button")).toHaveText([
    "Run check",
    "Run check",
    "Run check",
  ]);
});

test("saves only the editor's words while a script changes other text", async ({
  page,
  slashdocs,
}) => {
  const html = documentHTML().replace(
    "</body>",
    `<p id="clock">0</p>
    <script>
      let ticks = 0;
      setInterval(() => {
        document.getElementById("clock").textContent = String(++ticks);
        document.body.appendChild(document.createElement("span"));
      }, 200);
    </script>
  </body>`,
  );
  const document = await slashdocs.createDocument(uniqueName("Script clock"), html);

  await openEditable(page, document.id);
  const saved = nextSave(page, document.id);
  await placeCaret(page, "#tail", "twice");
  await page.keyboard.type("once");
  expect((await saved).status()).toBe(201);
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(await latestSource(page, document.id)).toBe(html.replace("twice", "once"));
});

test("keeps the highlights of other paragraphs while the editor types", async ({
  page,
  slashdocs,
}) => {
  const document = await slashdocs.createDocument(
    uniqueName("Highlights"),
    documentHTML(),
  );
  await slashdocs.createComment(document.id, "Which guide?", {
    quote: "read this guide",
  });
  await slashdocs.createComment(document.id, "Why twice?", { quote: "retry twice" });

  await openEditable(page, document.id);
  const marks = renderedDocument(page).locator("mark.slashdocs-mark");
  await expect(marks).toHaveCount(2);
  const saved = nextSave(page, document.id);
  await placeCaret(page, "#intro", "owners");
  await page.keyboard.type("readers");
  // Only the paragraph that takes the typing loses its highlight, until the
  // save.
  expect(
    await renderedDocument(page).locator("#tail mark.slashdocs-mark").count(),
  ).toBe(1);
  expect((await saved).status()).toBe(201);
  await expect(marks).toHaveCount(2);
});

test("restores an earlier version from the history", async ({ page, slashdocs }) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("History"), html);

  await openEditable(page, document.id);
  const saved = nextSave(page, document.id);
  await placeCaret(page, "#tail", "twice");
  await page.keyboard.type("three times");
  await saved;
  const savedAgain = nextSave(page, document.id);
  await placeCaret(page, "#tail", "three");
  await page.keyboard.type("four");
  await savedAgain;

  // The summary names the changed words, not the markup around them.
  await page.getByRole("button", { name: "History", exact: true }).click();
  const history = page.getByRole("dialog");
  await history.getByRole("button", { name: "Show 2 earlier edits" }).click();
  await history
    .getByRole("button", { name: /Replaced "twice" with "three times"/ })
    .click();
  await expect(renderedDocument(page).locator("#tail")).toHaveText(
    "Clients retry three times before giving up.",
  );
  await page.getByRole("button", { name: "History", exact: true }).click();
  await history.getByRole("button", { name: "Show 2 earlier edits" }).click();
  await history.getByRole("button", { name: /Created/ }).click();
  await expect(page.getByText("This is the document as it was")).toBeVisible();

  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText("Restored.")).toBeVisible();
  expect(await latestSource(page, document.id)).toBe(html);
});

test("keeps the editor's words when someone changes other text first", async ({
  page,
  slashdocs,
}) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("Elsewhere"), html);

  await openEditable(page, document.id);
  const saved = nextSave(page, document.id);
  await placeCaret(page, "#tail", "twice");
  await page.keyboard.type("three times");
  // An agent changes other text before the pause.
  await slashdocs.pushVersion(document.id, html.replace("keep it", "share it"));

  expect((await saved).status()).toBe(201);
  await expect
    .poll(() => latestSource(page, document.id))
    .toBe(html.replace("keep it", "share it").replace("twice", "three times"));
  await expect(renderedDocument(page).locator("#intro")).toContainText("share it");
});
