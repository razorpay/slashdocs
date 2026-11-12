import { type Browser, type Page } from "@playwright/test";
import {
  expect,
  latestSource,
  openHistory,
  renderedDocument,
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
  await expect(
    history.getByText(/^(admin and reviewer|reviewer and admin)$/),
  ).toBeVisible();
  await expect(history.getByRole("button", { name: /earlier edit/ })).toHaveCount(0);
  await shot(page, "03-history-one-entry");
  await page.keyboard.press("Escape");

  // An agent pushes in the middle of the sitting, and the reviewer types on.
  // History shows one row for the sitting, as the newest, and one row for
  // the push under it.
  const pushed = (await latestSource(page, document.id)).replace(
    "Section 6 holds the notes of the team.",
    "Section 6 holds the notes of the agent.",
  );
  await slashdocs.pushVersion(document.id, pushed);
  await expect(renderedDocument(reviewer).locator("#s6")).toContainText("agent");
  await reviewer.keyboard.type(" and July", { delay: 60 });
  await expect
    .poll(() => latestSource(page, document.id))
    .toContain("in June and July.");
  await openHistory(page);
  const rows = history.getByRole("button").filter({ hasText: "admin" });
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText(/admin and reviewer|reviewer and admin/);
  await expect(rows.nth(0)).toContainText("Current");
  await expect(rows.nth(1)).toContainText("agent");
  await reviewer.context().close();
});

// Both people type fast, with no pause, so each operation of one meets the
// operations of the other. The words of each person stay whole and in their order. At one
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
    // The reviewer starts after the first operation of the admin reaches the
    // server, and types while the admin types on.
    const first = page.keyboard.type(FIRST, { delay: 25 });
    await page.waitForResponse((r) => r.url().endsWith("/ops"));
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

test("two people start a sentence at one caret at the same moment, and each sentence stays whole", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Coedit caret");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.shareWithAnyone(document.id, "editor");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reviewer = await reviewerOn(browser, path);
  await expect(page.getByRole("button", { name: /^reviewer/ })).toBeVisible();
  await startEditing(page);
  await startEditing(reviewer);

  // Each sentence starts with a space, so the first keys of the two people
  // are equal characters at one place. Each key comes as a person types it.
  const type = async (p: Page, text: string, pause: number) => {
    for (const key of text) {
      await p.keyboard.type(key);
      await p.waitForTimeout(pause);
    }
  };
  await placeCaret(page, "#shared", "starts here");
  await placeCaret(reviewer, "#shared", "starts here");
  await Promise.all([type(page, " Me too.", 110), type(reviewer, " We agree.", 90)]);

  const either = (space: string) =>
    new RegExp(
      `^The plan starts here(${space}Me too\\.${space}We agree\\.|${space}We agree\\.${space}Me too\\.) and ends there\\.$`,
    );
  // A space that the browser shows at the end of a text is a no-break space
  // in the frame for a moment. The source has only spaces.
  for (const p of [page, reviewer])
    await expect(renderedDocument(p).locator("#shared")).toHaveText(either("\\s"));
  await expect
    .poll(
      async () =>
        (await latestSource(page, document.id)).match(/<p id="shared">(.*?)<\/p>/)?.[1],
    )
    .toMatch(either(" "));
  await reviewer.context().close();
});

