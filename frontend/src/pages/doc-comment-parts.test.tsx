import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyMentionDraft, type MentionDraft } from "@/lib/comment-mentions";
import { ComposeField } from "./doc-comment-parts";

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
