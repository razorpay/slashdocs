import { type Page } from "@playwright/test";
import { APP_ORIGIN, expect, test, uniqueName } from "./fixtures";

function documentHTML(title: string) {
  return `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>${title}</title></head>
  <body><h1>${title}</h1><p>Write the notes.</p></body>
</html>`;
}

const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    return el?.getAttribute("aria-label") || el?.textContent?.trim() || el?.tagName;
  });

// People that the users search finds, so that the test needs no real accounts.
const PEOPLE = {
  items: [
    { type: "user", id: "usr_r10_ann", email: "ann.r10@example.com", name: "Ann R10" },
    { type: "user", id: "usr_r10_bo", email: "bo.r10@example.com", name: "Bo R10" },
  ],
};

test("the settings pages are links that mark the current page, not tabs", async ({
  page,
}) => {
  await page.goto("/app/settings/profile");
  const nav = page.getByRole("navigation", { name: "Settings" });
  await expect(nav.getByRole("tab")).toHaveCount(0);
  const profile = nav.getByRole("link", { name: "Profile" });
  await expect(profile).toHaveAttribute("aria-current", "page");
  await profile.focus();
  await page.keyboard.press("Tab");
  const developers = nav.getByRole("link", { name: "Developers" });
  await expect(developers).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/app\/settings\/developers$/);
  await expect(nav.getByRole("link", { name: "Developers" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

test("the setup path is one tab stop, and the arrow keys, Home and End pick a path", async ({
  page,
}) => {
  await page.goto("/app/start");
  const tabs = page.getByRole("tablist", { name: "Setup path" });
  const cli = tabs.getByRole("tab", { name: "Terminal (CLI)" });
  const mcp = tabs.getByRole("tab", { name: "Agent app (MCP)" });
  await cli.click();
  await expect(cli).toHaveAttribute("tabindex", "0");
  await expect(mcp).toHaveAttribute("tabindex", "-1");

  await page.keyboard.press("ArrowRight");
  await expect(mcp).toBeFocused();
  await expect(mcp).toHaveAttribute("aria-selected", "true");
  await expect(mcp).toHaveAttribute("tabindex", "0");
  const panel = page.getByRole("tabpanel", { name: "Agent app (MCP)" });
  await expect(panel).toContainText("Add slashdocs to your agent app");
  await expect(mcp).toHaveAttribute("aria-controls", (await panel.getAttribute("id"))!);
  await page.keyboard.press("ArrowRight");
  await expect(cli).toBeFocused();
  await expect(cli).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(mcp).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Home");
  await expect(cli).toHaveAttribute("aria-selected", "true");
  await expect(cli).toBeFocused();
  // The focus ring shows on the tab.
  const outline = await cli.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).toBe("solid");
});

test("Documents search: Tab leaves an empty list, Escape closes it, and Down opens it again", async ({
  page,
}) => {
  await page.goto("/app/documents");
  const search = page.getByRole("combobox", { name: "Search documents" });
  await search.click();
  await expect(search).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Tab");
  await expect(search).not.toBeFocused();
  expect(await focused(page)).not.toBe("BODY");

  await search.click();
  await search.pressSequentially("du");
  await page.keyboard.press("Escape");
  await expect(search).toHaveAttribute("aria-expanded", "false");
  await page.keyboard.press("ArrowDown");
  await expect(search).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Enter");
  await expect(search).toHaveValue("during:");
});

test("the recipient list in Share takes Down, Up, Enter and Escape, and the dialog stays", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Keys share r10");
  const doc = await slashdocs.createDocument(title, documentHTML(title));
  await page.route("**/v1/users?q=*", (route) => route.fulfill({ json: PEOPLE }));
  await page.goto(`/app/d/${doc.id}`);
  await page.getByRole("button", { name: "Share", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const field = dialog.getByRole("combobox", { name: "Person or bot" });
  await field.click();
  await field.pressSequentially("r10");
  await expect(field).toHaveAttribute("aria-expanded", "true");
  const active = () =>
    field.evaluate(
      (el) =>
        document.getElementById(el.getAttribute("aria-activedescendant") || "")
          ?.textContent,
    );
  await expect.poll(active).toContain("Ann R10");
  await page.keyboard.press("ArrowDown");
  await expect.poll(active).toContain("Bo R10");
  await page.keyboard.press("ArrowDown");
  await expect.poll(active).toContain("Bo R10");
  await page.keyboard.press("ArrowUp");
  await expect.poll(active).toContain("Ann R10");
  await page.keyboard.press("Escape");
  await expect(field).toHaveAttribute("aria-expanded", "false");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(field).toHaveValue("ann.r10@example.com");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
});

test("a failed mention search says so and keeps the words, and Retry finds the people", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Keys mention r10");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "R10 mention", {
    quote: "Write the notes.",
  });
  let fail = true;
  await page.route("**/v1/users?q=*", (route) =>
    fail
      ? route.fulfill({ status: 503, json: { error: { code: "unavailable" } } })
      : route.fulfill({ json: PEOPLE }),
  );
  await page.goto(`/app/d/${document.id}?comment=${comment.id}`);
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  const reply = thread.getByPlaceholder("Reply…");
  await reply.click();
  await reply.pressSequentially("Ask @r1");
  await expect(
    thread.getByText("Could not search people. Your words stay."),
  ).toBeVisible();
  await expect(reply).toHaveValue("Ask @r1");

  fail = false;
  await thread.getByRole("button", { name: "Retry" }).click();
  await expect(reply).toBeFocused();
  const option = page.getByRole("option", { name: /Bo R10/ });
  await expect(option).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(option).toHaveAttribute("aria-selected", "true");
  // Escape closes the list, not the thread.
  await page.keyboard.press("Escape");
  await expect(option).toBeHidden();
  await expect(thread).toBeVisible();
  await expect(reply).toHaveValue("Ask @r1");
});

test("the reaction picker moves as a 3x3 grid, and Escape gives the focus back", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Keys react r10");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const comment = await slashdocs.createComment(document.id, "R10 react", {
    quote: "Write the notes.",
  });
  // A thread shows its reactions, with Add reaction, once it has one.
  await page.request.put(
    `/v1/documents/${document.id}/comments/${comment.id}/reactions/heart`,
    { headers: { Origin: APP_ORIGIN } },
  );
  await page.goto(`/app/d/${document.id}?comment=${comment.id}`);
  const thread = page.getByRole("dialog", { name: "Comment thread" });
  const trigger = thread.getByRole("button", { name: "Add reaction" });
  await trigger.focus();
  await page.keyboard.press("Enter");
  const menu = page.getByRole("menu", { name: "Add reaction" });
  await expect(menu).toBeVisible();
  for (const [key, name] of [
    ["ArrowDown", "Celebrate"],
    ["ArrowRight", "Confused"],
    ["ArrowDown", "Eyes"],
    ["ArrowDown", "Thumbs down"],
    ["ArrowLeft", "Thumbs up"],
    ["ArrowLeft", "Plus one"],
  ]) {
    await page.keyboard.press(key);
    expect(await focused(page), key).toBe(name);
  }
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(thread).toBeVisible();

  // The same for the menu of the thread: Escape closes the menu, not the thread.
  const actions = thread.getByRole("button", { name: "More actions" });
  await actions.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(thread).toBeVisible();
  await expect(actions).toBeFocused();
});

test("a dialog that a menu item opened gives the focus back to the menu button", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Keys focus r10");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await page.goto(`/app/d/${document.id}`);
  const more = page.getByRole("button", { name: "More", exact: true });
  for (const item of ["Move to folder", "Delete document", "Keyboard shortcuts"]) {
    // With the pointer.
    await more.click();
    await page.getByRole("menuitem", { name: item }).click();
    const dialog = page.getByRole("dialog").or(page.getByRole("alertdialog"));
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(more, item).toBeFocused();
    // With the keyboard.
    await page.keyboard.press("Enter");
    await page.getByRole("menuitem", { name: item }).focus();
    await page.keyboard.press("Enter");
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(more, item).toBeFocused();
  }
});
