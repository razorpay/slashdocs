import { type Locator, type Page } from "@playwright/test";
import { bridge, expect, renderedDocument, test, uniqueName } from "./fixtures";

// A pin stays exactly where the reader clicks, also in a page margin, and
// every pin stays on the visible page: a pin from a desktop margin on a
// phone, and a pin whose element is gone. A moved pin shows at its spot in
// the page, wears a dashed ring and can move again. A pin can be placed by
// keyboard only.

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

// A heading and numbered paragraphs in a narrow centered body.
function stepsHTML(title: string, paragraphs = 0) {
  const numbered = Array.from(
    { length: paragraphs },
    (_, i) => `<p id="p${i + 1}">Paragraph ${i + 1}.</p>`,
  ).join("");
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title>
    <style>body{max-width:480px;margin:40px auto;font:16px/1.5 sans-serif}</style>
  </head>
  <body>
    <h1>${title}</h1>
    <h2 id="steps">Steps</h2>
    <p id="intro">Write the notes.</p>
    ${numbered}
    <p>Closing words.</p>
  </body>
</html>`;
}

const PLACE_HINT = "Click a spot, or use Tab and Enter. Esc to cancel.";

async function frameBox(page: Page) {
  return (await page.locator('iframe[title="Rendered document"]').boundingBox())!;
}

// startPlacing starts to place a pin from the comments list. The frame
// places pins once it says so, a moment after the click.
async function startPlacing(page: Page) {
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("button", { name: "Comment on a spot" }).click();
  await expect(bridge(page).getByText(PLACE_HINT)).toBeVisible();
}

// post writes body in the open composer and posts it.
async function post(page: Page, body: string) {
  await page
    .getByRole("dialog", { name: "New comment" })
    .getByPlaceholder("Add a comment…")
    .fill(body);
  const posted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/comments"),
  );
  await page.getByRole("button", { name: "Post comment" }).click();
  return (await (await posted).json()) as {
    id: string;
    anchor: { point: { path?: string; target?: string; label?: string } };
  };
}

// placeAt places a pin at a spot of the document frame, from its top left,
// and posts it. It gives the spot in the page.
async function placeAt(page: Page, at: { x: number; y: number }, body: string) {
  await startPlacing(page);
  const frame = await frameBox(page);
  const spot = { x: frame.x + at.x, y: frame.y + at.y };
  await page.mouse.click(spot.x, spot.y);
  await post(page, body);
  return spot;
}

// tipOf gives the spot that a pin marks, which its transform origin is. A
// new pin pops in, scaled around that spot, so its box is read after that.
async function tipOf(pin: Locator) {
  await expect(pin).toBeVisible();
  await pin.evaluate((b) => Promise.all(b.getAnimations().map((a) => a.finished)));
  const box = (await pin.boundingBox())!;
  const [x, y] = (await pin.evaluate((b) => getComputedStyle(b).transformOrigin))
    .split(" ")
    .map(parseFloat);
  return { x: box.x + x, y: box.y + y };
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

test("a pin from a desktop margin is named by its block and stays on a phone screen", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Margin pin");
  const document = await slashdocs.createDocument(title, stepsHTML(title));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/app/d/${document.id}`);
  const steps = renderedDocument(page).locator("#steps");
  await expect(steps).toBeVisible();

  await startPlacing(page);
  const box = (await steps.boundingBox())!;
  const frame = await frameBox(page);
  await page.mouse.click(frame.x + 40, box.y + box.height / 2);
  const comment = await post(page, "Why this gap?");
  expect(comment.anchor.point.target).toBe("steps");
  expect(comment.anchor.point.label).toBe("Beside “Steps”");
  await expect(
    bridge(page).getByRole("button", { name: "Comment beside “Steps”" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByText("Why this gap?").click();
  const pin = bridge(page).getByRole("button", { name: "Comment beside “Steps”" });
  const tip = await tipOf(pin);
  const narrow = await frameBox(page);
  const shown = (await steps.boundingBox())!;
  expect(tip.x).toBeGreaterThanOrEqual(narrow.x);
  expect(tip.x).toBeLessThanOrEqual(narrow.x + narrow.width);
  // Beside its block.
  expect(Math.abs(tip.y - (shown.y + shown.height / 2))).toBeLessThanOrEqual(2);
});

test("a moved pin below a shorter page shows at its end, wears a dashed ring, and moves", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Short page pin");
  const document = await slashdocs.createDocument(title, stepsHTML(title, 30));
  await page.goto(`/app/d/${document.id}`);
  const p27 = renderedDocument(page).locator("#p27");
  await p27.scrollIntoViewIfNeeded();
  await startPlacing(page);
  const box = (await p27.boundingBox())!;
  await page.mouse.click(box.x + 20, box.y + box.height / 2);
  const comment = await post(page, "Keep paragraph 27");

  await slashdocs.pushVersion(document.id, stepsHTML(title));
  await page.goto(`/app/d/${document.id}`);
  await expect(renderedDocument(page).locator("#p27")).toHaveCount(0);
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByText("Keep paragraph 27").click();
  const pin = bridge(page).getByRole("button", { name: /^Comment.*, moved/ });
  const tip = await tipOf(pin);
  const frame = await frameBox(page);
  expect(tip.y).toBeLessThanOrEqual(frame.y + frame.height);
  // Its color stays, and a dashed ring says that it moved.
  expect(await pin.evaluate((b) => getComputedStyle(b).outlineStyle)).toBe("dashed");
  expect(await pin.locator("b").evaluate((b) => getComputedStyle(b).opacity)).toBe("1");

  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await thread.getByRole("button", { name: "Move pin" }).click();
  await expect(
    bridge(page).getByText("Click the new spot, or use Tab and Enter. Esc to cancel."),
  ).toBeVisible();
  const intro = (await renderedDocument(page).locator("#intro").boundingBox())!;
  const moved = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(`/${comment.id}`),
  );
  await page.mouse.click(intro.x + 20, intro.y + intro.height / 2);
  expect((await moved).ok()).toBe(true);
  await expect(
    bridge(page).getByRole("button", { name: "Comment on Write the notes." }),
  ).toBeVisible();
  await expect(thread.getByText("Moved: its element is gone")).toHaveCount(0);
});

