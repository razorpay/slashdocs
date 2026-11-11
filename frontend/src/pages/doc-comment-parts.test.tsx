import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { APIError, api, type Comment } from "@/api";
import { emptyMentionDraft, type MentionDraft } from "@/lib/comment-mentions";
import {
  AgentRequestBadge,
  ComposeField,
  Message,
  MoreMenu,
  ReplyRow,
  Replies,
} from "./doc-comment-parts";
import { DocProvider, type DocContextValue } from "./doc-context";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

function Field({
  onSubmit,
  pending = false,
}: {
  onSubmit: () => void;
  pending?: boolean;
}) {
  const [draft, setDraft] = useState<MentionDraft>(emptyMentionDraft);
  return (
    <ComposeField
      value={draft}
      onChange={setDraft}
      onSubmit={onSubmit}
      pending={pending}
      placeholder="Reply…"
      sendLabel="Post reply"
    />
  );
}

it("marks a comment that asks an agent to change words, and the bot that saw it", () => {
  const request: Comment = {
    id: "cmt_1",
    body: "Please change “3 open” to: 4 open",
    status: "open",
    author: { type: "user", id: "usr_ana" },
    created_on_version_id: "ver_1",
  };
  render(<AgentRequestBadge c={request} />);
  expect(screen.getByText("Agent request")).toBeVisible();
  cleanup();
  const bot = { type: "service_account" as const, id: "sa_1", name: "Docs bot" };
  render(
    <AgentRequestBadge
      c={{
        ...request,
        reactions: [{ emoji: "eyes", count: 1, reacted: false, reactors: [bot] }],
      }}
    />,
  );
  expect(screen.getByText("Agent request · Seen by Docs bot")).toBeVisible();
  cleanup();
  const { container } = render(
    <AgentRequestBadge c={{ ...request, body: "Looks good" }} />,
  );
  expect(container).toBeEmptyDOMElement();
});

it("sends on Enter, and Shift+Enter starts a new line instead", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<Field onSubmit={onSubmit} />);
  const box = screen.getByPlaceholderText("Reply…");
  await user.type(box, "Looks good{Shift>}{Enter}{/Shift}on my side");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(box).toHaveValue("Looks good\non my side");
  await user.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it("does not send a blank message", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<Field onSubmit={onSubmit} />);
  await user.type(screen.getByPlaceholderText("Reply…"), "   {Enter}");
  expect(onSubmit).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Post reply" })).toBeDisabled();
});

it("does not send while the last message is still sending", async () => {
  const user = userEvent.setup();
  const onSubmit = vi.fn();
  render(<Field onSubmit={onSubmit} pending />);
  await user.type(screen.getByPlaceholderText("Reply…"), "Ship it{Enter}");
  expect(onSubmit).not.toHaveBeenCalled();
});

const thread = { id: "cmt_1" } as Comment;

function renderReply() {
  const ctx = { principal: { type: "user", id: "u1" } } as DocContextValue;
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <DocProvider value={ctx}>
        <ReplyRow c={thread} docId="doc-1" />
      </DocProvider>
    </QueryClientProvider>,
  );
}

it("keeps a reply after the thread closes, until it is posted", async () => {
  localStorage.clear();
  const post = vi.spyOn(api, "createCommentReply").mockResolvedValue({} as never);
  const user = userEvent.setup();
  const first = renderReply();
  await user.type(screen.getByPlaceholderText("Reply…"), "Half a thought");
  first.unmount();

  renderReply();
  const box = screen.getByPlaceholderText("Reply…");
  expect(box).toHaveValue("Half a thought");
  await user.type(box, "{Enter}");
  expect(post).toHaveBeenCalledWith("doc-1", "cmt_1", "Half a thought", []);
  expect(box).toHaveValue("");
  await act(() => new Promise((resolve) => setTimeout(resolve, 350)));
  expect(localStorage.getItem("slashdocs.reply-drafts")).toBe("{}");
});

