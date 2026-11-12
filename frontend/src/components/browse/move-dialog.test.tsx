import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APIError,
  api,
  type MoveDestinationBootstrap,
  type MoveDestinationNode,
} from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { MoveDialog } from "./move-dialog";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const node = (
  id: string,
  title: string,
  parentId: string | null,
  extra: Partial<MoveDestinationNode> = {},
): MoveDestinationNode => ({
  id,
  title,
  parent_id: parentId,
  access: "edit",
  selectable: true,
  ...extra,
});

const bootstrap = (
  overrides: Partial<MoveDestinationBootstrap> = {},
): MoveDestinationBootstrap => ({
  resource: {
    type: "document",
    id: "doc_1",
    title: "Q3 plan",
    can_move: true,
    source: { kind: "folder", folder_id: "c", token: "ms1_source" },
  },
  documents: { selectable: true, current: false, can_create_child: true },
  path: ["a", "b", "c"],
  path_restricted_prefix: false,
  levels: [
    {
      parent: null,
      items: [
        node("a", "A", null, { has_children: true }),
        node("other", "Other", null),
      ],
    },
    { parent: "a", items: [node("b", "B", "a", { has_children: true })] },
    {
      parent: "b",
      items: [
        node("c", "C", "b", {
          current: true,
          reason: "current",
          selectable: false,
          has_children: true,
        }),
        node("sibling", "Sibling", "b"),
      ],
    },
  ],
  focus: "c",
  ...overrides,
});

function renderMove(
  props: {
    type?: "document" | "folder";
    id?: string;
    parentId?: string;
  } = {},
) {
  const onOpenChange = vi.fn();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MoveDialog
        open
        onOpenChange={onOpenChange}
        title="Q3 plan"
        type={props.type || "document"}
        id={props.id || "doc_1"}
        parentId={props.parentId}
      />
    </QueryClientProvider>,
  );
  return { onOpenChange, client };
}

function renderReopenMove() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open move
        </button>
        <MoveDialog
          open={open}
          onOpenChange={setOpen}
          title="Q3 plan"
          type="document"
          id="doc_1"
        />
      </>
    );
  }
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
  return { client };
}