// Both texts start with a space, so the first keys of the two people are
// equal characters at one place. Only the server knows whose each space is,
// and the next key of each person must go after the space of that person.
for (const gap of [30, 60, 90, 120])
  test(`two people type in turn at one caret, ${gap} ms apart, and the text of each stays whole`, async ({
    page,
    browser,
    slashdocs,
  }) => {
    const title = uniqueName("Coedit turns");
    const document = await slashdocs.createDocument(title, documentHTML(title));
    await slashdocs.shareWithAnyone(document.id, "editor");
    const path = `/app/d/${document.id}`;
    await page.goto(path);
    const reviewer = await reviewerOn(browser, path);
    await expect(page.getByRole("button", { name: /^reviewer/ })).toBeVisible();
    await startEditing(page);
    await startEditing(reviewer);

    await placeCaret(page, "#shared", "starts here");
    await placeCaret(reviewer, "#shared", "starts here");
    // A key of the admin, at once a key of the reviewer, then a pause.
    const [mine, theirs] = [" AAAA one", " RRRR two"];
    for (let i = 0; i < mine.length; i++) {
      await page.keyboard.type(mine[i]);
      await reviewer.keyboard.type(theirs[i]);
      await page.waitForTimeout(gap);
    }

    const either = (space: string) =>
      new RegExp(
        `^The plan starts here(${space}AAAA one${space}RRRR two|${space}RRRR two${space}AAAA one)${space}and ends there\\.$`,
      );
    for (const p of [page, reviewer])
      await expect(renderedDocument(p).locator("#shared")).toHaveText(either("\\s"));
    await expect
      .poll(
        async () =>
          (await latestSource(page, document.id)).match(
            /<p id="shared">(.*?)<\/p>/,
          )?.[1],
      )
      .toMatch(either(" "));
    await reviewer.context().close();
  });

// The admin removes the text of a paragraph while the reviewer types in it.
// The keys that the admin did not see stay, whole and in their order, at
// the place of the removed text, and the next keys of the reviewer go after
// them.
test("a person who types in a paragraph that another person empties keeps their text in order", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Coedit delete");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.shareWithAnyone(document.id, "editor");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reviewer = await reviewerOn(browser, path);
  await expect(page.getByRole("button", { name: /^reviewer/ })).toBeVisible();
  await startEditing(page);
  await startEditing(reviewer);

  const typed = " REVIEWER-IN-DOOMED-PARA";
  await placeCaret(reviewer, "#s2", "Section 2 holds");
  const typing = reviewer.keyboard.type(typed, { delay: 60 });
  await page.waitForTimeout(300);
  await renderedDocument(page)
    .locator("#s2")
    .evaluate((element) => {
      const d = element.ownerDocument;
      d.body.focus();
      d.getSelection()!.selectAllChildren(element);
    });
  await page.keyboard.press("Backspace");
  await typing;

  // The admin removed the keys that they saw: the rest of the text stays.
  const text = async (p: Page) =>
    (await renderedDocument(p).locator("#s2").textContent())?.trim();
  await expect.poll(() => text(reviewer)).not.toContain("Section 2");
  await expect.poll(() => text(page)).toBe(await text(reviewer));
  const rest = (await text(reviewer)) ?? "";
  expect(rest).not.toBe("");
  expect(typed.endsWith(rest), rest).toBe(true);
  await expect.poll(() => latestSource(page, document.id)).toContain(rest);
  await reviewer.context().close();
});

