import { createRef } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { Comment } from "@/api";
import { CommentPopovers } from "./doc-comment-popover";
import { DocProvider, type DocContextValue } from "./doc-context";

// jsdom has no media queries.
beforeEach(() => {
  window.matchMedia = () =>
    ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
});
afterEach(cleanup);

const c = {
  id: "c1",
  body: "Look here",
  status: "open",
  author: { type: "user", id: "u1", name: "Reviewer" },
} as Comment;

// A thread whose text is gone opens at once, with no anchor from the frame.
function renderThread() {
  const ctx = {
    docId: "doc-1",
    comments: [c],
    drafts: [],
    activeComment: "c1",
    setActiveComment: () => {},
    unanchoredComments: new Set(["c1"]),
    signIn: () => {},
  } as unknown as DocContextValue;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <DocProvider value={ctx}>
          <CommentPopovers
            frame={createRef()}
            bounds={createRef()}
            origin={null}
            ready={false}
            postToFrame={() => {}}
          />
        </DocProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it("takes the focus that was lost, so Esc reaches the thread", () => {
  renderThread();
  expect(screen.getByRole("dialog", { name: "Comment thread" })).toHaveFocus();
});

it("leaves the focus in the document", () => {
  const frame = document.body.appendChild(document.createElement("iframe"));
  frame.focus();
  renderThread();
  expect(frame).toHaveFocus();
  frame.remove();
});
