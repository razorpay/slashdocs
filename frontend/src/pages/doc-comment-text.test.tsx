import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { api } from "@/api";
import { emptyMentionDraft, type MentionDraft } from "@/lib/comment-mentions";
import { MentionTextarea } from "./doc-comment-text";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Field({ onChange }: { onChange: (draft: MentionDraft) => void }) {
  const [draft, setDraft] = useState(emptyMentionDraft);
  return (
    <MentionTextarea
      draft={draft}
      onChange={(next) => {
        setDraft(next);
        onChange(next);
      }}
    />
  );
}

it.each([
  ["a click", () => userEvent.click(screen.getByRole("option", { name: /reviewer/ }))],
  [
    "Enter",
    () => {
      // A browser reports the selection of the pick's own key press, before
      // the field shows the mention.
      const field = screen.getByRole("combobox");
      document.addEventListener("keydown", () => fireEvent.keyUp(field), {
        once: true,
      });
      return userEvent.keyboard("{Enter}");
    },
  ],
])("keeps one space after a mention picked with %s", async (_, pick) => {
  vi.spyOn(api, "searchUsers").mockResolvedValue({
    items: [{ type: "user", id: "u1", name: "reviewer" }],
  } as Awaited<ReturnType<typeof api.searchUsers>>);
  const onChange = vi.fn();
  render(<Field onChange={onChange} />);
  const user = userEvent.setup();
  await user.type(screen.getByRole("combobox"), "Check @re");
  await screen.findByRole("option", { name: /reviewer/ });
  await pick();
  await user.keyboard(" please");
  expect(onChange).toHaveBeenLastCalledWith({
    body: "Check @reviewer please",
    mentions: [
      { principal: expect.objectContaining({ id: "u1" }), offset: 6, length: 9 },
    ],
  });
});

it("marks the option that Enter picks, and the pointer moves the mark", async () => {
  vi.spyOn(api, "searchUsers").mockResolvedValue({
    items: [
      { type: "user", id: "u1", name: "reviewer" },
      { type: "user", id: "u2", name: "researcher" },
    ],
  } as Awaited<ReturnType<typeof api.searchUsers>>);
  render(<Field onChange={() => {}} />);
  const user = userEvent.setup();
  await user.type(screen.getByRole("combobox"), "@re");
  const [first, second] = await screen.findAllByRole("option");
  expect(first).toHaveAttribute("aria-selected", "true");
  await user.hover(second);
  expect(second).toHaveAttribute("aria-selected", "true");
  expect(first).toHaveAttribute("aria-selected", "false");
});
