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
  await vi.waitFor(() => expect(ctx.discardDraft).toHaveBeenCalledWith("d1"));
  expect(create).toHaveBeenCalledTimes(2);
  expect(create.mock.calls[1][2]).toBe("Try again");
});

it("tells the frame how much of it a sheet covers, while the sheet is open", async () => {
  window.matchMedia = () =>
    ({
      matches: true,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  // Each sheet is 400px tall, and reports it as it opens. The frame is not
  // scaled.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this instanceof HTMLIFrameElement ? 712 : 400;
  });
  const stub = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(private fn: () => void) {}
    observe() {
      this.fn();
    }
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const iframe = document.body.appendChild(document.createElement("iframe"));
  // The frame fills the 768px window below a 56px bar.
  iframe.getBoundingClientRect = () => new DOMRect(0, 56, 1024, 712);
  const frame = { current: iframe };
  const posted: Record<string, unknown>[] = [];
  function Sheet() {
    const [client] = useState(() => new QueryClient());
    const [active, setActive] = useState<string | undefined>("c1");
    const ctx = {
      docId: "doc-1",
      comments: [c],
      drafts: [],
      activeComment: active,
      setActiveComment: setActive,
      unanchoredComments: new Set(["c1"]),
      movedPins: new Set(),
      signIn: () => {},
    } as unknown as DocContextValue;
    return (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <DocProvider value={ctx}>
            <CommentPopovers
              frame={frame}
              bounds={createRef()}
              origin={null}
              ready={false}
              postToFrame={(m) => posted.push(m)}
            />
          </DocProvider>
        </MemoryRouter>
      </QueryClientProvider>
    );
  }
  try {
    render(<Sheet />);
    expect(posted.at(-1)).toEqual({ type: "slashdocs:cover", bottom: 400 });
    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() =>
      expect(posted.at(-1)).toEqual({ type: "slashdocs:cover", bottom: 0 }),
    );
  } finally {
    globalThis.ResizeObserver = stub;
    vi.restoreAllMocks();
    iframe.remove();
  }
});

it("keeps the words of an edit and a reply when someone deletes the thread", async () => {
  localStorage.clear();
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText");
  const mine = { ...c, author: { type: "user", id: "me" } } as Comment;
  const ctx = {
    principal: { type: "user", id: "me" },
    signIn: undefined,
    comments: [mine],
  } as Partial<DocContextValue>;
  const view = render(<Thread {...ctx} />);
  await user.type(screen.getByPlaceholderText("Reply…"), "UNSENT REPLY");
  await user.click(screen.getByRole("button", { name: "More actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Edit" }));
  await user.type(
    await screen.findByRole("combobox", { name: "Edit comment" }),
    " UNSAVED EDIT",
  );
  view.rerender(<Thread {...ctx} comments={[]} />);
  const notice = await screen.findByRole("status");
  expect(notice).toHaveTextContent(
    "This thread was deleted. Your words were not sent:Look here UNSAVED EDITUNSENT REPLY",
  );
  await user.click(screen.getByRole("button", { name: "Copy my text" }));
  expect(writeText).toHaveBeenCalledWith("Look here UNSAVED EDIT\n\nUNSENT REPLY");
});

it("shows a new comment as sending, with the field clear for more words", async () => {
  let settle!: (value: Comment) => void;
  vi.spyOn(api, "createComment").mockReturnValueOnce(
    new Promise<Comment>((resolve) => (settle = resolve)),
  );
  const ctx = renderDraft();
  const field = screen.getByPlaceholderText("Add a comment…");
  await userEvent.type(field, "First words{Enter}");
  expect(field).toHaveValue("");
  expect(screen.getByText("Sending…").closest("[aria-busy]")).toHaveTextContent(
    "First words",
  );
  settle({ id: "c2" } as Comment);
  await vi.waitFor(() => expect(ctx.discardDraft).toHaveBeenCalledWith("d1"));
  // The thread opens where its composer is still open, and only there.
  const open = ctx.setActiveComment.mock.lastCall![0];
  expect(open("d1")).toBe("c2");
  expect(open(undefined)).toBeUndefined();
  expect(open("c9")).toBe("c9");
});

it.each([
  ["opens the posted thread where its composer stays open", false, "c2"],
  ["keeps the thread closed when Esc closes a comment that sends", true, undefined],
])("%s", async (_, esc, opened) => {
  let settle!: (value: Comment) => void;
  vi.spyOn(api, "createComment").mockReturnValueOnce(
    new Promise<Comment>((resolve) => (settle = resolve)),
  );
  function Composer() {
    const [active, setActive] = useState<string | undefined>("d1");
    const draft: CommentDraft = {
      id: "d1",
      version: "v1",
      quote: "Look",
      body: "",
      mentions: [],
      updatedAt: 0,
    };
    renders.push(active);
    return (
      <DocProvider
        value={
          {
            docId: "doc-1",
            comments: [],
            drafts: active === "d1" ? [draft] : [],
            activeComment: active,
            setActiveComment: setActive,
            unanchoredComments: new Set(["d1"]),
            saveDraft: () => {},
            // As the workspace does, it closes the draft that is still open.
            discardDraft: (id: string) =>
              setActive((now) => (now === id ? undefined : now)),
          } as unknown as DocContextValue
        }
      >
        <CommentPopovers
          frame={createRef()}
          bounds={createRef()}
          origin={null}
          ready={false}
          postToFrame={() => {}}
        />
      </DocProvider>
    );
  }
  const renders: (string | undefined)[] = [];
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <Composer />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await userEvent.type(screen.getByPlaceholderText("Add a comment…"), "Sent{Enter}");
  if (esc) await userEvent.keyboard("{Escape}");
  settle({ id: "c2" } as Comment);
  await vi.waitFor(() => expect(renders.at(-1)).toBe(opened));
  await new Promise((r) => setTimeout(r, 50));
  expect(renders.at(-1)).toBe(opened);
});
