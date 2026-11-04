import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { api } from "@/api";
import { booksApi, type ChapterChanges, type ReadingPosition } from "@/lib/books";
import { deviceIdStore, readerSettingsStore } from "@/lib/reader-store";
import { DocProvider, type DocContextValue } from "./doc-context";
import type { DocWorkspace } from "./doc-workspace";
import { BookNumberRoute, BookReaderRoute } from "./book-reader";
import { bookManifest, bookState, stubMatchMedia } from "./book-fixtures";

type WorkspaceProps = Parameters<typeof DocWorkspace>[0];

const h = vi.hoisted(() => ({
  last: undefined as WorkspaceProps | undefined,
  restore: undefined as unknown as ReturnType<typeof vi.fn>,
  stream: { subscribeKV: () => () => {}, viewers: [] },
  streamArgs: [] as unknown[],
}));

// The workspace renders the frame, which jsdom cannot. The stub shows the bar
// and the overlay inside a document context, and exposes the reader props.
vi.mock("./doc-workspace", () => ({
  DocWorkspace: (props: WorkspaceProps & { overlay?: ReactNode }) => {
    h.last = props;
    return (
      <DocProvider value={{ restorePosition: h.restore } as unknown as DocContextValue}>
        <div data-testid="workspace" data-version={props.version}>
          {props.bar({
            commentsOpen: false,
            onToggleComments: () => {},
            onShowShortcuts: () => {},
          })}
          {props.overlay}
        </div>
      </DocProvider>
    );
  },
}));
vi.mock("./use-document-stream", () => ({
  useDocumentStream: (args: unknown) => {
    h.streamArgs.push(args);
    return h.stream;
  },
}));

const reader = () => h.last!.reader!;

const position = (over: Partial<ReadingPosition>): ReadingPosition => ({
  device_id: deviceIdStore.read(),
  document_id: "doc_2",
  version_id: "ver_2",
  section_id: "setup",
  anchor: { quote: "saved quote" },
  progression: 0.4,
  client_ts: "2026-11-01T10:00:00Z",
  ...over,
});

function Where() {
  const loc = useLocation();
  return <output data-testid="where">{loc.pathname + loc.hash}</output>;
}

const NO_CHANGES: ChapterChanges = {
  since_version_id: "",
  versions: [],
  changed_sections: [],
};

