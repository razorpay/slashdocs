import { type Locator, type Page } from "@playwright/test";
import { expect, reviewerOn, test, uniqueName } from "./fixtures";

// The document bar keeps back, home and the title on the left, and every
// action on the right in one order, so that the icons never move.

// The names of the controls that show in the bar, from left to right.
async function barOrder(page: Page): Promise<string[]> {
  return page.locator("header").evaluate((header) =>
    [...header.querySelectorAll<HTMLElement>("a, button")]
      .filter((el) => el.checkVisibility() && el.getBoundingClientRect().width > 0)
      .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
      .map((el) => el.getAttribute("aria-label") ?? el.textContent!.trim()),
  );
}

for (const [width, people, account] of [
  [1440, true, true],
  [1024, true, true],
  [390, false, false],
] as const)
  test(`the bar keeps its order at ${width}px`, async ({
    page,
    browser,
    slashdocs,
  }) => {
    const title = uniqueName("Bar order");
    const document = await slashdocs.createDocument(title, `<h1>${title}</h1>`);
    await slashdocs.shareWithAnyone(document.id, "viewer");
    const reviewer = await reviewerOn(browser, `/app/d/${document.id}`);
    await page.setViewportSize({ width, height: 800 });
    await page.goto(`/app/d/${document.id}`);
    await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
    const viewers = page.getByRole("group", { name: "People viewing this document" });
    if (people) await expect(viewers.getByRole("button")).toHaveCount(1);
    const names = (await barOrder(page)).filter(
      (name) => !/^(Rename|slashdocs home|Back to)/.test(name),
    );
    expect(names).toEqual([
      ...(people ? [expect.stringMatching(/reviewer/i)] : []),
      "Edit",
      // The owner may ask for approval.
      ...(people ? ["Request approval"] : []),
      "Comments",
      "Share",
      "More",
      ...(account ? ["Account menu"] : []),
    ]);
    // History and Full screen are in More.
    await expect(
      page.locator("header").getByRole("button", { name: "History" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("menuitem", { name: "History" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /^Full screen/ })).toBeVisible();
    await reviewer.context().close();
  });

test("Done takes the place of Edit, and the icons after it stay", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Bar done");
  const document = await slashdocs.createDocument(title, `<p>${title}</p>`);
  await page.setViewportSize({ width: 1440, height: 800 });
  await page.goto(`/app/d/${document.id}`);
  const comments = page.getByRole("button", { name: "Comments" });
  await expect(page.getByRole("button", { name: "Edit", exact: true })).toBeVisible();
  const before = (await comments.boundingBox())!;
  await page.keyboard.press("e");
  const done = page.getByRole("button", { name: "Done", exact: true });
  await expect(done).toBeVisible();
  // The Esc key chip shows on a wide screen.
  await expect(done.getByText("Esc", { exact: true })).toBeVisible();
  expect((await comments.boundingBox())!.x).toBe(before.x);
});

const box = async (locator: Locator) => (await locator.boundingBox())!;

test("a phone bar keeps the title, and gives 40px targets", async ({
  page,
  browser,
  slashdocs,
}) => {
  const title = uniqueName("Phone bar title");
  const document = await slashdocs.createDocument(title, `<h1>${title}</h1>`);
  await slashdocs.shareWithAnyone(document.id, "viewer");
  // The document waits on one approval, so its chip would be in the bar.
  await page.route(`**/v1/documents/${document.id}`, async (route) => {
    const response = await route.fetch();
    const json = {
      ...(await response.json()),
      approval_status: "pending",
      approval_summary: { approved: 0, total: 1, rejected: 0, pending: 1 },
    };
    await route.fulfill({ response, json });
  });
  const path = `/app/d/${document.id}`;
  const reviewer = await reviewerOn(browser, path);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(path);

  const more = page.getByRole("button", { name: "More" });
  // More carries the badge of the approvals, as the bar has no room for them.
  await expect(more.locator('span[aria-hidden="true"]')).toBeVisible();
  await more.click();
  await expect(page.getByRole("menuitem", { name: /Follow reviewer/ })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Approvals/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("group", { name: "People viewing this document" }),
  ).toBeHidden();
  await expect(page.getByRole("button", { name: /^Approvals: / })).toBeHidden();
  await expect(page.getByRole("button", { name: "Account menu" })).toBeHidden();
  // About 7px a letter: at least 12 letters of the title show.
  expect(
    (await box(page.getByRole("button", { name: /^Rename/ }))).width,
  ).toBeGreaterThan(84);

  const comments = page.getByRole("button", { name: "Comments" });
  for (const target of [
    page.getByRole("button", { name: "Edit", exact: true }),
    page.getByRole("button", { name: "Share" }),
    comments,
    more,
  ]) {
    const { width, height } = await box(target);
    expect(Math.min(width, height)).toBeGreaterThanOrEqual(40);
  }
  await comments.click();
  const spot = page.getByRole("button", { name: "Comment on a spot" });
  expect((await box(spot)).height).toBeGreaterThanOrEqual(40);
  await reviewer.context().close();
});
