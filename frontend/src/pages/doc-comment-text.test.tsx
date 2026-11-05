import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

function Field({
  onChange,
  onKeyDown,
}: {
  onChange: (draft: MentionDraft) => void;
  onKeyDown?: (event: { key: string }) => void;
}) {
  const [draft, setDraft] = useState(emptyMentionDraft);
  return (
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MentionTextarea
        draft={draft}
        onKeyDown={onKeyDown}
        onChange={(next) => {
          setDraft(next);
          onChange(next);
        }}
      />
    </QueryClientProvider>
  );
}

const people = (...names: string[]) =>
  ({
    items: names.map((name, i) => ({ type: "user", id: `u${i}`, name })),
  }) as Awaited<ReturnType<typeof api.searchUsers>>;

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

it("says that a mention search failed, keeps the words, and Retry finds the people", async () => {
  const search = vi.spyOn(api, "searchUsers").mockRejectedValue(new Error("503"));
  const onChange = vi.fn();
  render(<Field onChange={onChange} />);
  const user = userEvent.setup();
  const field = screen.getByRole("combobox");
  await user.type(field, "Ask @re");
  expect(await screen.findByText(/Could not search people/)).toBeVisible();
  expect(screen.queryByText(/Choose a person/)).toBeNull();
  expect(field).toHaveValue("Ask @re");

  search.mockResolvedValue(people("reviewer"));
  await user.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("option", { name: /reviewer/ })).toBeVisible();
  expect(field).toHaveFocus();
});

it("says that nobody matches, not to pick from suggestions that are not there", async () => {
  vi.spyOn(api, "searchUsers").mockResolvedValue(people());
  render(<Field onChange={() => {}} />);
  await userEvent.type(screen.getByRole("combobox"), "@zz");
  expect(await screen.findByText("No one matches @zz.")).toBeVisible();
});

it("closes only the list on Escape, and typing opens it again", async () => {
  vi.spyOn(api, "searchUsers").mockResolvedValue(people("reviewer", "researcher"));
  const onKeyDown = vi.fn();
  render(<Field onChange={() => {}} onKeyDown={onKeyDown} />);
  const user = userEvent.setup();
  const field = screen.getByRole("combobox");
  await user.type(field, "@re");
  await screen.findByRole("listbox");
  await user.keyboard("{ArrowUp}");
  expect(screen.getByRole("option", { name: /researcher/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(onKeyDown).not.toHaveBeenCalledWith(
    expect.objectContaining({ key: "Escape" }),
  );
  await user.type(field, "s");
  expect(await screen.findByRole("listbox")).toBeVisible();
});
