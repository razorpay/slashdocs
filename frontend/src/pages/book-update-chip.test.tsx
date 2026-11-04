import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { booksApi, type ChapterChanges } from "@/lib/books";
import { BookUpdateChip } from "./book-update-chip";
import { bookState } from "./book-fixtures";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const changes: ChapterChanges = {
  since_version_id: "ver_1",
  versions: [
    { id: "ver_2", number: 2, change_summary: "Added retries", created_at: "" },
    {
      id: "ver_3",
      number: 3,
      change_summary: "- Fixed a typo\n- New diagram",
      created_at: "",
    },
  ],
  changed_sections: [
    { id: "retries", title: "Retries", removed: false },
    { id: "old", title: "Old section", removed: true },
  ],
};

function renderChip(updated: boolean, onOpenSection = vi.fn()) {
  vi.spyOn(booksApi, "state").mockResolvedValue(bookState({ doc_1: { updated } }));
  vi.spyOn(booksApi, "changes").mockResolvedValue(changes);
  const seen = vi.spyOn(booksApi, "seen").mockResolvedValue(undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <BookUpdateChip
        bookId="b1"
        doc="doc_1"
        versionId="ver_3"
        onOpenSection={onOpenSection}
      />
    </QueryClientProvider>,
  );
  return { seen, onOpenSection };
}

describe("BookUpdateChip", () => {
  it("is hidden when not updated", async () => {
    renderChip(false);
    await waitFor(() => expect(booksApi.state).toHaveBeenCalled());
    // Let the state query settle before checking nothing rendered.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole("button", { name: /Updated since you read/ })).toBeNull();
  });

  it("lists every version note newest first and changed sections", async () => {
    const user = userEvent.setup();
    const { seen, onOpenSection } = renderChip(true);
    await user.click(
      await screen.findByRole("button", { name: /Updated since you read/ }),
    );
    const panel = await screen.findByRole("dialog");
    expect(
      await within(panel).findByRole("heading", {
        name: "Version 3 · 2 sections changed",
      }),
    ).toBeInTheDocument();
    const notes = within(panel)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    const v3 = notes.findIndex((t) => t?.includes("Fixed a typo"));
    const v2 = notes.findIndex((t) => t?.includes("Added retries"));
    expect(v3).toBeGreaterThanOrEqual(0);
    expect(v3).toBeLessThan(v2);
    expect(within(panel).getByText("New diagram")).toBeInTheDocument();
    // Removed sections are listed without a link.
    expect(within(panel).getByText(/Old section/)).toBeInTheDocument();
    expect(within(panel).queryByRole("button", { name: /Old section/ })).toBeNull();

    await user.click(within(panel).getByRole("button", { name: "Retries" }));
    expect(onOpenSection).toHaveBeenCalledWith("retries");
    await waitFor(() => expect(seen).toHaveBeenCalledWith("b1", "doc_1", "ver_3"));
  });

  it("dismiss calls seen", async () => {
    const user = userEvent.setup();
    const { seen } = renderChip(true);
    await user.click(await screen.findByRole("button", { name: "Dismiss update" }));
    await waitFor(() => expect(seen).toHaveBeenCalledWith("b1", "doc_1", "ver_3"));
  });
});
