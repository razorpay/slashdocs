import {
  expect,
  overlaps,
  paragraphsHTML,
  renderedDocument,
  test,
  uniqueName,
} from "./fixtures";

// Classic scroll bars, which take room, as on a desktop with a mouse. The
// content moves under the Comments panel while the scroll bar stays at the
// edge, and a page keeps its column when its scroll bar comes and goes.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("a thread follows its anchor from under the Comments panel, and the scroll bar stays at the edge", async ({
  page,
  slashdocs,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const title = uniqueName("Glide thread");
  const document = await slashdocs.createDocument(
    title,
    paragraphsHTML(title, { paragraphs: 12, width: 640 }),
  );
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
