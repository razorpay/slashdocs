import { type Page } from "@playwright/test";
import { expect, test, uniqueName } from "./fixtures";

const documentHTML = (title: string) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1><p>Move-tree browser coverage.</p></body></html>`;

const node = (
  id: string,
  title: string,
  parentId: string | null,
  extra: Record<string, unknown> = {},
) => ({
  id,
  title,
  parent_id: parentId,
  access: "edit",
  selectable: true,
  ...extra,
});

function bootstrap(documentId: string, title: string) {
  return {
    resource: {
      type: "document",
      id: documentId,
      title,
      can_move: true,
      source: { kind: "folder", folder_id: "c", token: "ms1_browser_source" },
    },
    documents: {
      selectable: true,
      current: false,
      can_create_child: true,
      would_lose_access: true,
    },
    path: ["a", "b", "c"],
    path_restricted_prefix: true,
    levels: [
      {
        parent: null,
        items: [
          node("a", "A", null, {
            access: "view",
            selectable: false,
            reason: "view_only",
            has_children: true,
          }),
          node("other", "Other", null),
        ],
      },
      {
        parent: "a",
        items: [
          node("b", "B", "a", { has_children: true }),
          node("a-sibling", "A sibling", "a"),
        ],
      },
      {
        parent: "b",
        items: [
          node("c", "C", "b", {
            current: true,
            reason: "current",
            selectable: false,
            has_children: true,
          }),
          node("b-sibling", "B sibling", "b"),
        ],
        after: "cursor-b",
      },
    ],
    focus: "c",
  };
}

function revealedBootstrap(documentId: string, title: string) {
  return {
    ...bootstrap(documentId, title),
    path: ["a", "plans", "roadmap"],
    levels: [
      {
        parent: null,
        items: [
          node("a", "A", null, {
            access: "view",
            selectable: false,
            reason: "view_only",
            has_children: true,
          }),
        ],
      },
      {
        parent: "a",
        items: [node("plans", "Plans", "a", { has_children: true })],
      },
      {
        parent: "plans",
        items: [node("roadmap", "Roadmap", "plans")],
      },
    ],
    focus: "roadmap",
  };
}

async function mockMoveTree(page: Page, documentId: string, title: string) {
  const moves: Array<Record<string, unknown>> = [];
  await page.route("**/v1/move-destinations**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/search")) {
      await route.fulfill({
        json: {
          items: [
            node("roadmap", "Roadmap", "plans", {
              ancestors: [
                { id: "a", title: "A" },
                { id: "plans", title: "Plans" },
              ],
            }),
          ],
          has_more: false,
        },
      });
      return;
    }
    if (url.pathname.endsWith("/children")) {
      await route.fulfill({
        json: {
          parent: url.searchParams.get("parent"),
          items: [node("later", "Later", "b")],
        },
      });
      return;
    }
    await route.fulfill({
      json: url.searchParams.get("reveal")
        ? revealedBootstrap(documentId, title)
        : bootstrap(documentId, title),
    });
  });
  await page.route(`**/v1/documents/${documentId}/move`, async (route) => {
    moves.push(route.request().postDataJSON() as Record<string, unknown>);
    await route.fulfill({
      json: {
        document_id: documentId,
        moved: true,
        destination: { kind: "root" },
        access_lost: true,
      },
    });
  });
  return moves;
}

test.use({
  video: process.env.SLASHDOCS_E2E_VIDEO === "1" ? "on" : "retain-on-failure",
});

test("Esc V opens the move tree and supports pagination, search reveal, and access-loss confirmation", async ({
  page,
  slashdocs,
}) => {
  const title = uniqueName("Move tree desktop");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  const moves = await mockMoveTree(page, document.id, title);
  await page.goto(`/app/d/${document.id}`);
  await expect(page.getByRole("button", { name: "More", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("v");

  const dialog = page.getByRole("dialog", { name: `Move “${title}”` });
  await expect(dialog).toBeVisible();
  const tree = dialog.getByRole("tree", { name: "Move destination folders" });
  await expect(tree.getByRole("treeitem", { name: /A.*View only/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(tree.getByRole("treeitem", { name: "B", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await expect(tree.getByRole("treeitem", { name: /C.*Current/ })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await expect(tree.getByRole("treeitem", { name: "A sibling" })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "B sibling" })).toBeVisible();

  await tree
    .getByRole("treeitem", { name: "Show more folders in Documents / A / B" })
    .click();
  await expect(tree.getByRole("treeitem", { name: "Later" })).toBeVisible();

  const search = dialog.getByRole("searchbox", { name: "Search all folders" });
  await search.fill("r");
  await expect(
    dialog.getByText("Type at least 2 characters to search all folders."),
  ).toBeVisible();
  await search.fill("roadmap");
  await dialog.getByRole("button", { name: /Roadmap/ }).click();
  await expect(tree.getByRole("treeitem", { name: "Roadmap" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await tree.getByRole("treeitem", { name: "Documents" }).click();
  await expect(
    dialog.getByText(/Moving to Documents will remove your access/),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Move and lose access" }).click();
  await expect(dialog).toBeHidden();
  await expect(
    page.getByText("Moved to Documents. You no longer have access to this document."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveCount(0);
  expect(moves).toEqual([
    {
      destination: { kind: "root" },
      source_token: "ms1_browser_source",
      acknowledge_access_loss: true,
    },
  ]);
});

test("the move tree is a bottom sheet with mobile-sized controls", async ({
  page,
  slashdocs,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const title = uniqueName("Move tree mobile");
  const document = await slashdocs.createDocument(title, documentHTML(title));
  await mockMoveTree(page, document.id, title);
  await page.goto(`/app/d/${document.id}`);
  await expect(page.getByRole("button", { name: "More", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.keyboard.press("v");

  const dialog = page.getByRole("dialog", { name: `Move “${title}”` });
  await expect(dialog).toBeVisible();
  await expect
    .poll(async () => {
      const settledBox = await dialog.boundingBox();
      return settledBox ? Math.abs(settledBox.y + settledBox.height - 844) : Infinity;
    })
    .toBeLessThanOrEqual(1);
  const box = await dialog.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBe(0);
  expect(box!.width).toBe(390);
  const radii = await dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      top: style.borderTopLeftRadius,
      bottom: style.borderBottomLeftRadius,
    };
  });
  expect(radii.top).not.toBe("0px");
  expect(radii.bottom).toBe("0px");

  const tree = dialog.getByRole("tree", { name: "Move destination folders" });
  await expect(tree.getByRole("treeitem", { name: /A.*View only/ })).toBeVisible();
  for (const control of [
    dialog.getByRole("searchbox", { name: "Search all folders" }),
    dialog.getByRole("button", { name: "Cancel" }),
    dialog.getByRole("button", { name: "Move" }),
  ]) {
    const controlBox = await control.boundingBox();
    expect(controlBox?.height).toBeGreaterThanOrEqual(44);
  }
});
