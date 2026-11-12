import { expect, test, type Page, type Route } from "@playwright/test";

type Actor = "owner" | "direct" | "nested" | "removed";

type WorkspaceState = {
  actor: Actor;
  documentGroupRole?: string;
  folderGroupRole?: string;
  removalCacheExpired: boolean;
  googleFailure: boolean;
  directShares: string[];
};

const owner = {
  type: "user",
  id: "owner",
  email: "owner@example.com",
  name: "Owner",
};
const group = {
  type: "google_group",
  id: "groups/platform",
  email: "platform@example.com",
  name: "Platform",
};
const document = {
  id: "doc_1",
  title: "Group Plan",
  owner,
  current_version_id: "ver_1",
  parent_folder_id: "fld_1",
  parent_folder: { id: "fld_1", title: "Shared Folder" },
};
const folder = { id: "fld_1", title: "Shared Folder", owner, ancestors: [] };

function newState(): WorkspaceState {
  return {
    actor: "owner",
    removalCacheExpired: false,
    googleFailure: false,
    directShares: [],
  };
}

function actorPrincipal(actor: Actor) {
  if (actor === "owner") return owner;
  return {
    type: "user",
    id: actor,
    email: `${actor}@example.com`,
    name: actor[0].toUpperCase() + actor.slice(1),
  };
}

function isCurrentGroupMember(state: WorkspaceState) {
  return (
    state.actor === "direct" ||
    state.actor === "nested" ||
    (state.actor === "removed" && !state.removalCacheExpired)
  );
}

function documentRole(state: WorkspaceState) {
  if (state.actor === "owner") return "owner";
  if (!isCurrentGroupMember(state)) return "";
  return state.documentGroupRole || state.folderGroupRole || "";
}

function folderRole(state: WorkspaceState) {
  if (state.actor === "owner") return "owner";
  return isCurrentGroupMember(state) ? state.folderGroupRole || "" : "";
}

function json(route: Route, payload: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(payload),
  });
}

function dependencyUnavailable(route: Route) {
  return json(
    route,
    {
      error: {
        code: "group_membership_unavailable",
        message: "Google Group membership could not be refreshed; try again shortly",
      },
    },
    503,
  );
}

function accessItems(state: WorkspaceState, resource: "document" | "folder") {
  const items: unknown[] = [
    {
      principal: owner,
      effective_role: "owner",
      sources: [
        {
          resource_type: resource,
          resource_id: resource === "document" ? "doc_1" : "fld_1",
          resource_title: resource === "document" ? "Group Plan" : "Shared Folder",
          role: "owner",
        },
      ],
    },
  ];
  const role =
    resource === "document"
      ? state.documentGroupRole || state.folderGroupRole
      : state.folderGroupRole;
  if (role) {
    const inherited = resource === "document" && !state.documentGroupRole;
    items.push({
      principal: group,
      effective_role: role,
      sources: [
        {
          resource_type: inherited ? "folder" : resource,
          resource_id: inherited
            ? "fld_1"
            : resource === "document"
              ? "doc_1"
              : "fld_1",
          resource_title: inherited
            ? "Shared Folder"
            : resource === "document"
              ? "Group Plan"
              : "Shared Folder",
          role,
          grant_id: inherited ? "gr_folder" : `gr_${resource}`,
        },
      ],
    });
  }
  for (const address of state.directShares) {
    const serviceAccount = address.endsWith(".bot");
    items.push({
      principal: {
        type: serviceAccount ? "service_account" : "user",
        id: serviceAccount ? "sa_report" : "usr_alice",
        email: address,
        name: serviceAccount ? "Report bot" : "Alice",
      },
      effective_role: "commenter",
      sources: [
        {
          resource_type: resource,
          resource_id: resource === "document" ? "doc_1" : "fld_1",
          resource_title: resource === "document" ? "Group Plan" : "Shared Folder",
          role: "commenter",
          grant_id: `gr_${address}`,
        },
      ],
    });
  }
  return items;
}

