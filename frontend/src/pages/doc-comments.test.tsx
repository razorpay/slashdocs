import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type Comment } from "@/api";
import { Comments } from "./doc-comments";
import { useDoc } from "./doc-context";

vi.mock("./doc-context", () => ({ useDoc: vi.fn() }));

const author = { type: "user" as const, id: "author", name: "Author" };
const comment: Comment = {
  id: "comment",
  body: "Please review @Alex",
  status: "open",
  author,
  created_on_version_id: "version",
  created_at: "2026-10-19T10:00:00Z",
  mentions: [
    { principal: { type: "user", id: "alex", name: "Alex" }, offset: 14, length: 5 },
  ],
  replies: [
    {
      id: "reply",
      body: "My reply",
      status: "open",
      author,
      created_on_version_id: "version",
      parent_comment_id: "comment",
    },
  ],
};

beforeEach(() => {
  vi.mocked(useDoc).mockReturnValue({
    docId: "doc",
    comments: [comment],
    drafts: [],
    commentFilter: "all",
    principal: author,
    unanchoredComments: new Set(),
    setActiveComment: vi.fn(),
    setCommentFilter: vi.fn(),
    scrollDocumentTo: vi.fn(),
  } as unknown as ReturnType<typeof useDoc>);
});
afterEach(cleanup);

function mount() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Comments mobile />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), client };
}

it("lets authors edit roots and replies while preserving untouched mentions", async () => {
  const patch = vi
    .spyOn(api, "patchComment")
    .mockResolvedValue({ ...comment, edited_at: "2026-10-19T10:01:00Z" });
  const { user, client } = mount();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  await user.click(screen.getAllByRole("button", { name: "Edit comment" })[0]);
  const input = screen.getByRole("combobox", { name: "Edit comment text" });
  expect(input).toHaveFocus();
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await user.type(input, " please");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(patch).toHaveBeenCalledWith("doc", "comment", {
      body: "Please review @Alex please",
      mentions: comment.mentions,
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("combobox", { name: "Edit comment text" }),
    ).not.toBeInTheDocument(),
  );
  expect(invalidate).toHaveBeenCalled();
  await user.click(screen.getAllByRole("button", { name: "Edit comment" })[1]);
  await user.type(
    screen.getByRole("combobox", { name: "Edit comment text" }),
    " updated",
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(patch).toHaveBeenLastCalledWith("doc", "reply", {
      body: "My reply updated",
      mentions: [],
    }),
  );
});

it("hides editing for other authors and shows persisted edited labels on roots and replies", () => {
  vi.mocked(useDoc).mockReturnValue({
    ...useDoc(),
    principal: { type: "user", id: "other" },
    comments: [
      {
        ...comment,
        edited_at: "2026-10-19T10:01:00Z",
        replies: [{ ...comment.replies![0], edited_at: "2026-10-19T10:02:00Z" }],
      },
    ],
  });
  mount();
  expect(
    screen.queryByRole("button", { name: "Edit comment" }),
  ).not.toBeInTheDocument();
  expect(screen.getAllByText("Edited")).toHaveLength(2);
  expect(screen.getAllByText("Edited")[0]).toHaveAttribute(
    "title",
    expect.stringContaining("Edited"),
  );
});

it("cancels edits without a request and rejects empty saves", async () => {
  const patch = vi.spyOn(api, "patchComment");
  const { user } = mount();
  await user.click(screen.getAllByRole("button", { name: "Edit comment" })[0]);
  await user.clear(screen.getByRole("combobox", { name: "Edit comment text" }));
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(patch).not.toHaveBeenCalled();
  expect(screen.getByText("@Alex")).toBeInTheDocument();
});

it("retains the draft on failure and prevents duplicate saves while pending", async () => {
  const patch = vi
    .spyOn(api, "patchComment")
    .mockRejectedValueOnce(new Error("offline"));
  const { user } = mount();
  await user.click(screen.getAllByRole("button", { name: "Edit comment" })[1]);
  const input = screen.getByRole("combobox", { name: "Edit comment text" });
  await user.type(input, " updated");
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
  expect(input).toHaveValue("My reply updated");
  let finish!: (c: Comment) => void;
  patch.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await user.click(screen.getByRole("button", { name: "Save changes" }));
  expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
  expect(input).toBeDisabled();
  expect(
    within(input.closest("form")!).getByRole("button", { name: "Cancel" }),
  ).toBeDisabled();
  finish(comment);
  await waitFor(() =>
    expect(
      screen.queryByRole("combobox", { name: "Edit comment text" }),
    ).not.toBeInTheDocument(),
  );
  expect(patch).toHaveBeenCalledTimes(2);
});
