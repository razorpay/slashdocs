import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "@/components/ui/sheet";
import { ShareSheet } from "./doc-share-sheet";

type FetchOptions = {
  groupsEnabled?: boolean;
  groupSearchFails?: boolean;
  groupSearchDelayMs?: number;
  groupItems?: Array<{ id: string; email: string; name: string }>;
  userItems?: Array<{ id: string; email: string; name: string }>;
  accessFails?: boolean;
  owner?: { id: string; email?: string; name?: string };
  requesters?: Array<{ type: string; id: string; email?: string; name?: string }>;
};

function installFetch(options: FetchOptions = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/v1/config") {
        return jsonResponse({
          deployment: "org",
          org_name: "Acme",
          everyone_label: "Anyone in Acme",
          google_groups_enabled: options.groupsEnabled ?? true,
        });
      }
      if (url.startsWith("/v1/google-groups")) {
        if (options.groupSearchDelayMs) {
          await new Promise((resolve) =>
            setTimeout(resolve, options.groupSearchDelayMs),
          );
        }
        if (options.groupSearchFails) {
          return jsonResponse(
            { error: { code: "dependency_unavailable", message: "temporary" } },
            503,
          );
        }
        return jsonResponse({
          items: options.groupItems ?? [
            {
              id: "groups/platform",
              email: "platform@example.com",
              name: "Platform",
            },
          ],
        });
      }
      if (url.startsWith("/v1/users")) {
        return jsonResponse({ items: options.userItems ?? [] });
      }
      if (url === "/v1/documents/doc_1/access-requests") {
        return jsonResponse({
          items: (options.requesters ?? []).map((requester) => ({
            requester,
            requested_at: "2026-11-01T00:00:00Z",
          })),
        });
      }
      if (url === "/v1/documents/doc_1/access") {
        if (options.accessFails) {
          return jsonResponse(
            { error: { code: "forbidden", message: "not allowed" } },
            403,
          );
        }
        return jsonResponse({
          current_role: "owner",
          items: [
            {
              principal: {
                type: "user",
                ...(options.owner ?? {
                  id: "owner",
                  email: "owner@example.com",
                  name: "Owner",
                }),
              },
              effective_role: "owner",
              sources: [
                {
                  resource_type: "document",
                  resource_id: "doc_1",
                  resource_title: "Doc",
                  role: "owner",
                },
              ],
            },
            {
              principal: {
                type: "google_group",
                id: "groups/editors",
                email: "editors@example.com",
                name: "Editors",
              },
              effective_role: "editor",
              sources: [
                {
                  resource_type: "document",
                  resource_id: "doc_1",
                  resource_title: "Doc",
                  role: "editor",
                  grant_id: "gr_editors",
                },
              ],
            },
            {
              principal: {
                type: "google_group",
                id: "groups/inherited",
                email: "inherited@example.com",
                name: "Inherited group",
              },
              effective_role: "viewer",
              sources: [
                {
                  resource_type: "folder",
                  resource_id: "fld_parent",
                  resource_title: "Parent folder",
                  role: "viewer",
                  grant_id: "gr_inherited",
                },
              ],
            },
            {
              principal: {
                type: "user",
                id: "folder_owner",
                email: "folder-owner@example.com",
                name: "Folder Owner",
              },
              effective_role: "editor",
              sources: [
                {
                  resource_type: "folder",
                  resource_id: "fld_parent",
                  resource_title: "Parent folder",
                  role: "editor",
                },
              ],
            },
          ],
        });
      }
      if (url === "/v1/documents/doc_1/grants") {
        return jsonResponse({ id: "gr_new", role: "commenter" }, 201);
      }
      if (url.includes("/grants/")) return jsonResponse({ id: "gr_editors" });
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
  return calls;
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function renderShare() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Sheet open>
        <ShareSheet docId="doc_1" canManageAccess />
      </Sheet>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Google Group sharing", () => {
  it("switches target modes, debounces search, and requires verified selection", async () => {
    const calls = installFetch();
    renderShare();
    expect(await screen.findByRole("tab", { name: "Google Groups" })).toBeVisible();
    fireEvent.click(screen.getByRole("tab", { name: "Google Groups" }));
    const input = screen.getByPlaceholderText("Search group name or email");
    fireEvent.change(input, { target: { value: "plat" } });
    expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();
    await waitFor(() =>
      expect(calls.some((call) => call.url.includes("/v1/google-groups?q=plat"))).toBe(
        true,
      ),
    );
    await waitFor(() => expect(screen.getByText("platform@example.com")).toBeVisible());
    fireEvent.click(screen.getByText("Platform"));
    expect(screen.getByRole("button", { name: "Share" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Share" }));
    await waitFor(() => {
      const request = calls.find(
        (call) =>
          call.url === "/v1/documents/doc_1/grants" && call.init?.method === "POST",
      );
      expect(JSON.parse(String(request?.init?.body))).toEqual({
        principal: { type: "google_group", email: "platform@example.com" },
        role: "commenter",
      });
    });
  });

  it("shows dependency errors and hides group controls when disabled", async () => {
    installFetch({ groupSearchFails: true });
    renderShare();
    await userEvent.click(await screen.findByRole("tab", { name: "Google Groups" }));
    await userEvent.type(
      screen.getByPlaceholderText("Search group name or email"),
      "pl",
    );
    expect(
      await screen.findByText(/Google Group search is temporarily unavailable/i),
    ).toBeVisible();

    cleanup();
    vi.unstubAllGlobals();
    installFetch({ groupsEnabled: false });
    renderShare();
    await waitFor(() =>
      expect(screen.queryByRole("tab", { name: "Google Groups" })).toBeNull(),
    );
  });

  it("shows loading, empty, and access-authorization states", async () => {
    installFetch({ groupSearchDelayMs: 100, groupItems: [], accessFails: true });
    renderShare();
    await userEvent.click(await screen.findByRole("tab", { name: "Google Groups" }));
    await userEvent.type(
      screen.getByPlaceholderText("Search group name or email"),
      "zz",
    );
    expect(await screen.findByText("Searching Google Groups…")).toBeVisible();
    expect(
      await screen.findByText(/No verified organization groups matched/i),
    ).toBeVisible();
    expect(await screen.findByText("Could not load access list.")).toBeVisible();
  });

  it("distinguishes owner, direct, and inherited access", async () => {
    installFetch();
    renderShare();
    expect(await screen.findByText("Google Group · direct access")).toBeVisible();
    expect(screen.getByText("Inherited from Parent folder")).toBeVisible();
    expect(screen.getAllByText("Owner").length).toBeGreaterThan(0);
    // No grant gives the folder owner editor, so no grant can change it.
    const folderOwner = screen.getByText("Owner of Parent folder").closest("div.flex");
    expect(
      within(folderOwner as HTMLElement).getByRole("button", { name: /^Access role/ }),
    ).toBeDisabled();
  });

  it("lists requests for access and puts a requester in the share form", async () => {
    installFetch({
      requesters: [
        { type: "user", id: "usr_reader", email: "reader@example.com", name: "Reader" },
        { type: "service_account", id: "sa_bot", name: "report-bot@brave.otter.bot" },
      ],
    });
    renderShare();
    expect(await screen.findByText("Requests for access")).toBeVisible();
    expect(screen.getByText("report-bot@brave.otter.bot (bot)")).toBeVisible();
    for (const address of ["reader@example.com", "report-bot@brave.otter.bot"]) {
      await userEvent.click(
        screen.getByRole("button", { name: `Share with ${address}` }),
      );
      expect(screen.getByDisplayValue(address)).toBeVisible();
    }
  });

  it("does not expose an internal id for an unhydrated owner", async () => {
    installFetch({ owner: { id: "usr_google_123456789" } });
    renderShare();
    expect((await screen.findAllByText("Owner")).length).toBeGreaterThan(0);
    expect(screen.queryByText("usr_google_123456789")).toBeNull();
  });

  it("changes a role and removes access from the role menu", async () => {
    const calls = installFetch();
    renderShare();
    const user = userEvent.setup();
    const row = (await screen.findByText("Editors")).closest(
      "div.flex.justify-between",
    );
    const role = within(row as HTMLElement).getByRole("button", {
      name: "Access role: Editor",
    });
    await user.click(role);
    await user.click(screen.getByRole("menuitem", { name: "Viewer" }));
    await waitFor(() => {
      const request = calls.find(
        (call) =>
          call.url.endsWith("/grants/gr_editors") && call.init?.method === "PATCH",
      );
      expect(JSON.parse(String(request?.init?.body))).toEqual({ role: "viewer" });
    });
    await user.click(role);
    await user.click(screen.getByRole("menuitem", { name: "Remove access" }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url.endsWith("/grants/gr_editors") && call.init?.method === "DELETE",
        ),
      ).toBe(true),
    );
  });

  it("floats user suggestions and hides them once one is picked", async () => {
    installFetch({
      groupsEnabled: false,
      userItems: [{ id: "usr_ana", email: "ana@example.com", name: "Ana" }],
    });
    renderShare();
    const user = userEvent.setup();
    const input = await screen.findByRole("combobox", { name: "Person or bot" });
    await user.type(input, "an");
    expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();
    await user.click(await screen.findByRole("option", { name: /Ana/ }));
    expect(input).toHaveValue("ana@example.com");
    expect(screen.getByRole("button", { name: "Share" })).toBeEnabled();
    await waitFor(() =>
      expect(screen.queryByRole("option", { name: /Ana/ })).toBeNull(),
    );
  });

  it("moves through the suggestions with the keyboard and skips grantees", async () => {
    installFetch({
      groupsEnabled: false,
      userItems: [
        { id: "owner", email: "owner@example.com", name: "Owner" },
        { id: "usr_ana", email: "ana@example.com", name: "Ana" },
      ],
    });
    renderShare();
    const user = userEvent.setup();
    const input = await screen.findByRole("combobox", { name: "Person or bot" });
    await user.type(input, "ex");
    const owner = await screen.findByRole("option", { name: /Owner.*Has access/ });
    expect(owner).toHaveAttribute("aria-disabled", "true");
    await user.click(owner);
    expect(input).toHaveValue("ex");

    await user.keyboard("{ArrowDown}");
    const ana = screen.getByRole("option", { name: /Ana/ });
    expect(ana).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", ana.id);
    await user.keyboard("{Escape}");
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("dialog")).toBeVisible();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(input).toHaveValue("ana@example.com");
  });

  it("shows Copied on the link button for a moment", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    installFetch();
    renderShare();
    await userEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/app/d/doc_1"));
    expect(screen.getByRole("button", { name: "Copied" })).toBeVisible();
    await waitFor(
      () => expect(screen.getByRole("button", { name: "Copy link" })).toBeVisible(),
      { timeout: 2500 },
    );
  });
});
