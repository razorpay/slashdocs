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
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { Sheet } from "@/components/ui/sheet";
import { clearFieldDrafts } from "@/lib/field-drafts";
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
  grantError?: string;
  deployment?: "org" | "public";
  // The grant from the parent folder is gone, as after a remote revoke.
  inheritedGone?: boolean;
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
          deployment: options.deployment ?? "org",
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
      if (url.startsWith("/v1/documents/doc_1/access-requests/")) {
        return new Response(null, { status: 204 });
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
            { error: { code: "unavailable", message: "try again" } },
            503,
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
            ...(options.inheritedGone
              ? []
              : [
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
                ]),
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
        if (options.grantError) {
          return jsonResponse(
            { error: { code: "bad_request", message: options.grantError } },
            400,
          );
        }
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

function renderShare(canManageAccess = true) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <Sheet open>
        <ShareSheet docId="doc_1" canManageAccess={canManageAccess} />
      </Sheet>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  clearFieldDrafts();
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
    expect(await screen.findByText(/Could not load who has access/)).toBeVisible();
  });

  it("says that access is unknown while the list fails, and loads it on Retry", async () => {
    const user = userEvent.setup();
    const options: FetchOptions = { accessFails: true };
    installFetch(options);
    renderShare(false);

    expect(await screen.findByText(/Could not load who has access/)).toBeVisible();
    expect(screen.getByText("Unknown")).toBeVisible();
    expect(screen.queryByRole("button", { name: /General access role/ })).toBeNull();
    expect(screen.queryByText(/Sharing is read-only/)).toBeNull();

    options.accessFails = false;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("button", { name: "General access role: No access" }),
    ).toBeDisabled();
    expect(screen.getByText(/Sharing is read-only/)).toBeVisible();
    expect(screen.queryByText("Unknown")).toBeNull();
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

  it("shares with a requester in the chosen role, or declines", async () => {
    const calls = installFetch({
      requesters: [
        { type: "user", id: "usr_reader", email: "reader@example.com", name: "Reader" },
        { type: "service_account", id: "sa_bot", name: "report-bot@brave.otter.bot" },
      ],
    });
    renderShare();
    const user = userEvent.setup();
    expect(await screen.findByText("Requests for access")).toBeVisible();
    expect(screen.getByText("report-bot@brave.otter.bot (bot)")).toBeVisible();
    expect(screen.getAllByText(/^Asked /)).toHaveLength(2);

    await user.click(
      screen.getByRole("button", { name: "Role for reader@example.com: Commenter" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Editor" }));
    await user.click(
      screen.getByRole("button", { name: "Share with reader@example.com" }),
    );
    await waitFor(() => {
      const grant = calls.find((call) => call.url === "/v1/documents/doc_1/grants");
      expect(JSON.parse(String(grant?.init?.body))).toEqual({
        address: "reader@example.com",
        role: "editor",
      });
    });

    await user.click(
      screen.getByRole("button", { name: "Decline report-bot@brave.otter.bot" }),
    );
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.url === "/v1/documents/doc_1/access-requests/service_account/sa_bot" &&
            call.init?.method === "DELETE",
        ),
      ).toBe(true),
    );
  });

  it("shows a failed share under the field, and clears it on a change", async () => {
    installFetch({
      groupsEnabled: false,
      userItems: [{ id: "usr_ana", email: "ana@example.com", name: "Ana" }],
      grantError: "No slashdocs user exists for that email.",
    });
    renderShare();
    const user = userEvent.setup();
    const input = await screen.findByRole("combobox", { name: "Person or bot" });
    expect(input).toHaveAttribute("placeholder", "Email or bot address");
    await user.type(input, "ana@example.co");
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No slashdocs user exists for that email.",
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    await user.type(input, "m");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers the invite link for an address with no account on a public server", async () => {
    installFetch({
      deployment: "public",
      groupsEnabled: false,
      userItems: [],
      grantError: "No slashdocs user exists for that email.",
    });
    renderShare();
    const user = userEvent.setup();
    const input = await screen.findByRole("combobox", { name: "Person or bot" });
    await user.type(input, "nobody@example.com");
    expect(await screen.findByText(/None of your contacts match/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Share" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No slashdocs user exists",
    );
    // The error replaces the hint, so the two do not say the same thing.
    expect(screen.queryByText(/None of your contacts match/)).toBeNull();
    // userEvent.setup puts in its own clipboard, so the stub comes after it.
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    await user.click(screen.getByRole("button", { name: "Copy invite link" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("/app/d/doc_1"));
  });

  it("does not offer Share for an address that has no account", async () => {
    installFetch({ groupsEnabled: false, userItems: [] });
    renderShare();
    const user = userEvent.setup();
    const input = await screen.findByRole("combobox", { name: "Person or bot" });
    await user.type(input, "nobody@example.com");
    expect(await screen.findByText(/They need to sign in once/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();
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

  it("says when Copy fails, and selects the link", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    installFetch();
    renderShare();
    await userEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    expect(await screen.findByRole("button", { name: "Could not copy" })).toBeVisible();
    expect(window.getSelection()?.toString()).toContain("/app/d/doc_1");
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

describe("the words of a share", () => {
  it("keeps the words of each target type through a change, and no group of the other", async () => {
    installFetch();
    renderShare();
    const user = userEvent.setup();
    const people = await screen.findByRole("tab", { name: "People and bots" });
    await user.type(screen.getByRole("combobox", { name: "Person or bot" }), "ana@");
    // The target types are one tab stop, and the arrow keys move between them.
    people.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Google Groups" })).toHaveFocus();
    const group = screen.getByRole("combobox", { name: "Google Group" });
    expect(group).toHaveValue("");
    await user.type(group, "plat");
    await user.click(await screen.findByText("Platform"));
    expect(screen.getByRole("button", { name: "Share" })).toBeEnabled();

    await user.click(screen.getByRole("tab", { name: "People and bots" }));
    expect(screen.getByRole("combobox", { name: "Person or bot" })).toHaveValue("ana@");
    await user.click(screen.getByRole("tab", { name: "Google Groups" }));
    expect(screen.getByRole("combobox", { name: "Google Group" })).toHaveValue(
      "platform@example.com",
    );
    expect(screen.getByRole("button", { name: "Share" })).toBeDisabled();
  });

  it("says when an inherited grant changed elsewhere before its change is confirmed", async () => {
    const options: FetchOptions = {};
    installFetch(options);
    const { client } = renderShare();
    const user = userEvent.setup();
    const row = (await screen.findByText("Inherited group")).closest(
      "div.flex.justify-between",
    );
    await user.click(
      within(row as HTMLElement).getByRole("button", { name: "Access role: Viewer" }),
    );
    await user.click(screen.getByRole("menuitem", { name: "Remove access" }));
    expect(await screen.findByText("Remove access for Inherited group?")).toBeTruthy();

    options.inheritedGone = true;
    await client.invalidateQueries();
    expect(
      await screen.findByText("This access changed elsewhere. It is removed now."),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove from folder" })).toBeDisabled();
  });

  it("keeps an unsent address through a close, and says that it came back", async () => {
    installFetch({ groupsEnabled: false });
    const first = renderShare();
    const user = userEvent.setup();
    await user.type(
      await screen.findByRole("combobox", { name: "Person or bot" }),
      "ana@example.com",
    );
    first.unmount();
    renderShare();
    expect(await screen.findByRole("combobox", { name: "Person or bot" })).toHaveValue(
      "ana@example.com",
    );
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("combobox", { name: "Person or bot" })).toHaveValue("");
  });
});

describe("A share that ends after the sheet closed", () => {
  for (const [result, kind, text] of [
    ["succeeds", "success", "Shared with ana@example.com."],
    ["fails", "error", "No slashdocs user exists for that email."],
  ] as const) {
    it(`says so in a toast when it ${result}`, async () => {
      installFetch({ groupsEnabled: false });
      let answer!: { resolve: () => void; reject: (e: Error) => void };
      vi.spyOn(api, "createGrant").mockReturnValue(
        new Promise((resolve, reject) => {
          answer = { resolve: () => resolve({} as never), reject };
        }),
      );
      const shown = vi.spyOn(toast, kind);
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      const sheet = (open: boolean) => (
        <QueryClientProvider client={client}>
          <Sheet open={open}>
            <ShareSheet docId="doc_1" />
          </Sheet>
        </QueryClientProvider>
      );
      const { rerender } = render(sheet(true));
      const user = userEvent.setup();
      await user.type(
        await screen.findByRole("combobox", { name: "Person or bot" }),
        "ana@example.com",
      );
      await user.click(screen.getByRole("button", { name: "Share" }));
      rerender(sheet(false));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      if (kind === "success") answer.resolve();
      else answer.reject(new Error(text));
      await waitFor(() => expect(shown).toHaveBeenCalledWith(text));
    });
  }
});
