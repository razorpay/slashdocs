import { type Locator, type Page } from "@playwright/test";
import {
  APP_ORIGIN,
  expect,
  openEditable,
  overlaps,
  paragraphsHTML,
  QUICK,
  renderedDocument,
  test,
  toastsOver,
  uniqueName,
} from "./fixtures";

// The layout around the document. An open thread keeps its paragraph above
// a comment sheet, while the sheet grows and shrinks, and the page glides
// back when the sheet closes. The document glides from under the Comments
// panel, and stays still while a composer opens. Toasts cover no thread and
// no heading.

async function addReplies(page: Page, docId: string, commentId: string, count: number) {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const reply = await page.request.post(
      `/v1/documents/${docId}/comments/${commentId}/replies`,
      {
        headers: { Origin: APP_ORIGIN },
        data: { body: `Reply ${i}. This reply gives the reviewer more context.` },
      },
    );
    expect(reply.ok()).toBe(true);
    ids.push((await reply.json()).id);
  }
  return ids;
}

async function deleteComments(page: Page, docId: string, ids: string[]) {
  for (const id of ids) {
    const deleted = await page.request.delete(`/v1/documents/${docId}/comments/${id}`, {
      headers: { Origin: APP_ORIGIN },
    });
    expect(deleted.ok()).toBe(true);
  }
}

// track gives the top of el on each frame until done settles, and then for
// 600 ms more.
function trackUntil(el: Locator, done: Promise<unknown>): Promise<number[]> {
  return el
    .evaluate(
      (node, wait) =>
        new Promise<number[]>((resolve) => {
          const tops: number[] = [];
          let end = Infinity;
          (window as unknown as { trackEnd: () => void }).trackEnd = () => {
            end = performance.now() + wait;
          };
          const step = () => {
            tops.push(node.getBoundingClientRect().top);
            if (performance.now() < end) requestAnimationFrame(step);
            else resolve(tops);
          };
          step();
        }),
      600,
    )
    .then(async (tops) => (await done, tops));
}

// track gives the top of el on each frame for ms, from now.
function trackFor(el: Locator, ms: number): Promise<number[]> {
  return el.evaluate(
    (node, ms) =>
      new Promise<number[]>((resolve) => {
        const tops: number[] = [];
        const end = performance.now() + ms;
        const step = () => {
          tops.push(node.getBoundingClientRect().top);
          if (performance.now() < end) requestAnimationFrame(step);
          else resolve(tops);
        };
        step();
      }),
    ms,
  );
}

// inRoom tells whether the page of el shows some of the room that a comment
// sheet leaves after its end.
function inRoom(el: Locator): Promise<boolean> {
  return el.evaluate((node) => {
    const root = node.ownerDocument.scrollingElement!;
    const room = parseFloat(getComputedStyle(root).paddingBottom);
    return root.scrollTop + root.clientHeight > root.scrollHeight - room + 1;
  });
}

// A centered column moves left from under the comments list, with no
// reflow, and a page with no margin to spare makes room beside the list.
function columnHTML(title: string, width: string) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title>
  <style>body{max-width:${width};margin:40px auto;font:16px/1.5 sans-serif}</style></head>
  <body><h1>${title}</h1><p id="text">${"Words of the page. ".repeat(40)}</p></body>
</html>`;
}

test("closing a long thread on the last paragraph of a phone page glides, not jumps", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Sheet end");
  const document = await slashdocs.createDocument(title, paragraphsHTML(title));
  const quote = `Paragraph 29. ${QUICK}`;
  const comment = await slashdocs.createComment(document.id, `On ${quote}`, { quote });
  await addReplies(page, document.id, comment.id, 10);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/d/${document.id}`);
  const last = renderedDocument(page).locator("#p29");
  await expect(last).toBeAttached();

  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByText(`On ${quote}`).click();
  const sheet = page.getByRole("dialog", { name: "Comment thread" });
  await expect(sheet.getByText("Reply 9.")).toBeAttached();
  await expect
    .poll(async () => {
      const top = (await sheet.boundingBox())!.y;
      const box = (await last.boundingBox())!;
      return box.y >= 0 && box.y + box.height <= top && (await inRoom(last));
    })
    .toBe(true);

  const tracked = trackFor(last, 900);
  await page.keyboard.press("Escape");
  const tops = await tracked;
  const steps = tops.slice(1).map((top, i) => Math.abs(top - tops[i]));
  // The page scrolls back over many frames, and no frame jumps.
  expect(Math.max(...steps)).toBeLessThan(150);
  await expect(sheet).toHaveCount(0);
  // It ends in the real page, with no room left after it.
  const end = await last.evaluate((p) => {
    const root = p.ownerDocument.scrollingElement!;
    return root.scrollHeight - root.clientHeight - root.scrollTop;
  });
  expect(end).toBeGreaterThanOrEqual(0);
  expect(end).toBeLessThan(2);
});

