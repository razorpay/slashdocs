import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { clearFieldDrafts } from "@/lib/field-drafts";
import { DocBar } from "./doc-bar";
import { ModeButton } from "./doc-mode-button";
import { DocProvider, type DocContextValue, type SaveState } from "./doc-context";
import { newLoads } from "./live-load";
import type { Viewer } from "./use-document-stream";

const mockDocContext: DocContextValue = {
  docId: "doc_1",
  version: "v_1",
  comments: [],
  commentsLoading: false,
  commentsError: false,
  notifications: false,
  drafts: [],
  startDraft: vi.fn(),
  saveDraft: vi.fn(),
  moveDraft: vi.fn(),
  discardDraft: vi.fn(),
  setActiveComment: vi.fn(),
  jumpToComment: vi.fn(),
  resolveThread: vi.fn(),
  readThread: vi.fn(),
  unanchoredComments: new Set(),
  setUnanchoredComments: vi.fn(),
  movedPins: new Set(),
  setMovedPins: vi.fn(),
  commentPositions: new Map(),
  setCommentPositions: vi.fn(),
  documentHeight: 1,
  setDocumentHeight: vi.fn(),
  registerDocumentPrinter: vi.fn(),
  printDocument: vi.fn(),
  registerDocumentScroller: vi.fn(),
  scrollDocumentTo: vi.fn(),
  handleDocCommentClick: vi.fn(),
  handleRenderedDocumentClick: vi.fn(),
  placingPin: false,
  setPlacingPin: vi.fn(),
  subscribeDocumentKV: () => () => {},
  reportViewport: vi.fn(),
  moveCursor: vi.fn(),
  holdCursor: vi.fn(),
  subscribeCursors: () => () => {},
  canEdit: false,
  editing: false,
  setEditing: vi.fn(async () => true),
  registerLiveText: vi.fn(),
  saveState: "idle",
  setSaveState: vi.fn(),
  retrySave: vi.fn(),
  frameReady: true,
  setFrameReady: vi.fn(),
  frameShows: vi.fn(),
  showCurrent: vi.fn(),
  frameLoad: 0,
  reloadFrame: vi.fn(),
  onPage: { current: true },
  liveLoads: newLoads(),
  typists: [],
  madeBy: () => undefined,
  live: true,
  holdUpdate: vi.fn(),
  showUpdate: vi.fn(),
  anchorOf: vi.fn(async () => undefined),
};

const OWNER = { type: "user" as const, id: "usr_owner" };

