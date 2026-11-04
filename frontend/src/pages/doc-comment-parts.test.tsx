import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { api, type Comment } from "@/api";
import { emptyMentionDraft, type MentionDraft } from "@/lib/comment-mentions";
import { AgentRequestBadge, ComposeField, ReplyRow } from "./doc-comment-parts";
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

it("marks a comment that asks an agent to change words", () => {
  render(<AgentRequestBadge body="Please change “3 open” to: 4 open" />);
  expect(screen.getByText("Agent request")).toBeVisible();
  cleanup();
  const { container } = render(<AgentRequestBadge body="Looks good" />);
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
