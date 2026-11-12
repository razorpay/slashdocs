import { expect, signedOutPage, test } from "./fixtures";

// The landing page, as a signed-out reader sees it.

test("the install command fades only on the side that hides text", async ({
  browser,
}) => {
  const page = await signedOutPage(browser);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const command = page.locator("pre", { hasText: "install.sh | sh" }).first();
  await expect(command).toBeVisible();
  const mask = () => command.evaluate((el) => el.style.maskImage);
  await expect
    .poll(mask)
    .toBe(
      "linear-gradient(to right, black, black calc(100% - 3.5rem), transparent calc(100% - 2.25rem))",
    );
  await command.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
  await expect
    .poll(mask)
    .toBe("linear-gradient(to right, transparent, black 1.5rem, black)");
});
