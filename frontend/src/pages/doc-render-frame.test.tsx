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

function setup(extra: Partial<DocContextValue> = {}) {
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
  const ctx = {
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
    ...extra,
  } as unknown as DocContextValue;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DocProvider value={ctx}>
          <RenderFrame />
        </DocProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { reportViewport };
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
    });
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
