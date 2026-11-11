import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { api, type Comment, type Principal } from "@/api";
import { saveReplyDraft, setEdit, type CommentDraft } from "@/lib/comment-drafts";
import { CommentComposer, CommentThread, CommentsList } from "./doc-comments";
import { DocProvider, type DocContextValue } from "./doc-context";

const author: Principal & { type: "user" } = {
  type: "user",
  id: "u1",
  name: "Reviewer",
  email: "reviewer@example.com",
};
const reader: Principal = { type: "user", id: "u2", name: "Reader" };

function thread(id: string, status: string, over: Partial<Comment> = {}): Comment {
  return {
    id,
    body: `Thread ${id}`,
    selected_text: "quoted text",
    status,
    author,
    created_on_version_id: "v1",
    anchor: { quote: "quoted text" },
    ...over,
  };
}

const comments = [
  thread("open", "open"),
  thread("resolved", "resolved"),
  thread("pin", "open", {
    selected_text: "",
    anchor: { quote: "", point: { label: "Revenue chart", x: 0.5, y: 0.5 } },
    replies: [
      thread("reply", "open", {
        mentions: [{ principal: { type: "user", id: "u2" }, offset: 0, length: 7 }],
      }),
    ],
  }),
];

function renderList(over: Partial<DocContextValue> = {}, showsLatest = true) {
  const ctx = {
    docId: "doc-1",
    comments,
    commentsLoading: false,
    commentsError: false,
    notifications: false,
    principal: reader,
    unanchoredComments: new Set<string>(),
    movedPins: new Set<string>(),
    commentPositions: new Map(),
    drafts: [],
    discardDraft: vi.fn(),
    ...over,
  } as DocContextValue;
  const props = {
    showsLatest,
    onPick: vi.fn(),
    onPlacePin: vi.fn(),
    retry: { isFetching: false, refetch: vi.fn() },
    onClose: vi.fn(),
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <DocProvider value={ctx}>
          <CommentsList {...props} />
        </DocProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...props, ctx };
}

const listed = () =>
  screen
    .getAllByRole("listitem")
    .map((item) => within(item).getByText(/^Thread /).textContent);

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it("lists every thread, open and resolved, and filters them", async () => {
  renderList();
  expect(listed()).toEqual(["Thread open", "Thread resolved", "Thread pin"]);

  await userEvent.click(screen.getByRole("button", { name: "open" }));
  expect(listed()).toEqual(["Thread open", "Thread pin"]);

  await userEvent.click(screen.getByRole("button", { name: "resolved" }));
  expect(listed()).toEqual(["Thread resolved"]);

  // A thread mentions the reader in a reply.
  await userEvent.click(screen.getByRole("button", { name: "for you" }));
  expect(listed()).toEqual(["Thread pin"]);
});

it("lists threads in the order of the document, and marks the unread ones", () => {
  renderList({
    comments: [...comments.slice(0, 2), { ...comments[2], unread: true }],
    commentPositions: new Map([
      ["pin", { top: 10, bottom: 10 }],
      ["open", { top: 500, bottom: 520 }],
    ]),
  });
  // The resolved thread is not in the document: it comes last.
  expect(listed()).toEqual(["Thread pin", "Thread open", "Thread resolved"]);
  expect(screen.getAllByRole("img", { name: "Unread" })).toHaveLength(1);
});

it("names what a thread is on: its quote, or the element of its pin", () => {
  renderList();
  expect(screen.getAllByText("quoted text")).toHaveLength(2);
  expect(screen.getByText("Revenue chart")).toBeInTheDocument();
});

it("marks a thread whose text or pin is gone", () => {
  renderList({ unanchoredComments: new Set(["resolved"]) });
  const item = screen.getByText("Thread resolved").closest("li")!;
  expect(within(item).getByText("Not found in this version")).toBeInTheDocument();
});

it("trusts the server's placement on the latest version only", () => {
  const gone = thread("gone", "resolved", {
    current_placement: { status: "orphaned", confidence: 0, matched_text: "" },
  });
  renderList({ comments: [gone] });
  expect(screen.getByText("Not found in this version")).toBeInTheDocument();
  cleanup();
  renderList({ comments: [gone] }, false);
  expect(screen.queryByText("Not found in this version")).not.toBeInTheDocument();
});