async function installFakeWorkspace(page: Page, state: WorkspaceState) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "slashdocs.onboarding",
      JSON.stringify({
        status: "skipped",
        steps: {
          cli_installed: false,
          cli_authed: false,
          agent_configured: false,
          first_doc_seen: false,
        },
      }),
    );
  });
  await page.route("**/fake-render**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><title>Rendered group plan</title><body style="min-height:5000px"><p>Visible document content</p><script>document.addEventListener("click",()=>parent.postMessage({type:"slashdocs:document-click"},location.origin))</script></body>',
    }),
  );
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/v1/me") {
      const principal = actorPrincipal(state.actor);
      return json(route, { principal, user: principal });
    }
    if (path === "/v1/config") {
      return json(route, {
        deployment: "org",
        org_name: "Acme",
        everyone_label: "Anyone in Acme",
        google_groups_enabled: true,
      });
    }
    if (path === "/v1/google-groups") {
      if (state.googleFailure) {
        return json(
          route,
          { error: { code: "dependency_unavailable", message: "temporary" } },
          503,
        );
      }
      return json(route, { items: [group] });
    }
    if (path === "/v1/users") {
      return json(route, {
        items: [
          {
            type: "user",
            id: "usr_alice",
            email: "alice@example.com",
            name: "Alice",
          },
        ],
      });
    }
    if (path === "/v1/pins") return json(route, { items: [] });

    if (path === "/v1/documents" && method === "GET") {
      if (state.googleFailure && state.actor !== "owner") {
        return dependencyUnavailable(route);
      }
      return json(route, { items: documentRole(state) ? [document] : [] });
    }
    if (path === "/v1/folders" && method === "GET") {
      if (state.googleFailure && state.actor !== "owner") {
        return dependencyUnavailable(route);
      }
      if (url.searchParams.get("folder_id") === "fld_1") {
        return json(route, {
          folder,
          items: documentRole(state) ? [{ type: "document", document }] : [],
          has_more: false,
        });
      }
      return json(route, {
        items: folderRole(state) ? [{ type: "folder", folder }] : [],
        has_more: false,
      });
    }
    if (path === "/v1/documents/doc_1" && method === "GET") {
      if (state.googleFailure && state.actor !== "owner") {
        return dependencyUnavailable(route);
      }
      if (!documentRole(state)) {
        return json(
          route,
          { error: { code: "forbidden", message: "viewer role required" } },
          403,
        );
      }
      return json(route, document);
    }
    if (path === "/v1/folders/fld_1" && method === "GET") {
      if (state.googleFailure && state.actor !== "owner") {
        return dependencyUnavailable(route);
      }
      if (!folderRole(state)) {
        return json(
          route,
          { error: { code: "forbidden", message: "viewer role required" } },
          403,
        );
      }
      return json(route, folder);
    }
    if (path === "/v1/documents/doc_1/versions") {
      return json(route, { items: [{ id: "ver_1", number: 1 }] });
    }
    if (path === "/v1/documents/doc_1/comments") return json(route, { items: [] });
    if (path === "/v1/documents/doc_1/versions/ver_1/render-token") {
      return json(route, { token: "fake", url: `${url.origin}/fake-render` });
    }
    if (path === "/v1/documents/doc_1/access") {
      return json(route, {
        current_role: documentRole(state),
        items: accessItems(state, "document"),
      });
    }
    if (path === "/v1/folders/fld_1/access") {
      return json(route, {
        current_role: folderRole(state),
        items: accessItems(state, "folder"),
      });
    }
    if (path === "/v1/documents/doc_1/grants" && method === "POST") {
      const body = request.postDataJSON() as {
        principal?: { type?: string; email?: string };
        address?: string;
        role: string;
      };
      if (body.principal?.type === "google_group") {
        state.documentGroupRole = body.role;
        return json(
          route,
          { id: "gr_document", principal: group, role: body.role },
          201,
        );
      }
      if (body.address) state.directShares.push(body.address);
      return json(route, { id: "gr_direct", role: body.role }, 201);
    }
    if (path === "/v1/folders/fld_1/grants" && method === "POST") {
      const body = request.postDataJSON() as {
        principal?: { type?: string };
        role: string;
      };
      if (body.principal?.type === "google_group") state.folderGroupRole = body.role;
      return json(route, { id: "gr_folder", principal: group, role: body.role }, 201);
    }

    return json(route, { error: { code: "not_found", message: path } }, 404);
  });
}

async function shareWithPlatformGroup(page: Page) {
  await page.getByRole("button", { name: "Share" }).click();
  const shareSheet = page.getByRole("dialog", { name: /^Share (document|folder)$/ });
  await shareSheet.getByRole("tab", { name: "Google Groups" }).click();
  await shareSheet.getByPlaceholder("Search group name or email").fill("platform");
  await shareSheet
    .locator("button")
    .filter({ hasText: "Platform" })
    .filter({ hasText: "platform@example.com" })
    .click();
  await shareSheet.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByText("Access granted.")).toBeVisible();
}

test("owner shares a document and folder with a verified group", async ({ page }) => {
  const state = newState();
  await installFakeWorkspace(page, state);

  await page.goto("/app/d/doc_1");
  await expect(page.getByText("Group Plan", { exact: true })).toBeVisible();
  await expect(
    page.frameLocator("iframe").getByText("Visible document content"),
  ).toBeVisible();
  await shareWithPlatformGroup(page);
  await expect.poll(() => state.documentGroupRole).toBe("commenter");

  await page.keyboard.press("Escape");
  await page.goto("/app/folders/fld_1");
  await expect(page.getByText("Shared Folder", { exact: true }).first()).toBeVisible();
  await shareWithPlatformGroup(page);
  await expect.poll(() => state.folderGroupRole).toBe("commenter");
});