function renderReader(
  url = "/app/b/b1/c/doc_2",
  state = bookState(),
  changes = NO_CHANGES,
) {
  vi.spyOn(api, "me").mockResolvedValue({
    principal: { type: "user", id: "usr_1", email: "a@example.com" },
  });
  vi.spyOn(booksApi, "manifest").mockResolvedValue(bookManifest());
  vi.spyOn(booksApi, "state").mockResolvedValue(state);
  vi.spyOn(booksApi, "changes").mockResolvedValue(changes);
  vi.spyOn(booksApi, "headings").mockResolvedValue({
    items: [
      { id: "intro", text: "Introduction", level: 2, url: "" },
      { id: "setup", text: "Setting up", level: 2, url: "" },
      { id: "setup-a", text: "A detail", level: 3, url: "" },
    ],
  });
  const open = vi.spyOn(booksApi, "open").mockResolvedValue(undefined);
  const done = vi.spyOn(booksApi, "done").mockResolvedValue(undefined);
  vi.spyOn(booksApi, "savePosition").mockResolvedValue(undefined);
  vi.spyOn(booksApi, "progress").mockResolvedValue(undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/app/b/:bookId/c/:docId" element={<BookReaderRoute />} />
          <Route path="/app/b/:bookId/:number" element={<BookNumberRoute />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { open, done, client };
}

const where = () => screen.getByTestId("where").textContent;

beforeEach(() => {
  vi.stubGlobal("matchMedia", stubMatchMedia(false));
  h.last = undefined;
  h.restore = vi.fn();
  h.streamArgs = [];
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("BookReader", () => {
  it("number URL redirects to the canonical chapter URL", async () => {
    renderReader("/app/b/b1/2");
    await waitFor(() => expect(where()).toBe("/app/b/b1/c/doc_2"));
    expect(await screen.findByTestId("workspace")).toHaveAttribute(
      "data-version",
      "ver_2",
    );
  });

  it("says so when the chapter is not in the book", async () => {
    renderReader("/app/b/b1/c/doc_404");
    expect(
      await screen.findByText("That chapter is not available in this book."),
    ).toBeInTheDocument();
  });

  it("opens the chapter with the version being read and shows the breadcrumb", async () => {
    const { open } = renderReader();
    await waitFor(() => expect(open).toHaveBeenCalledWith("b1", "doc_2", "ver_2"));
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "My Book" })).toHaveAttribute(
      "href",
      "/app/b/b1",
    );
    expect(within(crumbs).getByText("2 · Title 2")).toBeInTheDocument();
    expect(reader().frameTitle).toBe("Chapter 2, Title 2");
  });

  it("passes a live document stream", async () => {
    renderReader();
    await screen.findByTestId("workspace");
    expect(h.last!.stream).toBe(h.stream);
    expect(h.streamArgs.at(-1)).toMatchObject({ docId: "doc_2", version: "ver_2" });
  });

  it("arrow keys move to neighbouring chapters", async () => {
    const user = userEvent.setup();
    renderReader();
    await screen.findByTestId("workspace");
    await user.keyboard("{ArrowRight}");
    expect(where()).toBe("/app/b/b1/c/doc_3");
    await user.keyboard("{ArrowLeft}");
    expect(where()).toBe("/app/b/b1/c/doc_2");
    // Keys pressed inside the chapter arrive from the frame.
    act(() => reader().onKey!("ArrowLeft"));
    expect(where()).toBe("/app/b/b1/c/doc_1");
  });

  it("announces the chapter on change", async () => {
    const user = userEvent.setup();
    renderReader();
    await screen.findByTestId("workspace");
    await user.keyboard("{ArrowRight}");
    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Chapter announcement" }),
      ).toHaveTextContent("Chapter 3, Title 3"),
    );
    const title = screen.getByRole("heading", { level: 1, name: "Chapter 3, Title 3" });
    expect(title).toHaveFocus();
    expect(reader().frameTitle).toBe("Chapter 3, Title 3");
  });

  it("restores the saved place in this chapter", async () => {
    renderReader("/app/b/b1/c/doc_2", bookState({}, { positions: [position({})] }));
    await waitFor(() =>
      expect(h.restore).toHaveBeenCalledWith({
        anchor: { quote: "saved quote" },
        section: "setup",
        progression: 0.4,
      }),
    );
  });

  it("lets an explicit link win over the saved place", async () => {
    renderReader(
      "/app/b/b1/c/doc_2#setup",
      bookState({}, { positions: [position({})] }),
    );
    await screen.findByTestId("workspace");
    await waitFor(() => expect(booksApi.state).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(h.restore).not.toHaveBeenCalled();
  });

  it("offers the other device's position without a dialog", async () => {
    const user = userEvent.setup();
    renderReader(
      "/app/b/b1/c/doc_2",
      bookState(
        {},
        {
          positions: [
            position({ progression: 0.1 }),
            position({
              device_id: "phone",
              document_id: "doc_3",
              version_id: "ver_3",
              section_id: "intro",
              progression: 0.5,
              client_ts: "2026-11-02T10:00:00Z",
            }),
          ],
        },
      ),
    );
    const note = await screen.findByRole("group", { name: "Other device" });
    // Notes sit in one live region, so they are read out.
    expect(note.closest('[role="status"]')).toHaveAttribute("aria-live", "polite");
    // The section's title arrives with that chapter's headings.
    await waitFor(() =>
      expect(note).toHaveTextContent(
        "On another device you were at Ch 3 · Introduction",
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await user.click(within(note).getByRole("button", { name: "Go there" }));
    await waitFor(() => expect(where()).toBe("/app/b/b1/c/doc_3"));
    await waitFor(() =>
      expect(h.restore).toHaveBeenLastCalledWith(
        expect.objectContaining({ section: "intro", progression: 0.5 }),
      ),
    );
    // Every jump can be undone.
    await user.click(
      await screen.findByRole("button", { name: "Back to where you were" }),
    );
    await waitFor(() => expect(where()).toBe("/app/b/b1/c/doc_2"));
  });

  it("dismisses the other device's note", async () => {
    const user = userEvent.setup();
    renderReader(
      "/app/b/b1/c/doc_2",
      bookState(
        {},
        {
          positions: [
            position({
              device_id: "phone",
              document_id: "doc_3",
              client_ts: "2026-11-02T10:00:00Z",
            }),
          ],
        },
      ),
    );
    const note = await screen.findByRole("group", { name: "Other device" });
    await user.click(within(note).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("group", { name: "Other device" })).toBeNull();
  });

  it("shows a toast when the saved place cannot be found", async () => {
    const info = vi.spyOn(toast, "info");
    renderReader("/app/b/b1/c/doc_2", bookState({}, { positions: [position({})] }));
    await waitFor(() => expect(h.restore).toHaveBeenCalled());
    act(() => reader().onRestored!("none"));
    expect(info).toHaveBeenCalledWith(
      "Couldn't find your saved place in this version, so the chapter opens at the top.",
    );
  });

  it("hides shortcuts when turned off in settings", async () => {
    readerSettingsStore.write({ ...readerSettingsStore.read(), shortcuts: false });
    const user = userEvent.setup();
    renderReader();
    await screen.findByTestId("workspace");
    await user.keyboard("{ArrowRight}/");
    act(() => reader().onKey!("ArrowRight"));
    expect(where()).toBe("/app/b/b1/c/doc_2");
    expect(screen.queryByRole("searchbox")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Search this book" }),
    ).not.toHaveAttribute("aria-keyshortcuts");
  });

  it("opens search with /", async () => {
    vi.spyOn(booksApi, "search").mockResolvedValue({ items: [] });
    const user = userEvent.setup();
    renderReader();
    await screen.findByTestId("workspace");
    await user.keyboard("/");
    expect(
      await screen.findByRole("searchbox", { name: "Search this book" }),
    ).toHaveValue("");
  });

  it("changes reading settings from the Aa popover", async () => {
    const user = userEvent.setup();
    renderReader();
    await screen.findByTestId("workspace");
    await user.click(screen.getByRole("button", { name: "Reading settings" }));
    const panel = await screen.findByRole("dialog", { name: "Reading settings" });
    await user.click(within(panel).getByRole("tab", { name: "Large" }));
    await user.click(within(panel).getByRole("tab", { name: "Paper" }));
    await user.click(within(panel).getByRole("tab", { name: "Wide" }));
    expect(reader().settings).toEqual({ size: "l", width: "wide", theme: "paper" });
    await user.click(
      within(panel).getByRole("switch", { name: "Single-key shortcuts" }),
    );
    expect(readerSettingsStore.read().shortcuts).toBe(false);
  });

  it("tracks the current section", async () => {
    renderReader();
    await screen.findByTestId("workspace");
    const tracker = await screen.findByRole("group", { name: "Sections" });
    act(() => reader().onViewport!({ section: "setup-a", progression: 0.5 }));
    expect(within(tracker).getByRole("button", { name: "Setting up" })).toHaveAttribute(
      "aria-current",
      "location",
    );
    // Only top-level sections get a segment.
    expect(within(tracker).getAllByRole("button")).toHaveLength(2);
  });

  it("offers done and the next chapter at the end, naming a new part", async () => {
    const user = userEvent.setup();
    const { done } = renderReader();
    await screen.findByTestId("workspace");
    expect(screen.queryByRole("button", { name: "Mark chapter done" })).toBeNull();
    act(() => reader().onViewport!({ section: "setup", progression: 0.99 }));
    const strip = screen.getByRole("region", { name: "End of chapter" });
    expect(within(strip).getByText("Part Two starts")).toBeInTheDocument();
    expect(within(strip).getByRole("link", { name: /Title 3/ })).toHaveAttribute(
      "href",
      "/app/b/b1/c/doc_3",
    );
    await user.click(within(strip).getByRole("button", { name: "Mark chapter done" }));
    await waitFor(() => expect(done).toHaveBeenCalledWith("b1", "doc_2", true));
  });

  it("offers the end strip for a chapter that fits on screen", async () => {
    renderReader();
    await screen.findByTestId("workspace");
    act(() => reader().onViewport!({ section: "", progression: 0, fits: true }));
    expect(screen.getByRole("region", { name: "End of chapter" })).toBeInTheDocument();
  });

  it("marks changed headings in an updated chapter", async () => {
    renderReader("/app/b/b1/c/doc_2", bookState({ doc_2: { updated: true } }), {
      since_version_id: "ver_1",
      versions: [{ id: "ver_2", number: 2, change_summary: "x", created_at: "" }],
      changed_sections: [
        { id: "setup", title: "Setting up", removed: false },
        { id: "gone", title: "Gone", removed: true },
      ],
    });
    await waitFor(() => expect(reader().markHeadings).toEqual(["setup"]));
  });

  it("does not restore a position saved on another chapter", async () => {
    renderReader(
      "/app/b/b1/c/doc_2",
      bookState({}, { positions: [position({ document_id: "doc_1" })] }),
    );
    await screen.findByTestId("workspace");
    await waitFor(() => expect(booksApi.state).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(h.restore).not.toHaveBeenCalled();
  });

  it("restores once per visit, even when the state is fetched again", async () => {
    const { client } = renderReader(
      "/app/b/b1/c/doc_2",
      bookState({}, { positions: [position({})] }),
    );
    await waitFor(() => expect(h.restore).toHaveBeenCalledTimes(1));
    await act(() => client.invalidateQueries({ queryKey: ["book", "b1"] }));
    await waitFor(() =>
      expect(vi.mocked(booksApi.state).mock.calls.length).toBeGreaterThan(1),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(h.restore).toHaveBeenCalledTimes(1);
  });

  it("falls back to how far the reader got when there is no saved place", async () => {
    const info = vi.spyOn(toast, "info");
    renderReader(
      "/app/b/b1/c/doc_2",
      bookState(
        { doc_2: { state: "reading", furthest: 0.5 } },
        { positions: [position({ document_id: "doc_1" })] },
      ),
    );
    await waitFor(() => expect(h.restore).toHaveBeenCalledWith({ progression: 0.5 }));
    // A miss here is not a lost saved place, so it stays quiet.
    act(() => reader().onRestored!("none"));
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining("saved place"));
  });

  it("never uses the progression fallback for a finished chapter", async () => {
    renderReader(
      "/app/b/b1/c/doc_2",
      bookState({ doc_2: { state: "read", furthest: 0.5 } }),
    );
    await screen.findByTestId("workspace");
    await waitFor(() => expect(booksApi.state).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(h.restore).not.toHaveBeenCalled();
  });

  it("keeps the version being read when the manifest brings a newer one", async () => {
    const info = vi.spyOn(toast, "info");
    const { client } = renderReader();
    const workspace = await screen.findByTestId("workspace");
    expect(workspace).toHaveAttribute("data-version", "ver_2");
    const newer = bookManifest();
    newer.readingOrder[1].properties!.versionId = "ver_2b";
    vi.mocked(booksApi.manifest).mockResolvedValue(newer);
    await act(() => client.invalidateQueries({ queryKey: ["book", "b1"] }));
    await waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        "A new version of this chapter is available.",
        expect.anything(),
      ),
    );
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-version", "ver_2");
    expect(h.last!.version).toBe("ver_2");
  });

  it("View moves to the new version and keeps the reader's place", async () => {
    const info = vi.spyOn(toast, "info");
    const { client } = renderReader();
    await screen.findByTestId("workspace");
    await waitFor(() => expect(booksApi.state).toHaveBeenCalled());
    act(() =>
      reader().onViewport!({
        anchor: { quote: "where I was" },
        section: "setup",
        progression: 0.6,
      }),
    );
    const newer = bookManifest();
    newer.readingOrder[1].properties!.versionId = "ver_2b";
    vi.mocked(booksApi.manifest).mockResolvedValue(newer);
    await act(() => client.invalidateQueries({ queryKey: ["book", "b1"] }));
    await waitFor(() => expect(info).toHaveBeenCalled());
    const [, options] = info.mock.calls.find(
      ([message]) => message === "A new version of this chapter is available.",
    )!;
    h.restore.mockClear();
    act(() =>
      (options as unknown as { action: { onClick: () => void } }).action.onClick(),
    );
    await waitFor(() =>
      expect(screen.getByTestId("workspace")).toHaveAttribute("data-version", "ver_2b"),
    );
    expect(h.restore).toHaveBeenCalledWith({
      anchor: { quote: "where I was" },
      section: "setup",
      progression: 0.6,
    });
  });

  it("binds the new-version toast to its chapter and drops it on chapter change", async () => {
    const user = userEvent.setup();
    const info = vi.spyOn(toast, "info").mockReturnValue("toast_ver_2b");
    const dismiss = vi.spyOn(toast, "dismiss");
    const { client } = renderReader();
    await screen.findByTestId("workspace");
    act(() => reader().onViewport!({ section: "setup", progression: 0.3 }));
    const newer = bookManifest();
    newer.readingOrder[1].properties!.versionId = "ver_2b";
    vi.mocked(booksApi.manifest).mockResolvedValue(newer);
    await act(() => client.invalidateQueries({ queryKey: ["book", "b1"] }));
    await waitFor(() => expect(info).toHaveBeenCalled());
    const [, options] = info.mock.calls.find(
      ([message]) => message === "A new version of this chapter is available.",
    )!;
    await user.keyboard("{ArrowRight}");
    expect(where()).toBe("/app/b/b1/c/doc_3");
    expect(dismiss).toHaveBeenCalledWith("toast_ver_2b");
    // A View click that still lands does nothing to the next chapter.
    act(() =>
      (options as unknown as { action: { onClick: () => void } }).action.onClick(),
    );
    expect(screen.getByTestId("workspace")).toHaveAttribute("data-version", "ver_3");
  });

  it("keeps the changed-heading marks after the update is seen", async () => {
    const { client } = renderReader(
      "/app/b/b1/c/doc_2",
      bookState({ doc_2: { updated: true } }),
      {
        since_version_id: "ver_1",
        versions: [{ id: "ver_2", number: 2, change_summary: "x", created_at: "" }],
        changed_sections: [{ id: "setup", title: "Setting up", removed: false }],
      },
    );
    await waitFor(() => expect(reader().markHeadings).toEqual(["setup"]));
    vi.mocked(booksApi.state).mockResolvedValue(
      bookState({ doc_2: { updated: false } }),
    );
    await act(() => client.invalidateQueries({ queryKey: ["book", "b1"] }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /Updated since you read/ }),
      ).toBeNull(),
    );
    expect(reader().markHeadings).toEqual(["setup"]);
  });
});
