import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { DocProvider, type DocContextValue, type ReaderOptions } from "./doc-context";
import { RenderFrame } from "./doc-render-frame";

const ORIGIN = "https://render.example";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function setup(extra: Partial<DocContextValue> = {}, url = "/app/d/doc_1") {
  vi.spyOn(api, "renderToken").mockResolvedValue({
    token: "t",
    url: `${ORIGIN}/render/doc_1`,
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  const reportViewport = vi.fn();
  const base = {
    docId: "doc_1",
    version: "ver_1",
    comments: [],
    commentFilter: "open",
    drafts: [],
    startDraft: vi.fn(),
    handleDocCommentClick: vi.fn(),
    setUnanchoredComments: vi.fn(),
    setCommentPositions: vi.fn(),
    setCommentViewport: vi.fn(),
    registerDocumentScroller: vi.fn(),
    registerDocumentPrinter: vi.fn(),
    syncCommentRail: vi.fn(),
    handleRenderedDocumentClick: vi.fn(),
    subscribeDocumentKV: () => () => {},
    reportViewport,
    moveCursor: vi.fn(),
    subscribeCursors: () => () => {},
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (more: Partial<DocContextValue>) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]}>
        <DocProvider value={{ ...base, ...more } as unknown as DocContextValue}>
          <RenderFrame />
        </DocProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const { rerender } = render(tree(extra));
  // Re-render with new context fields, as a reader settings change would.
  const update = (more: Partial<DocContextValue>) => rerender(tree(more));
  return { reportViewport, update };
}

async function frame(title: string) {
  const iframe = (await screen.findByTitle(title)) as HTMLIFrameElement;
  const view = iframe.contentWindow!;
  const posted = vi.spyOn(view, "postMessage").mockImplementation(() => {});
  const send = (data: unknown) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { origin: ORIGIN, source: view, data }),
      );
    });
  const types = () =>
    posted.mock.calls.map(([message]) => (message as { type: string }).type);
  return { posted, send, types };
}

describe("RenderFrame outside book mode", () => {
  it("keeps today's title, messages and keys", async () => {
    const { reportViewport } = setup();
    const { send, types } = await frame("Rendered document");
    const keydown = vi.fn();
    window.addEventListener("keydown", keydown);
    send({ type: "slashdocs:ready" });
    // A reader "t" is not the Esc-then-T chord, which arrives unflagged.
    send({ type: "slashdocs:keydown", key: "t", reader: true });
    send({ type: "slashdocs:keydown", key: "ArrowRight", reader: true });
    send({
      type: "slashdocs:viewport",
      anchor: { quote: "hello" },
      section: "intro",
      progression: 0.5,
    });
    window.removeEventListener("keydown", keydown);
    expect(types()).not.toContain("slashdocs:reader-settings");
    expect(types()).not.toContain("slashdocs:mark-headings");
    expect(keydown).not.toHaveBeenCalled();
    expect(reportViewport).toHaveBeenCalledWith({
      quote: "hello",
      prefix: undefined,
      suffix: undefined,
    });
  });
});

describe("RenderFrame in book mode", () => {
  it("sends reader styles, reports sections and forwards reader keys", async () => {
    const reader: ReaderOptions = {
      frameTitle: "Chapter 2: Queues",
      settings: { size: "l", width: "narrow", theme: "paper" },
      markHeadings: ["intro"],
      onViewport: vi.fn(),
      onKey: vi.fn(),
      onRestored: vi.fn(),
    };
    setup({ reader });
    const { posted, send } = await frame("Chapter 2: Queues");
    send({ type: "slashdocs:ready" });
    const messages = posted.mock.calls.map(([message]) => message);
    expect(messages).toContainEqual({ type: "slashdocs:theme", theme: "light" });
    expect(messages).toContainEqual({
      type: "slashdocs:reader-settings",
      settings: reader.settings,
    });
    expect(messages).toContainEqual({
      type: "slashdocs:mark-headings",
      ids: ["intro"],
    });

    send({ type: "slashdocs:viewport", section: "intro", progression: 1.7 });
    expect(reader.onViewport).toHaveBeenCalledWith({
      anchor: undefined,
      section: "intro",
      progression: 1,
      fits: false,
    });
    // Only a literal true says the chapter fits on screen.
    send({ type: "slashdocs:viewport", section: "", progression: 0, fits: true });
    expect(reader.onViewport).toHaveBeenLastCalledWith(
      expect.objectContaining({ fits: true }),
    );
    send({ type: "slashdocs:viewport", section: "", progression: 0, fits: "yes" });
    expect(reader.onViewport).toHaveBeenLastCalledWith(
      expect.objectContaining({ fits: false }),
    );
    send({ type: "slashdocs:keydown", key: "ArrowRight", reader: true });
    send({ type: "slashdocs:keydown", key: "x", reader: true });
    expect(reader.onKey).toHaveBeenCalledTimes(1);
    expect(reader.onKey).toHaveBeenCalledWith("ArrowRight");
    send({ type: "slashdocs:position-restored", method: "section" });
    send({ type: "slashdocs:position-restored", method: "bogus" });
    expect(reader.onRestored).toHaveBeenCalledTimes(1);
    expect(reader.onRestored).toHaveBeenCalledWith("section");
  });

  it("holds a restore until the frame is ready", async () => {
    let restore: ((target: { section?: string; progression?: number }) => void) | null =
      null;
    setup({
      reader: {},
      registerPositionRestorer: (fn) => {
        restore = fn;
      },
    });
    const { posted, send, types } = await frame("Rendered document");
    act(() => restore!({ section: "intro", progression: 0.4 }));
    expect(types()).not.toContain("slashdocs:navigate-position");
    send({ type: "slashdocs:ready" });
    expect(posted.mock.calls.map(([message]) => message)).toContainEqual({
      type: "slashdocs:navigate-position",
      section: "intro",
      progression: 0.4,
    });
  });
});

