import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import type { Comment, Principal } from "@/api";
import { CommentsList } from "./doc-comments";
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
    ...over,
  } as DocContextValue;
  const props = {
    showsLatest,
    onPick: vi.fn(),
    onPlacePin: vi.fn(),
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
  return props;
}

const listed = () =>
  screen
    .getAllByRole("listitem")
    .map((item) => within(item).getByText(/^Thread /).textContent);

afterEach(cleanup);

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
