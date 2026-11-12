import { expect, paragraphsHTML, renderedDocument, test, uniqueName } from "./fixtures";

// Each heading has a link to copy. The link stays in the page at any width,
// says Copied at its # control, and shows to copy by hand when the browser
// does not copy it.

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

test("a heading link says Copied at its # control, not in a toast", async ({
  page,
  slashdocs,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1440, height: 900 });
  const title = uniqueName("Heading copy");
  const document = await slashdocs.createDocument(
    title,
    paragraphsHTML(title, { paragraphs: 4 }),
  );
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

test("a heading link that the browser does not copy shows to copy by hand", async ({
  page,
  slashdocs,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
    });
  });
  const title = uniqueName("Heading denied");
  const document = await slashdocs.createDocument(
    title,
    `<!doctype html><title>${title}</title><h1 id="top">${title}</h1><p>Words.</p>`,
  );
  await page.goto(`/app/d/${document.id}`);
  await renderedDocument(page).locator("h1").hover();
  await renderedDocument(page)
    .getByRole("button", { name: `Copy link to ${title}` })
    .click();

  const dialog = page.getByRole("dialog", { name: "Copy the heading link" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(`/app/d/${document.id}#top`)).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`/app/d/${document.id}#top$`));
});
