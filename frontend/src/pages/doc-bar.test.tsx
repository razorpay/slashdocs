import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocBar } from "./doc-bar";
import { DocProvider, type DocContextValue } from "./doc-context";
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

function renderDocBar(labelsEnabled = true, viewers: Viewer[] = []) {
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
      if (url === "/v1/documents/doc_1/access") {
        return new Response(
          JSON.stringify({
            current_role: "owner",
            items: [],
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
            current="v_1"
            latest="v_2"
            previewing={false}
            canChangeContent
            versions={[
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
            ]}
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

    expect(screen.getByText("Second version")).toBeInTheDocument();

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
});
