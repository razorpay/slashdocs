import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, APIError, type ServerConfig } from "@/api";
import { booksApi } from "@/lib/books";
import { FolderBookAction } from "./folder-book-action";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Where() {
  const l = useLocation();
  return (
    <div data-testid="where">
      {l.pathname}|{JSON.stringify(l.state)}
    </div>
  );
}

function setup(opts: { enabled: boolean; canEdit: boolean; book?: boolean }) {
  vi.spyOn(api, "getConfig").mockResolvedValue({
    books_enabled: opts.enabled,
  } as ServerConfig);
  const lookup = vi
    .spyOn(booksApi, "folderBook")
    .mockImplementation(() =>
      opts.book
        ? Promise.resolve({ book_id: "b1" })
        : Promise.reject(new APIError(404, "not_found", "no book")),
    );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/app/folders/f1"]}>
        <Routes>
          <Route
            path="/app/folders/:id"
            element={<FolderBookAction folderId="f1" canEdit={opts.canEdit} />}
          />
          <Route path="*" element={<Where />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return lookup;
}

describe("FolderBookAction", () => {
  it("offers Make this a book only to editors with books enabled", async () => {
    setup({ enabled: true, canEdit: true });
    expect(
      await screen.findByRole("button", { name: "Make this a book" }),
    ).toBeTruthy();
  });

  it("hides Make this a book from non-editors", async () => {
    const lookup = setup({ enabled: true, canEdit: false });
    await waitFor(() => expect(lookup).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Make this a book" })).toBeNull();
  });

  it("hides everything when books are off", async () => {
    const lookup = setup({ enabled: false, canEdit: true, book: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(lookup).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Make this a book" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Read as book" })).toBeNull();
  });

  it("links to the book when the folder already has one", async () => {
    setup({ enabled: true, canEdit: false, book: true });
    const link = await screen.findByRole("link", { name: "Read as book" });
    expect(link.getAttribute("href")).toBe("/app/b/b1");
    expect(screen.queryByRole("button", { name: "Make this a book" })).toBeNull();
  });

  it("creates the book and opens the editor with the placement summary", async () => {
    setup({ enabled: true, canEdit: true });
    vi.spyOn(booksApi, "createBook").mockResolvedValue({
      book_id: "b9",
      outline_version_id: "bov_1",
      placed: ["a", "b", "c"],
      not_in_outline: [{ id: "d", title: "D" }],
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Make this a book" }));
    const where = await screen.findByTestId("where");
    expect(where.textContent).toBe('/app/b/b9/outline|{"placed":3,"notInOutline":1}');
  });
});