// paragraphsHTML gives a document with a paragraph for each text, with the
// ids b, c, d and on.
function paragraphsHTML(title: string, ...texts: string[]) {
  const body = texts.map((text, i) => `<p id="${"bcdefg"[i]}">${text}</p>`).join("\n");
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
<h1>${title}</h1>
${body}
  </body>
</html>`;
}

// tagsWhole tells whether each tag of html ends before the next one starts.
const tagsWhole = (html: string) => !/<[a-zA-Z/!?][^>]*</.test(html);

// selectNode selects all of an element, with its tags.
const selectNode = (page: Page, selector: string) =>
  renderedDocument(page)
    .locator(selector)
    .evaluate((element) => {
      const d = element.ownerDocument;
      const range = d.createRange();
      range.selectNode(element);
      d.body.focus();
      d.getSelection()!.removeAllRanges();
      d.getSelection()!.addRange(range);
    });

// Each removal has the texts that the document then holds. The keys of the
// person stay in their paragraph, which the removal keeps for them, and
// their last key "Z" goes there too.
const removals: [string, (reviewer: Page) => Promise<void>, string[]][] = [
  [
    "removes the paragraph",
    async (reviewer) => {
      await selectNode(reviewer, "#c");
      await reviewer.keyboard.press("Delete");
    },
    ["Z"],
  ],
  [
    "removes all the text and types",
    async (reviewer) => {
      await placeCaret(reviewer, "#d", "After");
      await reviewer.keyboard.press("ControlOrMeta+a");
      await reviewer.keyboard.press("Delete");
      await reviewer.keyboard.type("fresh", { delay: 30 });
    },
    ["fresh", "Z"],
  ],
];
for (const [name, remove, held] of removals) {
  test(`a person who types while another person ${name} keeps the later keys as text, out of the tags`, async ({
    page,
    browser,
    slashdocs,
  }) => {
    const title = uniqueName("Coedit remove");
    const html = paragraphsHTML(title, "Before.", "Third paragraph here.", "After.");
    const document = await slashdocs.createDocument(title, html);
    await slashdocs.shareWithAnyone(document.id, "editor");
    const path = `/app/d/${document.id}`;
    await page.goto(path);
    const reviewer = await reviewerOn(browser, path);
    await expect(page.getByRole("button", { name: /^reviewer/ })).toBeVisible();
    await startEditing(page);
    await startEditing(reviewer);

    await placeCaret(page, "#c", "Third");
    const typing = page.keyboard.type(" mid", { delay: 100 });
    await page.waitForTimeout(150);
    await remove(reviewer);
    await typing;
    await page.keyboard.type("Z");

    // The keys stay in the paragraph of the person, and the two pages show
    // the same text. The page that removed all the text can keep the
    // <br> of its empty block after the text that it typed, which shows no
    // line: empty lines do not count.
    const text = async (p: Page) =>
      (await renderedDocument(p).locator("body").innerText()).replace(/\n+/g, "\n");
    for (const part of held) {
      await expect.poll(() => text(reviewer)).toContain(part);
      await expect.poll(() => latestSource(page, document.id)).toContain(part);
    }
    await expect.poll(() => text(page)).toBe(await text(reviewer));
    const source = await latestSource(page, document.id);
    expect(tagsWhole(source), source).toBe(true);
    for (const [, id] of source.matchAll(/ id="([^"]*)"/g))
      expect(["b", "c", "d"], source).toContain(id);
    await reviewer.context().close();
  });
}

// bareText tells whether the body holds text outside its elements.
const bareText = (page: Page) =>
  renderedDocument(page)
    .locator("body")
    .evaluate((body) =>
      Array.from(body.childNodes).some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim(),
      ),
    );

test("a person who types while another person deletes all the text keeps the text in its paragraph", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Coedit select all");
  const html = paragraphsHTML(title, "Before.", "Third paragraph here.", "After.");
  const document = await slashdocs.createDocument(title, html);
  await slashdocs.shareWithAnyone(document.id, "editor");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reviewer = await reviewerOn(browser, path);
  await expect(page.getByRole("button", { name: /^reviewer/ })).toBeVisible();
  await startEditing(page);
  await startEditing(reviewer);

  await placeCaret(page, "#c", "here");
  const typing = page.keyboard.type(" typing on", { delay: 100 });
  await page.waitForTimeout(150);
  await placeCaret(reviewer, "#d", "After");
  await reviewer.keyboard.press("ControlOrMeta+a");
  await reviewer.keyboard.press("Delete");
  await typing;

  // The select-all leaves the heading empty. The text of the person stays
  // in their paragraph, in both frames, and after a load.
  for (const p of [page, reviewer]) {
    await expect(renderedDocument(p).locator("p#c")).toHaveText(/ping on$/);
    await expect(renderedDocument(p).locator("#b, #d")).toHaveCount(0);
    expect(await bareText(p)).toBe(false);
  }
  await expect
    .poll(() => latestSource(page, document.id))
    .toMatch(/<h1><\/h1>\s*<p id="c">[^<]*ping on<\/p>/);
  await page.reload();
  await expect(renderedDocument(page).locator("p#c")).toHaveText(/ping on$/);
  expect(await bareText(page)).toBe(false);
  await reviewer.context().close();
});

test("a person whose paragraph another person removes types on after their own text", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Coedit replace");
  const html = paragraphsHTML(
    title,
    "Top line.",
    "Middle line.",
    "Lower line.",
    "Bottom line.",
  );
  const document = await slashdocs.createDocument(title, html);
  await slashdocs.shareWithAnyone(document.id, "editor");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reviewer = await reviewerOn(browser, path);
  await expect(page.getByRole("button", { name: /^reviewer/ })).toBeVisible();
  await startEditing(page);
  await startEditing(reviewer);

  await placeCaret(page, "#c", "Middle");
  const typing = page.keyboard.type(" typing", { delay: 100 });
  await page.waitForTimeout(250);
  // The reviewer types over the first three paragraphs.
  await renderedDocument(reviewer)
    .locator("#b")
    .evaluate((element) => {
      const d = element.ownerDocument;
      const last = d.querySelector("#d")!.firstChild as Text;
      d.body.focus();
      d.getSelection()!.setBaseAndExtent(element.firstChild!, 0, last, last.length);
    });
  await reviewer.keyboard.press("Backspace");
  await reviewer.keyboard.type("R");
  await typing;
  await page.keyboard.type("Z");

  // The merge keeps the rest of the typing in the first paragraph, and the
  // last key goes after it, not into the next paragraph.
  for (const p of [page, reviewer]) {
    await expect(renderedDocument(p).locator("#b")).toHaveText(/^R.*Z$/);
    await expect(renderedDocument(p).locator("#e")).toHaveText("Bottom line.");
  }
  await expect
    .poll(() => latestSource(page, document.id))
    .toMatch(/<p id="b">R[^<]*Z<\/p>/);
  await reviewer.context().close();
});

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

test("a push of a few words goes in, and one that rewrites what the reader reads waits behind the banner", async ({
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

  // An agent writes again the sections that the reader looks at: the reader
  // stays on what they read, and the banner offers the new text.
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

// The place of an element on the screen of the reader.
const topOf = async (page: Page, selector: string) =>
  Math.round((await renderedDocument(page).locator(selector).boundingBox())!.y);

test("a push that changes nothing in the reader's view goes in with no banner, far below or above", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Coedit view");
  const html = documentHTML(title, 40);
  const document = await slashdocs.createDocument(title, html);
  await slashdocs.shareWithAnyone(document.id, "viewer");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reader = await reviewerOn(browser, path);
  await expect(renderedDocument(reader).locator("#shared")).toBeVisible();
  await mark(reader);
  const banner = reader.getByRole("button", { name: "Show the latest" });

  // The reader is at the top. An agent writes the last twenty sections
  // again: a large change, but none of it is in the view.
  let next = html;
  for (let i = 21; i <= 40; i++)
    next = next.replace(
      `Section ${i} holds the notes of the team.`,
      `Section ${i} now lists every open decision, its owner, and the date.`,
    );
  await slashdocs.pushVersion(document.id, next);
  await expect(renderedDocument(reader).locator("#s40")).toHaveText(
    "Section 40 now lists every open decision, its owner, and the date.",
  );
  await expect(banner).toHaveCount(0);
  expect(await kept(reader)).toBe("yes");

  // The reader reads section 30. An agent adds three paragraphs at the top.
  // The page is longer above the reader, and their text stays where it is.
  await renderedDocument(reader)
    .locator("#s30")
    .evaluate((el) => el.scrollIntoView({ block: "center" }));
  const before = await topOf(reader, "#s30");
  await shot(reader, "11-reader-at-section-30");
  next = next.replace(
    '<p id="shared">',
    '<p id="n1">A new first paragraph.</p>\n    <p id="n2">A new second paragraph.</p>\n    <p id="n3">A new third paragraph.</p>\n    <p id="shared">',
  );
  await slashdocs.pushVersion(document.id, next);
  await expect(renderedDocument(reader).locator("#n3")).toHaveText(
    "A new third paragraph.",
  );
  await expect(banner).toHaveCount(0);
  expect(Math.abs((await topOf(reader, "#s30")) - before)).toBeLessThanOrEqual(2);
  expect(await kept(reader)).toBe("yes");
  await shot(reader, "12-new-text-above-reader-stays-still");

  // An agent adds four paragraphs in the middle of what the reader reads.
  // They would move the rest of the view, so the change waits. The banner
  // pushes the document down by its height.
  next = next.replace(
    '<p id="s30">',
    [4, 5, 6, 7]
      .map((n) => `<p id="n${n}">Paragraph ${n} that an agent adds right here.</p>`)
      .join("\n    ") + '\n    <p id="s30">',
  );
  await slashdocs.pushVersion(document.id, next);
  await expect(banner).toBeVisible();
  await expect(renderedDocument(reader).locator("#n4")).toHaveCount(0);
  const room = (await reader.getByRole("status").filter({ has: banner }).boundingBox())!
    .height;
  expect(Math.abs((await topOf(reader, "#s30")) - before - room)).toBeLessThanOrEqual(
    2,
  );
  await shot(reader, "13-change-in-view-waits");
  await reader.context().close();
});

test("a push that changes only styles goes in with no banner unless it moves what the reader reads", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Coedit styles");
  const html = documentHTML(title, 40).replace(
    "</title>",
    "</title><style>p { color: rgb(0, 0, 0); }</style>",
  );
  const document = await slashdocs.createDocument(title, html);
  await slashdocs.shareWithAnyone(document.id, "viewer");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reader = await reviewerOn(browser, path);
  await expect(renderedDocument(reader).locator("#shared")).toBeVisible();
  await mark(reader);
  const banner = reader.getByRole("button", { name: "Show the latest" });
  const s30 = renderedDocument(reader).locator("#s30");
  await s30.evaluate((el) => el.scrollIntoView({ block: "center" }));
  const before = await topOf(reader, "#s30");
  const restyle = async (css: string) => {
    const source = await latestSource(page, document.id);
    await slashdocs.pushVersion(
      document.id,
      source.replace(/<style>.*<\/style>/, `<style>${css}</style>`),
    );
  };

  // An agent changes a color: it goes in, and nothing moves.
  await restyle("p { color: rgb(200, 0, 0); }");
  await expect(s30).toHaveCSS("color", "rgb(200, 0, 0)");
  await expect(banner).toHaveCount(0);
  expect(await topOf(reader, "#s30")).toBe(before);
  expect(await kept(reader)).toBe("yes");

  // An agent makes the title above the view larger: the text of the reader
  // stays where it is.
  await restyle("p { color: rgb(200, 0, 0); } h1 { font-size: 120px; }");
  await expect(renderedDocument(reader).locator("h1")).toHaveCSS("font-size", "120px");
  await expect(banner).toHaveCount(0);
  expect(Math.abs((await topOf(reader, "#s30")) - before)).toBeLessThanOrEqual(2);

  // An agent makes the paragraph that the reader reads much larger. The
  // text after it would move, so the change waits.
  await restyle(
    "p { color: rgb(200, 0, 0); } h1 { font-size: 120px; } #s30 { font-size: 48px; }",
  );
  await expect(banner).toBeVisible();
  await expect(s30).toHaveCSS("font-size", "16px");
  await banner.click();
  await expect(s30).toHaveCSS("font-size", "48px");
  await expect(banner).toHaveCount(0);

  // An agent makes all the text larger: the view of the reader cannot stay.
  await restyle("body { font-size: 24px; } p { color: rgb(200, 0, 0); }");
  await expect(banner).toBeVisible();
  await expect(renderedDocument(reader).locator("#s29")).toHaveCSS("font-size", "16px");
  await banner.click();
  await expect(renderedDocument(reader).locator("#s29")).toHaveCSS("font-size", "24px");
  expect(await kept(reader)).toBe("yes");
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
  // After some seconds the bar says why the text does not reach the server.
  const offline = page.getByText("Offline", { exact: true });
  await expect(offline).toBeVisible({ timeout: 15_000 });
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
  await expect(offline).toBeHidden();
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
  // Each group of words goes to the server as the reviewer types it, and the
  // reader gets it in place.
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

// An agent writes again the sections that a reader of documentHTML reads.
const rewritten = (html: string) =>
  html.replaceAll(
    "holds the notes of the team.",
    "now lists every open decision, its owner, and the date that the team set for it.",
  );

test("a reader sees the typing of another person live while a push waits behind the banner", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Coedit typing behind banner");
  const html = documentHTML(title, 12);
  const document = await slashdocs.createDocument(title, html);
  await slashdocs.shareWithAnyone(document.id, "viewer");
  const path = `/app/d/${document.id}`;
  await page.goto(path);
  const reader = await reviewerOn(browser, path);
  const text = renderedDocument(reader);
  await expect(text.locator("#shared")).toBeVisible();
  await mark(reader);
  const banner = reader.getByRole("button", { name: "Show the latest" });

  await slashdocs.pushVersion(document.id, rewritten(html));
  await expect(banner).toBeVisible();

  // The admin types above the sections that wait. The reader sees the
  // typing at once, and the push still waits.
  await startEditing(page);
  await expect(renderedDocument(page).locator("#s1")).toHaveText(/now lists/);
  await placeCaret(page, "#shared", "starts here");
  await page.keyboard.type(", today", { delay: 40 });
  await expect(text.locator("#shared")).toHaveText(
    "The plan starts here, today and ends there.",
  );
  await expect(banner).toBeVisible();
  await expect(text.locator("#s1")).toHaveText(
    "Section 1 holds the notes of the team.",
  );
  expect(await kept(reader)).toBe("yes");
  await shot(reader, "14-typing-behind-banner");

  // The reader asks for the latest: the push goes in around the typing.
  await banner.click();
  await expect(text.locator("#s1")).toHaveText(
    "Section 1 now lists every open decision, its owner, and the date that the team set for it.",
  );
  await expect(text.locator("#shared")).toHaveText(
    "The plan starts here, today and ends there.",
  );
  await expect(banner).toHaveCount(0);
  expect(await kept(reader)).toBe("yes");
  await reader.context().close();
});

test("a word that one person types and takes out again goes out of the frames of an editor and a reader, with no load", async ({
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
  // The admin reads in a second tab, and the reviewer edits.
  const reader = await page.context().newPage();
  await reader.goto(`/app/d/${document.id}`);
  await startEditing(reviewer);
  await startEditing(page);
  for (const p of [reader, reviewer]) await mark(p);

  await placeCaret(page, "#shared", "starts here");
  await page.keyboard.type(" brave", { delay: 40 });
  for (const p of [reader, reviewer])
    await expect(renderedDocument(p).locator("#shared")).toHaveText(
      "The plan starts here brave and ends there.",
    );
  for (let i = 0; i < " brave".length; i++) await page.keyboard.press("Backspace");

  const loaded = "The plan starts here and ends there.";
  await expect.poll(() => latestSource(page, document.id)).toBe(html);
  for (const p of [page, reader, reviewer]) {
    await expect(renderedDocument(p).locator("#shared")).toHaveText(loaded);
    if (p !== page) expect(await kept(p)).toBe("yes");
  }
  await reader.close();
  await reviewer.context().close();
});
