import { createRef, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { toast, type Action } from "sonner";
import { api, type Comment } from "@/api";
import type { CommentDraft } from "@/lib/comment-drafts";
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
function Thread(more: Partial<DocContextValue>) {
  const [client] = useState(() => new QueryClient());
  const ctx = {
    docId: "doc-1",
    comments: [c],
    drafts: [],
    activeComment: "c1",
    setActiveComment: () => {},
    unanchoredComments: new Set(["c1"]),
    movedPins: new Set(),
    signIn: () => {},
    ...more,
  } as unknown as DocContextValue;
  return (
    <QueryClientProvider client={client}>
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
    </QueryClientProvider>
  );
}

function renderThread(more: Partial<DocContextValue> = {}) {
  render(<Thread {...more} />);
}

function ClosableThread() {
  const [active, setActive] = useState<string | undefined>("c1");
  return <Thread activeComment={active} setActiveComment={setActive} />;
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

it.each([
  ["the button that opened it", true],
  ["the Comments button, when its opener is gone", false],
])("gives the focus back to %s when Esc closes it", async (_, kept) => {
  const button = (label: string) => {
    const el = document.body.appendChild(document.createElement("button"));
    el.setAttribute("aria-label", label);
    return el;
  };
  const comments = button("Comments");
  const opener = button("Open thread");
  opener.focus();
  render(<ClosableThread />);
  expect(screen.getByRole("dialog", { name: "Comment thread" })).toHaveFocus();
  if (!kept) opener.remove();
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(kept ? opener : comments).toHaveFocus());
  comments.remove();
  opener.remove();
});

function renderDraft() {
  const draft: CommentDraft = {
    id: "d1",
    version: "v1",
    quote: "Look",
    body: "",
    mentions: [],
    updatedAt: 0,
  };
  const ctx = {
    drafts: [draft],
    activeComment: "d1",
    unanchoredComments: new Set(["d1"]),
    setActiveComment: vi.fn(),
    saveDraft: vi.fn(),
    discardDraft: vi.fn(),
  };
  renderThread(ctx);
  return ctx;
}

it("keeps a typed draft when Esc closes the new comment", async () => {
  const ctx = renderDraft();
  await userEvent.type(screen.getByPlaceholderText("Add a comment…"), "Half a thought");
  await userEvent.keyboard("{Escape}");
  expect(ctx.setActiveComment).toHaveBeenCalledWith(undefined);
  cleanup();
  expect(ctx.saveDraft).toHaveBeenLastCalledWith("d1", {
    body: "Half a thought",
    mentions: [],
  });
  expect(ctx.discardDraft).not.toHaveBeenCalled();
});

it("discards a draft with its discard button only", async () => {
  const ctx = renderDraft();
  await userEvent.type(screen.getByPlaceholderText("Add a comment…"), "Never mind");
  await userEvent.click(screen.getByRole("button", { name: "Discard comment" }));
  expect(ctx.discardDraft).toHaveBeenCalledWith("d1");
});

it("keeps the text of a comment that did not post, and posts it again", async () => {
  const create = vi
    .spyOn(api, "createComment")
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValueOnce({ id: "c2" } as Comment);
  const error = vi.spyOn(toast, "error");
  const ctx = renderDraft();
  const field = screen.getByPlaceholderText("Add a comment…");
  await userEvent.type(field, "Try again{Enter}");
  await vi.waitFor(() => expect(error).toHaveBeenCalled());
  expect(field).toHaveValue("Try again");

  const retry = error.mock.calls[0][1]?.action as Action;
  retry.onClick({} as Parameters<Action["onClick"]>[0]);
  await vi.waitFor(() => expect(ctx.setActiveComment).toHaveBeenCalledWith("c2"));
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1][2]).toBe("Try again");
});
