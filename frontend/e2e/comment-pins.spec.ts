import { type FrameLocator, type Page } from "@playwright/test";
import { expect, test, uniqueName } from "./fixtures";

// The bridge window draws the pins over the document frame.
function bridge(page: Page): FrameLocator {
  return page.frameLocator('iframe[title="Rendered document"]');
}

function renderedDocument(page: Page): FrameLocator {
  return bridge(page).frameLocator("iframe#slashdocs-doc");
}

function documentHTML(title: string) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body>
    <h1>${title}</h1>
    <div id="chart" style="width:400px;height:300px;background:#eef">Revenue chart</div>
    <p>Words that the owner edits.</p>
  </body>
</html>`;
}

function commentPosted(page: Page, documentID: string) {
  return page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      response.request().method() === "POST" &&
      url.pathname === `/v1/documents/${documentID}/comments`
    );
  });
}

test("pins a comment to any spot, and keeps it there", async ({ page, slashdocs }) => {
  const title = uniqueName("Pins");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const doc = renderedDocument(page);
  await expect(doc.locator("#chart")).toBeVisible();

  // The owner edits this document, so in its text C types. The comments
  // list starts placing a pin instead.
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.getByRole("button", { name: "Comment on a spot" }).click();
  await doc.locator("#chart").click({ position: { x: 100, y: 75 } });
  const composer = page
    .getByRole("dialog", { name: "New comment" })
    .getByPlaceholder("Add a comment…");
  await expect(composer).toBeFocused();
  await composer.fill("Label this axis");
  const posted = commentPosted(page, document.id);
  await page.getByRole("button", { name: "Post comment" }).click();
  const comment = (await (await posted).json()) as {
    anchor: { quote: string; point: { target: string; x: number; y: number } };
  };
  expect(comment.anchor.point.target).toBe("chart");
  expect(comment.anchor.point.x).toBeCloseTo(0.25, 1);
  expect(comment.anchor.point.y).toBeCloseTo(0.25, 1);
  expect(comment.anchor.quote).toBe("Revenue chart");

  const thread = page.getByRole("dialog", { name: "Comment thread" });
  await expect(thread.getByText("Label this axis")).toBeVisible();
  const pin = bridge(page).getByRole("button", { name: "Comment on Revenue chart" });
  await expect(pin).toBeVisible();

  // Placing the pin left in-place editing alone.
  await thread.press("Escape");
  await doc.locator("p").click();
  await page.keyboard.press("End");
  await page.keyboard.type(" Still editable.");
  await expect(doc.locator("p")).toHaveText(
    "Words that the owner edits. Still editable.",
  );

  // The pin stays on its spot after a reload, and opens its thread.
  await page.reload();
  const chart = await doc.locator("#chart").boundingBox();
  const box = await pin.boundingBox();
  expect(chart && box).toBeTruthy();
  // The tip of the pin, its bottom left corner, marks the spot.
  expect(Math.abs(box!.x - (chart!.x + 100))).toBeLessThan(3);
  expect(Math.abs(box!.y + box!.height - (chart!.y + 75))).toBeLessThan(3);
  await pin.click();
  await expect(thread.getByText("Label this axis")).toBeVisible();

  // A resolved pin leaves the document, and the comments list still has it.
  await thread.getByRole("button", { name: "Resolve comment" }).click();
  await thread.getByRole("button", { name: "Close comment" }).click();
  await expect(pin).toBeHidden();
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  const list = page.getByRole("dialog", { name: "Comments" });
  await list.getByRole("button", { name: "resolved", exact: true }).click();
  await list.getByRole("button").filter({ hasText: "Label this axis" }).click();
  await expect(thread.getByRole("button", { name: "Reopen comment" })).toBeVisible();
  await expect(pin).toBeVisible();
});

test("C with nothing selected places a pin, and Esc stops", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Pin key");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  // An earlier edit does not take typing, so C places a pin there.
  await slashdocs.pushVersion(document.id, documentHTML(`${title} again`));
  await page.goto(`/app/d/${document.id}?version=${document.current_version_id}`);
  const doc = renderedDocument(page);
  await doc.locator("h1").click();

  await page.keyboard.press("c");
  await page.keyboard.press("Escape");
  await doc.locator("p").click();
  await expect(page.getByRole("dialog", { name: "New comment" })).toBeHidden();

  await page.keyboard.press("c");
  await doc.locator("p").click();
  await expect(page.getByRole("dialog", { name: "New comment" })).toBeVisible();
  await expect(
    bridge(page).getByRole("button", { name: "Unsent comment" }),
  ).toBeVisible();
  // An empty one goes when it closes.
  await page.keyboard.press("Escape");
  await expect(
    bridge(page).getByRole("button", { name: "Unsent comment" }),
  ).toBeHidden();
});

test("pins close together merge, and the cluster lists its threads", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Cluster");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  for (const [body, x] of [
    ["First pin", 0.5],
    ["Second pin", 0.51],
  ] as const)
    await slashdocs.createComment(document.id, body, {
      point: { target: "chart", x, y: 0.5 },
    });
  await page.goto(`/app/d/${document.id}`);
  const cluster = bridge(page).getByRole("button", { name: "2 comment threads" });
  await cluster.click();
  const threads = page.getByRole("dialog", { name: "Comment threads" });
  await threads.getByRole("button").filter({ hasText: "Second pin" }).click();
  await expect(
    page.getByRole("dialog", { name: "Comment thread" }).getByText("Second pin"),
  ).toBeVisible();
});
