import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "@/api";
import { booksApi, type Outline, type OutlineResponse } from "@/lib/books";
import { bookManifest, stubMatchMedia } from "./book-fixtures";
import { BookOutlineEditorPage } from "./book-outline-editor";

beforeEach(() => {
  vi.stubGlobal("matchMedia", stubMatchMedia());
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const outline = (): Outline => ({
  title: "My Book",
  front: [],
  parts: [
    { title: "Part One", chapters: [{ doc: "doc_a" }, { doc: "doc_b" }] },
    { title: "Part Two", chapters: [{ doc: "doc_c" }] },
  ],
  back: [],
});

function response(over: Partial<OutlineResponse> = {}): OutlineResponse {
  return {
    version_id: "bov_1",
    number: 1,
    outline: outline(),
    not_in_outline: [{ id: "doc_d", title: "Extra" }],
    removed: [],
    ...over,
  };
}

function mockLoad(over: Partial<OutlineResponse> = {}) {
  const m = bookManifest();
  m.toc = [
    {
      title: "Part One",
      children: [
        {
          title: "Alpha",
          properties: { documentId: "doc_a", kind: "chapter", part: 0 },
        },
        {
          title: "Beta",
          properties: { documentId: "doc_b", kind: "chapter", part: 0 },
        },
      ],
    },
    {
      title: "Part Two",
      children: [
        {
          title: "Gamma",
          properties: { documentId: "doc_c", kind: "chapter", part: 1 },
        },
      ],
    },
  ];
  vi.spyOn(booksApi, "manifest").mockResolvedValue(m);
  return vi.spyOn(booksApi, "outline").mockResolvedValue(response(over));
}

function renderEditor(state?: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[{ pathname: "/app/b/b1/outline", state }]}>
        <Routes>
          <Route path="/app/b/:bookId/outline" element={<BookOutlineEditorPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// The chapter rows in order, as "number: title".
function chapterRows(): string[] {
  return screen
    .getAllByRole("listitem")
    .map((li) => li.getAttribute("aria-label") ?? "")
    .filter((l) => l.startsWith("Chapter "));
}

describe("BookOutlineEditorPage", () => {
  it("moves a chapter down and renumbers", async () => {
    mockLoad();
    const user = userEvent.setup();
    renderEditor();
    await screen.findByRole("listitem", { name: "Chapter 1: Alpha" });
    expect(chapterRows()).toEqual([
      "Chapter 1: Alpha",
      "Chapter 2: Beta",
      "Chapter 3: Gamma",
    ]);
    await user.click(screen.getByRole("button", { name: "Move Alpha down" }));
    expect(chapterRows()).toEqual([
      "Chapter 1: Beta",
      "Chapter 2: Alpha",
      "Chapter 3: Gamma",
    ]);
  });

  it("keyboard move and drag both reorder and renumber", async () => {
    mockLoad();
    const user = userEvent.setup();
    // jsdom has no layout. Give every row, part header and part footer a box
    // in document order so the keyboard sensor can find what it is over.
    const spy = vi
      .spyOn(Element.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: Element) {
        const all = Array.from(document.querySelectorAll("li, header, footer"));
        const i = all.indexOf(this);
        const top = i < 0 ? 0 : i * 100;
        return {
          x: 0,
          y: top,
          top,
          left: 0,
          right: 100,
          bottom: top + (i < 0 ? 0 : 100),
          width: 100,
          height: i < 0 ? 0 : 100,
          toJSON: () => ({}),
        } as DOMRect;
      });
    renderEditor();
    await screen.findByRole("listitem", { name: "Chapter 1: Alpha" });

    // Keyboard buttons.
    await user.click(screen.getByRole("button", { name: "Move Gamma up" }));
    expect(chapterRows()).toEqual([
      "Chapter 1: Alpha",
      "Chapter 2: Beta",
      "Chapter 3: Gamma",
    ]);
    expect(
      within(screen.getByRole("group", { name: "Part One" })).getAllByRole("listitem"),
    ).toHaveLength(3);

    // Drag with the dnd-kit keyboard sensor: Space lifts, arrows move 25px,
    // Space drops. Four presses is one row of 100px.
    const handle = screen.getByRole("button", { name: "Drag Alpha" });
    handle.focus();
    await user.keyboard(" ");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}");
    await user.keyboard(" ");
    await waitFor(() =>
      expect(chapterRows()).toEqual([
        "Chapter 1: Beta",
        "Chapter 2: Alpha",
        "Chapter 3: Gamma",
      ]),
    );
    spy.mockRestore();
  });

  it("adds a planned chapter with a title", async () => {
    mockLoad();
    const user = userEvent.setup();
    renderEditor();
    await screen.findByRole("listitem", { name: "Chapter 1: Alpha" });
    const partTwo = screen.getByRole("group", { name: "Part Two" });
    await user.click(
      within(partTwo).getByRole("button", { name: "Add planned chapter" }),
    );
    const input = within(partTwo).getByRole("textbox", {
      name: "Planned chapter title",
    });
    await user.type(input, "Retries");
    expect(chapterRows()).toContain("Chapter 4: Retries (planned)");
  });

  it("pushes with the base version and note", async () => {
    mockLoad();
    const push = vi
      .spyOn(booksApi, "pushOutline")
      .mockResolvedValue({ version_id: "bov_2", number: 2 });
    const user = userEvent.setup();
    renderEditor();
    await screen.findByRole("listitem", { name: "Chapter 1: Alpha" });
    await user.click(screen.getByRole("button", { name: "Move Alpha down" }));
    await user.type(screen.getByLabelText("Note (optional)"), "swap intro");
    await user.click(screen.getByRole("button", { name: "Save outline" }));
    await waitFor(() => expect(push).toHaveBeenCalledTimes(1));
    const [id, base, sent, note] = push.mock.calls[0];
    expect(id).toBe("b1");
    expect(base).toBe("bov_1");
    expect(note).toBe("swap intro");
    expect(sent.parts[0].chapters.map((c) => c.doc)).toEqual(["doc_b", "doc_a"]);
  });

  it("moves documents between Not in outline and parts", async () => {
    mockLoad();
    const user = userEvent.setup();
    renderEditor();
    await screen.findByRole("listitem", { name: "Chapter 1: Alpha" });
    await user.selectOptions(screen.getByLabelText("Add Extra to…"), "Part Two");
    expect(chapterRows()).toContain("Chapter 4: Extra");
    await user.click(screen.getByRole("button", { name: "Remove Alpha" }));
    expect(chapterRows()[0]).toBe("Chapter 1: Beta");
    const pool = screen.getByRole("region", { name: "Not in outline" });
    expect(within(pool).getByText("Alpha")).toBeTruthy();
  });

  it("shows validation problems at their rows", async () => {
    mockLoad();
    vi.spyOn(booksApi, "pushOutline").mockRejectedValue(
      new APIError(422, "invalid_outline", "invalid", {
        problems: [
          {
            path: "parts[1].chapters[0].doc",
            message: "document is in another folder",
          },
          { path: "parts[0].title", message: "part title is required" },
          { path: "nonsense", message: "something odd" },
        ],
      }),
    );
    const user = userEvent.setup();
    renderEditor();
    await screen.findByRole("listitem", { name: "Chapter 1: Alpha" });
    await user.click(screen.getByRole("button", { name: "Move Alpha down" }));
    await user.click(screen.getByRole("button", { name: "Save outline" }));
    const gamma = await screen.findByRole("listitem", { name: "Chapter 3: Gamma" });
    expect(within(gamma).getByText("document is in another folder")).toBeTruthy();
    const partOne = screen.getByRole("group", { name: "Part One" });
    expect(within(partOne).getByText("part title is required")).toBeTruthy();
    const summary = screen.getByRole("alert");
    expect(within(summary).getByText(/something odd/)).toBeTruthy();
  });

  it("explains a conflict and offers reload", async () => {
    const load = mockLoad();
    vi.spyOn(booksApi, "pushOutline").mockRejectedValue(
      new APIError(409, "outline_conflict", "conflict", {
        current_version_id: "bov_9",
      }),
    );
    const user = userEvent.setup();
    renderEditor();
    await screen.findByRole("listitem", { name: "Chapter 1: Alpha" });
    await user.click(screen.getByRole("button", { name: "Move Alpha down" }));
    await user.click(screen.getByRole("button", { name: "Save outline" }));
    expect(
      await screen.findByText(
        "Someone changed the outline while you were editing. Reload to see their version.",
      ),
    ).toBeTruthy();
    load.mockResolvedValue(
      response({
        version_id: "bov_9",
        outline: {
          ...outline(),
          parts: [{ title: "Theirs", chapters: [{ doc: "doc_c" }] }],
        },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Reload" }));
    // There are unsaved edits, so the page asks before discarding them.
    await user.click(await screen.findByRole("button", { name: "Discard my changes" }));
    expect(await screen.findByRole("group", { name: "Theirs" })).toBeTruthy();
  });

  it("reports what Make this a book placed", async () => {
    mockLoad();
    renderEditor({ placed: 2, notInOutline: 1 });
    expect(
      await screen.findByText(
        "Placed 2 chapters; 1 document is not in the outline yet.",
      ),
    ).toBeTruthy();
  });
});
