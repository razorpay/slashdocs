import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "@/api";
import {
  booksApi,
  type BookState,
  type Manifest,
  type ManifestLink,
} from "@/lib/books";
import { BookHomePage } from "./book-home";
import { stubMatchMedia } from "./book-fixtures";

// The page backdrop reads matchMedia, which jsdom lacks.
beforeEach(() => {
  vi.stubGlobal("matchMedia", stubMatchMedia(false));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const ch = (n: number, kind: "chapter" | "planned" = "chapter"): ManifestLink => ({
  href: kind === "chapter" ? `/app/b/b1/c/doc_${n}` : undefined,
  title: `Title ${n}`,
  properties: {
    documentId: kind === "chapter" ? `doc_${n}` : undefined,
    kind,
    number: n,
    part: 1,
    wordCount: 2300,
  },
});

function manifest(numbers: number[], canEdit = false): Manifest {
  const links = numbers.map((n) => ch(n, n === 58 ? "planned" : "chapter"));
  return {
    metadata: {
      identifier: "b1",
      title: "My Book",
      numberOfChapters: links.length,
      folderId: "f1",
      outlineVersionId: "v1",
      canEdit,
    },
    readingOrder: links.filter((l) => l.properties?.kind === "chapter"),
    toc: [{ title: "Part One", children: links }],
  };
}

const state = (over: Partial<BookState> = {}): BookState => ({
  positions: [],
  chapters: {},
  progress: { chapter: 0, of: 3, share: 0 },
  ...over,
});

function renderHome() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/app/b/b1"]}>
        <Routes>
          <Route path="/app/b/:bookId" element={<BookHomePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("BookHomePage", () => {
  it("shows continue reading at the newest position", async () => {
    vi.spyOn(booksApi, "manifest").mockResolvedValue(manifest([1, 24, 58]));
    vi.spyOn(booksApi, "state").mockResolvedValue(
      state({
        positions: [
          {
            device_id: "d",
            document_id: "doc_24",
            version_id: "v",
            section_id: "",
            anchor: {},
            progression: 0.5,
            client_ts: "2026-01-01T00:00:00Z",
          },
        ],
      }),
    );
    renderHome();
    const link = await screen.findByRole("link", { name: /continue/i });
    expect(link.getAttribute("href")).toBe("/app/b/b1/c/doc_24");
    expect(screen.getByText(/about 5 min left/i)).toBeTruthy();
  });

  it("groups updated chapters and marks all seen", async () => {
    vi.spyOn(booksApi, "manifest").mockResolvedValue(manifest([1, 2, 3]));
    vi.spyOn(booksApi, "state").mockResolvedValue(
      state({
        chapters: {
          doc_1: {
            state: "read",
            updated: true,
            seen_version_id: "",
            furthest_progression: 1,
          },
          doc_2: {
            state: "read",
            updated: true,
            seen_version_id: "",
            furthest_progression: 1,
          },
        },
      }),
    );
    const seenAll = vi.spyOn(booksApi, "seenAll").mockResolvedValue(undefined);
    renderHome();
    expect(
      await screen.findByText("2 chapters you read have new versions"),
    ).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Mark all seen" }));
    await waitFor(() => expect(seenAll).toHaveBeenCalledWith("b1"));
  });

  it("renders planned chapters as disabled with a text state", async () => {
    vi.spyOn(booksApi, "manifest").mockResolvedValue(manifest([1, 58]));
    vi.spyOn(booksApi, "state").mockResolvedValue(state());
    renderHome();
    await screen.findAllByText("Title 1");
    const row = screen.getByText("Title 58").closest("[aria-disabled]")!;
    expect(row.getAttribute("aria-disabled")).toBe("true");
    expect(within(row as HTMLElement).queryByRole("link")).toBeNull();
    expect(row.textContent).toMatch(/Planned/);
  });

  it("never shows chapters missing from the manifest", async () => {
    vi.spyOn(booksApi, "manifest").mockResolvedValue(manifest([1, 3]));
    vi.spyOn(booksApi, "state").mockResolvedValue(state());
    renderHome();
    await screen.findAllByText("Title 1");
    expect(screen.getByText("Title 3")).toBeTruthy();
    expect(screen.queryByText("Title 2")).toBeNull();
  });

  it("links to no outline editor before its route exists", async () => {
    // The outline editor and its route arrive with the next PR in the stack.
    vi.spyOn(booksApi, "manifest").mockResolvedValue(manifest([1], true));
    vi.spyOn(booksApi, "state").mockResolvedValue(state());
    renderHome();
    await screen.findAllByText("Title 1");
    expect(screen.queryByRole("link", { name: /edit outline/i })).toBeNull();
  });

  it("puts Updated inside the chapter row and its name", async () => {
    vi.spyOn(booksApi, "manifest").mockResolvedValue(manifest([1, 2]));
    vi.spyOn(booksApi, "state").mockResolvedValue(
      state({
        chapters: {
          doc_1: {
            state: "read",
            updated: true,
            seen_version_id: "",
            furthest_progression: 1,
          },
        },
      }),
    );
    renderHome();
    const row = await screen.findByRole("link", { name: /^1\s*Title 1\s*Updated/ });
    expect(row).toHaveAttribute("href", "/app/b/b1/c/doc_1");
    expect(within(row).getByText("Updated")).toBeTruthy();
  });

  it("says so quietly when the reading state cannot be loaded", async () => {
    vi.spyOn(booksApi, "manifest").mockResolvedValue(manifest([1, 2]));
    const st = vi
      .spyOn(booksApi, "state")
      .mockRejectedValue(new APIError(500, "internal", "boom"));
    renderHome();
    expect(
      await screen.findByText(
        "Your reading progress can't be loaded right now.",
        undefined,
        { timeout: 4000 },
      ),
    ).toBeTruthy();
    // The chapters are still listed.
    expect(screen.getByText("Title 2")).toBeTruthy();
    st.mockResolvedValue(state());
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(
        screen.queryByText("Your reading progress can't be loaded right now."),
      ).toBeNull(),
    );
  });

  it("explains a group outage as temporary", async () => {
    vi.spyOn(booksApi, "manifest").mockRejectedValue(
      new APIError(503, "group_membership_unavailable", "groups down"),
    );
    vi.spyOn(booksApi, "state").mockResolvedValue(state());
    renderHome();
    expect(
      await screen.findByText("Can't check your access right now", undefined, {
        timeout: 4000,
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("explains a rate limit", async () => {
    vi.spyOn(booksApi, "manifest").mockRejectedValue(
      new APIError(429, "rate_limited", "slow down"),
    );
    vi.spyOn(booksApi, "state").mockResolvedValue(state());
    renderHome();
    expect(await screen.findByText("Too many requests")).toBeTruthy();
  });

  it("explains a disabled feature", async () => {
    vi.spyOn(booksApi, "manifest").mockRejectedValue(
      new APIError(404, "feature_disabled", "off"),
    );
    vi.spyOn(booksApi, "state").mockRejectedValue(
      new APIError(404, "feature_disabled", "off"),
    );
    renderHome();
    expect(
      await screen.findByText("Books are not enabled on this server."),
    ).toBeTruthy();
  });
});