describe("MoveDialog", () => {
  beforeEach(() => {
    vi.spyOn(api, "getMoveDestinations").mockResolvedValue(bootstrap());
    vi.spyOn(api, "searchMoveDestinations").mockResolvedValue({
      items: [],
      has_more: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the current path expanded and keeps the current folder collapsed", async () => {
    renderMove();

    const tree = await screen.findByRole("tree", {
      name: "Move destination folders",
    });
    expect(within(tree).getByRole("treeitem", { name: "A" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(tree).getByRole("treeitem", { name: "B" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(within(tree).getByRole("treeitem", { name: /C.*Current/ })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(within(tree).getByRole("treeitem", { name: /C.*Current/ })).toHaveAttribute(
      "tabindex",
      "0",
    );
    expect(screen.getByRole("searchbox", { name: "Search all folders" })).toHaveFocus();
  });

  it("keeps selection separate from expansion and moves only on confirmation", async () => {
    const user = userEvent.setup();
    const move = vi.spyOn(api, "moveDocument").mockResolvedValue({
      document_id: "doc_1",
      moved: true,
      destination: { kind: "folder", folder_id: "sibling" },
      undo: {
        destination: { kind: "folder", folder_id: "c" },
        source_token: "ms1_undo",
      },
    });
    renderMove();

    const sibling = await screen.findByRole("treeitem", { name: "Sibling" });
    await user.click(sibling);
    expect(sibling).toHaveAttribute("aria-selected", "true");
    expect(move).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Move to Sibling" }));
    await waitFor(() =>
      expect(move).toHaveBeenCalledWith(
        "doc_1",
        { kind: "folder", folder_id: "sibling" },
        "ms1_source",
      ),
    );
  });

  it("clears the prior destination and search before reopening from cache", async () => {
    const user = userEvent.setup();
    renderReopenMove();

    await user.click(await screen.findByRole("treeitem", { name: "Sibling" }));
    expect(screen.getByRole("button", { name: "Move to Sibling" })).toBeEnabled();
    await user.type(
      screen.getByRole("searchbox", { name: "Search all folders" }),
      "roadmap",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await user.click(await screen.findByRole("button", { name: "Open move" }));
    expect(
      await screen.findByRole("searchbox", { name: "Search all folders" }),
    ).toHaveValue("");
    const sibling = await screen.findByRole("treeitem", { name: "Sibling" });
    expect(sibling).toHaveAttribute("aria-selected", "false");
    expect(screen.queryByRole("button", { name: "Move to Sibling" })).toBeNull();
    expect(screen.getByRole("button", { name: "Move" })).toBeDisabled();
  });

  it("keeps view-only folders focusable and expandable but not selectable", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getMoveDestinations").mockResolvedValue(
      bootstrap({
        path: [],
        levels: [
          {
            parent: null,
            items: [
              node("locked", "Finance", null, {
                access: "view",
                selectable: false,
                reason: "view_only",
                has_children: true,
              }),
            ],
          },
        ],
        focus: "locked",
      }),
    );
    const children = vi.spyOn(api, "listMoveDestinationChildren").mockResolvedValue({
      parent: "locked",
      items: [node("child", "Shared child", "locked")],
    });
    renderMove();

    const locked = await screen.findByRole("treeitem", {
      name: /Finance.*View only/,
    });
    expect(locked).not.toHaveAttribute("aria-disabled");
    expect(screen.getByText("View only")).toBeVisible();
    await user.click(locked);
    expect(locked).toHaveFocus();
    expect(await screen.findByRole("treeitem", { name: "Shared child" })).toBeVisible();
    expect(children).toHaveBeenCalledWith("document", "doc_1", "locked", undefined);
    expect(screen.getByRole("button", { name: "Move" })).toBeDisabled();

    await user.click(locked);
    expect(locked).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: "Shared child" })).toBeNull();

    const chevron = locked.querySelector<HTMLElement>("span[aria-hidden='true']");
    expect(chevron).not.toBeNull();
    await user.click(chevron!);
    await waitFor(() => expect(locked).toHaveFocus());
    expect(await screen.findByRole("treeitem", { name: "Shared child" })).toBeVisible();
  });

  it("exposes an expanded branch loader as a disabled child tree item", async () => {
    const user = userEvent.setup();
    const children = deferred<{
      parent: string | null;
      items: MoveDestinationNode[];
    }>();
    vi.spyOn(api, "getMoveDestinations").mockResolvedValue(
      bootstrap({
        path: [],
        levels: [
          {
            parent: null,
            items: [node("parent", "Parent", null, { has_children: true })],
          },
        ],
        focus: "parent",
      }),
    );
    vi.spyOn(api, "listMoveDestinationChildren").mockReturnValue(children.promise);
    renderMove();

    const parent = await screen.findByRole("treeitem", { name: "Parent" });
    const chevron = parent.querySelector<HTMLElement>("span[aria-hidden='true']");
    expect(chevron).not.toBeNull();
    await user.click(chevron!);
    const tree = screen.getByRole("tree", { name: "Move destination folders" });
    const loading = within(tree).getByRole("treeitem", {
      name: "Loading folders…",
    });
    expect(loading).toHaveAttribute("aria-level", "3");
    expect(loading).toHaveAttribute("aria-disabled", "true");
    expect(loading).toHaveAttribute("aria-busy", "true");
    expect(loading).toHaveAttribute("tabindex", "-1");
    expect(within(tree).queryByRole("status")).toBeNull();

    await act(async () => {
      children.resolve({ parent: "parent", items: [] });
      await children.promise;
    });
  });

  it("reveals a global search result in the tree before it can move", async () => {
    const user = userEvent.setup();
    const result = node("deep", "Roadmap", "plans", {
      ancestors: [
        { id: "a", title: "A" },
        { id: "plans", title: "Plans" },
      ],
    });
    vi.spyOn(api, "searchMoveDestinations").mockResolvedValue({
      items: [result],
      has_more: false,
    });
    vi.spyOn(api, "getMoveDestinations")
      .mockResolvedValueOnce(bootstrap())
      .mockResolvedValueOnce(
        bootstrap({
          path: ["a", "plans", "deep"],
          levels: [
            {
              parent: null,
              items: [node("a", "A", null, { has_children: true })],
            },
            {
              parent: "a",
              items: [node("plans", "Plans", "a", { has_children: true })],
            },
            {
              parent: "plans",
              items: [result],
            },
          ],
          focus: "deep",
        }),
      );
    renderMove();

    await user.type(
      screen.getByRole("searchbox", { name: "Search all folders" }),
      "road",
    );
    await waitFor(() =>
      expect(api.searchMoveDestinations).toHaveBeenCalledWith(
        "document",
        "doc_1",
        "road",
      ),
    );
    const roadmap = await screen.findByRole("button", { name: /Roadmap.*A \/ Plans/ });
    await user.click(roadmap);

    const revealed = await screen.findByRole("treeitem", { name: "Roadmap" });
    expect(revealed).toHaveAttribute("aria-selected", "true");
    await waitFor(() => expect(revealed).toHaveFocus());
    expect(api.getMoveDestinations).toHaveBeenLastCalledWith(
      "document",
      "doc_1",
      "deep",
    );
  });

  it("includes branch-local retry in the tree roving-focus sequence", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "listMoveDestinationChildren")
      .mockRejectedValueOnce(new Error("503"))
      .mockResolvedValueOnce({
        parent: "c",
        items: [node("child", "Child", "c")],
      });
    renderMove();

    const current = await screen.findByRole("treeitem", { name: /C.*Current/ });
    await user.click(current);
    expect(screen.getByRole("treeitem", { name: "Sibling" })).toBeVisible();
    const retry = await screen.findByRole("treeitem", {
      name: "Retry loading folders in Documents / A / B / C",
    });
    expect(retry.tagName).toBe("BUTTON");
    expect(retry).toHaveAttribute("tabindex", "-1");
    await user.keyboard("{ArrowDown}");
    await waitFor(() => expect(retry).toHaveFocus());
    expect(retry).toHaveAttribute("tabindex", "0");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("treeitem", { name: "Child" })).toBeVisible();
  });

  it("loads earlier and later pages from synthetic tree rows", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getMoveDestinations").mockResolvedValue(
      bootstrap({
        path: [],
        levels: [
          {
            parent: null,
            items: [node("middle", "Middle", null)],
            before: "before_cursor",
            after: "after_cursor",
          },
        ],
        focus: "middle",
      }),
    );
    const children = vi
      .spyOn(api, "listMoveDestinationChildren")
      .mockResolvedValueOnce({
        parent: null,
        items: [node("earlier", "Earlier", null)],
      })
      .mockResolvedValueOnce({
        parent: null,
        items: [node("later", "Later", null)],
      });
    renderMove();

    const documents = await screen.findByRole("treeitem", { name: "Documents" });
    documents.focus();
    await user.keyboard("{ArrowDown}");
    const earlier = screen.getByRole("treeitem", {
      name: "Show earlier folders in Documents",
    });
    await waitFor(() => expect(earlier).toHaveFocus());
    expect(
      within(screen.getByRole("tree", { name: "Move destination folders" }))
        .getAllByRole("treeitem")
        .filter((item) => item.tabIndex === 0),
    ).toEqual([earlier]);
    await user.keyboard(" ");
    expect(await screen.findByRole("treeitem", { name: "Earlier" })).toHaveFocus();
    expect(children).toHaveBeenNthCalledWith(
      1,
      "document",
      "doc_1",
      null,
      "before_cursor",
    );

    await user.keyboard("{End}");
    const later = screen.getByRole("treeitem", {
      name: "Show more folders in Documents",
    });
    await waitFor(() => expect(later).toHaveFocus());
    await user.keyboard(" ");
    expect(await screen.findByRole("treeitem", { name: "Later" })).toHaveFocus();
    expect(children).toHaveBeenNthCalledWith(
      2,
      "document",
      "doc_1",
      null,
      "after_cursor",
    );
  });

  it("keeps level-15 semantics while capping mobile and desktop indentation", async () => {
    const ids = Array.from({ length: 14 }, (_, index) => `deep_${index + 1}`);
    const longTitle =
      "A very long restricted destination folder name that must remain readable on a phone";
    vi.spyOn(api, "getMoveDestinations").mockResolvedValue(
      bootstrap({
        path: ids,
        levels: ids.map((id, index) => ({
          parent: index ? ids[index - 1] : null,
          items: [
            node(
              id,
              index === ids.length - 1 ? longTitle : `Folder ${index + 1}`,
              index ? ids[index - 1] : null,
              index === ids.length - 1
                ? {
                    access: "view",
                    selectable: false,
                    reason: "view_only",
                  }
                : { has_children: true },
            ),
          ],
          ...(index === ids.length - 1 ? { after: "deep_after" } : {}),
        })),
        focus: ids.at(-1)!,
      }),
    );
    renderMove();

    const deep = await screen.findByRole("treeitem", {
      name: new RegExp(`${longTitle}.*View only`),
    });
    expect(deep).toHaveAttribute("aria-level", "15");
    expect(deep.parentElement).toHaveStyle({
      "--move-tree-indent-mobile": "48px",
      "--move-tree-indent-desktop": "180px",
    });
    expect(deep.className).toContain("var(--move-tree-indent-mobile)");
    expect(deep.className).toContain("var(--move-tree-indent-desktop)");
    expect(within(deep).getByText(longTitle)).toHaveClass("break-words");
    expect(within(deep).getByText("View only")).toBeVisible();

    const more = screen.getByRole("treeitem", { name: /Show more folders in/ });
    expect(more).toHaveAttribute("aria-level", "15");
    expect(more).toHaveStyle({
      "--move-tree-indent-mobile": "48px",
      "--move-tree-indent-desktop": "180px",
    });
    expect(more.className).toContain("var(--move-tree-indent-mobile)");
    expect(more.className).toContain("var(--move-tree-indent-desktop)");
  });

  it("describes hidden ancestry without inventing a restricted tree item", async () => {
    vi.spyOn(api, "getMoveDestinations").mockResolvedValue(
      bootstrap({
        resource: {
          type: "document",
          id: "doc_1",
          title: "Q3 plan",
          can_move: true,
          source: { kind: "restricted", token: "ms1_hidden" },
        },
        path: [],
        path_restricted_prefix: true,
        levels: [
          {
            parent: null,
            items: [
              node("visible", "Visible child", null, { restricted_parent: true }),
            ],
          },
        ],
        focus: "visible",
      }),
    );
    renderMove();

    expect(
      await screen.findByText(
        "Currently in a restricted folder. Choose a new location.",
      ),
    ).toBeVisible();
    expect(screen.getByText("In a restricted folder")).toBeVisible();
    expect(screen.queryByRole("treeitem", { name: /^Restricted/ })).toBeNull();
  });

  it("preserves the existing PATCH flow for folder moves", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getMoveDestinations").mockResolvedValue(
      bootstrap({
        resource: {
          type: "folder",
          id: "fld_1",
          title: "Q3 plan",
          can_move: true,
          source: { kind: "folder", folder_id: "old" },
        },
        path: [],
        levels: [{ parent: null, items: [node("new", "New parent", null)] }],
        focus: "new",
      }),
    );
    const update = vi
      .spyOn(api, "updateFolder")
      .mockResolvedValue({ id: "fld_1", title: "Q3 plan" });
    renderMove({ type: "folder", id: "fld_1", parentId: "old" });

    await user.click(await screen.findByRole("treeitem", { name: "New parent" }));
    await user.click(screen.getByRole("button", { name: "Move to New parent" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("fld_1", undefined, "new"));
  });

  it("refreshes stale destinations and keeps the dialog open", async () => {
    const user = userEvent.setup();
    const refreshed = bootstrap({
      resource: {
        type: "document",
        id: "doc_1",
        title: "Q3 plan",
        can_move: true,
        source: { kind: "root", token: "ms1_refreshed" },
      },
      documents: { selectable: false, current: true, can_create_child: true },
      path: [],
      levels: [{ parent: null, items: [node("other", "Other", null)] }],
      focus: null,
    });
    vi.spyOn(api, "getMoveDestinations")
      .mockResolvedValueOnce(bootstrap())
      .mockResolvedValueOnce(refreshed);
    vi.spyOn(api, "moveDocument").mockRejectedValue(
      new APIError(409, "source_changed", "source changed"),
    );
    const { onOpenChange } = renderMove();

    await user.click(await screen.findByRole("treeitem", { name: "Sibling" }));
    await user.click(screen.getByRole("button", { name: "Move to Sibling" }));

    await waitFor(() => expect(api.getMoveDestinations).toHaveBeenCalledTimes(2));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(
      await screen.findByRole("treeitem", { name: /Documents.*Current/ }),
    ).toBeVisible();
  });

  it("does not apply a child response from a previous dialog opening", async () => {
    const user = userEvent.setup();
    const children = deferred<{
      parent: string | null;
      items: MoveDestinationNode[];
    }>();
    vi.spyOn(api, "listMoveDestinationChildren").mockReturnValue(children.promise);
    renderReopenMove();

    await user.click(await screen.findByRole("treeitem", { name: /C.*Current/ }));
    await waitFor(() => expect(api.listMoveDestinationChildren).toHaveBeenCalled());
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Open move" }));

    await act(async () => {
      children.resolve({
        parent: "c",
        items: [node("late", "Late child", "c")],
      });
      await children.promise;
    });
    expect(screen.queryByRole("treeitem", { name: "Late child" })).toBeNull();
  });

  it("does not apply or report a reveal response from a previous opening", async () => {
    const user = userEvent.setup();
    const reveal = deferred<MoveDestinationBootstrap>();
    const result = node("roadmap", "Roadmap", null);
    vi.mocked(api.getMoveDestinations)
      .mockResolvedValueOnce(bootstrap())
      .mockReturnValueOnce(reveal.promise)
      .mockResolvedValue(bootstrap());
    vi.mocked(api.searchMoveDestinations).mockResolvedValue({
      items: [result],
      has_more: false,
    });
    renderReopenMove();

    await user.type(
      await screen.findByRole("searchbox", { name: "Search all folders" }),
      "road",
    );
    await user.click(await screen.findByRole("button", { name: /Roadmap/ }));
    await waitFor(() => expect(api.getMoveDestinations).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Open move" }));

    await act(async () => {
      reveal.resolve(
        bootstrap({
          path: ["roadmap"],
          levels: [{ parent: null, items: [result] }],
          focus: "roadmap",
        }),
      );
      await reveal.promise;
    });
    expect(screen.queryByRole("treeitem", { name: "Roadmap" })).toBeNull();
    expect(screen.queryByText(/Could not show that folder/)).toBeNull();
  });

  it("does not report a failed reveal from a previous opening", async () => {
    const user = userEvent.setup();
    const reveal = deferred<MoveDestinationBootstrap>();
    const result = node("roadmap", "Roadmap", null);
    vi.mocked(api.getMoveDestinations)
      .mockResolvedValueOnce(bootstrap())
      .mockReturnValueOnce(reveal.promise)
      .mockResolvedValue(bootstrap());
    vi.mocked(api.searchMoveDestinations).mockResolvedValue({
      items: [result],
      has_more: false,
    });
    renderReopenMove();

    await user.type(
      await screen.findByRole("searchbox", { name: "Search all folders" }),
      "road",
    );
    await user.click(await screen.findByRole("button", { name: /Roadmap/ }));
    await waitFor(() => expect(api.getMoveDestinations).toHaveBeenCalledTimes(2));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Open move" }));

    await act(async () => {
      reveal.reject(new APIError(500, "internal_error", "could not reveal"));
      await expect(reveal.promise).rejects.toThrow("could not reveal");
    });
    expect(screen.queryByText(/Could not show that folder/)).toBeNull();
  });

  it("does not apply an initial bootstrap from a previous opening", async () => {
    const user = userEvent.setup();
    const stale = deferred<MoveDestinationBootstrap>();
    const fresh = bootstrap({
      path: [],
      levels: [{ parent: null, items: [node("fresh", "Fresh root", null)] }],
      focus: "fresh",
    });
    vi.mocked(api.getMoveDestinations)
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue(fresh);
    renderReopenMove();

    await waitFor(() => expect(api.getMoveDestinations).toHaveBeenCalledTimes(1));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Open move" }));

    await act(async () => {
      stale.resolve(
        bootstrap({
          path: [],
          levels: [{ parent: null, items: [node("stale", "Stale root", null)] }],
          focus: "stale",
        }),
      );
      await stale.promise;
    });

    expect(await screen.findByRole("treeitem", { name: "Fresh root" })).toBeVisible();
    expect(screen.queryByRole("treeitem", { name: "Stale root" })).toBeNull();
    expect(api.getMoveDestinations).toHaveBeenCalledTimes(2);
  });

  it("preserves selection when bootstrap data refetches in the background", async () => {
    const user = userEvent.setup();
    const { client } = renderMove();
    const sibling = await screen.findByRole("treeitem", { name: "Sibling" });
    await user.click(sibling);
    expect(sibling).toHaveAttribute("aria-selected", "true");

    act(() => {
      client.setQueryData(
        queryKeys.moveDestinations("document", "doc_1"),
        bootstrap({
          levels: bootstrap().levels.map((level) => ({
            ...level,
            after: level.parent === "b" ? "new_cursor" : level.after,
          })),
        }),
      );
    });

    await waitFor(() => expect(sibling).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByRole("button", { name: "Move to Sibling" })).toBeEnabled();
  });

  it("recovers one expired cursor from the last loaded folder anchor", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getMoveDestinations").mockResolvedValue(
      bootstrap({
        path: [],
        levels: [
          {
            parent: null,
            items: [node("middle", "Middle", null)],
            after: "expired_cursor",
          },
        ],
        focus: "middle",
      }),
    );
    const children = vi
      .spyOn(api, "listMoveDestinationChildren")
      .mockRejectedValueOnce(new APIError(400, "invalid_cursor", "invalid cursor"))
      .mockResolvedValueOnce({
        parent: null,
        items: [node("later", "Later", null)],
      });
    renderMove();

    await user.click(
      await screen.findByRole("treeitem", {
        name: "Show more folders in Documents",
      }),
    );

    expect(await screen.findByRole("treeitem", { name: "Later" })).toBeVisible();
    expect(children).toHaveBeenNthCalledWith(
      1,
      "document",
      "doc_1",
      null,
      "expired_cursor",
    );
    expect(children).toHaveBeenNthCalledWith(
      2,
      "document",
      "doc_1",
      null,
      undefined,
      "middle",
      "after",
    );
  });

  it("does not search until two trimmed characters are present", async () => {
    const user = userEvent.setup();
    const search = vi.mocked(api.searchMoveDestinations);
    renderMove();

    await user.type(
      await screen.findByRole("searchbox", { name: "Search all folders" }),
      "a",
    );
    expect(
      screen.getByText("Type at least 2 characters to search all folders."),
    ).toBeVisible();
    expect(search).not.toHaveBeenCalled();

    await user.type(screen.getByRole("searchbox"), "b");
    await waitFor(() => expect(search).toHaveBeenCalledWith("document", "doc_1", "ab"));
  });

  it("warns inline and explicitly acknowledges a root move that loses access", async () => {
    const user = userEvent.setup();
    vi.spyOn(api, "getMoveDestinations").mockResolvedValue(
      bootstrap({
        documents: {
          selectable: true,
          current: false,
          can_create_child: true,
          would_lose_access: true,
        },
      }),
    );
    const move = vi.spyOn(api, "moveDocument").mockResolvedValue({
      document_id: "doc_1",
      moved: true,
      destination: { kind: "root" },
      access_lost: true,
      undo: null,
    });
    renderMove();

    await user.click(await screen.findByRole("treeitem", { name: "Documents" }));
    expect(
      screen.getByText(
        "Moving to Documents will remove your access to this document. You may not be able to open it again.",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Move and lose access" }));
    await waitFor(() =>
      expect(move).toHaveBeenCalledWith("doc_1", { kind: "root" }, "ms1_source", true),
    );
  });

  it("keeps an authoritative access-loss 409 inline and retries with acknowledgement", async () => {
    const user = userEvent.setup();
    const move = vi
      .spyOn(api, "moveDocument")
      .mockRejectedValueOnce(
        new APIError(409, "access_loss_confirmation_required", "confirmation required"),
      )
      .mockResolvedValueOnce({
        document_id: "doc_1",
        moved: true,
        destination: { kind: "root" },
        access_lost: true,
        undo: null,
      });
    const { onOpenChange } = renderMove();

    await user.click(await screen.findByRole("treeitem", { name: "Documents" }));
    await user.click(screen.getByRole("button", { name: "Move to Documents" }));
    expect(
      await screen.findByText(
        "Moving to Documents will remove your access to this document. You may not be able to open it again.",
      ),
    ).toBeVisible();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    await user.click(screen.getByRole("button", { name: "Move and lose access" }));
    await waitFor(() =>
      expect(move).toHaveBeenNthCalledWith(
        2,
        "doc_1",
        { kind: "root" },
        "ms1_source",
        true,
      ),
    );
  });
});