it("marks a pin whose element is gone as moved, not as lost", () => {
  const moved = thread("moved", "open", {
    anchor: { quote: "", point: { label: "Pricing", x: -0.2, y: 0.5 } },
    current_placement: { status: "moved", confidence: 0, matched_text: "" },
  });
  renderList({ comments: [moved] });
  expect(screen.getByText("Pricing")).toBeInTheDocument();
  expect(screen.getByText("Moved: its element is gone")).toBeInTheDocument();
  expect(screen.queryByText("Not found in this version")).not.toBeInTheDocument();
  cleanup();
  // On an earlier version, the bridge tells.
  renderList({ comments: [moved], movedPins: new Set(["moved"]) }, false);
  expect(screen.getByText("Moved: its element is gone")).toBeInTheDocument();
});

it("opens a picked thread, and starts placing a pin", async () => {
  const props = renderList();
  await userEvent.click(screen.getByText("Thread resolved"));
  expect(props.onPick).toHaveBeenCalledWith("resolved");

  await userEvent.click(screen.getByRole("button", { name: "Comment on a spot" }));
  expect(props.onPlacePin).toHaveBeenCalled();
});

it("says when a filter has no threads", async () => {
  renderList({ comments: [thread("open", "open")] });
  await userEvent.click(screen.getByRole("button", { name: "resolved" }));
  expect(screen.getByText("No resolved comments yet")).toBeInTheDocument();
});

it("marks the open thread and scrolls it into view", () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  renderList({ activeComment: "pin" });
  const row = screen.getByText("Thread pin").closest("button")!;
  expect(row).toHaveAttribute("aria-current", "true");
  expect(scrollIntoView).toHaveBeenCalledOnce();
  expect(scrollIntoView.mock.contexts[0]).toBe(row);
});

it("shows a mention as a chip, as the thread does", () => {
  renderList({
    comments: [
      thread("open", "open", {
        body: "Thread @Reader please",
        mentions: [{ principal: { type: "user", id: "u2" }, offset: 7, length: 7 }],
      }),
    ],
  });
  expect(screen.getByText("@Reader")).toHaveClass("rounded");
});

it("tells a failed load from an empty list, and tries again", async () => {
  const props = renderList({ commentsError: true });
  expect(screen.getByText("Could not load comments")).toBeInTheDocument();
  expect(screen.queryByText("No comments yet")).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(props.retry.refetch).toHaveBeenCalled();
});

it("asks a reader who is signed out to sign in to comment", async () => {
  const props = renderList({ signIn: vi.fn(), principal: undefined });
  expect(screen.queryByRole("button", { name: "for you" })).not.toBeInTheDocument();
  expect(
    screen.queryByRole("button", { name: "Comment on a spot" }),
  ).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Sign in to comment" }));
  expect(props.onPlacePin).toHaveBeenCalled();
});

const draft = (id: string, body: string): CommentDraft => ({
  id,
  version: "v1",
  quote: "drafted text",
  body,
  mentions: [],
  updatedAt: Date.now(),
});

it("lists the drafts with text first, counts them apart, and opens one", async () => {
  const { onPick } = renderList({
    comments: [],
    drafts: [draft("draft:1", "Not sent yet"), draft("draft:2", " ")],
  });
  const drafts = within(screen.getByRole("list", { name: "Drafts" }));
  expect(drafts.getAllByRole("listitem")).toHaveLength(1);
  expect(drafts.getByText("Draft")).toBeInTheDocument();
  expect(drafts.getByText("drafted text")).toBeInTheDocument();
  expect(screen.getByLabelText("0 comment threads (all), 1 draft")).toHaveTextContent(
    "0 · 1 draft",
  );
  expect(screen.queryByText("No comments yet")).not.toBeInTheDocument();

  await userEvent.click(drafts.getByText("Not sent yet"));
  expect(onPick).toHaveBeenCalledWith("draft:1");

  // A draft is an open thread that is not sent.
  await userEvent.click(screen.getByRole("button", { name: "resolved" }));
  expect(screen.queryByRole("list", { name: "Drafts" })).not.toBeInTheDocument();
});

it("discards a draft from the list", async () => {
  const { ctx } = renderList({ drafts: [draft("draft:1", "Not sent yet")] });
  await userEvent.click(screen.getByRole("button", { name: "Discard" }));
  expect(ctx.discardDraft).toHaveBeenCalledWith("draft:1");
});

