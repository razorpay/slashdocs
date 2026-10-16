import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocBar } from "./doc-bar";
import { DocProvider, type DocContextValue } from "./doc-context";

const mockDocContext: DocContextValue = {
  docId: "doc_1",
  version: "v_1",
  comments: [],
  commentFilter: "all",
  setCommentFilter: vi.fn(),
  commentsLoading: false,
  commentsError: false,
  notifications: false,
  drafts: [],
  startDraft: vi.fn(),
  saveDraft: vi.fn(),
  discardDraft: vi.fn(),
  setActiveComment: vi.fn(),
  unanchoredComments: new Set(),
  setUnanchoredComments: vi.fn(),
  commentPositions: new Map(),
  setCommentPositions: vi.fn(),
  commentViewport: { scrollTop: 0, scrollHeight: 0 },
  setCommentViewport: vi.fn(),
  registerDocumentPrinter: vi.fn(),
  printDocument: vi.fn(),
  registerDocumentScroller: vi.fn(),
  scrollDocumentTo: vi.fn(),
  registerCommentRailSync: vi.fn(),
  syncCommentRail: vi.fn(),
  handleDocCommentClick: vi.fn(),
  handleRenderedDocumentClick: vi.fn(),
  subscribeDocumentKV: () => () => {},
  reportViewport: vi.fn(),
  moveCursor: vi.fn(),
  subscribeCursors: () => () => {},
};

function renderDocBar(labelsEnabled = true) {
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
      return new Response(JSON.stringify({}), {
        headers: { "Content-Type": "application/json" },
      });
    }),
  );

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const onSelectVersion = vi.fn();

  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <DocProvider value={mockDocContext}>
          <DocBar
            title="Test Document"
            docId="doc_1"
            current="v_1"
            latest="v_2"
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
            viewers={[]}
            onFollowViewer={vi.fn()}
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

  return { onSelectVersion };
}

describe("DocBar More menu and small-screen reachable dialogs", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("opens version history dialog from the More menu", async () => {
    const user = userEvent.setup();
    const { onSelectVersion } = renderDocBar();

    const moreButton = screen.getByRole("button", { name: "More" });
    await user.click(moreButton);

    const historyMenuItem = await screen.findByRole("menuitem", {
      name: /Version history/i,
    });
    expect(historyMenuItem).toBeInTheDocument();
    expect(historyMenuItem).toHaveClass("sm:hidden");

    await user.click(historyMenuItem);

    const dialogTitle = await screen.findByRole("heading", {
      name: "Version history",
    });
    expect(dialogTitle).toBeInTheDocument();

    expect(screen.getByText("Second version")).toBeInTheDocument();

    const v2Button = screen.getByRole("button", { name: /Version 2/i });
    await user.click(v2Button);
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
  });

  it("hides document labels from the More menu when labels are disabled", async () => {
    const user = userEvent.setup();
    renderDocBar(false);

    const moreButton = screen.getByRole("button", { name: "More" });
    await user.click(moreButton);

    await waitFor(() => {
      expect(
        screen.getByRole("menuitem", { name: /Version history/i }),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByRole("menuitem", { name: /Document labels/i }),
    ).not.toBeInTheDocument();
  });
});
