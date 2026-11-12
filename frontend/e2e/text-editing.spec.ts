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

// versions lists what the History holds of each version, the oldest first.
async function versions(page: Page, id: string) {
  const { items } = (await (
    await page.request.get(`/v1/documents/${id}/versions`)
  ).json()) as { items: { open: boolean; change_summary: string }[] };
  return items.map(({ open, change_summary }) => ({ open, change_summary }));
}

// saved waits until the live document on the server is source. Each key
// goes to the server as it comes, so only the source tells that all did.
const saved = (page: Page, id: string, source: string) =>
  expect.poll(() => latestSource(page, id)).toBe(source);

test("changes only the third of four identical labels", async ({ page, slashdocs }) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("Labels"), html);

  await openEditable(page, document.id);
  await placeCaret(page, ".card strong", "Try it.", { nth: 2 });
  await page.keyboard.type("Read it.");
  // Every other byte, the entities too, stays as it was.
  const third = html.indexOf("Try it.", html.indexOf("second"));
  await saved(
    page,
    document.id,
    html.slice(0, third) + "Read it." + html.slice(third + "Try it.".length),
  );

  await page.reload();
  const labels = renderedDocument(page).locator(".card strong");
  await expect(labels).toHaveText(["Try it.", "Try it.", "Read it.", "Try it."]);
});

test("Enter opens a new paragraph to type in", async ({ page, slashdocs }) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("Enter"), html);

  await openEditable(page, document.id);
  await placeCaret(page, "#tail", "giving up.", { collapse: true });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Then they stop.");
  await saved(
    page,
    document.id,
    html.replace("giving up.</p>", "giving up.</p><p>Then they stop.</p>"),
  );
  await page.reload();
  await expect(renderedDocument(page).locator("#tail + p")).toHaveText(
    "Then they stop.",
  );
});

test("Cmd or Ctrl+B makes the selected words bold", async ({ page, slashdocs }) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("Bold"), html);

  await openEditable(page, document.id);
  await placeCaret(page, "#tail", "twice");
  await page.keyboard.press("ControlOrMeta+b");
  await saved(
    page,
    document.id,
    html.replace("retry twice", "retry <strong>twice</strong>"),
  );
});

test("Enter at the end of a list item adds an item", async ({ page, slashdocs }) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("List"), html);

  await openEditable(page, document.id);
  await placeCaret(page, "#steps li", "Run the tool", { nth: 1, collapse: true });
  await page.keyboard.press("Enter");
  await page.keyboard.type("Read the report");
  await saved(
    page,
    document.id,
    html.replace(
      "<li>Run the tool</li>",
      "<li>Run the tool</li><li>Read the report</li>",
    ),
  );

  await page.reload();
  await expect(renderedDocument(page).locator("#steps li")).toHaveText([
    "Install the tool",
    "Run the tool",
    "Read the report",
  ]);
});

// Tab moves the caret from cell to cell of a table, and Shift+Tab back. It
// never moves the focus out of the document, where the next keys go nowhere.
test("Tab moves the caret to the next cell of a table, and keeps the focus outside one", async ({
  page,
  slashdocs,
}) => {
  const html = documentHTML().replace(
    "</body>",
    '<table id="grid"><tr><td>cell one</td><td>cell two</td></tr></table></body>',
  );
  const document = await slashdocs.createDocument(uniqueName("Tab"), html);

  await openEditable(page, document.id);
  await placeCaret(page, "#grid td", "one", { collapse: true });
  await page.keyboard.press("Tab");
  await page.keyboard.type(" next");
  // The last cell keeps the caret: Tab adds no row.
  await page.keyboard.press("Tab");
  await page.keyboard.type(" last");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.type(" back");
  await placeCaret(page, "#tail", "giving up.", { collapse: true });
  await page.keyboard.press("Tab");
  await page.keyboard.type(" Still here.");
  await saved(
    page,
    document.id,
    html
      .replace("cell one", "cell one back")
      .replace("cell two", "cell two next last")
      .replace("giving up.", "giving up. Still here."),
  );
});