it("offers to move a moved pin to its author, in its thread", async () => {
  const moved = thread("moved", "open", {
    anchor: { quote: "", point: { label: "Intro", x: 0.5, y: 0.5 } },
  });
  const setPlacingPin = vi.fn();
  const ctx = {
    docId: "doc-1",
    principal: author,
    canEdit: false,
    unanchoredComments: new Set<string>(),
    movedPins: new Set(["moved"]),
    setPlacingPin,
  } as unknown as DocContextValue;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <DocProvider value={ctx}>
          <CommentThread c={moved} onClose={vi.fn()} />
        </DocProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  expect(screen.getByText("Moved: its element is gone")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Move pin" }));
  expect(setPlacingPin).toHaveBeenCalledWith("moved");
});

it("tells how to start a thread", () => {
  renderList({ comments: [] });
  expect(
    screen.getByText("Select text, or press C and click a spot, to start a thread."),
  ).toBeInTheDocument();
});

function renderComposer() {
  const ctx = {
    docId: "doc-1",
    principal: reader,
    unanchoredComments: new Set<string>(),
    saveDraft: vi.fn(),
    discardDraft: vi.fn(),
    setActiveComment: vi.fn(),
  } as unknown as DocContextValue;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocProvider value={ctx}>
        <CommentComposer draft={draft("draft:1", "")} />
      </DocProvider>
    </QueryClientProvider>,
  );
  return { ctx, box: screen.getByPlaceholderText("Add a comment…") };
}

it("keeps the words typed while a comment posts, as a reply to the new thread", async () => {
  localStorage.clear();
  let settle!: (c: Comment) => void;
  const post = vi
    .spyOn(api, "createComment")
    .mockReturnValue(new Promise((resolve) => (settle = resolve)));
  const { ctx, box } = renderComposer();
  await userEvent.type(box, "Fix this{Enter}KEEP THE LATER WORDS");
  expect(post).toHaveBeenCalledWith(
    "doc-1",
    "v1",
    "Fix this",
    "drafted text",
    undefined,
    [],
  );
  await act(async () => settle(thread("cmt_new", "open")));
  expect(ctx.discardDraft).toHaveBeenCalledWith("draft:1");
  const open = vi.mocked(ctx.setActiveComment).mock.lastCall![0] as (
    id?: string,
  ) => string;
  expect(open("draft:1")).toBe("cmt_new");
  expect(
    JSON.parse(localStorage.getItem("slashdocs.reply-drafts")!)["doc-1"].cmt_new,
  ).toMatchObject({ body: "KEEP THE LATER WORDS" });
});

it("keeps the comment in its draft when it does not post", async () => {
  vi.spyOn(api, "createComment").mockRejectedValue(new Error("503"));
  const { ctx, box } = renderComposer();
  await userEvent.type(box, "Fix this{Enter}");
  await vi.waitFor(() => expect(api.createComment).toHaveBeenCalled());
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
  expect(box).toHaveValue("Fix this");
  expect(ctx.discardDraft).not.toHaveBeenCalled();
});

it("lists the unsent words of a thread that someone deleted, to open, copy or discard", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText");
  setEdit("doc-1", "gone", {
    thread: "gone",
    base: "Deleted words",
    body: "Deleted words IMPORTANT EDIT",
    mentions: [],
  });
  saveReplyDraft("doc-1", "gone", { body: "UNSENT REPLY", mentions: [] });
  saveReplyDraft("doc-1", "open", { body: "Reply on a live thread", mentions: [] });
  const { onPick } = renderList();
  const drafts = within(screen.getByRole("list", { name: "Drafts" }));
  expect(drafts.getAllByRole("listitem")).toHaveLength(3);
  expect(drafts.getAllByText("Thread deleted")).toHaveLength(2);
  expect(
    screen.getByLabelText("3 comment threads (all), 3 drafts"),
  ).toBeInTheDocument();

  const edit = within(drafts.getByText("Deleted words IMPORTANT EDIT").closest("li")!);
  await user.click(edit.getByRole("button", { name: "Copy my text" }));
  expect(writeText).toHaveBeenCalledWith("Deleted words IMPORTANT EDIT");
  await user.click(drafts.getByText("UNSENT REPLY"));
  expect(onPick).toHaveBeenCalledWith("gone");
  await user.click(edit.getByRole("button", { name: "Discard" }));
  expect(drafts.queryByText("Deleted words IMPORTANT EDIT")).toBeNull();
  expect(drafts.getByText("Reply on a live thread")).toBeInTheDocument();
});

it("keeps the drafts in reach when the comments do not load", () => {
  saveReplyDraft("doc-1", "gone", { body: "UNSENT REPLY", mentions: [] });
  renderList({ comments: [], commentsError: true });
  const drafts = within(screen.getByRole("list", { name: "Drafts" }));
  expect(drafts.getByText("UNSENT REPLY")).toBeInTheDocument();
  // It cannot know yet whether the thread is gone.
  expect(drafts.queryByText("Thread deleted")).toBeNull();
});
