import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { api, type Comment } from "@/api";
import { emptyMentionDraft, type MentionDraft } from "@/lib/comment-mentions";
import {
  AgentRequestBadge,
  ComposeField,
  Message,
  MoreMenu,
  ReplyRow,
} from "./doc-comment-parts";
import { DocProvider, type DocContextValue } from "./doc-context";

afterEach(cleanup);

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
  ["the author", { principal: { type: "user", id: "usr_ana" }, editable: false }, true],
  ["an editor", { principal: { type: "user", id: "usr_ed" }, editable: true }, true],
  [
    "a commenter",
    { principal: { type: "user", id: "usr_bo" }, editable: false },
    false,
  ],
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
  await user.type(box, "Agreed{Enter} KEEP THE LATER WORDS");
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
  return screen.findByRole("combobox");
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
  });
  update({ ...mine, body: "Original words fixed" });
  await act(async () => response.settle({} as Comment));
  expect(screen.getByRole("combobox")).toHaveValue("Original words fixed KEEP");
  expect(screen.queryByRole("status")).toBeNull();

  patch.mockResolvedValue({} as Comment);
  await user.keyboard("{Enter}");
  update({ ...mine, body: "Original words fixed KEEP" });
  await vi.waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  expect(screen.getByText("Original words fixed KEEP")).toBeVisible();
});