describe("RenderFrame reader updates", () => {
  it("clears reader styles once the reader options go away", async () => {
    const { update } = setup({
      reader: {
        settings: { size: "s", width: "wide", theme: "system" },
        markHeadings: ["a"],
      },
    });
    const { posted, send } = await frame("Rendered document");
    send({ type: "slashdocs:ready" });
    posted.mockClear();
    act(() => update({ reader: {} }));
    const messages = posted.mock.calls.map(([message]) => message);
    expect(messages).toContainEqual({
      type: "slashdocs:reader-settings",
      settings: null,
    });
    expect(messages).toContainEqual({ type: "slashdocs:mark-headings", ids: [] });
  });

  it("does not resend marks for a new array with the same ids", async () => {
    const { update } = setup({ reader: { markHeadings: ["a"] } });
    const { posted, send, types } = await frame("Rendered document");
    send({ type: "slashdocs:ready" });
    posted.mockClear();
    act(() => update({ reader: { markHeadings: ["a"] } }));
    expect(types()).not.toContain("slashdocs:mark-headings");
  });

  it("restores at once when the frame is already ready", async () => {
    let restore: ((target: { progression?: number }) => void) | null = null;
    setup({
      reader: {},
      registerPositionRestorer: (fn) => {
        restore = fn;
      },
    });
    const { posted, send } = await frame("Rendered document");
    send({ type: "slashdocs:ready" });
    posted.mockClear();
    act(() => restore!({ progression: 0.7 }));
    expect(posted.mock.calls.map(([message]) => message)).toEqual([
      { type: "slashdocs:navigate-position", progression: 0.7 },
    ]);
  });
});

describe("RenderFrame hash navigation", () => {
  // As before book mode: an empty heading cancels any earlier link
  // navigation in the frame.
  it("sends an empty heading navigation on ready without a hash", async () => {
    setup();
    const { posted, send } = await frame("Rendered document");
    send({ type: "slashdocs:ready" });
    expect(posted.mock.calls.map(([message]) => message)).toContainEqual({
      type: "slashdocs:navigate-heading",
      id: "",
    });
  });

  // The bridge ignores an empty heading for a waiting restore, and the
  // restore goes first so a real link still wins.
  it("posts a waiting restore before the hash navigation", async () => {
    let restore: ((target: { progression?: number }) => void) | null = null;
    setup({
      reader: {},
      registerPositionRestorer: (fn) => {
        restore = fn;
      },
    });
    const { send, types } = await frame("Rendered document");
    act(() => restore!({ progression: 0.4 }));
    send({ type: "slashdocs:ready" });
    const order = types().filter((t) => t.startsWith("slashdocs:navigate-"));
    expect(order).toEqual([
      "slashdocs:navigate-position",
      "slashdocs:navigate-heading",
    ]);
  });

  it("still navigates to a heading in the hash", async () => {
    setup({}, "/app/d/doc_1#intro");
    const { posted, send } = await frame("Rendered document");
    send({ type: "slashdocs:ready" });
    expect(posted.mock.calls.map(([message]) => message)).toContainEqual({
      type: "slashdocs:navigate-heading",
      id: "intro",
    });
  });
});