test("a pin can be placed with the keyboard only", async ({ page, slashdocs }) => {
  const title = uniqueName("Keyboard pin");
  const document = await slashdocs.createDocument(title, stepsHTML(title));
  await page.goto(`/app/d/${document.id}`);
  await expect(renderedDocument(page).locator("#intro")).toBeVisible();

  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("button", { name: "Comment on a spot" }).focus();
  await page.keyboard.press("Enter");
  await expect(bridge(page).getByText(PLACE_HINT)).toBeVisible();
  // The ring goes over the title, Steps, and the intro, and back to Steps.
  for (const key of ["Tab", "Tab", "ArrowDown", "Shift+Tab"])
    await page.keyboard.press(key);
  const ring = bridge(page).locator(".sd-place-ring");
  const steps = (await renderedDocument(page).locator("#steps").boundingBox())!;
  const ringBox = (await ring.boundingBox())!;
  expect(Math.abs(ringBox.y - steps.y)).toBeLessThanOrEqual(1);
  expect(await ring.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");

  await page.keyboard.press("Enter");
  const composer = page
    .getByRole("dialog", { name: "New comment" })
    .getByPlaceholder("Add a comment…");
  await expect(composer).toBeFocused();
  const comment = await post(page, "From the keyboard");
  expect(comment.anchor.point.target).toBe("steps");

  // Esc stops placing.
  await startPlacing(page);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Escape");
  await expect(bridge(page).getByText(PLACE_HINT)).toHaveCount(0);
  await expect(ring).toHaveCount(0);
});

test("the document frame does not scroll sideways on a phone", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Narrow frame");
  const document = await slashdocs.createDocument(title, stepsHTML(title));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/app/d/${document.id}`);
  const root = renderedDocument(page).locator("html");
  await expect(renderedDocument(page).locator("#intro")).toBeVisible();
  await expect
    .poll(() => root.evaluate((el) => el.scrollWidth - el.clientWidth))
    .toBe(0);
  const bridgeRoot = bridge(page).locator("html");
  expect(await bridgeRoot.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
});

test("keyboard placement works again and again in one page, with Esc and the Esc chord between", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Keyboard pins again");
  const document = await slashdocs.createDocument(title, stepsHTML(title));
  await page.goto(`/app/d/${document.id}`);
  await expect(renderedDocument(page).locator("#intro")).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { keydowns: number };
    w.keydowns = 0;
    window.addEventListener("keydown", () => w.keydowns++, true);
  });
  const composer = page
    .getByRole("dialog", { name: "New comment" })
    .getByPlaceholder("Add a comment…");
  for (const between of ["Escape", "Escape", "Escape c"]) {
    const comments = page.getByRole("button", { name: "Comment on a spot" });
    if (!(await comments.isVisible()))
      await page.getByRole("button", { name: "Comments", exact: true }).click();
    await comments.focus();
    await page.keyboard.press("Enter");
    await expect(bridge(page).getByText(PLACE_HINT)).toBeVisible();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Enter");
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue("");
    await expect(bridge(page).getByText(PLACE_HINT)).toHaveCount(0);
    for (const key of between.split(" ")) await page.keyboard.press(key);
    await expect(composer).toHaveCount(0);
  }
  // Each press is one key: nothing sends keys again, and the page answers.
  expect(
    await page.evaluate(() => (window as unknown as { keydowns: number }).keydowns),
  ).toBeLessThan(40);
});
