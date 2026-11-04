import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { DocBar } from "./doc-bar";
import { EditStatus } from "./doc-edit-status";
import { DocProvider, type DocContextValue, type SaveState } from "./doc-context";
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
  unanchoredComments: new Set(),
  setUnanchoredComments: vi.fn(),
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
  subscribeCursors: () => () => {},
  editable: false,
  saveState: "idle",
  setSaveState: vi.fn(),
  stayOnVersion: vi.fn(),
  showLatest: vi.fn(),
};

const OWNER = { type: "user" as const, id: "usr_owner" };

function renderDocBar(
  labelsEnabled = true,
  viewers: Viewer[] = [],
  requesters: unknown[] = [],
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
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
            current_role: "owner",
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

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DocProvider value={mockDocContext}>
          <DocBar
            title="Test Document"
            docId="doc_1"
            owner={OWNER}
            principal={OWNER}
            current="v_1"
            latest="v_2"
            previewing={false}
            canChangeContent
            labels={["payments", "runbook"]}
            onSelectVersion={onSelectVersion}
            onShowLatest={vi.fn()}
            viewers={viewers}
            onFollowViewer={onFollowViewer}
            commentsOpen={false}
            onToggleComments={vi.fn()}
            onShowShortcuts={vi.fn()}
            shareOpen={false}
            onShareOpenChange={vi.fn()}
          />
        </DocProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

  return { onSelectVersion, onFollowViewer };
}

describe("DocBar More menu and small-screen reachable dialogs", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
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
    expect(historyMenuItem).toHaveClass("sm:hidden");

    await user.click(historyMenuItem);

    const dialogTitle = await screen.findByRole("heading", {
      name: "History",
    });
    expect(dialogTitle).toBeInTheDocument();

    expect(await screen.findByText("Second version")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Second version/ }));
    expect(onSelectVersion).toHaveBeenCalledWith("v_2");
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
    expect(labelsMenuItem).toHaveClass("lg:hidden");

    await user.click(labelsMenuItem);

    const dialogTitle = await screen.findByRole("heading", {
      name: "Document labels",
    });
    expect(dialogTitle).toBeInTheDocument();

    const input = screen.getByPlaceholderText("runbook, payments, onboarding");
    expect(input).toHaveValue("payments, runbook");

    // An unsaved draft does not survive closing the dialog.
    await user.type(input, ", draft");
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Document labels" }));
    expect(
      await screen.findByPlaceholderText("runbook, payments, onboarding"),
    ).toHaveValue("payments, runbook");
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

  it("counts the requests for access on the Share button", async () => {
    renderDocBar(true, [], [{ type: "user", id: "usr_reader" }]);
    expect(
      await screen.findByRole("button", { name: "Share, 1 request for access" }),
    ).toBeVisible();
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

  it("tells a reader who cannot edit what they may do", () => {
    const status = (access?: "commenter" | "viewer", editable = false) =>
      render(
        <DocProvider value={{ ...mockDocContext, editable }}>
          <EditStatus access={access} />
        </DocProvider>,
      ).container.textContent;
    expect(status("commenter")).toBe("Can comment");
    expect(status("viewer")).toBe("Can view");
    expect(status("commenter", true)).toBe("Can edit");
    expect(status()).toBe("");
  });

  it("says Saving… only while a save runs, and announces only a failed save", () => {
    const status = (saveState: SaveState) => {
      cleanup();
      render(
        <DocProvider value={{ ...mockDocContext, editable: true, saveState }}>
          <EditStatus />
        </DocProvider>,
      );
      const region = screen.getByRole("status");
      return [region.textContent, region.getAttribute("aria-live")];
    };
    expect(status("unsaved")).toEqual(["Edited", "off"]);
    expect(status("saving")).toEqual(["Saving…", "off"]);
    expect(status("saved")).toEqual(["Saved", "off"]);
    expect(status("failed")).toEqual(["Not saved", "polite"]);
    expect(status("refused")).toEqual(["Not saved", "polite"]);
  });
});