// selectBlocks selects from the start of the text of an element to the end
// of the words last.
async function selectBlocks(page: Page, selector: string, last: string) {
  await renderedDocument(page)
    .locator(selector)
    .evaluate((start, last) => {
      const d = start.ownerDocument;
      const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
      let end = walker.nextNode() as Text;
      while (!end.data.endsWith(last)) end = walker.nextNode() as Text;
      d.body.focus();
      d.getSelection()!.setBaseAndExtent(start.firstChild!, 0, end, end.length);
    }, last);
}

for (const [name, last, keys] of [
  ["Backspace and typing", "third panel.", ["Backspace", "R"]],
  ["typing over the last paragraphs", "giving up.", ["R"]],
] as const)
  test(`${name} over whole paragraphs puts the text in the first one`, async ({
    page,
    slashdocs,
  }) => {
    const html = documentHTML();
    const document = await slashdocs.createDocument(uniqueName("Replace"), html);

    await openEditable(page, document.id);
    await selectBlocks(page, "#intro", last);
    for (const key of keys) await page.keyboard.press(key);
    await expect(renderedDocument(page).locator("#intro")).toHaveText("R");
    const start = html.indexOf("Caf&eacute;");
    const end = html.indexOf("</p>", html.indexOf(last));
    await saved(page, document.id, html.slice(0, start) + "R" + html.slice(end));
  });

test("two tabs that edit different text both save", async ({ page, slashdocs }) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("Two tabs"), html);
  const other = await page.context().newPage();

  await openEditable(page, document.id);
  await openEditable(other, document.id);
  // A load of a frame removes this mark.
  const body = (tab: Page) => renderedDocument(tab).locator("body");
  for (const tab of [page, other])
    await body(tab).evaluate((el) => void (el.dataset.e2eKept = "yes"));

  await placeCaret(page, "#tail", "twice");
  await page.keyboard.type("three times");
  await placeCaret(other, "#intro", "keep it");
  await other.keyboard.type("share it");
  await saved(
    page,
    document.id,
    html.replace("retry twice", "retry three times").replace("keep it", "share it"),
  );
  // Each tab gets the text of the other in place, with no load of its frame.
  for (const tab of [page, other]) {
    await expect(renderedDocument(tab).locator("#tail")).toHaveText(
      "Clients retry three times before giving up.",
    );
    await expect(renderedDocument(tab).locator("#intro")).toHaveText(
      "Café owners read this guide & share it.",
    );
    await expect(body(tab)).toHaveAttribute("data-e2e-kept", "yes");
  }
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
  const hint = renderedDocument(page).getByText(
    "A script on the page writes this text.",
  );
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

test("text in a drawing is not editable, and offers to ask an agent", async ({
  page,
  slashdocs,
}) => {
  const html = documentHTML().replace(
    "</body>",
    `<svg width="200" height="40"><text id="chart-label" x="0" y="20">Sales by month</text></svg>
  </body>`,
  );
  const document = await slashdocs.createDocument(uniqueName("Drawing"), html);

  await openEditable(page, document.id);
  const label = renderedDocument(page).locator("#chart-label");
  await expect(label.locator("xpath=ancestor::*[local-name()='svg']")).toHaveAttribute(
    "contenteditable",
    "false",
  );
  await label.click();
  await expect(
    renderedDocument(page).getByText("You cannot change this part of the page here."),
  ).toBeVisible();
  await renderedDocument(page)
    .getByRole("button", { name: "Ask an agent to change this" })
    .click();
  await expect(
    page.getByText("Please change “Sales by month” to:", { exact: false }),
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
  await placeCaret(page, "#labels button", "step");
  await page.keyboard.type("check");
  await saved(page, document.id, html.replace('"Run step"', '"Run check"'));
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
  await placeCaret(page, "#tail", "twice");
  await page.keyboard.type("once");
  await saved(page, document.id, html.replace("twice", "once"));
  await expect(notSaved(page)).toBeHidden();
});

test("keeps the highlights of other paragraphs while the editor types", async ({
  page,
  slashdocs,
}) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("Highlights"), html);
  await slashdocs.createComment(document.id, "Which guide?", {
    quote: "read this guide",
  });
  await slashdocs.createComment(document.id, "Why twice?", { quote: "retry twice" });

  await openEditable(page, document.id);
  const marks = renderedDocument(page).locator("mark.slashdocs-mark");
  await expect(marks).toHaveCount(2);
  await placeCaret(page, "#intro", "owners");
  await page.keyboard.type("readers");
  // Only the paragraph that takes the typing loses its highlight, until the
  // save.
  expect(
    await renderedDocument(page).locator("#tail mark.slashdocs-mark").count(),
  ).toBe(1);
  await saved(page, document.id, html.replace("owners", "readers"));
  await expect(marks).toHaveCount(2);
});