it.each([
  ["the author", { principal: { type: "user", id: "usr_ana" }, canEdit: false }, true],
  ["an editor", { principal: { type: "user", id: "usr_ed" }, canEdit: true }, true],
  ["a commenter", { principal: { type: "user", id: "usr_bo" }, canEdit: false }, false],
])("offers Move pin to %s", async (_, reader, offered) => {
  const user = userEvent.setup();
  const setPlacingPin = vi.fn();
  const pin: Comment = {
    id: "cmt_pin",
    body: "Here",
    status: "open",
    author: { type: "user", id: "usr_ana" },
    created_on_version_id: "ver_1",
    anchor: { quote: "", point: { x: 0.5, y: 0.5 } },
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocProvider value={{ ...reader, setPlacingPin } as unknown as DocContextValue}>
        <MoreMenu c={pin} docId="doc_1" thread />
      </DocProvider>
    </QueryClientProvider>,
  );
  await user.click(screen.getByRole("button", { name: "More actions" }));
  const item = screen.queryByRole("menuitem", { name: "Move pin" });
  if (!offered) return expect(item).toBeNull();
  await user.click(item!);
  // After the menu closes, so that the document frame keeps the focus.
  await vi.waitFor(() => expect(setPlacingPin).toHaveBeenCalledWith("cmt_pin"));
});

// held gives a promise for a mocked API call, and the function that settles it.
function held<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (settle = resolve));
  return { promise, settle };
}

it("keeps the words typed while a reply posts, without the posted ones", async () => {
  localStorage.clear();
  const response = held<Comment>();
  const post = vi.spyOn(api, "createCommentReply").mockReturnValue(response.promise);
  const user = userEvent.setup();
  renderReply();
  const box = screen.getByPlaceholderText("Reply…");
  await user.type(box, "Agreed{Enter}KEEP THE LATER WORDS");
  expect(post).toHaveBeenCalledWith("doc-1", "cmt_1", "Agreed", []);
  await act(async () => response.settle({} as Comment));
  expect(box).toHaveValue("KEEP THE LATER WORDS");
});

const mine: Comment = {
  id: "cmt_mine",
  body: "Original words",
  status: "open",
  author: { type: "user", id: "u1" },
  created_on_version_id: "ver_1",
  parent_comment_id: "cmt_1",
};

function renderMessage(c: Comment) {
  const ctx = { principal: { type: "user", id: "u1" } } as DocContextValue;
  const ui = (next: Comment) => (
    <QueryClientProvider client={new QueryClient()}>
      <DocProvider value={ctx}>
        <Message c={next} docId="doc-1" thread={false} />
      </DocProvider>
    </QueryClientProvider>
  );
  const view = render(ui(c));
  return (next: Comment) => view.rerender(ui(next));
}

async function startEdit(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Message actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Edit" }));
  return screen.findByRole("combobox", { name: "Edit reply" });
}

it("starts each edit from the text on screen, after a live change", async () => {
  const user = userEvent.setup();
  const update = renderMessage(mine);
  update({ ...mine, body: "Remote words" });
  expect(await startEdit(user)).toHaveValue("Remote words");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  await user.keyboard("{Escape}");
});

it("takes a live change into an untouched edit, and tells of one under a changed edit", async () => {
  const user = userEvent.setup();
  const update = renderMessage(mine);
  const box = await startEdit(user);
  update({ ...mine, body: "Remote words" });
  expect(box).toHaveValue("Remote words");
  expect(screen.queryByRole("status")).toBeNull();

  await user.type(box, " and mine");
  update({ ...mine, body: "Second remote words" });
  expect(box).toHaveValue("Remote words and mine");
  expect(screen.getByRole("status")).toHaveTextContent(
    "This reply changed while you edited. It now says:Second remote words",
  );
  await user.click(screen.getByRole("button", { name: "Use the new text" }));
  expect(box).toHaveValue("Second remote words");
  expect(screen.queryByRole("status")).toBeNull();
  await user.keyboard("{Escape}");
});

