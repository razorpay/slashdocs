import { type FrameLocator, type Page } from "@playwright/test";
import { expect, test, uniqueName } from "./fixtures";

// A pin stays exactly where the reader clicks, also in a page margin, and a
// pin whose element is gone shows at its spot in the page, marked as moved.

function bridge(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Rendered document"]');
}

function renderedDocument(page: Page): FrameLocator {
  return bridge(page).frameLocator("iframe#slashdocs-doc");
}

// A narrow centered body leaves wide page margins at both sides.
function documentHTML(title: string, intro = true) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title>
    <style>body{max-width:480px;margin:40px auto;font:16px/1.5 sans-serif}</style>
  </head>
  <body>
    <h1>${title}</h1>
    ${intro ? '<p id="intro">The introduction that a later version drops.</p>' : ""}
    <p>Closing words.</p>
  </body>
</html>`;
}

// placeAt places a pin at a spot of the document frame, from its top left,
// and posts it. It gives the spot in the page.
async function placeAt(page: Page, at: { x: number; y: number }, body: string) {
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("button", { name: "Comment on a spot" }).click();
  // The frame places pins once it says so, a moment after the click.
  await expect(
    bridge(page).getByText("Click a spot, or use Tab and Enter. Esc to cancel."),
  ).toBeVisible();
  const frame = await page.locator('iframe[title="Rendered document"]').boundingBox();
  const spot = { x: frame!.x + at.x, y: frame!.y + at.y };
  await page.mouse.click(spot.x, spot.y);
  await page
    .getByRole("dialog", { name: "New comment" })
    .getByPlaceholder("Add a comment…")
    .fill(body);
  const posted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/comments"),
  );
  await page.getByRole("button", { name: "Post comment" }).click();
  await posted;
  return spot;
}

// tipOf gives the spot that a pin marks: the bottom left of its button, or
// the bottom right when its body turns left.
async function tipOf(pin: ReturnType<FrameLocator["getByRole"]>) {
  let box: Awaited<ReturnType<typeof pin.boundingBox>> = null;
  await expect.poll(async () => (box = await pin.boundingBox())).not.toBeNull();
  // The spot that a pin marks is its transform origin.
  const [x, y] = (await pin.evaluate((b) => getComputedStyle(b).transformOrigin))
    .split(" ")
    .map(parseFloat);
  return { x: box!.x + x, y: box!.y + y };
}

test("a pin placed in the page margin stays at the click after a reload", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Margin pin");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const intro = renderedDocument(page).locator("#intro");
  const box = (await intro.boundingBox())!;
  const frame = (await page
    .locator('iframe[title="Rendered document"]')
    .boundingBox())!;

  // Left of the intro, in the margin, so on the intro and named as beside it.
  const spot = await placeAt(
    page,
    { x: 120, y: box.y - frame.y + box.height / 2 },
    "Why this gap?",
  );
  await page.reload();
  const pin = bridge(page).getByRole("button", {
    name: "Comment beside “The introduction that a later version drops.”",
  });
  const tip = await tipOf(pin);
  expect(Math.abs(tip.x - spot.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(tip.y - spot.y)).toBeLessThanOrEqual(2);
});

test("a pin whose element is gone shows at its page spot, marked as moved", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Moved pin");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const intro = renderedDocument(page).locator("#intro");
  const box = await intro.boundingBox();
  const frame = await page.locator('iframe[title="Rendered document"]').boundingBox();
  const spot = await placeAt(
    page,
    { x: box!.x - frame!.x + 40, y: box!.y - frame!.y + box!.height / 2 },
    "Keep this intro",
  );

  await slashdocs.pushVersion(document.id, documentHTML(title, false));
  await page.goto(`/app/d/${document.id}`);
  await expect(intro).toHaveCount(0);
  const pin = bridge(page).getByRole("button", { name: /^Comment.*, moved/ });
  const tip = await tipOf(pin);
  expect(Math.abs(tip.x - spot.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(tip.y - spot.y)).toBeLessThanOrEqual(2);
  await pin.click();
  await expect(
    page
      .getByRole("dialog", { name: "Comment thread" })
      .getByText("Moved: its element is gone"),
  ).toBeVisible();
});
