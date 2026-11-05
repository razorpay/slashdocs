import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APIError } from "@/api";
import { booksApi } from "@/lib/books";
import { BookSearch } from "./book-search";
import { bookManifest } from "./book-fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const hit = (id: string, title: string) => ({
  id,
  title,
  snippet: "how to \u0002retry\u0003 a call",
});

function renderSearch() {
  const onOpen = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BookSearch
        open
        onOpenChange={() => {}}
        bookId="b1"
        manifest={bookManifest()}
        currentDoc="doc_2"
        onOpen={onOpen}
      />
    </QueryClientProvider>,
  );
  return { onOpen };
}

describe("BookSearch", () => {
  it("searches the book and drops chapters the reader cannot open", async () => {
    const search = vi
      .spyOn(booksApi, "search")
      .mockResolvedValue({ items: [hit("doc_1", "Title 1"), hit("doc_x", "Secret")] });
    const user = userEvent.setup();
    const { onOpen } = renderSearch();
    await user.type(
      screen.getByRole("searchbox", { name: "Search this book" }),
      "retry",
    );
    const row = await screen.findByRole("button", { name: /Title 1/ });
    expect(search).toHaveBeenLastCalledWith("b1", "retry", undefined);
    expect(within(row).getByText("1")).toBeInTheDocument();
    expect(within(row).getByText("retry").tagName).toBe("MARK");
    expect(screen.queryByText("Secret")).toBeNull();
    // A result opens at its first match.
    await user.click(row);
    expect(onOpen).toHaveBeenCalledWith("/app/b/b1/c/doc_1#text=retry", "doc_1");
  });

  it("narrows to this chapter with the toggle", async () => {
    const search = vi
      .spyOn(booksApi, "search")
      .mockResolvedValue({ items: [hit("doc_2", "Title 2")] });
    const user = userEvent.setup();
    renderSearch();
    await user.type(
      screen.getByRole("searchbox", { name: "Search this book" }),
      "retry",
    );
    await screen.findByRole("button", { name: /Title 2/ });
    await user.click(screen.getByRole("button", { name: "This chapter" }));
    await waitFor(() =>
      expect(search).toHaveBeenLastCalledWith("b1", "retry", "doc_2"),
    );
    expect(screen.getByRole("button", { name: "This chapter" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows 'No matches in this book' for empty results", async () => {
    vi.spyOn(booksApi, "search").mockResolvedValue({ items: [] });
    const user = userEvent.setup();
    renderSearch();
    await user.type(screen.getByRole("searchbox", { name: "Search this book" }), "zzz");
    expect(await screen.findByText("No matches in this book")).toBeInTheDocument();
  });

  it("shows the API error message and a Retry button on failure", async () => {
    const search = vi
      .spyOn(booksApi, "search")
      .mockRejectedValue(new APIError(500, "internal", "Search is unavailable."));
    const user = userEvent.setup();
    renderSearch();
    await user.type(
      screen.getByRole("searchbox", { name: "Search this book" }),
      "retry",
    );
    expect(await screen.findByText("Search is unavailable.")).toBeInTheDocument();
    const calls = search.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(search.mock.calls.length).toBeGreaterThan(calls));
  });
});