for (const reducedMotion of ["no-preference", "reduce"] as const)
  test(`at 390px, the paragraph of an open thread stays still while its replies go and come (${reducedMotion})`, async ({
    page,
    slashdocs,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 390, height: 844 });
    const title = uniqueName("Sheet shrink");
    const document = await slashdocs.createDocument(title, paragraphsHTML(title));
    const quote = `Paragraph 29. ${QUICK}`;
    const comment = await slashdocs.createComment(document.id, `On ${quote}`, {
      quote,
    });
    const replies = await addReplies(page, document.id, comment.id, 10);
    await page.goto(`/app/d/${document.id}?comment=${comment.id}`);
    const sheet = page.getByRole("dialog", { name: "Comment thread" });
    await expect(sheet.getByText("Reply 9.")).toBeAttached();
    const p29 = renderedDocument(page).locator("#p29");
    // The paragraph comes up above the sheet, and stays there.
    let last = NaN;
    await expect
      .poll(async () => {
        const box = (await p29.boundingBox())!;
        const still = Math.abs(box.y - last) < 1;
        last = box.y;
        return still && box.y + box.height <= (await sheet.boundingBox())!.y;
      })
      .toBe(true);

    const end = () =>
      p29.evaluate(() => (window as unknown as { trackEnd: () => void }).trackEnd());
    const removed = (async () => {
      await deleteComments(page, document.id, replies.slice(4));
      await expect(sheet.getByText("Reply 4.")).toHaveCount(0);
      await deleteComments(page, document.id, replies.slice(0, 4));
      await expect(sheet.getByText("Reply 0.")).toHaveCount(0);
      await end();
    })();
    const tops = await trackUntil(p29, removed);
    // No frame moves the paragraph.
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(2);
    const box = (await p29.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual((await sheet.boundingBox())!.y);

    // Replies that come back grow the sheet, and the paragraph stays clear of it.
    await addReplies(page, document.id, comment.id, 10);
    await expect(sheet.getByText("Reply 9.")).toBeAttached();
    await expect
      .poll(async () => {
        const box = (await p29.boundingBox())!;
        return box.y >= 0 && box.y + box.height <= (await sheet.boundingBox())!.y;
      })
      .toBe(true);
  });

test("a long thread opened from Comments on a phone keeps its paragraph above the sheet", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Long thread");
  const document = await slashdocs.createDocument(
    title,
    paragraphsHTML(title, { paragraphs: 12 }),
  );
  const quotes = [`Paragraph 4. ${QUICK}`, `Paragraph 11. ${QUICK}`];
  for (const quote of quotes) {
    const comment = await slashdocs.createComment(document.id, `On ${quote}`, {
      quote,
    });
    await addReplies(page, document.id, comment.id, 10);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await expect(doc.locator("#p4")).toBeVisible();
  // The last paragraph too: the page makes room to bring it up.
  for (const [quote, block] of [
    [quotes[0], "#p4"],
    [quotes[1], "#p11"],
  ]) {
    await page.getByRole("button", { name: "Comments", exact: true }).click();
    await page.getByText(`On ${quote}`).click();
    const sheet = page.getByRole("dialog", { name: "Comment thread" });
    await expect(sheet.getByText("Reply 9.")).toBeAttached();
    await expect
      .poll(async () => {
        const top = (await sheet.boundingBox())!.y;
        const box = (await doc.locator(block).boundingBox())!;
        return box.y >= 0 && box.y + box.height <= top;
      })
      .toBe(true);
    await page.keyboard.press("Escape");
    await expect(sheet).toHaveCount(0);
  }
});