test("keeps the sandboxed document scrollable while sharing is open", async ({
  page,
}) => {
  const state = newState();
  await installFakeWorkspace(page, state);

  await page.goto("/app/d/doc_1");
  const frame = page.locator('iframe[title="Rendered document"]');
  const rendered = page.frameLocator('iframe[title="Rendered document"]');
  await expect(rendered.getByText("Visible document content")).toBeVisible();
  await frame.focus();
  await page.getByRole("button", { name: "Share", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Share document" })).toBeVisible();

  expect(
    await page.evaluate(() => globalThis.document.activeElement?.getAttribute("title")),
  ).toBe("Rendered document");
  expect(
    await page.evaluate(() =>
      globalThis.document.body.hasAttribute("data-scroll-locked"),
    ),
  ).toBe(false);
  const box = await frame.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, 600);
  await expect
    .poll(() =>
      rendered
        .locator("html")
        .evaluate((html) => html.ownerDocument.defaultView?.scrollY ?? 0),
    )
    .toBeGreaterThan(0);
  await expect(page.getByRole("dialog", { name: "Share document" })).toBeVisible();

  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.getByRole("dialog", { name: "Share document" })).toBeHidden();
});

test("direct and nested members discover and open group-shared resources", async ({
  page,
}) => {
  const state = newState();
  state.documentGroupRole = "viewer";
  state.folderGroupRole = "editor";
  state.actor = "direct";
  await installFakeWorkspace(page, state);

  for (const actor of ["direct", "nested"] as const) {
    state.actor = actor;
    await page.goto("/app/documents");
    await expect(page.getByText("Group Plan", { exact: true }).first()).toBeVisible();
    await page.goto("/app/d/doc_1");
    await expect(page.getByText("Group Plan", { exact: true })).toBeVisible();
  }
});

test("removed members lose access after the membership cache expires", async ({
  page,
}) => {
  const state = newState();
  state.actor = "direct";
  state.documentGroupRole = "viewer";
  await installFakeWorkspace(page, state);

  await page.goto("/app/d/doc_1");
  await expect(page.getByText("Group Plan", { exact: true })).toBeVisible();
  state.actor = "removed";
  await page.reload();
  await expect(page.getByText("Group Plan", { exact: true })).toBeVisible();

  state.removalCacheExpired = true;
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "You don't have access to this document" }),
  ).toBeVisible({ timeout: 12_000 });
  await expect(
    page.frameLocator("iframe").getByText("Visible document content"),
  ).toHaveCount(0);
});

test("nested group access inherited from a parent folder opens the document", async ({
  page,
}) => {
  const state = newState();
  state.actor = "nested";
  state.folderGroupRole = "editor";
  await installFakeWorkspace(page, state);

  await page.goto("/app/folders/fld_1");
  await expect(page.getByText("Group Plan", { exact: true }).first()).toBeVisible();
  await page.goto("/app/d/doc_1");
  await expect(page.getByText("Shared Folder", { exact: true })).toBeVisible();
  await expect(page.getByText("Group Plan", { exact: true })).toBeVisible();
});

test("Google failure shows a temporary error and never renders stale content", async ({
  page,
}) => {
  const state = newState();
  state.actor = "direct";
  state.documentGroupRole = "viewer";
  state.googleFailure = true;
  await installFakeWorkspace(page, state);

  await page.goto("/app/d/doc_1");
  await expect(
    page.getByRole("heading", { name: "Group access is temporarily unavailable" }),
  ).toBeVisible({ timeout: 12_000 });
  await expect(page.getByText(/stale group access has not been used/i)).toBeVisible();
  await expect(
    page.frameLocator("iframe").getByText("Visible document content"),
  ).toHaveCount(0);
});

test("existing user and service-account sharing remains available", async ({
  page,
}) => {
  const state = newState();
  await installFakeWorkspace(page, state);
  await page.goto("/app/d/doc_1");
  await page.getByRole("button", { name: "Share" }).click();

  const shareSheet = page.getByRole("dialog", { name: "Share document" });
  const input = shareSheet.getByPlaceholder(/user@org\.example/);
  await input.fill("alice");
  await shareSheet.getByRole("button", { name: /Alice/ }).click();
  await shareSheet.getByRole("button", { name: "Share", exact: true }).click();
  await expect.poll(() => state.directShares).toContain("alice@example.com");
  await expect(input).toHaveValue("");

  await input.fill("report-creator@brave.otter.bot");
  await shareSheet.getByRole("button", { name: "Share", exact: true }).click();
  await expect
    .poll(() => state.directShares)
    .toContain("report-creator@brave.otter.bot");
});
