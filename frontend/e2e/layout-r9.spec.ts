import { type FrameLocator, type Locator, type Page } from "@playwright/test";
import { APP_ORIGIN, expect, test, uniqueName } from "./fixtures";

// The layout around the document: the room that a comment sheet leaves at the
// page end, the glide from under the Comments panel, the focus after a
// composer, and the place of toasts.

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

// Classic scroll bars, which take room, as on a desktop with a mouse.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

const QUICK = "The quick brown fox jumps over the lazy dog.";

// A centered column with wide margins at both sides.
function documentHTML(title: string, width: number, paragraphs = 30) {
  const numbered = Array.from(
    { length: paragraphs },
    (_, i) => `<p id="p${i}">Paragraph ${i}. ${QUICK} ${QUICK}</p>`,
  ).join("");
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title>
    <style>body{max-width:${width}px;margin:40px auto;padding:0 16px;font:16px/1.5 sans-serif}</style>
  </head>
  <body><h1>${title}</h1>${numbered}</body>
</html>`;
}

async function addReplies(page: Page, docId: string, commentId: string, count = 10) {
  for (let i = 0; i < count; i++) {
    const reply = await page.request.post(
      `/v1/documents/${docId}/comments/${commentId}/replies`,
      {
        headers: { Origin: APP_ORIGIN },
        data: { body: `Reply ${i}. This reply gives the reviewer more context.` },
      },
    );
    expect(reply.ok()).toBe(true);
  }
}

// track gives the top of el on each frame for ms, from now.
function track(el: Locator, ms: number): Promise<number[]> {
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

const overlaps = (
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + b.height &&
  b.y < a.y + a.height;

test("closing a long thread on the last paragraph of a phone page glides, not jumps", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Sheet end r9");
  const document = await slashdocs.createDocument(title, documentHTML(title, 480));
  const quote = `Paragraph 29. ${QUICK}`;
  const comment = await slashdocs.createComment(document.id, `On ${quote}`, { quote });
  await addReplies(page, document.id, comment.id);
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

  const tracked = track(last, 900);
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

test("a thread follows its anchor from under the Comments panel, and the scroll bar stays at the edge", async ({
  page,
  slashdocs,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const title = uniqueName("Glide thread r9");
  const document = await slashdocs.createDocument(title, documentHTML(title, 640, 12));
  const quote = "lazy dog. The quick brown fox";
  const comment = await slashdocs.createComment(document.id, "On the middle", {
    quote,
  });
  await page.goto(`/app/d/${document.id}?comment=${comment.id}`);
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  const mark = renderedDocument(page).locator("mark.slashdocs-mark").first();
  await expect(thread.getByText("On the middle")).toBeVisible();
  const [markBefore, before] = [
    (await mark.boundingBox())!,
    (await thread.boundingBox())!,
  ];

  await page.getByRole("button", { name: "Comments", exact: true }).click();
  const list = page.getByRole("dialog", { name: "Comments" });
  await expect(list).toBeVisible();
  await expect
    .poll(async () => (await mark.boundingBox())!.x)
    .toBeLessThan(markBefore.x);
  await page.waitForTimeout(500);
  const [markAfter, after, panel] = [
    (await mark.boundingBox())!,
    (await thread.boundingBox())!,
    (await list.boundingBox())!,
  ];
  // It moved with its anchor, and it is clear of the panel.
  expect(after.x).toBeLessThan(before.x);
  expect(overlaps(after, panel)).toBe(false);
  expect(Math.abs(after.y - before.y - (markAfter.y - markBefore.y))).toBeLessThan(2);
  // Only the content moves: the frame, with its scroll bar, stays.
  const frame = page.locator('iframe[title="Rendered document"]');
  expect((await frame.boundingBox())!.x).toBe(0);
});

test("Esc on a composer placed from the keyboard gives the focus back", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Focus back r9");
  const document = await slashdocs.createDocument(title, documentHTML(title, 640, 4));
  await page.goto(`/app/d/${document.id}`);
  await expect(renderedDocument(page).locator("#p3")).toBeAttached();
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  const spot = page.getByRole("button", { name: "Comment on a spot" });
  await spot.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.frameLocator('iframe[title="Rendered document"]').getByText(/^Click a spot/),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  const field = page
    .getByRole("dialog", { name: "New comment" })
    .getByPlaceholder("Add a comment…");
  await expect(field).toBeFocused();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  // The placement closed the list, so the focus goes to its button.
  await expect(
    page.getByRole("button", { name: "Comments", exact: true }),
  ).toBeFocused();
});

test("a toast covers no open thread", async ({ page, slashdocs }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const title = uniqueName("Toast r9");
  const html = documentHTML(title, 480, 12);
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

test("a page keeps its column in place when its scroll bar comes and goes", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const left = async (path: string) => {
    await page.goto(path);
    const main = page.locator("main");
    await expect(main.getByRole("heading").first()).toBeVisible();
    return main.evaluate((el) => el.clientWidth);
  };
  // Profile is short, and Developers is long.
  expect(await left("/app/settings/profile")).toBe(
    await left("/app/settings/developers"),
  );
});
