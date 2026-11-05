import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

// Errors the app's global query handler would toast (main.tsx).
let globalErrors = vi.fn<(e: unknown) => void>();

function setup(opts: {
  enabled: boolean;
  canEdit: boolean;
  book?: boolean;
  lookupError?: APIError;
}) {
  vi.spyOn(api, "getConfig").mockResolvedValue({
    books_enabled: opts.enabled,
  } as ServerConfig);
  const lookup = vi
    .spyOn(booksApi, "folderBook")
    .mockImplementation(() =>
      opts.book
        ? Promise.resolve({ book_id: "b1" })
        : Promise.reject(opts.lookupError ?? new APIError(404, "not_found", "no book")),
    );
  globalErrors = vi.fn<(e: unknown) => void>();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
    queryCache: new QueryCache({
      onError: (e, q) => {
        if (!q.meta?.suppressGlobalError) globalErrors(e);
      },
    }),
  });
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

  it("raises no error for a folder that is not a book", async () => {
    setup({ enabled: true, canEdit: true });
    await screen.findByRole("button", { name: "Make this a book" });
    expect(globalErrors).not.toHaveBeenCalled();
  });

  it("offers Make this a book only when the folder has no book", async () => {
    const lookup = setup({
      enabled: true,
      canEdit: true,
      lookupError: new APIError(503, "unavailable", "down"),
    });
    await waitFor(() => expect(lookup).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole("button", { name: "Make this a book" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Read as book" })).toBeNull();
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