test("a restore from the history keeps the typed sitting as an entry of its own", async ({
  page,
  slashdocs,
}) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("History"), html);

  await openEditable(page, document.id);
  await placeCaret(page, "#tail", "twice");
  await page.keyboard.type("three times");
  await saved(page, document.id, html.replace("twice", "three times"));

  // The editor is still in Edit mode, so the sitting is open.
  await openHistory(page);
  const history = page.getByRole("dialog", { name: "History" });
  await expect(
    history.getByRole("button", { name: /Changed “twice” to “three times”/ }),
  ).toBeVisible();
  await history.getByRole("button", { name: /Created/ }).click();
  await expect(page.getByText("This is the document as it was")).toBeVisible();

  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText(/^Restored an earlier version of/)).toBeVisible();
  expect(await latestSource(page, document.id)).toBe(html);
  // The restore ends the sitting, and comes after it.
  expect(await versions(page, document.id)).toEqual([
    { open: false, change_summary: "" },
    { open: false, change_summary: "Changed “twice” to “three times”" },
    { open: false, change_summary: "Restored: Created" },
  ]);
  // The History shows the restore, and what the editor typed before it.
  await openHistory(page);
  await expect(
    history.getByRole("button", { name: /Restored: Created/ }),
  ).toBeVisible();
  await history
    .getByRole("button", { name: /Changed “twice” to “three times”/ })
    .click();
  await expect(renderedDocument(page).locator("#tail")).toHaveText(
    "Clients retry three times before giving up.",
  );
});

test("Undo after another person typed in the same paragraph takes back only the editor's last typing", async ({
  page,
  browser,
  slashdocs,
}) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("Undo"), html);
  await slashdocs.shareWithAnyone(document.id, "editor");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reviewer = await reviewerOn(browser, path);
  await startEditing(page);
  await startEditing(reviewer);
  const tail = (p: Page) => renderedDocument(p).locator("#tail");

  await placeCaret(page, "#tail", "Clients", { collapse: true });
  await page.keyboard.type(" always", { delay: 30 });
  await expect(tail(reviewer)).toContainText("Clients always retry");
  await placeCaret(reviewer, "#tail", "giving up", { collapse: true });
  await reviewer.keyboard.type(" at last", { delay: 30 });
  await expect(tail(page)).toContainText("giving up at last.");
  // A pause ends the first typing of the editor, so Undo has two steps.
  await page.waitForTimeout(1200);
  await page.keyboard.type(" and often", { delay: 30 });
  await expect(tail(reviewer)).toContainText("always and often");

  for (const text of [
    "Clients always retry twice before giving up at last.",
    "Clients retry twice before giving up at last.",
  ]) {
    await page.keyboard.press("ControlOrMeta+z");
    for (const p of [page, reviewer]) await expect(tail(p)).toHaveText(text);
  }
  await saved(page, document.id, html.replace("giving up.", "giving up at last."));
  await reviewer.context().close();
});

test("a push between the keys of an editor keeps the words of both, and the sitting stays one entry", async ({
  page,
  slashdocs,
}) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("Elsewhere"), html);

  await openEditable(page, document.id);
  await placeCaret(page, "#tail", "twice");
  await page.keyboard.type("three");
  await saved(page, document.id, html.replace("twice", "three"));
  // An agent that read the document before the editor typed changes other
  // text, and the editor types on.
  await slashdocs.pushVersion(
    document.id,
    html.replace("keep it", "share it"),
    document.current_version_id,
  );
  await page.keyboard.type(" times");

  await saved(
    page,
    document.id,
    html.replace("keep it", "share it").replace("twice", "three times"),
  );
  await expect(renderedDocument(page).locator("#intro")).toContainText("share it");
  // The History has the first version, the push, and one open entry for
  // the sitting of the editor, before and after the push.
  expect((await versions(page, document.id)).map((v) => v.open)).toEqual([
    false,
    false,
    true,
  ]);
});

