import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { Comment, Principal } from "@/api";
import { Comments } from "./doc-comments";
import { DocProvider, type DocContextValue } from "./doc-context";

afterEach(cleanup);

const author: Principal & { type: "user" } = {
  type: "user",
  id: "u1",
  name: "Reviewer",
  email: "reviewer@example.com",
};

function thread(id: string, status: string): Comment {
  return {
    id,
    body: `Thread ${id}`,
    selected_text: "quoted text",
    status,
    author,
    created_on_version_id: "v1",
    anchor: { quote: "quoted text" },
  };
}

function contextValue(over: Partial<DocContextValue> = {}): DocContextValue {
  return {
    docId: "doc-1",
    version: "v1",
    comments: [],
    commentFilter: "open",
    setCommentFilter: vi.fn(),
    commentsLoading: false,
    commentsError: false,
    notifications: false,
    principal: author,
    drafts: [],
    startDraft: vi.fn(),
    saveDraft: vi.fn(),
    discardDraft: vi.fn(),
    activeComment: undefined,
    setActiveComment: vi.fn(),
    unanchoredComments: new Set<string>(),
    setUnanchoredComments: vi.fn(),
    commentPositions: new Map(),
    setCommentPositions: vi.fn(),
    commentViewport: { scrollTop: 0, scrollHeight: 1 },
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
    ...over,
  };
}

function renderComments(ctx: DocContextValue) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DocProvider value={ctx}>
          <Comments />
        </DocProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Switching tabs only changes which threads are listed. Activating the first
// thread of the new filter revealed it through the rail, which scrolled the
// document to the top because a resolved thread never has a known position
// while the default Open filter hides its highlight.
it("switching to resolved leaves the document and the active thread alone", async () => {
  const setCommentFilter = vi.fn();
  const setActiveComment = vi.fn();
  const scrollDocumentTo = vi.fn();
  renderComments(
    contextValue({
      comments: [thread("c1", "open"), thread("c2", "resolved")],
      setCommentFilter,
      setActiveComment,
      scrollDocumentTo,
    }),
  );

  await userEvent.click(screen.getByRole("button", { name: "resolved" }));

  expect(setCommentFilter).toHaveBeenCalledWith("resolved");
  expect(scrollDocumentTo).not.toHaveBeenCalled();
  expect(setActiveComment).not.toHaveBeenCalled();
});

it("switching to an empty filter does not scroll the document", async () => {
  const scrollDocumentTo = vi.fn();
  renderComments(
    contextValue({
      comments: [thread("c1", "open")],
      scrollDocumentTo,
    }),
  );

  await userEvent.click(screen.getByRole("button", { name: "resolved" }));

  expect(scrollDocumentTo).not.toHaveBeenCalled();
});

it("drops the active thread when the new filter hides it", async () => {
  const setActiveComment = vi.fn();
  const scrollDocumentTo = vi.fn();
  renderComments(
    contextValue({
      comments: [thread("c1", "open"), thread("c2", "resolved")],
      activeComment: "c1",
      setActiveComment,
      scrollDocumentTo,
    }),
  );

  await userEvent.click(screen.getByRole("button", { name: "resolved" }));

  expect(setActiveComment).toHaveBeenCalledWith(undefined);
  expect(scrollDocumentTo).not.toHaveBeenCalled();
});

it("keeps the active thread when the new filter still lists it", async () => {
  const setActiveComment = vi.fn();
  const scrollDocumentTo = vi.fn();
  renderComments(
    contextValue({
      comments: [thread("c1", "open"), thread("c2", "resolved")],
      activeComment: "c2",
      setActiveComment,
      scrollDocumentTo,
    }),
  );

  await userEvent.click(screen.getByRole("button", { name: "all" }));

  expect(setActiveComment).not.toHaveBeenCalled();
  expect(scrollDocumentTo).not.toHaveBeenCalled();
});
