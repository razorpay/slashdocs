import { type FrameLocator, type Page } from "@playwright/test";
import { expect, test, uniqueName } from "./fixtures";

function renderedDocument(page: Page): FrameLocator {
  return page
    .frameLocator('iframe[title="Rendered document"]')
    .frameLocator("iframe#slashdocs-doc");
}

// A long page with a pin target far below the changed list item.
function documentHTML(title: string, step: string) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    <ul><li>Read the brief.</li><li id="step">Write the notes ${step}.</li><li>Ship it.</li></ul>
    ${"<p>Filler words that make the page long.</p>".repeat(12)}
    <div id="chart" style="height:120px;background:#eef">Chart</div>
    ${"<p>More filler words.</p>".repeat(30)}
  </body>
</html>`;
}

test("a change made elsewhere flashes the changed item while a pin is open", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Flash with pin");
  const document = await slashdocs.createDocument(title, documentHTML(title, "once"));
  const pin = await slashdocs.createComment(document.id, "Look here", {
    point: { target: "chart", x: 0.5, y: 0.5 },
  });
  // The open pin centers itself on a load. Each change goes into the page in
  // place, with no load, so the page stays where the reader scrolled it.
  await page.goto(`/app/d/${document.id}?comment=${pin.id}`);
  const doc = renderedDocument(page);
  await expect(doc.locator("#step")).toHaveText("Write the notes once.");
  const scrollY = () => doc.locator("body").evaluate(() => window.scrollY);
  await doc.locator("body").evaluate(() => window.scrollTo(0, 37));

  for (const step of ["once more", "a 4th time", "a 5th time"]) {
    await slashdocs.pushVersion(document.id, documentHTML(title, step));
    await expect(doc.locator("#step")).toHaveText(`Write the notes ${step}.`);
    const flash = doc.locator(".slashdocs-text-flash");
    await expect(flash).toHaveCount(1);
    const [box, words] = await Promise.all([
      flash.boundingBox(),
      doc.locator("#step").boundingBox(),
    ]);
    expect(Math.abs(box!.y - words!.y)).toBeLessThan(words!.height);
    expect(await scrollY()).toBe(37);
    // The flash goes before the next change comes.
    await expect(flash).toHaveCount(0);
  }
});

// The keycast is hidden from screen readers. Its line runs out with the time.
const keycast = (page: Page) => page.locator('[aria-label="Time to press a letter"]');
const placeHint = (page: Page) =>
  page.frameLocator('iframe[title="Rendered document"]').locator(".sd-place-hint");

function noteHTML(title: string) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    <p id="tail">Clients retry twice before giving up.</p>
  </body>
</html>`;
}

// An Esc that closes a thread is the thread's: it arms no chord, so C after
// it places a pin, from the app and from the document.
for (const from of ["the thread", "the document"] as const) {
  test(`Esc that closes a thread from ${from} arms no chord`, async ({
    page,
    slashdocs,
  }) => {
    const title = uniqueName("Esc thread");
    const document = await slashdocs.createDocument(title, noteHTML(title));
    await slashdocs.createComment(document.id, "Why twice?", {
      quote: "retry twice",
    });
    // An earlier version takes no typing.
    await slashdocs.pushVersion(document.id, noteHTML(`${title} again`));
    await page.goto(`/app/d/${document.id}?version=${document.current_version_id}`);
    const doc = renderedDocument(page);
    await expect(doc.locator("h1")).toHaveText(title);

    const thread = page.getByRole("dialog", { name: "Comment thread" });
    const mark = doc.locator("mark.slashdocs-mark").first();
    await mark.click();
    await expect(thread).toBeVisible();
    if (from === "the thread") await thread.focus();
    await page.keyboard.press("Escape");
    await expect(thread).toBeHidden();
    await page.waitForTimeout(200);
    await expect(keycast(page)).toHaveCount(0);

    if (from === "the document") await doc.locator("h1").click();
    await page.keyboard.press("c");
    await expect(placeHint(page)).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Comments" })).toBeHidden();
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

// The link of a heading stays in the page at any width, also after a long
// last word at the edge, and adds no line to its heading.
test.describe("at 390x844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("heading links make the page no wider", async ({ page, slashdocs }) => {
    const title = uniqueName("Headings");
    const headings = Array.from(
      { length: 24 },
      (_, i) => `<h2>${"Step ".repeat(i % 8)}${"x".repeat(3 + i)}</h2>`,
    ).join("");
    const document = await slashdocs.createDocument(
      title,
      `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>${headings}</body></html>`,
    );
    await page.goto(`/app/d/${document.id}`);
    const doc = renderedDocument(page);
    await expect(doc.locator(".slashdocs-heading-link")).toHaveCount(25);
    const overflow = await doc.locator("body").evaluate((body) => {
      const root = body.ownerDocument.documentElement;
      const outside = [...body.querySelectorAll(".slashdocs-heading-link")].filter(
        (button) => button.getBoundingClientRect().right > root.clientWidth,
      );
      // The links take no line of their own: each heading keeps its height
      // without them.
      const headings = [...body.querySelectorAll("h1,h2")];
      const heights = () => headings.map((h) => h.getBoundingClientRect().height);
      const withLinks = heights();
      body.ownerDocument.head.insertAdjacentHTML(
        "beforeend",
        "<style>.slashdocs-heading-link{display:none!important}</style>",
      );
      const taller = heights().filter((height, i) => height !== withLinks[i]);
      return {
        wider: root.scrollWidth - root.clientWidth,
        outside: outside.length,
        taller: taller.length,
      };
    });
    expect(overflow).toEqual({ wider: 0, outside: 0, taller: 0 });
  });
});