it("keeps an edit open with the words typed while it saved", async () => {
  const user = userEvent.setup();
  const response = held<Comment>();
  const patch = vi.spyOn(api, "patchComment").mockReturnValue(response.promise);
  const update = renderMessage(mine);
  const box = await startEdit(user);
  await user.type(box, " fixed{Enter} KEEP");
  expect(patch).toHaveBeenCalledWith("doc-1", "cmt_mine", {
    body: "Original words fixed",
    mentions: [],
    base_body: "Original words",
  });
  update({ ...mine, body: "Original words fixed" });
  await act(async () => response.settle({} as Comment));
  expect(screen.getByRole("combobox", { name: "Edit reply" })).toHaveValue(
    "Original words fixed KEEP",
  );
  expect(screen.queryByRole("status")).toBeNull();

  patch.mockResolvedValue({} as Comment);
  await user.keyboard("{Enter}");
  update({ ...mine, body: "Original words fixed KEEP" });
  await vi.waitFor(() =>
    expect(screen.queryByRole("combobox", { name: "Edit reply" })).toBeNull(),
  );
  expect(screen.getByText("Original words fixed KEEP")).toBeVisible();
});

// otherTab writes a reply draft as another tab does: to storage, with a
// storage event.
function otherTab(body: string) {
  const key = "slashdocs.reply-drafts";
  const value = JSON.stringify({
    "doc-1": { cmt_1: { body, mentions: [], updatedAt: Date.now() } },
  });
  localStorage.setItem(key, value);
  window.dispatchEvent(new StorageEvent("storage", { key, newValue: value }));
}
const pause = () => act(() => new Promise((resolve) => setTimeout(resolve, 350)));
const storedReply = () =>
  JSON.parse(localStorage.getItem("slashdocs.reply-drafts")!)["doc-1"]?.cmt_1?.body;

it("takes a reply draft that another tab changed, and keeps both when both changed", async () => {
  localStorage.clear();
  const user = userEvent.setup();
  renderReply();
  const box = screen.getByPlaceholderText("Reply…");
  await user.type(box, "TAB A INITIAL");
  await pause();
  act(() => otherTab("TAB A IMPORTANT NEW WORDS"));
  expect(box).toHaveValue("TAB A IMPORTANT NEW WORDS");

  await user.type(box, " AND MINE");
  act(() => otherTab("NEWER IN THE OTHER TAB"));
  expect(box).toHaveValue("TAB A IMPORTANT NEW WORDS AND MINE");
  expect(screen.getByRole("status")).toHaveTextContent(
    "This draft changed in another tab. It now says:NEWER IN THE OTHER TAB",
  );
  // Until the reader chooses, the newer text stays saved.
  await user.type(box, "!");
  await pause();
  expect(storedReply()).toBe("NEWER IN THE OTHER TAB");
  await user.click(screen.getByRole("button", { name: "Keep mine" }));
  expect(screen.queryByRole("status")).toBeNull();
  expect(storedReply()).toBe("TAB A IMPORTANT NEW WORDS AND MINE!");

  await user.type(box, "?");
  act(() => otherTab("THEIRS AGAIN"));
  await user.click(screen.getByRole("button", { name: "Use the new text" }));
  expect(box).toHaveValue("THEIRS AGAIN");
  await pause();
  expect(storedReply()).toBe("THEIRS AGAIN");
});

function renderThreadReplies(c: Comment) {
  const ctx = { principal: { type: "user", id: "u1", name: "Ana" } } as DocContextValue;
  const client = new QueryClient();
  const ui = (next: Comment) => (
    <QueryClientProvider client={client}>
      <DocProvider value={ctx}>
        <Replies c={next} docId="doc-1" />
        <ReplyRow c={next} docId="doc-1" />
      </DocProvider>
    </QueryClientProvider>
  );
  const view = render(ui(c));
  return (next: Comment) => view.rerender(ui(next));
}

