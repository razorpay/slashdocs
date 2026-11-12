import {
  bridge,
  expect,
  overlaps,
  toastsOver,
  paragraphsHTML,
  QUICK,
  renderedDocument,
  test,
  uniqueName,
} from "./fixtures";

// A change that another person or an agent makes goes into the page in
// place, and a flash marks the words that changed. A change that rewrites
// what the reader reads waits for the reader behind the offer of Show the
// latest. The offer takes room above the document and covers none of it.

// A list whose middle item changes. after goes below the list.
function listHTML(title: string, step = "Write the notes.", after = "") {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    <ul><li>Read the brief.</li><li id="step">${step}</li><li>Ship it.</li></ul>
    ${after}
  </body>
</html>`;
}

// A long page with a pin target far below the changed list item.
const CHART_BELOW = `${"<p>Filler words that make the page long.</p>".repeat(12)}
    <div id="chart" style="height:120px;background:#eef">Chart</div>
    ${"<p>More filler words.</p>".repeat(30)}`;

const SLOW_FOX = "A slow red fox walks around the dog that sleeps.";

test("a small change made elsewhere flashes the list item that changed", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Change flash");
  const document = await slashdocs.createDocument(title, listHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await expect(doc.locator("#step")).toBeVisible();

  await slashdocs.pushVersion(document.id, listHTML(title, "Write the notes again."));
  await expect(doc.locator("#step")).toHaveText("Write the notes again.");
  await expect(doc.locator(".slashdocs-text-flash")).toHaveCount(1);
});

test("the offer of a large change made elsewhere waits for the reader", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Changed elsewhere");
  const document = await slashdocs.createDocument(title, listHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const step = renderedDocument(page).locator("#step");
  await expect(step).toBeVisible();

  const long = "Write the notes again, with each decision of the team. ".repeat(30);
  await slashdocs.pushVersion(document.id, listHTML(title, long));
  // The offer waits at the top of the document, and does not go by itself.
  const offer = page.getByRole("button", { name: "Show the latest", exact: true });
  await expect(offer).toBeVisible();
  await expect(page.getByRole("status").filter({ has: offer }).locator("p")).toHaveText(
    / updated this document\.$/,
  );
  await page.waitForTimeout(5000);
  await expect(offer).toBeVisible();
  await expect(step).toHaveText("Write the notes.");

  await offer.click();
  await expect(step).toHaveText(long.trim());
  await expect(offer).toBeHidden();
});

test("a change made elsewhere flashes the changed item while a pin is open", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Flash with pin");
  const document = await slashdocs.createDocument(
    title,
    listHTML(title, "Write the notes once.", CHART_BELOW),
  );
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
    await slashdocs.pushVersion(
      document.id,
      listHTML(title, `Write the notes ${step}.`, CHART_BELOW),
    );
    await expect(doc.locator("#step")).toHaveText(`Write the notes ${step}.`);
    // Each run of changed words has a flash of its own, on the line of the
    // item.
    const flash = doc.locator(".slashdocs-text-flash");
    await expect(flash).not.toHaveCount(0);
    const [box, words] = await Promise.all([
      flash.first().boundingBox(),
      doc.locator("#step").boundingBox(),
    ]);
    expect(Math.abs(box!.y - words!.y)).toBeLessThan(words!.height);
    expect(await scrollY()).toBe(37);
    // The flash goes before the next change comes.
    await expect(flash).toHaveCount(0);
  }
});

test("a small change made elsewhere flashes the block that changed", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Change flash");
  const html = paragraphsHTML(title);
  const document = await slashdocs.createDocument(title, html);
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await expect(doc.locator("#p12")).toBeVisible();

  // The change goes into the page in place: the reader asks for nothing.
  await slashdocs.pushVersion(
    document.id,
    html.replace("Paragraph 12.", "Paragraph 12 changed."),
  );
  await expect(doc.locator("#p12")).toContainText("Paragraph 12 changed");
  const flash = doc.locator(".slashdocs-text-flash");
  await expect(flash).toHaveCount(1);
  expect(
    overlaps((await flash.boundingBox())!, (await doc.locator("#p12").boundingBox())!),
  ).toBe(true);
});

test("the offer of a large change made elsewhere says nothing in a toast, and the placement hint shows", async ({
  page,
  slashdocs,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const title = uniqueName("Offer");
  const html = paragraphsHTML(title, { paragraphs: 4, margin: 12 });
  const document = await slashdocs.createDocument(title, html);
  await slashdocs.pushVersion(
    document.id,
    html.replace("Paragraph 0.", "Paragraph zero."),
  );
  await page.goto(`/app/d/${document.id}`);
  await expect(renderedDocument(page).locator("#p0")).toBeVisible();
  // A change of each line that the reader sees does not go into the page in
  // place.
  await slashdocs.pushVersion(document.id, html.replaceAll(QUICK, SLOW_FOX));
  const offer = page.getByRole("button", { name: "Show the latest", exact: true });
  await expect(offer).toBeVisible();
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

  await page.keyboard.press("c");
  const hint = bridge(page).locator(".sd-place-hint");
  await expect(hint).toBeVisible();
  expect(await toastsOver(page, (await hint.boundingBox())!)).toBe(false);
  const banner = page.getByRole("status").filter({ has: offer });
  expect(overlaps((await banner.boundingBox())!, (await hint.boundingBox())!)).toBe(
    false,
  );
  await page.keyboard.press("Escape");

  await offer.click();
  await expect(renderedDocument(page).locator("#p1")).toContainText("A slow red fox");
  await expect(offer).toBeHidden();
});

test("Show the latest keeps the place of a reader in the middle of a long document", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Place");
  const html = paragraphsHTML(title);
  const document = await slashdocs.createDocument(title, html);
  await page.goto(`/app/d/${document.id}`);
  const p15 = renderedDocument(page).locator("#p15");
  await p15.evaluate((el) => el.scrollIntoView({ block: "center" }));
  expect(await p15.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  // Where the paragraph is on the screen. The banner takes room at the top
  // of the document and pushes it down by its height, so no text goes
  // under the banner.
  const place = async () => (await p15.boundingBox())!.y;
  const before = await place();

  // The push writes each line again, so it waits for the reader.
  await slashdocs.pushVersion(document.id, html.replaceAll(QUICK, SLOW_FOX));
  const offer = page.getByRole("button", { name: "Show the latest", exact: true });
  await expect(offer).toBeVisible();
  const room = (await page.getByRole("status").filter({ has: offer }).boundingBox())!
    .height;
  await expect
    .poll(async () => Math.abs((await place()) - before - room))
    .toBeLessThanOrEqual(4);

  await offer.click();
  await expect(p15).toContainText("A slow red fox");
  await expect(offer).toBeHidden();
  await expect
    .poll(async () => Math.abs((await place()) - before))
    .toBeLessThanOrEqual(4);
});

for (const fullscreen of [false, true])
  test(`the banner pushes the document down and covers none of its lines${fullscreen ? ", in full screen" : ""}`, async ({
    page,
    slashdocs,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const title = uniqueName("Banner room");
    const html = paragraphsHTML(title);
    const document = await slashdocs.createDocument(title, html);
    await page.goto(`/app/d/${document.id}${fullscreen ? "?fullscreen=1" : ""}`);
    // The first line of the view is a line of paragraph 15.
    const p15 = renderedDocument(page).locator("#p15");
    await p15.evaluate((el) => el.scrollIntoView({ block: "start" }));

    // The push writes each line again, so it waits for the reader.
    await slashdocs.pushVersion(document.id, html.replaceAll(QUICK, SLOW_FOX));
    const offer = page.getByRole("button", { name: "Show the latest", exact: true });
    await expect(offer).toBeVisible();
    // The banner slides up into its place as it comes (.enter).
    const status = page.getByRole("status").filter({ has: offer });
    await status.evaluate((el) =>
      Promise.all(el.getAnimations().map((animation) => animation.finished)),
    );
    const banner = (await status.boundingBox())!;
    // A full-width banner, above the frame.
    expect(banner.width).toBeGreaterThan(1000);
    const frame = (await page.getByTitle("Rendered document").boundingBox())!;
    expect(frame.y).toBeGreaterThanOrEqual(banner.y + banner.height - 1);
    // The first line of the view is still in the view, under the banner.
    await expect(p15).toBeInViewport();
    await expect(p15).toContainText("Paragraph 15.");
    expect(overlaps(banner, (await p15.boundingBox())!)).toBe(false);
    expect((await p15.boundingBox())!.y).toBeGreaterThanOrEqual(frame.y - 1);
  });

test("the offer goes by itself when the reader scrolls far from the change that waited", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Away");
  const html = paragraphsHTML(title);
  const document = await slashdocs.createDocument(title, html);
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await expect(doc.locator("#p0")).toBeVisible();

  // The push writes the first paragraphs again, which the reader looks at.
  await slashdocs.pushVersion(
    document.id,
    html.replace(
      /<p id="p([0-7])">[^<]*<\/p>/g,
      `<p id="p$1">Part $1. ${SLOW_FOX}</p>`,
    ),
  );
  const offer = page.getByRole("button", { name: "Show the latest", exact: true });
  await expect(offer).toBeVisible();
  await expect(doc.locator("#p0")).toContainText("Paragraph 0.");

  // At the end of the document, none of the change is in the view.
  await doc.locator("#p29").evaluate((el) => el.scrollIntoView({ block: "end" }));
  await expect(offer).toBeHidden();
  await expect(doc.locator("#p0")).toContainText("A slow red fox");
  await expect(doc.locator("#p29")).toBeInViewport();
});
