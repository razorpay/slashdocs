import { useState } from "react";
import { cleanup, render, screen } from "@testing-library/react";
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

it("keeps one space after a picked mention", async () => {
  vi.spyOn(api, "searchUsers").mockResolvedValue({
    items: [{ type: "user", id: "u1", name: "reviewer" }],
  } as Awaited<ReturnType<typeof api.searchUsers>>);
  const onChange = vi.fn();
  render(<Field onChange={onChange} />);
  const user = userEvent.setup();
  await user.type(screen.getByRole("combobox"), "Check @re");
  await user.click(await screen.findByRole("option", { name: /reviewer/ }));
  await user.type(screen.getByRole("combobox"), " please");
  expect(onChange).toHaveBeenLastCalledWith({
    body: "Check @reviewer please",
    mentions: [
      { principal: expect.objectContaining({ id: "u1" }), offset: 6, length: 9 },
    ],
  });
});