test("a push of a file that equals the document makes no History entry", async ({
  page,
  slashdocs,
}) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("Same push"), html);
  const pushed = html.replace("keep it", "share it");
  await slashdocs.pushVersion(document.id, pushed);
  expect(await versions(page, document.id)).toHaveLength(2);
  const { current_version_id } = await slashdocs.getDocument(document.id);

  await slashdocs.pushVersion(document.id, pushed);
  expect(await versions(page, document.id)).toHaveLength(2);
  expect((await slashdocs.getDocument(document.id)).current_version_id).toBe(
    current_version_id,
  );
  expect(await latestSource(page, document.id)).toBe(pushed);
});

test("Bold by one person keeps the caret of another person later in the paragraph", async ({
  page,
  browser,
  slashdocs,
}) => {
  const html = documentHTML();
  const document = await slashdocs.createDocument(uniqueName("Bold caret"), html);
  await slashdocs.shareWithAnyone(document.id, "editor");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reviewer = await reviewerOn(browser, path);
  await startEditing(page);
  await startEditing(reviewer);

  await placeCaret(reviewer, "#tail", "before giving", { collapse: true });
  await placeCaret(page, "#tail", "twice");
  await page.keyboard.press("ControlOrMeta+b");
  await expect(renderedDocument(reviewer).locator("#tail strong")).toHaveText("twice");
  // The next keys of the reviewer land where their caret was.
  await reviewer.keyboard.type(" in", { delay: 30 });

  await saved(
    page,
    document.id,
    html.replace(
      "retry twice before giving up",
      "retry <strong>twice</strong> before giving in up",
    ),
  );
  for (const p of [page, reviewer])
    await expect(renderedDocument(p).locator("#tail")).toHaveText(
      "Clients retry twice before giving in up.",
    );
  await reviewer.context().close();
});

test.describe("formatting", () => {
  test("the Bold button of the selection actions makes the words bold", async ({
    page,
    slashdocs,
  }) => {
    const html = documentHTML();
    const document = await slashdocs.createDocument(uniqueName("Bold button"), html);

    await openEditable(page, document.id);
    await placeCaret(page, "#tail", "twice");
    const bold = renderedDocument(page).getByRole("button", { name: "Bold" });
    await bold.click();
    await expect(bold).toHaveAttribute("aria-pressed", "true");
    await saved(
      page,
      document.id,
      html.replace("retry twice", "retry <strong>twice</strong>"),
    );
  });

  test("Cmd or Ctrl+B at a caret makes the next typed words bold", async ({
    page,
    slashdocs,
  }) => {
    const html = documentHTML();
    const document = await slashdocs.createDocument(uniqueName("Bold caret"), html);

    await openEditable(page, document.id);
    await placeCaret(page, "#tail", "retry ", { collapse: true });
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.type("only");
    await saved(
      page,
      document.id,
      html.replace("retry twice", "retry <strong>only</strong>twice"),
    );
  });

  test("Cmd or Ctrl+K in a link shows its address, and Remove link takes it off", async ({
    page,
    slashdocs,
  }) => {
    const html = documentHTML();
    const linked = html.replace(
      "this guide",
      '<a href="https://example.com/guide">this guide</a>',
    );
    const document = await slashdocs.createDocument(uniqueName("Link"), linked);

    await openEditable(page, document.id);
    await placeCaret(page, "#intro a", "this", { collapse: true });
    await page.keyboard.press("ControlOrMeta+k");
    const field = renderedDocument(page).getByRole("textbox", { name: "Link address" });
    await expect(field).toHaveValue("https://example.com/guide");
    await renderedDocument(page).getByRole("button", { name: "Remove link" }).click();
    await expect(field).toHaveCount(0);

    // The text around the link joins into one, which spells é as it shows.
    await saved(page, document.id, html.replace("Caf&eacute;", "Café"));
  });

  test("a numbered list that Enter splits keeps its numbers", async ({
    page,
    slashdocs,
  }) => {
    const html = documentHTML().replace(
      "</body>",
      "<ol><li>Plan</li><li>Build</li><li>Ship</li></ol>\n  </body>",
    );
    const document = await slashdocs.createDocument(uniqueName("Numbers"), html);

    await openEditable(page, document.id);
    await placeCaret(page, "ol li", "Build", { nth: 1, collapse: true });
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");

    await expect
      .poll(() => latestSource(page, document.id))
      .toContain('<ol start="3"><li>Ship</li></ol>');
    await page.reload();
    await expect(renderedDocument(page).locator("ol").nth(1)).toHaveAttribute(
      "start",
      "3",
    );
  });
});