it("shows a reply as sending in the thread, clears it from the field, and puts it back if it fails", async () => {
  localStorage.clear();
  let fail!: (reason: Error) => void;
  const response = new Promise<Comment>((_, reject) => (fail = reject));
  vi.spyOn(api, "createCommentReply").mockReturnValueOnce(response);
  const error = vi.spyOn(toast, "error");
  const user = userEvent.setup();
  renderThreadReplies(thread);
  const box = screen.getByPlaceholderText("Reply…");
  await user.type(box, "Double enter{Enter}");
  expect(box).toHaveValue("");
  const sending = screen.getByText("Sending…").closest("[aria-busy]");
  expect(sending).toHaveTextContent("Double enter");

  await user.type(box, "later");
  act(() => fail(new Error("offline")));
  await vi.waitFor(() => expect(error).toHaveBeenCalled());
  expect(box).toHaveValue("Double enter later");
  expect(screen.queryByText("Sending…")).toBeNull();
});

it("keeps the words of an edit when someone deletes its reply, with Copy my text", async () => {
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, "writeText");
  const update = renderThreadReplies({ ...thread, replies: [mine] });
  await user.click(screen.getByRole("button", { name: "Message actions" }));
  await user.click(screen.getByRole("menuitem", { name: "Edit" }));
  await user.type(
    await screen.findByRole("combobox", { name: "Edit reply" }),
    " UNSAVED EDIT",
  );
  update({ ...thread, replies: [] });
  expect(screen.getByRole("status")).toHaveTextContent(
    "This reply was deleted. Your words were not sent:Original words UNSAVED EDIT",
  );
  await user.click(screen.getByRole("button", { name: "Copy my text" }));
  expect(writeText).toHaveBeenCalledWith("Original words UNSAVED EDIT");
  await user.click(screen.getByRole("button", { name: "Discard" }));
  expect(screen.queryByRole("status")).toBeNull();
});

it("sends the text that an edit started from, so that a stale edit fails", async () => {
  const user = userEvent.setup();
  const patch = vi
    .spyOn(api, "patchComment")
    .mockRejectedValue(new APIError(409, "comment_changed", "changed"));
  const error = vi.spyOn(toast, "error");
  const update = renderMessage(mine);
  const box = await startEdit(user);
  await user.type(box, " MINE{Enter}");
  expect(patch).toHaveBeenCalledWith("doc-1", "cmt_mine", {
    body: "Original words MINE",
    mentions: [],
    base_body: "Original words",
  });
  update({ ...mine, body: "Newer words" });
  await vi.waitFor(() =>
    expect(screen.getByRole("status")).toHaveTextContent(
      "This reply changed while you edited. It now says:Newer words",
    ),
  );
  expect(box).toHaveValue("Original words MINE");
  expect(error).not.toHaveBeenCalled();
  await user.keyboard("{Escape}");
});

it("keeps both texts of a two-tab conflict after the thread closes, and shows them again", async () => {
  const user = userEvent.setup();
  const first = renderReply();
  await user.type(screen.getByPlaceholderText("Reply…"), "SHARED");
  await pause();
  await user.type(screen.getByPlaceholderText("Reply…"), " IMPORTANT LOCAL WORDS");
  act(() => otherTab("THE OTHER TAB SAVED"));
  expect(screen.getByRole("status")).toHaveTextContent("THE OTHER TAB SAVED");
  first.unmount();

  renderReply();
  expect(screen.getByPlaceholderText("Reply…")).toHaveValue(
    "SHARED IMPORTANT LOCAL WORDS",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "This draft changed in another tab. It now says:THE OTHER TAB SAVED",
  );
  expect(storedReply()).toBe("THE OTHER TAB SAVED");
  await user.click(screen.getByRole("button", { name: "Keep mine" }));
  expect(storedReply()).toBe("SHARED IMPORTANT LOCAL WORDS");
  expect(screen.queryByRole("status")).toBeNull();
});

