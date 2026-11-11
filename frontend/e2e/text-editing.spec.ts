import { type FrameLocator, type Page } from "@playwright/test";
import {
  expect,
  notSaved,
  openEditable,
  openHistory,
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
  // A load of a frame removes this mark.
  const body = (tab: Page) => renderedDocument(tab).locator("body");
  for (const tab of [page, other])
    await body(tab).evaluate((el) => void (el.dataset.e2eKept = "yes"));

  const first = nextSave(page, document.id);
  await placeCaret(page, "#tail", "twice");
  await page.keyboard.type("three times");
  expect((await first).status()).toBe(201);

  const second = nextSave(other, document.id);
  await placeCaret(other, "#intro", "keep it");
  await other.keyboard.type("share it");
  expect((await second).status()).toBe(201);

  expect(await latestSource(page, document.id)).toBe(
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
  await expect(notSaved(page)).toBeHidden();
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
  await openHistory(page);
  const history = page.getByRole("dialog");
  await history.getByRole("button", { name: "Show 2 earlier edits" }).click();
  await history
    .getByRole("button", { name: /Changed “twice” to “three times”/ })
    .click();
  await expect(renderedDocument(page).locator("#tail")).toHaveText(
    "Clients retry three times before giving up.",
  );
  await openHistory(page);
  await history.getByRole("button", { name: "Show 2 earlier edits" }).click();
  await history.getByRole("button", { name: /Created/ }).click();
  await expect(page.getByText("This is the document as it was")).toBeVisible();

  await page.getByRole("button", { name: "Restore" }).click();
  await expect(page.getByText(/^Restored an earlier version of/)).toBeVisible();
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

test.describe("formatting", () => {
  test("the Bold button of the selection actions makes the words bold", async ({
    page,
    slashdocs,
  }) => {
    const html = documentHTML();
    const document = await slashdocs.createDocument(uniqueName("Bold button"), html);

    await openEditable(page, document.id);
    const saved = nextSave(page, document.id);
    await placeCaret(page, "#tail", "twice");
    const bold = renderedDocument(page).getByRole("button", { name: "Bold" });
    await bold.click();
    await expect(bold).toHaveAttribute("aria-pressed", "true");
    expect((await saved).status()).toBe(201);

    expect(await latestSource(page, document.id)).toBe(
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
    const saved = nextSave(page, document.id);
    await placeCaret(page, "#tail", "retry ", { collapse: true });
    await page.keyboard.press("ControlOrMeta+b");
    await page.keyboard.type("only");
    expect((await saved).status()).toBe(201);

    await expect
      .poll(() => latestSource(page, document.id))
      .toBe(html.replace("retry twice", "retry <strong>only</strong>twice"));
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
    const saved = nextSave(page, document.id);
    await placeCaret(page, "#intro a", "this", { collapse: true });
    await page.keyboard.press("ControlOrMeta+k");
    const field = renderedDocument(page).getByRole("textbox", { name: "Link address" });
    await expect(field).toHaveValue("https://example.com/guide");
    await renderedDocument(page).getByRole("button", { name: "Remove link" }).click();
    await expect(field).toHaveCount(0);
    expect((await saved).status()).toBe(201);

    // The text around the link joins into one, which spells é as it shows.
    expect(await latestSource(page, document.id)).toBe(
      html.replace("Caf&eacute;", "Café"),
    );
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
    const saved = nextSave(page, document.id);
    await placeCaret(page, "ol li", "Build", { nth: 1, collapse: true });
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    expect((await saved).status()).toBe(201);

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
    const saved = nextSave(page, document.id);
    await placeCaret(page, ".badge", "Pending", { collapse: true });
    for (let i = 0; i < "Pending".length; i++) await page.keyboard.press("Backspace");
    await page.keyboard.type("Done");
    expect((await saved).status()).toBe(201);

    await expect
      .poll(() => latestSource(page, document.id))
      .toBe(html.replace(">Pending<", ">Done<"));
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
    const saved = nextSave(page, document.id);
    await placeCaret(page, "#health", "Green", { collapse: true });
    for (let i = 0; i < "Green".length; i++) await page.keyboard.press("Backspace");
    await page.keyboard.type("Amber");
    expect((await saved).status()).toBe(201);

    expect(await latestSource(page, document.id)).toBe(
      html.replace('"Green"', '"Amber"'),
    );
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

  test("browser Back before the pause keeps the edit", async ({ page, slashdocs }) => {
    const html = documentHTML();
    const title = uniqueName("Back");
    const document = await slashdocs.createDocument(title, html);

    // The document opens from the list, so that Back is a move in the app.
    await page.goto("/app/documents");
    await page.getByRole("link", { name: title }).first().click();
    await startEditing(page);
    const saved = nextSave(page, document.id);
    await placeCaret(page, "#tail", "twice");
    await page.keyboard.type("thrice");
    await page.waitForTimeout(300);
    await page.goBack();
    expect((await saved).status()).toBe(201);

    expect(await latestSource(page, document.id)).toBe(html.replace("twice", "thrice"));
  });

  test("a line break at the end of a paragraph stays after a reload", async ({
    page,
    slashdocs,
  }) => {
    const html = documentHTML();
    const document = await slashdocs.createDocument(uniqueName("Break"), html);

    await openEditable(page, document.id);
    const saved = nextSave(page, document.id);
    await placeCaret(page, "#tail", "giving up.", { collapse: true });
    await page.keyboard.press("Shift+Enter");
    expect((await saved).status()).toBe(201);

    expect(await latestSource(page, document.id)).toBe(
      html.replace("giving up.</p>", "giving up.<br><br></p>"),
    );
  });

  test("edits far apart in a stale tab land with no conflict", async ({
    page,
    slashdocs,
  }) => {
    const html = documentHTML();
    const document = await slashdocs.createDocument(uniqueName("Far apart"), html);
    const other = await page.context().newPage();
    await openEditable(page, document.id);
    await openEditable(other, document.id);

    const first = nextSave(page, document.id);
    await placeCaret(page, ".card strong", "Try it.", { nth: 1 });
    await page.keyboard.type("Read it.");
    expect((await first).status()).toBe(201);

    // The stale tab changes text above and below that edit.
    const second = nextSave(other, document.id);
    await placeCaret(other, "#intro", "keep it");
    await other.keyboard.type("share it");
    await placeCaret(other, "#tail", "twice");
    await other.keyboard.type("thrice");
    expect((await second).status()).toBe(201);

    await expect
      .poll(() => latestSource(page, document.id))
      .toBe(
        html
          .replace("keep it", "share it")
          .replace("twice", "thrice")
          .replace(/Try it\.(?=<\/strong> Open the second)/, "Read it."),
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
    const saved = nextSave(page, document.id);
    await placeCaret(page, "#chips b", "review", { nth: 1 });
    await page.keyboard.type("a look");
    expect((await saved).status()).toBe(201);

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
    let next = nextSave(page, document.id);
    await page.keyboard.type("x");
    expect((await next).status()).toBe(201);
    await expect(chips).toHaveText(["Needs a lookx", "Needs a lookx", "Needs a lookx"]);
    next = nextSave(page, document.id);
    await page.keyboard.press("Backspace");
    expect((await next).status()).toBe(201);
    await expect(chips).toHaveText(["Needs a look", "Needs a look", "Needs a look"]);
    expect(await latestSource(page, document.id)).toContain('LABEL = "Needs a look"');

    // Another place is the same string, so the reader can type there too.
    await chips.nth(0).click();
    await expect(
      renderedDocument(page).getByText("A script on the page writes this text."),
    ).toHaveCount(0);
    next = nextSave(page, document.id);
    await placeCaret(page, "#chips b", "look", { nth: 0, collapse: true });
    await page.keyboard.type("s");
    expect((await next).status()).toBe(201);
    await expect(chips).toHaveText(["Needs a looks", "Needs a looks", "Needs a looks"]);
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
