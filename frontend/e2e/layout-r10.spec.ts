import { type FrameLocator, type Locator, type Page } from "@playwright/test";
import { APP_ORIGIN, expect, test, uniqueName } from "./fixtures";

// Anchors stay still under remote changes, and transient UI covers no words
// or control under use: the room under a comment sheet that shrinks, the
// place of toasts, the offer of changes made elsewhere, and the copy of a
// heading link.

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

const QUICK = "The quick brown fox jumps over the lazy dog.";

function documentHTML(title: string, paragraphs = 30, margin = 40) {
  const numbered = Array.from(
    { length: paragraphs },
    (_, i) => `<p id="p${i}">Paragraph ${i}. ${QUICK} ${QUICK}</p>`,
  ).join("");
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title>
    <style>body{max-width:480px;margin:${margin}px auto;padding:0 16px;font:16px/1.5 sans-serif}h1{margin-top:12px}</style>
  </head>
  <body><h1 id="top">${title}</h1>${numbered}</body>
</html>`;
}

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
function track(el: Locator, done: Promise<unknown>): Promise<number[]> {
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

type Box = { x: number; y: number; width: number; height: number };
const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

for (const reducedMotion of ["no-preference", "reduce"] as const)
  test(`at 390px, the paragraph of an open thread stays still while its replies go and come (${reducedMotion})`, async ({
    page,
    slashdocs,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await page.setViewportSize({ width: 390, height: 844 });
    const title = uniqueName("Sheet shrink r10");
    const document = await slashdocs.createDocument(title, documentHTML(title));
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
    const tops = await track(p29, removed);
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

// toastsOver tells whether a toast covers box, in the app.
async function toastsOver(page: Page, box: Box): Promise<boolean> {
  const toasts = await page.locator("[data-sonner-toast]").all();
  for (const toast of toasts) {
    const at = await toast.boundingBox();
    if (at && overlaps(at, box)) return true;
  }
  return false;
}

test("at 1440px, the edit hint and the save message cover no heading at the top", async ({
  page,
  slashdocs,
}) => {
  await page.addInitScript(() =>
    window.localStorage.setItem("slashdocs:edit-hint-seen", "false"),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  const title = uniqueName("Hint r10");
  const document = await slashdocs.createDocument(title, documentHTML(title, 4, 12));
  await page.goto(`/app/d/${document.id}`);
  const heading = renderedDocument(page).locator("h1");
  await expect(heading).toBeVisible();

  await heading.click();
  // The bar says how to leave the text.
  await expect(
    page.getByRole("status").getByText("Type to edit. Press Esc to leave."),
  ).toBeVisible();
  await page.keyboard.type(" now");
  // The save says what it changed in the bar, with Undo, and no toast.
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(400);
  expect(await toastsOver(page, (await heading.boundingBox())!)).toBe(false);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
});

test("the offer of changes made elsewhere waits in the bar, and the placement hint shows", async ({
  page,
  slashdocs,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const title = uniqueName("Offer r10");
  const html = documentHTML(title, 4, 12);
  const document = await slashdocs.createDocument(title, html);
  await slashdocs.pushVersion(
    document.id,
    html.replace("Paragraph 0.", "Paragraph zero."),
  );
  await page.goto(`/app/d/${document.id}`);
  await expect(renderedDocument(page).locator("#p0")).toBeVisible();
  await slashdocs.pushVersion(
    document.id,
    html.replace("Paragraph 1.", "Paragraph one."),
  );
  const offer = page.getByRole("button", { name: "Show changes" });
  await expect(offer).toBeVisible();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

  await page.keyboard.press("c");
  const hint = page
    .frameLocator('iframe[title="Rendered document"]')
    .locator(".sd-place-hint");
  await expect(hint).toBeVisible();
  expect(await toastsOver(page, (await hint.boundingBox())!)).toBe(false);
  await page.keyboard.press("Escape");

  await offer.click();
  await expect(renderedDocument(page).locator("#p1")).toContainText("Paragraph one.");
  await expect(offer).toBeHidden();
});

test("a heading link says Copied at its # control, not in a toast", async ({
  page,
  slashdocs,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  const title = uniqueName("Heading copy r10");
  const document = await slashdocs.createDocument(title, documentHTML(title, 4));
  await page.goto(`/app/d/${document.id}`);
  const link = renderedDocument(page).getByRole("button", {
    name: `Copy link to ${title}`,
  });
  await renderedDocument(page).locator("h1").hover();
  await link.click();
  await expect(link).toHaveAttribute("data-slashdocs-copied", "");
  await expect(
    page.getByRole("status").getByText("Heading link copied."),
  ).toBeAttached();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("#top");
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  // It goes back to the # after a while.
  await expect(link).not.toHaveAttribute("data-slashdocs-copied", "");
});

test("at 390px, a toast shows above an open comment sheet", async ({
  page,
  slashdocs,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = uniqueName("Toast sheet r10");
  const document = await slashdocs.createDocument(title, documentHTML(title, 4));
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