test.describe("saving", () => {
  // A status and a script that show text from one string each.
  const scriptHTML = () =>
    documentHTML().replace(
      "</body>",
      `<p>State: <span class="badge">Pending</span></p>
      <p>Build health: <b id="health"></b></p>
      <p id="incidents"></p>
      <script>
        const HEALTH = "Green";
        document.getElementById("health").textContent = HEALTH;
        document.getElementById("incidents").textContent = "Open incidents: 3";
      </script>
    </body>`,
    );

  test("deleting all the text of a badge and typing keeps the badge", async ({
    page,
    slashdocs,
  }) => {
    const html = scriptHTML();
    const document = await slashdocs.createDocument(uniqueName("Badge"), html);

    await openEditable(page, document.id);
    await placeCaret(page, ".badge", "Pending", { collapse: true });
    for (let i = 0; i < "Pending".length; i++) await page.keyboard.press("Backspace");
    await page.keyboard.type("Done");
    await saved(page, document.id, html.replace(">Pending<", ">Done<"));
  });

  test("deleting all of a script text and typing keeps the element and the script", async ({
    page,
    slashdocs,
  }) => {
    const html = scriptHTML();
    const document = await slashdocs.createDocument(uniqueName("Health"), html);

    await openEditable(page, document.id);
    const health = renderedDocument(page).locator("#health");
    await health.click();
    await expect(health).toHaveAttribute("contenteditable", "true");
    await placeCaret(page, "#health", "Green", { collapse: true });
    for (let i = 0; i < "Green".length; i++) await page.keyboard.press("Backspace");
    await page.keyboard.type("Amber");
    await saved(page, document.id, html.replace('"Green"', '"Amber"'));
    await page.reload();
    await expect(renderedDocument(page).locator("#health")).toHaveText("Amber");
    await expect(renderedDocument(page).locator("#incidents")).toHaveText(
      "Open incidents: 3",
    );
  });

  test("a refused script edit stays on screen as not saved", async ({
    page,
    slashdocs,
  }) => {
    const html = documentHTML().replace(
      "</body>",
      `<p id="state"></p>
      <script>
        const STATE = "Ready";
        document.getElementById("state").textContent =
          STATE.length === 5 ? STATE : STATE.toUpperCase();
      </script>
    </body>`,
    );
    // The script shows a string of another length in capitals.
    const document = await slashdocs.createDocument(uniqueName("Refused"), html);

    await openEditable(page, document.id);
    const state = renderedDocument(page).locator("#state");
    await state.click();
    await expect(state).toHaveAttribute("contenteditable", "true");
    await placeCaret(page, "#state", "Ready");
    await page.keyboard.type("Done");
    await expect(notSaved(page)).toBeVisible();
    await expect(page.getByRole("button", { name: "Discard my change" })).toBeVisible();
    const unchanged = await slashdocs.getDocument(document.id);
    expect(unchanged.current_version_id).toBe(document.current_version_id);
  });

  test("browser Back while keys wait for a slow save keeps the edit", async ({
    page,
    slashdocs,
  }) => {
    const html = documentHTML();
    const title = uniqueName("Back");
    const document = await slashdocs.createDocument(title, html);

    // The document opens from the list, so that Back is a move in the app.
    await page.goto("/app/documents");
    await page.getByRole("link", { name: title }).first().click();
    await startEditing(page);
    // The first key is on its way for a long time, so the next keys wait.
    await page.route("**/ops", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await placeCaret(page, "#tail", "twice");
    await page.keyboard.type("thrice", { delay: 30 });
    // The frame gives its draft to the page a moment after the last key.
    await page.waitForTimeout(300);
    await page.goBack();
    await expect(page).toHaveURL(/\/app\/documents$/);

    await saved(page, document.id, html.replace("twice", "thrice"));
  });

  test("a line break at the end of a paragraph stays after a reload", async ({
    page,
    slashdocs,
  }) => {
    const html = documentHTML();
    const document = await slashdocs.createDocument(uniqueName("Break"), html);

    await openEditable(page, document.id);
    await placeCaret(page, "#tail", "giving up.", { collapse: true });
    await page.keyboard.press("Shift+Enter");
    await saved(
      page,
      document.id,
      html.replace("giving up.</p>", "giving up.<br><br></p>"),
    );
  });

  test("a script string in several places warns first, and its save keeps the place", async ({
    page,
    slashdocs,
  }) => {
    const html = documentHTML().replace(
      "</body>",
      `<div style="height:2000px"></div>
      <div id="chips"></div>
      <script>
        const LABEL = "Needs review";
        for (const n of [1, 2, 3]) {
          const chip = document.createElement("b");
          chip.textContent = LABEL;
          document.getElementById("chips").appendChild(chip);
        }
      </script>
    </body>`,
    );
    const document = await slashdocs.createDocument(uniqueName("Places"), html);

    await openEditable(page, document.id);
    const chips = renderedDocument(page).locator("#chips b");
    await chips.nth(1).click();
    await expect(
      renderedDocument(page).getByText(
        "This text shows in 3 places. Your change goes to all of them.",
      ),
    ).toBeVisible();
    const top = await chips.nth(1).evaluate(() => window.scrollY);
    expect(top).toBeGreaterThan(0);
    await placeCaret(page, "#chips b", "review", { nth: 1 });
    await page.keyboard.type("a look");

    await expect(chips).toHaveText(["Needs a look", "Needs a look", "Needs a look"]);
    // The frame did not load again: the scroll and the caret stay.
    expect(await chips.nth(1).evaluate(() => window.scrollY)).toBe(top);
    expect(
      await chips
        .nth(1)
        .evaluate((chip) =>
          chip.contains(chip.ownerDocument.getSelection()!.anchorNode),
        ),
    ).toBe(true);

    // A typo and its fix save, and every place shows the saved text.
    await page.keyboard.type("x");
    await expect(chips).toHaveText(["Needs a lookx", "Needs a lookx", "Needs a lookx"]);
    await saved(page, document.id, html.replace("Needs review", "Needs a lookx"));
    await page.keyboard.press("Backspace");
    await expect(chips).toHaveText(["Needs a look", "Needs a look", "Needs a look"]);
    await saved(page, document.id, html.replace("Needs review", "Needs a look"));

    // Another place is the same string, so the reader can type there too.
    await chips.nth(0).click();
    await expect(
      renderedDocument(page).getByText("A script on the page writes this text."),
    ).toHaveCount(0);
    await placeCaret(page, "#chips b", "look", { nth: 0, collapse: true });
    await page.keyboard.type("s");
    await expect(chips).toHaveText(["Needs a looks", "Needs a looks", "Needs a looks"]);
    await saved(page, document.id, html.replace("Needs review", "Needs a looks"));
  });

  test("Esc in the text leaves Edit mode and keeps the page", async ({
    page,
    slashdocs,
  }) => {
    const document = await slashdocs.createDocument(uniqueName("Esc"), documentHTML());

    await page.goto(`/app/d/${document.id}`);
    for (let i = 0; i < 3; i++) {
      await startEditing(page);
      await renderedDocument(page).locator("#tail").click();
      await page.keyboard.press("Escape");
      await expect(
        page.getByRole("button", { name: "Edit", exact: true }),
      ).toBeVisible();
    }
    await expect(page).toHaveURL(new RegExp(`/app/d/${document.id}`));
    await expect(renderedDocument(page).locator("#tail")).toBeVisible();
  });
});