test.describe("at 1440x900", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("the document glides from under the comments list when it has margin", async ({
    page,
    slashdocs,
  }) => {
    const title = uniqueName("Glide");
    const document = await slashdocs.createDocument(title, columnHTML(title, "760px"));
    await page.goto(`/app/d/${document.id}`);
    const frame = page.locator('iframe[title="Rendered document"]');
    const text = renderedDocument(page).locator("#text");
    await expect(text).toBeVisible();
    const [before, frameBefore] = [
      (await text.boundingBox())!,
      (await frame.boundingBox())!,
    ];

    await page.getByRole("button", { name: "Comments", exact: true }).click();
    const list = page.getByRole("dialog", { name: "Comments" });
    await expect(list).toBeVisible();
    await page.waitForTimeout(60);
    const midway = (await text.boundingBox())!;
    await page.waitForTimeout(400);
    const after = (await text.boundingBox())!;
    const listBox = (await list.boundingBox())!;

    // The words keep their lines: the frame keeps its width, and only moves.
    expect((await frame.boundingBox())!.width).toBe(frameBefore.width);
    expect(after.width).toBe(before.width);
    expect(after.x).toBeLessThan(before.x);
    expect(midway.x).toBeGreaterThan(after.x);
    expect(after.x + after.width).toBeLessThanOrEqual(listBox.x);

    await page.keyboard.press("Escape");
    await expect(list).toBeHidden();
    await expect.poll(async () => (await text.boundingBox())!.x).toBe(before.x);
  });

  test("a document with no margin to spare makes room beside the comments list", async ({
    page,
    slashdocs,
  }) => {
    const title = uniqueName("Crowded");
    const document = await slashdocs.createDocument(title, columnHTML(title, "none"));
    await page.goto(`/app/d/${document.id}`);
    const frame = page.locator('iframe[title="Rendered document"]');
    await expect(renderedDocument(page).locator("#text")).toBeVisible();
    const width = (await frame.boundingBox())!.width;

    await page.getByRole("button", { name: "Comments", exact: true }).click();
    const list = page.getByRole("dialog", { name: "Comments" });
    await expect(list).toBeVisible();
    await expect.poll(async () => (await frame.boundingBox())!.width).toBe(width - 392);
    expect((await frame.boundingBox())!.x).toBe(0);
  });
});

test("the document stays still while the comment composer opens", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Composer");
  // Short paragraphs in the full width, so that paragraph 12 is in view.
  const paragraphs = Array.from(
    { length: 30 },
    (_, i) => `<p id="p${i}">Paragraph ${i}. ${QUICK}</p>`,
  ).join("");
  const document = await slashdocs.createDocument(
    title,
    `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>${paragraphs}</body></html>`,
  );
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await doc.locator("body").evaluate(() => window.scrollTo(0, 37));
  await doc.locator("#p12").selectText();
  const scrollY = () => doc.locator("body").evaluate(() => window.scrollY);
  await doc.getByRole("button", { name: "Comment on selected text" }).click();
  await expect(page.getByPlaceholder("Add a comment…")).toBeFocused();
  // A smooth scroll would have moved by now.
  await page.waitForTimeout(400);
  expect(await scrollY()).toBe(37);
});

test("a toast covers no open thread", async ({ page, slashdocs }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const title = uniqueName("Toast");
  const html = paragraphsHTML(title, { paragraphs: 12 });
  const document = await slashdocs.createDocument(title, html);
  const quote = `Paragraph 11. ${QUICK}`;
  const comment = await slashdocs.createComment(document.id, "Near the end", { quote });
  await addReplies(page, document.id, comment.id, 6);
  await page.goto(`/app/d/${document.id}?comment=${comment.id}`);
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await expect(thread.getByText("Reply 5.")).toBeAttached();

  await thread.getByRole("button", { name: "More actions" }).first().click();
  await page.getByRole("menuitem", { name: "Copy link" }).click();
  const toast = page.locator("[data-sonner-toast]", { hasText: "comment link" });
  await expect(toast).toBeVisible();
  await page.waitForTimeout(400);
  expect(overlaps((await toast.boundingBox())!, (await thread.boundingBox())!)).toBe(
    false,
  );
});

test("at 1440px, a save says nothing, and covers no heading at the top", async ({
  page,
  slashdocs,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const title = uniqueName("Hint");
  const document = await slashdocs.createDocument(
    title,
    paragraphsHTML(title, { paragraphs: 4, margin: 12 }),
  );
  await openEditable(page, document.id);
  const heading = renderedDocument(page).locator("h1");
  await heading.click();
  const saved = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/ops"),
  );
  await page.keyboard.type(" now");
  expect((await saved).status()).toBe(200);
  await page.waitForTimeout(400);
  await expect(page.locator("header").getByText(/Saved|Editing|Undo/)).toHaveCount(0);
  expect(await toastsOver(page, (await heading.boundingBox())!)).toBe(false);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

test("at 390px, a toast shows above an open comment sheet", async ({
  page,
  slashdocs,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = uniqueName("Toast sheet");
  const document = await slashdocs.createDocument(
    title,
    paragraphsHTML(title, { paragraphs: 4 }),
  );
  const comment = await slashdocs.createComment(document.id, "On the first", {
    quote: `Paragraph 1. ${QUICK}`,
  });
  await page.goto(`/app/d/${document.id}?comment=${comment.id}`);
  const sheet = page.getByRole("dialog", { name: "Comment thread" });
  await expect(sheet.getByText("On the first")).toBeVisible();
  await sheet.getByRole("button", { name: "More actions" }).first().click();
  await page.getByRole("menuitem", { name: "Copy link" }).click();
  const toast = page.locator("[data-sonner-toast]", { hasText: "comment link" });
  await expect(toast).toBeVisible();
  await page.waitForTimeout(400);
  expect(overlaps((await toast.boundingBox())!, (await sheet.boundingBox())!)).toBe(
    false,
  );
});
