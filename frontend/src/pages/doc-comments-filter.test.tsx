import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Comment, Principal } from "@/api";
import { Comments } from "./doc-comments";
import { DocProvider, type DocContextValue } from "./doc-context";

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

// jsdom has no layout. Give each rail card a height, and put the cards below
// the rail, so that a reveal of a card scrolls the document.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const top = this.tagName === "ARTICLE" ? 400 : 0;
    return new DOMRect(0, top, 300, 300);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("switching filters activates the first thread of the new filter", async () => {
  const setCommentFilter = vi.fn();
  const setActiveComment = vi.fn();
  renderComments(
    contextValue({
      comments: [thread("c1", "open"), thread("c2", "resolved")],
      setCommentFilter,
      setActiveComment,
    }),
  );

  await userEvent.click(screen.getByRole("button", { name: "resolved" }));

  expect(setCommentFilter).toHaveBeenCalledWith("resolved");
  expect(setActiveComment).toHaveBeenCalledWith("c2");
});

it("switching to an empty filter leaves the document in place", async () => {
  const setActiveComment = vi.fn();
  const scrollDocumentTo = vi.fn();
  renderComments(
    contextValue({
      comments: [thread("c1", "open")],
      setActiveComment,
      scrollDocumentTo,
    }),
  );

  await userEvent.click(screen.getByRole("button", { name: "resolved" }));

  expect(setActiveComment).toHaveBeenCalledWith(undefined);
  expect(scrollDocumentTo).not.toHaveBeenCalled();
});

// After a filter switch, the bridge has not yet painted the threads of the new
// filter. The rail took such a thread for unanchored and scrolled the document
// to the top of the rail to reveal it.
it("the rail waits for the bridge to place the active thread", () => {
  const scrollDocumentTo = vi.fn();
  renderComments(
    contextValue({
      comments: [thread("c2", "resolved")],
      commentFilter: "resolved",
      activeComment: "c2",
      scrollDocumentTo,
    }),
  );

  expect(scrollDocumentTo).not.toHaveBeenCalled();
});

it("the rail reveals an active thread that the bridge could not anchor", () => {
  const scrollDocumentTo = vi.fn();
  renderComments(
    contextValue({
      comments: [thread("c2", "resolved")],
      commentFilter: "resolved",
      activeComment: "c2",
      unanchoredComments: new Set(["c2"]),
      scrollDocumentTo,
    }),
  );

  expect(scrollDocumentTo).toHaveBeenCalled();
});
