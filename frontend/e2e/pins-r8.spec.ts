import { type FrameLocator, type Locator, type Page } from "@playwright/test";
import { APP_ORIGIN, expect, test, uniqueName } from "./fixtures";

// One placement for every pin: its tip stays in the page in view, and its
// face goes to the nearest place that covers no text, with a pointer to the
// tip. A comment sheet keeps the open anchor above it. A pin on a touch
// screen takes a 40px hit area, and an open moved pin wears one ring.

function bridge(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Rendered document"]');
}

function renderedDocument(page: Page): FrameLocator {
  return bridge(page).frameLocator("iframe#slashdocs-doc");
}

const QUICK = "The quick brown fox jumps over the lazy dog.";

// A narrow centered body leaves wide page margins at both sides at 1440.
function documentHTML(title: string, paragraphs = 12) {
  const numbered = Array.from(
    { length: paragraphs },
    (_, i) => `<p id="p${i}">Paragraph ${i}. ${QUICK}</p>`,
  ).join("");
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title>
    <style>body{max-width:480px;margin:40px auto;padding:0 16px;font:16px/1.5 sans-serif}
    .badge{padding:1px 6px;border-radius:4px;background:#fef3c7}</style>
  </head>
  <body>
    <h1>${title}</h1>
    <h2 id="steps">Steps</h2>
    <p id="intro">Repeat repeat repeat.</p>
    <p id="status">Status <span class="badge" id="badge">Pending</span> for review.</p>
    ${numbered}
  </body>
</html>`;
}

async function startPlacing(page: Page) {
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("button", { name: "Comment on a spot" }).click();
  await expect(bridge(page).getByText(/^Click a spot/)).toBeVisible();
}

async function post(page: Page, body: string) {
  await page
    .getByRole("dialog", { name: "New comment" })
    .getByPlaceholder("Add a comment…")
    .fill(body);
  const posted = page.waitForResponse(
    (r) => r.request().method() === "POST" && r.url().endsWith("/comments"),
  );
  await page.getByRole("button", { name: "Post comment" }).click();
  await posted;
  await page.keyboard.press("Escape");
}

// placeAt places a pin at a point from the top left of an element, as it
// is once placing starts, and posts it.
async function placeAt(page: Page, el: Locator, x: number, y: number, body: string) {
  await startPlacing(page);
  const box = (await el.boundingBox())!;
  const at = [box.x + x, box.y + y] as const;
  // On a phone the Comments sheet slides away first.
  await expect
    .poll(() =>
      page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.localName, at),
    )
    .toBe("iframe");
  await page.mouse.click(...at);
  await post(page, body);
}

// facing gives the box of a pin's face and its tip, which its transform
// origin marks, once the pin rests.
async function facing(pin: Locator) {
  await expect(pin).toBeVisible();
  let last = "";
  await expect
    .poll(async () => {
      const now = JSON.stringify(await pin.boundingBox());
      const still = now === last;
      last = now;
      return still;
    })
    .toBe(true);
  const box = (await pin.boundingBox())!;
  const [x, y] = (await pin.evaluate((b) => getComputedStyle(b).transformOrigin))
    .split(" ")
    .map(parseFloat);
  return { box, tip: { x: box.x + x, y: box.y + y } };
}

// textLines gives the boxes of the lines of text of the document, on the page.
async function textLines(page: Page) {
  const frame = (await bridge(page).locator("iframe#slashdocs-doc").boundingBox())!;
  const lines = await renderedDocument(page)
    .locator("body")
    .evaluate((body) => {
      const out: { x: number; y: number; width: number; height: number }[] = [];
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        range.selectNodeContents(node);
        for (const r of range.getClientRects())
          out.push({ x: r.x, y: r.y, width: r.width, height: r.height });
      }
      return out;
    });
  return lines.map((r) => ({ ...r, x: r.x + frame.x, y: r.y + frame.y }));
}

// expectClear makes sure that a face covers no text, but for its rim in the
// top and bottom of a line, which hold little ink.
async function expectClear(page: Page, face: { x: number; y: number }, name: string) {
  const SLACK = 4;
  const [left, top, right, bottom] = [
    face.x + SLACK,
    face.y + SLACK,
    face.x + 28 - SLACK,
    face.y + 28 - SLACK,
  ];
  const covered = (await textLines(page)).filter(
    (r) => r.x < right && left < r.x + r.width && r.y < bottom && top < r.y + r.height,
  );
  expect(covered, `the face of ${name} covers no text`).toEqual([]);
}

// expectInFrame makes sure that a face is wholly in the visible width of
// the document.
async function expectInFrame(page: Page, face: { x: number; width: number }) {
  const frame = (await bridge(page).locator("iframe#slashdocs-doc").boundingBox())!;
  const width = await renderedDocument(page)
    .locator("html")
    .evaluate((el) => el.clientWidth);
  expect(face.x).toBeGreaterThanOrEqual(frame.x);
  expect(face.x + face.width).toBeLessThanOrEqual(frame.x + width);
}

test("margin pins from 1440 stay wholly on a phone screen, clear of the words beside them", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Margin pins r8");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  const p1 = (await doc.locator("#p1").boundingBox())!;
  await placeAt(page, doc.locator("#p1"), p1.width + 120, 10, "Right of paragraph 1");
  await placeAt(page, doc.locator("#steps"), -120, 16, "Left of Steps");
  const right = bridge(page).getByRole("button", {
    name: "Comment beside “Paragraph 1.",
  });
  const left = bridge(page).getByRole("button", { name: "Comment beside “Steps”" });
  await expect(right).toBeVisible();
  await expect(left).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  for (const [pin, block, name] of [
    [right, "#p1", "the right margin pin"],
    [left, "#steps", "the left margin pin"],
  ] as const) {
    await doc.locator(block).scrollIntoViewIfNeeded();
    const { box, tip } = await facing(pin);
    await expectInFrame(page, box);
    await expectClear(page, box, name);
    // The tip is beside its block, at its height.
    const shown = (await doc.locator(block).boundingBox())!;
    expect(tip.y).toBeGreaterThanOrEqual(shown.y);
    expect(tip.y).toBeLessThanOrEqual(shown.y + shown.height);
  }
  // Its thread opens with its pin.
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByText("Right of paragraph 1").click();
  await expect(right).toBeVisible();
});

for (const width of [1440, 390])
  test(`a pin on words takes clear space and points to its spot, at ${width} pixels`, async ({
    page,
    slashdocs,
  }) => {
    const title = uniqueName("Pins on words");
    const document = await slashdocs.createDocument(title, documentHTML(title));
    await page.setViewportSize({ width, height: 844 });
    await page.goto(`/app/d/${document.id}`);
    const doc = renderedDocument(page);
    await expect(doc.locator("#intro")).toBeVisible();
    const spots = [
      ["#intro", 4, "the start of Repeat"],
      ["#badge", 0.5, "the Pending badge"],
      ["#p4", 4, "the start of Paragraph 4"],
      ["#p2", 0.5, "the middle of a line"],
    ] as const;
    const placed: { el: Locator; x: number; name: string }[] = [];
    for (const [selector, at, name] of spots) {
      const el = doc.locator(selector);
      const x = at < 1 ? (await el.boundingBox())!.width * at : at;
      await placeAt(page, el, x, 10, `On ${name}`);
      placed.push({ el, x, name });
    }
    const pins = bridge(page).locator(".sd-pin");
    await expect(pins).toHaveCount(spots.length);
    for (const { el, name, ...at } of placed) {
      const box = (await el.boundingBox())!;
      const [x, y] = [box.x + at.x, box.y + 10];
      // The pin whose tip is at the spot.
      let found = false;
      for (const each of await pins.all()) {
        const { box, tip } = await facing(each);
        if (Math.hypot(tip.x - x, tip.y - y) > 2) continue;
        found = true;
        await expectClear(page, box, name);
        await expectInFrame(page, box);
        // A face away from its spot points to it.
        if ((await each.getAttribute("data-turn")) === "away")
          await expect(each.locator("s")).toBeVisible();
      }
      expect(found, `a pin marks ${name}`).toBe(true);
    }
  });

test("a long thread opened from Comments on a phone keeps its paragraph above the sheet", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Long thread r8");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const quotes = [`Paragraph 4. ${QUICK}`, `Paragraph 11. ${QUICK}`];
  for (const quote of quotes) {
    const comment = await slashdocs.createComment(document.id, `On ${quote}`, {
      quote,
    });
    for (let i = 0; i < 10; i++)
      expect(
        (
          await page.request.post(
            `/v1/documents/${document.id}/comments/${comment.id}/replies`,
            {
              headers: { Origin: APP_ORIGIN },
              data: { body: `Reply ${i}. This reply gives the reviewer more context.` },
            },
          )
        ).ok(),
      ).toBe(true);
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

test.describe("on a touch screen", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a pin keeps its 28px face and takes a 40px hit area", async ({
    page,
    slashdocs,
  }) => {
    const title = uniqueName("Touch pin");
    const document = await slashdocs.createDocument(title, documentHTML(title));
    await slashdocs.createComment(document.id, "Tap me", {
      point: { target: "steps", x: 0.5, y: 0.5 },
    });
    await page.goto(`/app/d/${document.id}`);
    const pin = bridge(page).locator(".sd-pin");
    const { box } = await facing(pin);
    expect(box.width).toBe(28);
    expect(box.height).toBe(28);
    // A tap 5px outside the face still finds the pin.
    const frame = (await page
      .locator('iframe[title="Rendered document"]')
      .boundingBox())!;
    const hit = await bridge(page)
      .locator("body")
      .evaluate(
        (body, [x, y]) =>
          body.ownerDocument.elementFromPoint(x, y)?.closest(".sd-pin") !== null,
        [box.x - frame.x + 14, box.y - frame.y - 5],
      );
    expect(hit).toBe(true);
    await page.touchscreen.tap(box.x + 14, box.y - 5);
    await expect(page.getByRole("dialog", { name: "Comment thread" })).toBeVisible();
  });
});

test("an open moved pin wears one ring: the active one, dashed", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Moved ring");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await slashdocs.createComment(document.id, "Keep this", {
    point: {
      target: "gone",
      x: 0.5,
      y: 0.5,
      page_x: 300,
      page_y: 300,
      viewport_w: 1280,
    },
  });
  await page.goto(`/app/d/${document.id}`);
  const pin = bridge(page).getByRole("button", { name: /^Comment.*, moved/ });
  await pin.click();
  await expect(page.getByRole("dialog", { name: "Comment thread" })).toBeVisible();
  await expect(pin).toHaveAttribute("data-active", "");
  const style = await pin.evaluate((b) => {
    const s = getComputedStyle(b);
    return { outline: `${s.outlineStyle} ${s.outlineColor}`, shadow: s.boxShadow };
  });
  expect(style.outline).toBe("dashed rgb(37, 99, 235)");
  expect(style.shadow).not.toContain("rgb(37, 99, 235)");
});