it("says that the words of a reply came back, and discards them on request", async () => {
  const user = userEvent.setup();
  const first = renderReply();
  await user.type(screen.getByPlaceholderText("Reply…"), "Half a thought");
  first.unmount();
  renderReply();
  const notice = screen.getByRole("status");
  expect(notice).toHaveTextContent("You did not send these words yet.");
  await user.click(within(notice).getByRole("button", { name: "Discard" }));
  expect(screen.getByPlaceholderText("Reply…")).toHaveValue("");
  await pause();
  expect(storedReply()).toBeUndefined();
});

it("shows the reply count with a reply that sends, so that nothing moves when it posts", async () => {
  vi.spyOn(api, "createCommentReply").mockReturnValueOnce(new Promise(() => {}));
  const user = userEvent.setup();
  renderThreadReplies(thread);
  await user.type(screen.getByPlaceholderText("Reply…"), "First reply{Enter}");
  expect(screen.getByText("1 reply")).toBeVisible();
});

it("closes the view on Esc but keeps a changed edit, and Cancel discards it", async () => {
  const user = userEvent.setup();
  const outer = vi.fn();
  document.addEventListener("keydown", outer);
  renderMessage(mine);
  const box = await startEdit(user);
  await user.type(box, " KEEP ME{Escape}");
  expect(outer).toHaveBeenCalledWith(expect.objectContaining({ key: "Escape" }));
  document.removeEventListener("keydown", outer);
  cleanup();

  renderMessage(mine);
  expect(screen.getByRole("combobox", { name: "Edit reply" })).toHaveValue(
    "Original words KEEP ME",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "You did not save this edit yet.",
  );
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("combobox", { name: "Edit reply" })).toBeNull();
  expect(screen.getByText("Original words")).toBeVisible();
});

it("shows a reply once when a live update brings it before its send ends", async () => {
  vi.spyOn(api, "createCommentReply").mockReturnValueOnce(new Promise(() => {}));
  const user = userEvent.setup();
  const update = renderThreadReplies(thread);
  await user.type(screen.getByPlaceholderText("Reply…"), "First reply{Enter}");
  update({
    ...thread,
    replies: [
      {
        ...mine,
        id: "cmt_new",
        author: { type: "user", id: "u1" },
        body: "First reply",
      },
    ],
  });
  expect(screen.getByText("1 reply")).toBeVisible();
  expect(screen.queryByText("Sending…")).toBeNull();
});

it("offers the first reaction on a message that has none, in its header", async () => {
  const user = userEvent.setup();
  const react = vi
    .spyOn(api, "setCommentReaction")
    .mockResolvedValue(undefined as never);
  renderMessage({ ...mine, reactions: [] });
  await user.click(screen.getByRole("button", { name: "Add reaction" }));
  await user.click(await screen.findByRole("menuitemcheckbox", { name: "Thumbs up" }));
  expect(react).toHaveBeenCalledWith("doc-1", mine.id, expect.any(String), true);
});

it("keeps the thread's last action at the end of its header, after the first reaction", () => {
  const ctx = { principal: { type: "user", id: "u1" } } as DocContextValue;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocProvider value={ctx}>
        <Message
          c={{ ...mine, parent_comment_id: undefined }}
          docId="doc-1"
          thread
          actions={<button type="button">Close comment</button>}
        />
      </DocProvider>
    </QueryClientProvider>,
  );
  const names = screen
    .getAllByRole("button")
    .map((b) => b.getAttribute("aria-label") ?? b.textContent);
  expect(names.at(-1)).toBe("Close comment");
  expect(names).toContain("Add reaction");
});