function renderDocBar(
  labelsEnabled = true,
  viewers: Viewer[] = [],
  requesters: unknown[] = [],
  role: "owner" | "editor" = "owner",
  props: Partial<ComponentProps<typeof DocBar>> = {},
  // Paths that answer 503.
  failing: string[] = [],
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (failing.includes(url)) {
        return new Response(JSON.stringify({ error: { code: "unavailable" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/v1/config") {
        return new Response(
          JSON.stringify({
            deployment: "org",
            labels_enabled: labelsEnabled,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/v1/documents/doc_1/access-requests") {
        return new Response(
          JSON.stringify({
            items: requesters.map((requester) => ({ requester, requested_at: "" })),
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/v1/documents/doc_1/access") {
        return new Response(
          JSON.stringify({
            current_role: role,
            items: [],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      if (url === "/v1/documents/doc_1/versions") {
        return new Response(
          JSON.stringify({
            items: [
              {
                id: "v_1",
                number: 1,
                created_at: "2026-01-01T00:00:00Z",
                change_summary: "Initial commit",
              },
              {
                id: "v_2",
                number: 2,
                created_at: "2026-01-02T00:00:00Z",
                change_summary: "Second version",
              },
            ],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(JSON.stringify({ items: [] }), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const onSelectVersion = vi.fn();
  const onFollowViewer = vi.fn();

  // update renders the bar again with other props, as a remote change does.
  const bar = (changed: Partial<ComponentProps<typeof DocBar>> = {}) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DocProvider value={mockDocContext}>
          <DocBar
            title="Test Document"
            docId="doc_1"
            owner={OWNER}
            principal={role === "owner" ? OWNER : { type: "user", id: "usr_editor" }}
            current="v_1"
            latest="v_2"
            previewing={false}
            canChangeContent
            labels={["payments", "runbook"]}
            onSelectVersion={onSelectVersion}
            viewers={viewers}
            onFollowViewer={onFollowViewer}
            commentsOpen={false}
            threads={{ open: 0, unread: false }}
            onToggleComments={vi.fn()}
            onShowShortcuts={vi.fn()}
            shareOpen={false}
            onShareOpenChange={vi.fn()}
            {...props}
            {...changed}
          />
        </DocProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(bar());
  return {
    onSelectVersion,
    onFollowViewer,
    update: (changed: Partial<ComponentProps<typeof DocBar>>) =>
      view.rerender(bar(changed)),
  };
}

afterEach(clearFieldDrafts);

describe("DocBar More menu and small-screen reachable dialogs", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    mockDocContext.canEdit = false;
    mockDocContext.latest = undefined;
    mockDocContext.shownSeq = undefined;
  });

  it("opens the history from the More menu", async () => {
    const user = userEvent.setup();
    const { onSelectVersion } = renderDocBar();

    const moreButton = screen.getByRole("button", { name: "More" });
    await user.click(moreButton);

    const historyMenuItem = await screen.findByRole("menuitem", {
      name: /^History$/,
    });
    expect(historyMenuItem).toBeInTheDocument();

    await user.click(historyMenuItem);

    const dialogTitle = await screen.findByRole("heading", {
      name: "History",
    });
    expect(dialogTitle).toBeInTheDocument();

    expect(await screen.findByText("Second version")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Second version/ }));
    // The reader leaves Edit mode first, as with Done.
    expect(mockDocContext.setEditing).toHaveBeenCalledWith(false);
    expect(onSelectVersion).toHaveBeenCalledWith("v_2");
  });

  it("stays on the document when text of the reader cannot save", async () => {
    const user = userEvent.setup();
    // Done does not leave Edit mode: the reader copies or discards first.
    vi.mocked(mockDocContext.setEditing).mockResolvedValueOnce(false);
    const { onSelectVersion } = renderDocBar();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: /^History$/ }));

    await user.click(await screen.findByRole("button", { name: /Second version/ }));

    expect(onSelectVersion).not.toHaveBeenCalled();
  });

  it("uploads on the state that the page showed when the form opened", async () => {
    const user = userEvent.setup();
    const create = vi
      .spyOn(api, "createVersion")
      .mockResolvedValue({ id: "v_3", number: 3, seq: 8 });
    mockDocContext.latest = 6;
    mockDocContext.shownSeq = 5;
    renderDocBar();
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Replace with an HTML file" }),
    );
    const dialog = await screen.findByRole("dialog");
    // Other people type while the form is open, and the page follows them.
    mockDocContext.shownSeq = 7;
    await user.upload(
      dialog.querySelector<HTMLInputElement>('input[type="file"]')!,
      new File(["<p>x</p>"], "x.html", { type: "text/html" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Upload" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.lastCall![1]).toEqual({ version: "v_2", seq: 5 });
  });

  it("opens labels dialog from the More menu when labels are enabled", async () => {
    const user = userEvent.setup();
    renderDocBar(true);

    const moreButton = screen.getByRole("button", { name: "More" });
    await user.click(moreButton);

    const labelsMenuItem = await screen.findByRole("menuitem", {
      name: /Document labels/i,
    });
    expect(labelsMenuItem).toBeInTheDocument();

    await user.click(labelsMenuItem);

    const dialogTitle = await screen.findByRole("heading", {
      name: "Document labels",
    });
    expect(dialogTitle).toBeInTheDocument();

    const input = screen.getByPlaceholderText("runbook, payments, onboarding");
    expect(input).toHaveValue("payments, runbook");

    // An unsaved draft survives closing the dialog, and says so.
    await user.type(input, ", draft");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: /Document labels/i }));
    expect(
      await screen.findByPlaceholderText("runbook, payments, onboarding"),
    ).toHaveValue("payments, runbook, draft");
    expect(
      screen.getByText("Your labels from earlier came back. They are not saved yet."),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByPlaceholderText("runbook, payments, onboarding")).toHaveValue(
      "payments, runbook",
    );
  });

  it("keeps typed labels when the labels change elsewhere, and saves only after a choice", async () => {
    const user = userEvent.setup();
    const save = vi
      .spyOn(api, "replaceDocumentLabels")
      .mockResolvedValue({} as Awaited<ReturnType<typeof api.replaceDocumentLabels>>);
    const { update } = renderDocBar(true);
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: /Document labels/i }));
    const input = await screen.findByRole("textbox", { name: "Labels" });
    await user.type(input, ", mine");
    update({ labels: ["payments", "theirs"] });
    expect(
      await screen.findByText("The labels changed elsewhere. They now say:"),
    ).toBeTruthy();
    expect(input).toHaveValue("payments, runbook, mine");
    const saveButton = screen.getByRole("button", { name: "Save labels" });
    expect(saveButton).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Use the new labels" }));
    expect(input).toHaveValue("payments, theirs");
    await user.click(saveButton);
    expect(save).toHaveBeenCalledWith("doc_1", ["payments", "theirs"]);
  });

  it("keeps a title being typed when the document is renamed elsewhere", async () => {
    const user = userEvent.setup();
    const rename = vi
      .spyOn(api, "renameDocument")
      .mockResolvedValue({ id: "doc_1", title: "Mine" });
    const { update } = renderDocBar();
    await user.click(screen.getByRole("button", { name: "Rename Test Document" }));
    const field = screen.getByRole("textbox", { name: "Document title" });
    await user.clear(field);
    await user.type(field, "Mine");
    update({ title: "Theirs" });
    expect(
      await screen.findByText("The document was renamed elsewhere. It is now:"),
    ).toBeTruthy();
    // A click away saves nothing while the reader has not chosen.
    await user.click(document.body);
    expect(rename).not.toHaveBeenCalled();
    expect(screen.getByRole("textbox", { name: "Document title" })).toHaveValue("Mine");
    await user.click(screen.getByRole("button", { name: "Keep mine" }));
    await user.keyboard("{Enter}");
    expect(rename).toHaveBeenCalledWith("doc_1", "Mine");
  });

  it("hides document labels from the More menu when labels are disabled", async () => {
    const user = userEvent.setup();
    renderDocBar(false);

    const moreButton = screen.getByRole("button", { name: "More" });
    await user.click(moreButton);

    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: /^History$/ })).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("menuitem", { name: /Document labels/i }),
    ).not.toBeInTheDocument();
  });

  it("opens a viewer's menu to jump to or follow them", async () => {
    const user = userEvent.setup();
    const viewer: Viewer = {
      session: "s_1",
      principal: { type: "user", id: "u_2", name: "Reviewer" },
      seenAt: 0,
    };
    const { onFollowViewer } = renderDocBar(true, [viewer]);

    await user.click(screen.getByRole("button", { name: "Reviewer" }));
    await user.click(await screen.findByRole("menuitem", { name: "Jump to Reviewer" }));
    expect(onFollowViewer).toHaveBeenLastCalledWith(viewer);

    // The keyboard opens the menu too.
    screen.getByRole("button", { name: "Reviewer" }).focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "Follow Reviewer" }));
    expect(onFollowViewer).toHaveBeenLastCalledWith(viewer, true);
  });

  it("names the followed viewer in the bar, and stops following there", async () => {
    const user = userEvent.setup();
    const viewer: Viewer = {
      session: "s_1",
      principal: { type: "user", id: "u_2", name: "Reviewer" },
      seenAt: 0,
    };
    const onUnfollowViewer = vi.fn();
    renderDocBar(true, [viewer], [], "owner", {
      followedSession: "s_1",
      onUnfollowViewer,
    });

    const stop = screen.getByRole("button", { name: "Stop following Reviewer" });
    expect(stop).toHaveTextContent("Following Reviewer");
    stop.focus();
    await user.keyboard("{Enter}");
    expect(onUnfollowViewer).toHaveBeenCalledOnce();
  });

  it("puts the approvals and the people in the More menu, for a phone bar", async () => {
    const user = userEvent.setup();
    const viewer: Viewer = {
      session: "s_1",
      principal: { type: "user", id: "u_2", name: "Reviewer" },
      seenAt: 0,
    };
    renderDocBar(true, [viewer], [], "owner", {
      approvalStatus: "pending",
      approvalSummary: { approved: 0, total: 1, rejected: 0, pending: 1 },
    });

    await user.click(screen.getByRole("button", { name: "More" }));
    expect(
      await screen.findByRole("menuitem", { name: "Follow Reviewer" }),
    ).toBeVisible();
    await user.click(screen.getByRole("menuitem", { name: /Approvals/ }));
    expect(await screen.findByRole("dialog")).toBeVisible();
  });

  it("puts every action on the right, in a fixed order, and the rest in More", async () => {
    const user = userEvent.setup();
    const viewer: Viewer = {
      session: "s_1",
      principal: { type: "user", id: "u_2", name: "Reviewer" },
      seenAt: 0,
    };
    mockDocContext.canEdit = true;
    renderDocBar(true, [viewer], [], "owner", {
      accountUser: OWNER,
      current: "v_2",
      followedSession: "s_1",
      approvalStatus: "approved",
      approvalSummary: { approved: 1, total: 1, rejected: 0, pending: 0 },
    });
    const names = () =>
      screen
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label"))
        .filter((name) => !name?.startsWith("Rename"));
    await screen.findByRole("button", { name: "Approvals: 1 of 1 approved" });
    // What comes and goes, as the follow, comes first, so that it moves no
    // action.
    expect(names()).toEqual([
      "Stop following Reviewer",
      "Following Reviewer",
      "Edit",
      "Approvals: 1 of 1 approved",
      "Comments",
      "Share",
      "More",
      "Account menu",
    ]);
    // History, full screen, the cursors and the labels are in More.
    await user.click(screen.getByRole("button", { name: "More" }));
    for (const name of [/^History$/, /^Full screen/, /cursors/, /Document labels/])
      expect(await screen.findByRole("menuitem", { name })).toBeVisible();
    await user.keyboard("{Escape}");
    // The menu of a viewer shows or hides the cursors too.
    await user.click(screen.getByRole("button", { name: "Following Reviewer" }));
    expect(await screen.findByRole("menuitem", { name: /cursors/ })).toBeVisible();
  });

  it("counts the requests for access on the Share button", async () => {
    renderDocBar(true, [], [{ type: "user", id: "usr_reader" }]);
    expect(
      await screen.findByRole("button", { name: "Share, 1 request for access" }),
    ).toBeVisible();
  });

  it("marks the Share button when the requests for access did not load", async () => {
    renderDocBar(true, [], [], "owner", {}, ["/v1/documents/doc_1/access-requests"]);
    expect(
      await screen.findByRole("button", {
        name: "Share, requests for access did not load",
      }),
    ).toHaveTextContent("!");
  });

  it("renames the document in place, and Esc keeps the old title", async () => {
    const user = userEvent.setup();
    const rename = vi
      .spyOn(api, "renameDocument")
      .mockResolvedValue({ id: "doc_1", title: "Plan B" });
    renderDocBar();

    await user.click(screen.getByRole("button", { name: "Rename Test Document" }));
    const field = screen.getByRole("textbox", { name: "Document title" });
    expect(field).toHaveFocus();
    await user.clear(field);
    await user.type(field, "Plan B{Enter}");
    expect(rename).toHaveBeenCalledWith("doc_1", "Plan B");
    // A rename that a click started gives the focus back without a ring.
    const title = screen.getByRole("button", { name: /^Rename / });
    expect(title).toHaveFocus();
    expect(title.className).toContain("focus-visible:outline-none");

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const again = await screen.findByRole("textbox", { name: "Document title" });
    await waitFor(() => expect(again).toHaveFocus());
    await user.type(again, "Plan C{Escape}");
    expect(rename).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /^Rename / }).className).not.toContain(
      "focus-visible:outline-none",
    );
    expect(screen.queryByRole("textbox", { name: "Document title" })).toBeNull();
  });

  it("tells an editor why the More menu cannot rename", async () => {
    const user = userEvent.setup();
    renderDocBar(true, [], [], "editor");
    await user.click(screen.getByRole("button", { name: "More" }));
    const rename = await screen.findByRole("menuitem", { name: /^Rename/ });
    expect(rename).toHaveAttribute("aria-disabled", "true");
    expect(rename).toHaveTextContent("Only the owner can rename");
    expect(screen.queryByRole("button", { name: /^Rename / })).toBeNull();
  });

  it("lets an editor move the document out of a folder that the editor cannot see", async () => {
    const user = userEvent.setup();
    renderDocBar(true, [], [], "editor", {
      parentFolderId: "fld_hidden",
      canMove: true,
    });
    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: "Move to folder" }));
    await user.click(await screen.findByRole("button", { name: "Documents" }));
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        "/v1/folders/fld_hidden/documents/doc_1",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });

  it("tells an editor who cannot move the document why", async () => {
    const user = userEvent.setup();
    renderDocBar(true, [], [], "editor", { parentFolderId: "fld_other" });
    await user.click(screen.getByRole("button", { name: "More" }));
    const move = await screen.findByRole("menuitem", { name: /^Move to folder/ });
    expect(move).toHaveAttribute("aria-disabled", "true");
    expect(move).toHaveTextContent("Only an editor of its folder can move it");
  });

  it("uses a hidden parent's id when the owner moves the document to root", async () => {
    const user = userEvent.setup();
    const move = vi.spyOn(api, "moveDocumentToRoot").mockResolvedValue();
    renderDocBar(true, [], [], "owner", { parentFolderId: "fld_hidden" });

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(await screen.findByRole("menuitem", { name: "Move to folder" }));
    await user.click(await screen.findByRole("button", { name: "Documents" }));

    await waitFor(() => expect(move).toHaveBeenCalledWith("fld_hidden", "doc_1"));
  });

  it("says when it could not check the reader's access, with Retry", async () => {
    const accessUnknown = { isFetching: false, refetch: vi.fn() };
    renderDocBar(true, [], [], "owner", { accessUnknown });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not check your access",
    );
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(accessUnknown.refetch).toHaveBeenCalled();
    expect(screen.queryByText("Can edit")).toBeNull();
  });

  it("shows Edit to an editor once the document shows, and Done in its place in Edit mode", () => {
    const controls = (canEdit: boolean, frameReady: boolean, editing = false) => {
      cleanup();
      render(
        <DocProvider value={{ ...mockDocContext, canEdit, frameReady, editing }}>
          <ModeButton />
        </DocProvider>,
      );
      return screen.queryAllByRole("button").map((b) => b.getAttribute("aria-label"));
    };
    expect(controls(true, true)).toEqual(["Edit"]);
    expect(controls(true, true, true)).toEqual(["Done"]);
    expect(controls(true, false)).toEqual([]);
    expect(controls(false, true)).toEqual([]);
  });

  it("starts Edit mode, and Done leaves it, from one button that keeps the focus", async () => {
    const setEditing = vi.fn(async () => true);
    const bar = (editing: boolean) => (
      <DocProvider value={{ ...mockDocContext, canEdit: true, editing, setEditing }}>
        <ModeButton />
      </DocProvider>
    );
    const { rerender } = render(bar(false));
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit).toHaveAttribute("aria-keyshortcuts", "E");
    await userEvent.click(edit);
    expect(setEditing).toHaveBeenLastCalledWith(true);
    rerender(bar(true));
    const done = screen.getByRole("button", { name: "Done" });
    expect(done).toBe(edit);
    expect(done).toHaveFocus();
    expect(done).toHaveAttribute("aria-keyshortcuts", "Escape");
    await userEvent.click(done);
    expect(setEditing).toHaveBeenLastCalledWith(false);
  });

  it("hides the state of a save, and shows only edits that did not save, with Retry", async () => {
    const retrySave = vi.fn();
    const status = (saveState: SaveState, editing = true) => {
      cleanup();
      render(
        <DocProvider
          value={{
            ...mockDocContext,
            canEdit: true,
            editing,
            saveState,
            retrySave,
          }}
        >
          <ModeButton />
        </DocProvider>,
      );
      const region = screen.getByRole("status");
      expect(region).toHaveAttribute("aria-live", "polite");
      return region.textContent;
    };
    expect(status("idle")).toBe("");
    for (const saveState of ["failed", "refused"] as const)
      expect(status(saveState)).toBe("Not saved · Retry");
    // Done left Edit mode while the edits wait for the network: they still
    // show as not saved.
    expect(status("idle", false)).toBe("");
    expect(status("failed", false)).toBe("Not saved · Retry");
    await userEvent.click(screen.getByRole("button", { name: "Not saved · Retry" }));
    expect(retrySave).toHaveBeenCalledOnce();
  });

  it("shows Offline, with no Retry, while the browser has no network", async () => {
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const chip = (saveState: SaveState) => {
      cleanup();
      render(
        <DocProvider
          value={{ ...mockDocContext, canEdit: true, editing: true, saveState }}
        >
          <ModeButton />
        </DocProvider>,
      );
      return screen.getByRole("status");
    };
    expect(chip("idle")).toHaveTextContent("");
    // A change that cannot save needs the editor, also offline.
    expect(chip("refused")).toHaveTextContent("Not saved · Retry");
    const status = chip("failed");
    expect(status).toHaveTextContent(/^Offline$/);
    expect(within(status).queryByRole("button")).toBeNull();
    await userEvent.hover(screen.getByText("Offline"));
    expect(
      await screen.findByRole("tooltip", {
        name: "Your edits are kept here. They save when you are online again.",
      }),
    ).toBeInTheDocument();

    // The chip follows the network of the browser.
    online.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event("online")));
    expect(status).toHaveTextContent("Not saved · Retry");
    online.mockReturnValue(false);
    act(() => void window.dispatchEvent(new Event("offline")));
    expect(status).toHaveTextContent(/^Offline$/);
    online.mockRestore();
  });
});
