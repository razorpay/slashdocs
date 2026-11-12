import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  api,
  APIError,
  type ApprovalsList,
  type Document,
  type DocumentEvent,
  type Principal,
} from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { findLiterals, type Render } from "@/lib/script-literals";
import * as sourceEdits from "@/lib/source-edits";
import * as sourceMerge from "@/lib/source-merge";
import { readTextDrafts, writeTextDraft, type TextDraft } from "@/lib/text-drafts";
import type { Patch, Region, ScriptChange } from "../../bridge/source-pieces";
import type { TextPatchResult } from "./doc-context";
import { useEarlierDraft } from "./use-earlier-draft";
import { newLoads, type Loads } from "./live-load";
import { useLiveText } from "./use-live-text";

vi.mock("@/lib/source-edits", { spy: true });
vi.mock("@/lib/source-merge", { spy: true });

// The sum of every source in these tests, unless a test gives another one:
// the client and the server agree.
const SUM = 7;

const SOURCE = "<p>Try it.</p><p>Try it.</p>";
// Each read of a version gives this source, at the seq that it asks for.
const sources = (source: string) =>
  vi
    .mocked(api.versionSource)
    .mockImplementation(async (_doc, _version, seq) => ({ source, seq }));
// The page of the document is there until a test leaves it.
const page = { current: true };
const loaded = { version: "ver_1", seq: 1, url: "/render/0" };
// The principal of the reader, whose text storage keeps.
const ME = "usr_me";
// The draft that storage keeps for the document. Each load keeps its own,
// and these tests have one at most.
const kept = () => {
  const drafts = Object.values(readTextDrafts(ME, "doc_1"));
  expect(drafts.length).toBeLessThan(2);
  return drafts[0];
};

beforeEach(async () => {
  // parse5 and acorn load on the first parse. Load them before the timers
  // stop.
  await sourceEdits.parseSource("");
  await findLiterals("", "x");
  vi.mocked(sourceEdits.parseSource).mockClear();
  vi.useFakeTimers();
  vi.mocked(sourceMerge.sumOf).mockReturnValue(SUM);
  vi.spyOn(api, "versionSource");
  sources(SOURCE);
  vi.spyOn(api, "getDocument").mockResolvedValue({ id: "doc_1" } as Document);
  page.current = true;
});
afterEach(async () => {
  // A hook that stays hears the events of the next test. Its last send
  // ends before storage clears.
  cleanup();
  await vi.advanceTimersByTimeAsync(0);
  localStorage.clear();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// A paragraph of the source, with new text.
const paragraph = (at: number, text: string): Region => ({
  from: at,
  to: at,
  pieces: [{ element: at, children: [{ text }] }],
  removed: [],
});
const first = (text: string) => paragraph(0, text);
const second = (text: string) => paragraph(14, text);

// The answer of the server for an operation. others is the source at the
// new seq when the server merged the operation: then the answer names what
// turns the source that the operation made into it.
const sent = (
  seq: number,
  others?: { from: string; to: string },
  version_id = "ver_1",
) => ({
  seq,
  version_id,
  others: others ? [sourceEdits.replacementsBetween(others.from, others.to)] : [],
  sum: SUM,
});

const asha = { type: "user" as const, id: "usr_a", name: "Asha" };

// The live document, which a client that lost the head takes as its head:
// the source of the current version, read with no seq.
const live = (source: string, seq: number) => {
  vi.mocked(api.getDocument).mockResolvedValue({
    id: "doc_1",
    current_version_id: "ver_1",
  } as Document);
  const get = vi
    .fn<(doc: string, version: string) => Promise<{ source: string; seq: number }>>()
    .mockResolvedValue({ source, seq });
  vi.mocked(api.versionSource).mockImplementation(async (doc, version, at) =>
    at === undefined ? get(doc, version) : { source: SOURCE, seq: at },
  );
  return get;
};

// The answer of the server for the changes from one source to the source at
// a later seq.
const changes = (seq: number, from: string, to: string, typed = true) => ({
  seq,
  version_id: "ver_1",
  ops: [sourceEdits.replacementsBetween(from, to)],
  typed,
  authors: [asha],
  sum: SUM,
});

function setup(
  props: {
    latest?: number;
    editing?: boolean;
    event?: DocumentEvent;
    loads?: Loads;
    owner?: string;
    signIn?: () => void;
  } = {},
) {
  // What the frame shows: every region that changed since it loaded, and
  // the count of the reader's operations.
  const frame = { regions: [] as Region[], scripts: [] as ScriptChange[], edits: 0 };
  const options = {
    docId: "doc_1",
    owner: ME as string | undefined,
    signIn: undefined as (() => void) | undefined,
    loaded: loaded as { version: string; seq?: number; url: string },
    latest: undefined as number | undefined,
    event: undefined as DocumentEvent | undefined,
    live: true,
    editing: true,
    onPage: page,
    loads: newLoads(),
    take: vi.fn(async () => ({ ...frame })),
    patch:
      vi.fn<
        (
          patches: Patch[],
          edits: number,
          flash: boolean,
          ask: boolean,
        ) => Promise<TextPatchResult>
      >(),
    setState: vi.fn(),
    holdCursor: vi.fn(),
    frameShows: vi.fn(),
    reload: vi.fn(),
    holdUpdate: vi.fn(),
    madeBy: vi.fn<(after: number, upto: number) => Principal[] | undefined>(),
    probe: vi.fn<Render>(),
    replaceText: vi.fn(),
    ...props,
  };
  const client = new QueryClient();
  // The page offers the text of an earlier visit, as DocWorkspace does.
  const hook = renderHook(
    () => {
      useEarlierDraft(options.docId, options.owner);
      return useLiveText({ ...options });
    },
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  const { result } = hook;
  // The reader leaves the page of the document.
  const leave = () => {
    page.current = false;
    hook.unmount();
  };
  // The tab closes: its loads let go of their drafts, as the page does when
  // it goes, and the next visit has a page again.
  const close = async () => {
    leave();
    options.loads.all.forEach((s) => s.release());
    await act(() => vi.advanceTimersByTimeAsync(0));
    page.current = true;
  };
  // The frame is ready, so the hook told the page the seq that it loaded.
  options.frameShows.mockClear();
  // The page gives new options to the hook.
  const rerender = (next: Partial<typeof options>) => {
    Object.assign(options, next);
    hook.rerender();
  };
  const key = async () => {
    act(() => result.current.changed());
    await act(() => vi.advanceTimersByTimeAsync(50));
  };
  // The reader types text in the second paragraph, and it goes out.
  const type = async (text: string) => {
    frame.regions = [...frame.regions.filter((r) => r.from !== 14), second(text)];
    await key();
  };
  // The frame applies each patch, and shows the regions after it.
  const patched = (regions: Region[]) =>
    options.patch.mockImplementationOnce(async () => {
      frame.regions = regions;
      return { ...frame, ok: true, stale: false };
    });
  return {
    ...options,
    client,
    frame,
    type,
    key,
    patched,
    result,
    hook,
    rerender,
    leave,
    close,
  };
}

it("sends the edits as replacements on the loaded seq", async () => {
  const edit = vi.spyOn(api, "sendOps").mockResolvedValue(sent(2));
  const { type, frameShows, setState } = setup();

  await type("Try it now.");

  expect(edit).toHaveBeenCalledWith("doc_1", {
    base_seq: 1,
    client_op_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    replacements: [{ start: 21, end: 24, old_html: "it.", new_html: "it now." }],
  });
  expect(frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
  expect(setState).toHaveBeenLastCalledWith("idle");
});

it("settles the edits at once, after the operation on its way", async () => {
  let land = () => {};
  const edit = vi
    .spyOn(api, "sendOps")
    .mockImplementationOnce(() => new Promise((done) => (land = () => done(sent(2)))))
    .mockResolvedValueOnce(sent(3))
    .mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const { type, frame, result } = setup();
  // Nothing typed: nothing to send.
  expect(await act(() => result.current.settle())).toBe(true);

  await type("Try it now.");
  // The reader typed more while the first operation was on its way.
  frame.regions = [second("Try it now!")];
  act(() => result.current.changed());
  const settled = act(() => result.current.settle());
  land();
  expect(await settled).toBe(true);
  expect(edit).toHaveBeenCalledTimes(2);

  // A send that fails for a reason that can pass goes on by itself: the
  // reader can leave the text.
  frame.regions = [second("Try it later.")];
  act(() => result.current.changed());
  expect(await act(() => result.current.settle())).toBe(true);
  expect(edit).toHaveBeenCalledTimes(3);
});

it("sends each operation on top of the last one", async () => {
  const edit = vi
    .spyOn(api, "sendOps")
    .mockResolvedValueOnce(sent(2))
    .mockResolvedValueOnce(sent(3));
  const { type } = setup();

  await type("Try it now.");
  await type("Try it now!");

  const [first, next] = edit.mock.calls.map(([, input]) => input);
  expect(next.base_seq).toBe(2);
  expect(next.client_op_id).not.toBe(first.client_op_id);
  expect(sourceEdits.replacementsBetween).toHaveBeenLastCalledWith(
    "<p>Try it.</p><p>Try it now.</p>",
    "<p>Try it.</p><p>Try it now!</p>",
  );
  expect(next.replacements).toEqual([
    { start: 24, end: 28, old_html: "now.", new_html: "now!" },
  ]);
  // The loaded source is read and parsed once.
  expect(api.versionSource).toHaveBeenCalledTimes(1);
  expect(sourceEdits.parseSource).toHaveBeenCalledTimes(1);
});

// A server of the release before has no route for operations. It answers
// 404 with no error code, while a server of this release still runs.
it.each([
  ["the network", new TypeError("Failed to fetch")],
  [
    "a server with no route for operations",
    new APIError(404, "http_error", "Not Found"),
  ],
])(
  "sends an operation that failed on %s again after 5 s, with the same id and body",
  async (_, error) => {
    const edit = vi
      .spyOn(api, "sendOps")
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(sent(2));
    const { type, setState, reload } = setup();

    await type("Try it now.");
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(edit).toHaveBeenCalledTimes(2);
    expect(edit.mock.calls[1][1]).toEqual(edit.mock.calls[0][1]);
    // The failure passed before the reader had to know of it.
    expect(setState.mock.calls.every(([state]) => state === "idle")).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  },
);

it("keeps the text, takes the reader to sign in, and sends the text after sign-in, when the session ended", async () => {
  const error = vi.spyOn(toast, "error");
  const edit = vi
    .spyOn(api, "sendOps")
    .mockRejectedValue(new APIError(401, "unauthorized", "sign in"));
  const signIn = vi.fn();
  const { type, client, setState, rerender, close } = setup();
  const invalidate = vi.spyOn(client, "invalidateQueries");

  await type("Try it now.");

  // The page asks who the reader is. The text waits in storage, is never
  // refused, and does not go again.
  expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.me() });
  expect(kept()).toMatchObject({ op: edit.mock.calls[0][1] });
  expect(setState).not.toHaveBeenCalledWith("refused");
  expect(error).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(60_000));
  expect(edit).toHaveBeenCalledOnce();

  // The page learns that the reader is signed out.
  rerender({ signIn });
  expect(signIn).toHaveBeenCalledOnce();

  // The page goes to sign in. The page after sign-in sends the text by
  // itself.
  await close();
  expect(kept()).toBeDefined();
  edit.mockResolvedValue(sent(2));
  setup({ editing: false });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(edit.mock.lastCall![1]).toEqual(edit.mock.calls[0][1]);
  expect(kept()).toBeUndefined();
});

it("takes the reader to sign in at once when the page knows that they are signed out", async () => {
  vi.spyOn(api, "sendOps").mockRejectedValue(
    new APIError(401, "unauthorized", "sign in"),
  );
  const signIn = vi.fn();
  const { type } = setup({ signIn });

  await type("Try it now.");

  expect(signIn).toHaveBeenCalledOnce();
});

it("holds the cursor of the reader from a key until the server answers the operation", async () => {
  let answer: (answer: ReturnType<typeof sent>) => void = () => {};
  vi.spyOn(api, "sendOps").mockImplementation(
    () => new Promise((resolve) => (answer = resolve)),
  );
  const { type, holdCursor } = setup();

  await type("Try it now.");
  expect(holdCursor).toHaveBeenLastCalledWith(true);
  await act(async () => answer(sent(2)));

  expect(holdCursor).toHaveBeenLastCalledWith(false);
});

it("holds one lock of a draft, for the load on the page, until the load leaves the page", async () => {
  const request = vi.spyOn(navigator.locks, "request");
  const { leave } = setup();
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(request).toHaveBeenCalledOnce();
  const [name] = request.mock.calls[0];

  leave();
  await act(() => vi.advanceTimersByTimeAsync(0));

  const free = vi.fn();
  await navigator.locks.request(name, { ifAvailable: true }, (lock) => free(!!lock));
  expect(free).toHaveBeenCalledWith(true);
});

describe("a send that fails for a reason that can pass", () => {
  const offline = () =>
    vi.spyOn(api, "sendOps").mockRejectedValue(new TypeError("Failed to fetch"));

  it("says nothing for the first 10 s, then that the text is not saved, with no toast", async () => {
    const error = vi.spyOn(toast, "error");
    const send = offline();
    const { type, setState } = setup();

    await type("Try it now.");
    await act(() => vi.advanceTimersByTimeAsync(9_900));
    expect(setState.mock.calls.every(([state]) => state === "idle")).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(setState).toHaveBeenLastCalledWith("failed");
    expect(error).not.toHaveBeenCalled();

    // The sign goes when a send gets to the server.
    send.mockResolvedValue(sent(2));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(setState).toHaveBeenLastCalledWith("idle");
  });

  it("says that the text is not saved after 20 s of sends that get no answer, and recovers by itself", async () => {
    // Each send fails after 10 s with no answer (see api.sendOps).
    const send = vi
      .spyOn(api, "sendOps")
      .mockImplementation(
        () =>
          new Promise((_, fail) =>
            setTimeout(() => fail(new DOMException("", "TimeoutError")), 10_000),
          ),
      );
    const { type, setState } = setup();

    await type("Try it now.");
    await act(() => vi.advanceTimersByTimeAsync(19_900));
    expect(setState.mock.calls.every(([state]) => state === "idle")).toBe(true);
    // The send after the first failure is on its way, and gets no answer.
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(send).toHaveBeenCalledTimes(2);
    expect(setState).toHaveBeenLastCalledWith("failed");

    // The network answers again: the try after the one on its way gets in.
    send.mockResolvedValue(sent(2));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(setState).toHaveBeenLastCalledWith("idle");
  });

  it("sends again at once when the network is back, or when the reader asks", async () => {
    const send = offline();
    const { type, result } = setup();
    await type("Try it now.");
    expect(send).toHaveBeenCalledOnce();

    await act(async () => void window.dispatchEvent(new Event("online")));
    expect(send).toHaveBeenCalledTimes(2);
    // Retry on the bar.
    await act(() => result.current.settle());
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[2][1]).toEqual(send.mock.calls[0][1]);
  });

  it("does not send again for each key while it waits for its next try", async () => {
    const send = offline();
    const { type } = setup();
    await type("Try it now.");
    await type("Try it now!");
    expect(send).toHaveBeenCalledOnce();

    // The keys typed meanwhile go when the operation before them is in.
    send.mockResolvedValueOnce(sent(2)).mockResolvedValueOnce(sent(3));
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.lastCall![1]).toMatchObject({
      base_seq: 2,
      replacements: [{ start: 24, end: 28, old_html: "now.", new_html: "now!" }],
    });
  });

  it("stops when the page is left", async () => {
    const send = offline();
    const { type, leave, setState } = setup();
    await type("Try it now.");
    leave();
    await act(() => vi.advanceTimersByTimeAsync(0));
    const sends = send.mock.calls.length;
    setState.mockClear();

    await act(() => vi.advanceTimersByTimeAsync(60_000));

    expect(send).toHaveBeenCalledTimes(sends);
    expect(setState).not.toHaveBeenCalled();
    // The text waits in storage for the next visit.
    expect(kept()).toBeDefined();
  });

  it("warns before an unload only about text that cannot go with the page", async () => {
    const unload = () => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const send = vi.spyOn(api, "sendOps").mockResolvedValue(sent(2));
    const { frame, result, type } = setup();
    // A key that waits for its burst goes with the page.
    frame.regions = [second("Try it now.")];
    act(() => result.current.changed());
    expect(unload()).toBe(false);

    send.mockRejectedValue(new TypeError("Failed to fetch"));
    await type("Try it now!");
    expect(unload()).toBe(true);
  });

  it("warns before an unload about text that is not sent while the browser is offline", async () => {
    const unload = () =>
      !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    const { frame, result } = setup();

    frame.regions = [second("Try it now.")];
    act(() => result.current.changed());

    expect(unload()).toBe(true);
  });
});

const THEIRS = "<p>Try this.</p><p>Try it.</p>";
const MERGED = "<p>Try this.</p><p>Try it now.</p>";

const MINE = "<p>Try it.</p><p>Try it now.</p>";
const merged = { from: MINE, to: MERGED };

it("shows the text of other people that a merged operation answers with, in place", async () => {
  const edit = vi.spyOn(api, "sendOps").mockResolvedValueOnce(sent(3, merged));
  const get = vi.spyOn(api, "documentChanges");
  const { type, patch, patched, frameShows, reload, holdUpdate } = setup();
  patched([first("Try this."), second("Try it now.")]);

  await type("Try it now.");

  // The answer names the changes: no request asks for them.
  expect(get).not.toHaveBeenCalled();
  // The frame already shows the text of the reader: only the text of the
  // other person goes to it, with its place, and it does not flash.
  expect(patch).toHaveBeenCalledExactlyOnceWith(
    [{ in: 0, after: null, before: null, html: "Try this.", marks: [[4, 8]] }],
    0,
    false,
    false,
  );
  expect(frameShows).toHaveBeenCalledExactlyOnceWith(3, "ver_1");
  expect(holdUpdate).toHaveBeenLastCalledWith(undefined);
  expect(reload).not.toHaveBeenCalled();

  // The next operation is on top of the merged head.
  edit.mockResolvedValueOnce(sent(4));
  await type("Try it now!");
  expect(edit.mock.lastCall![1]).toMatchObject({
    base_seq: 3,
    replacements: [{ start: 26, end: 30, old_html: "now.", new_html: "now!" }],
  });
  expect(frameShows).toHaveBeenLastCalledWith(4, "ver_1");
});

it("sends the text typed during a merged operation on the head that holds that operation", async () => {
  const { type, frame, patch, frameShows } = setup();
  const edit = vi.spyOn(api, "sendOps").mockImplementationOnce(async () => {
    frame.regions = [second("Try it now, please.")];
    frame.edits = 1;
    return sent(3, merged);
  });
  edit.mockResolvedValueOnce(sent(4));
  // The frame does not answer for the patch in time: the words typed
  // meanwhile still go out on the merged head, at their place in it.
  patch.mockRejectedValue(new Error("The document did not answer."));

  await type("Try it now.");
  await act(() => vi.advanceTimersByTimeAsync(50));

  expect(edit).toHaveBeenCalledTimes(2);
  expect(edit.mock.lastCall![1]).toMatchObject({
    base_seq: 3,
    replacements: [{ start: 26, end: 30, old_html: "now.", new_html: "now, please." }],
  });
  expect(frameShows).not.toHaveBeenCalledWith(3, "ver_1");
});

it("sends the keys that came while the frame did not answer for a patch", async () => {
  const { type, frame, patch } = setup();
  const edit = vi
    .spyOn(api, "sendOps")
    .mockResolvedValueOnce(sent(3, merged))
    .mockResolvedValueOnce(sent(4));
  // The reader types on while the frame takes the patch, and the frame
  // does not answer for it.
  patch.mockImplementation(async () => {
    frame.regions = [second("Try it now, please.")];
    frame.edits = 1;
    throw new Error("The document did not answer.");
  });

  await type("Try it now.");

  expect(edit).toHaveBeenCalledTimes(2);
  expect(edit.mock.lastCall![1]).toMatchObject({
    base_seq: 3,
    replacements: [{ start: 26, end: 30, old_html: "now.", new_html: "now, please." }],
  });
});

it("sends only the keys that are surely the reader's, and loads again, when the frame showed a patch that it did not answer for", async () => {
  const { type, frame, patch, reload } = setup();
  const edit = vi
    .spyOn(api, "sendOps")
    .mockResolvedValueOnce(sent(3, merged))
    .mockResolvedValueOnce(sent(4));
  // The frame shows the text of the other person, and the reader types on,
  // but the frame does not answer for the patch.
  patch.mockImplementation(async () => {
    frame.regions = [first("Try this."), second("Try it now, please.")];
    frame.edits = 1;
    throw new Error("The document did not answer.");
  });

  await type("Try it now.");

  // The text of the other person goes in one time: it is not the reader's.
  expect(edit).toHaveBeenCalledTimes(2);
  expect(edit.mock.lastCall![1]).toMatchObject({
    base_seq: 3,
    replacements: [{ start: 26, end: 30, old_html: "now.", new_html: "now, please." }],
  });
  expect(reload).toHaveBeenCalledOnce();
});

describe("an answer that does not make the source of the server", () => {
  const wrong = [
    [
      "operations that do not fit",
      { others: [[{ start: 0, end: 3, old_html: "<h1", new_html: "<h2" }]] },
    ],
    ["another sum", { sum: SUM + 1 }],
  ] as const;

  it.each(wrong)(
    "takes the live document as the head, and shows it in place (%s)",
    async (_name, answer) => {
      const send = vi
        .spyOn(api, "sendOps")
        .mockResolvedValue({ ...sent(3, merged), ...answer } as never);
      const get = live(MERGED, 3);
      const { type, patch, patched, frameShows, reload, setState } = setup();
      patched([first("Try this."), second("Try it now.")]);

      await type("Try it now.");

      expect(get).toHaveBeenCalledExactlyOnceWith("doc_1", "ver_1");
      // The server holds the text of the reader: only the text of the
      // other person goes into the frame, and nothing goes again. The
      // operations that made the live document are not known: the change
      // flashes, and has no marks.
      expect(patch).toHaveBeenCalledExactlyOnceWith(
        [{ in: 0, after: null, before: null, html: "Try this." }],
        0,
        true,
        false,
      );
      expect(frameShows).toHaveBeenCalledExactlyOnceWith(3, "ver_1");
      expect(send).toHaveBeenCalledOnce();
      expect(setState.mock.calls.every(([state]) => state === "idle")).toBe(true);
      expect(reload).not.toHaveBeenCalled();
    },
  );

  // The reader types on while the operation is on its way.
  const typesOn = (view: ReturnType<typeof setup>, answers: object[]) => {
    const send = vi.spyOn(api, "sendOps").mockImplementationOnce(async () => {
      view.frame.regions = [second("Try it now, please.")];
      view.result.current.changed();
      return answers[0] as never;
    });
    for (const answer of answers.slice(1)) send.mockResolvedValueOnce(answer as never);
    return send;
  };

  it("sends the text that the reader typed meanwhile on the live document", async () => {
    const view = setup();
    const send = typesOn(view, [{ ...sent(3, merged), sum: SUM + 1 }, sent(4)]);
    live(MERGED, 3);

    await view.type("Try it now.");
    await act(() => vi.advanceTimersByTimeAsync(100));

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.lastCall![1]).toMatchObject({
      base_seq: 3,
      replacements: [
        { start: 26, end: 30, old_html: "now.", new_html: "now, please." },
      ],
    });
    expect(view.setState.mock.calls.every(([state]) => state === "idle")).toBe(true);
  });

  it("loads the document again, and never says that the text cannot save, when the live document does not fit either", async () => {
    const error = vi.spyOn(toast, "error");
    const view = setup();
    const lost = { ...sent(3, merged), sum: SUM + 1 };
    const send = typesOn(view, [lost, lost]);
    const get = live(MERGED, 3);
    view.patched([first("Try this."), second("Try it now, please.")]);

    await view.type("Try it now.");
    await act(() => vi.advanceTimersByTimeAsync(100));

    // The server took both operations: the frame loads the document with
    // the text, and nothing goes again.
    expect(send).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(2);
    expect(view.reload).toHaveBeenCalledOnce();
    expect(view.setState.mock.calls.every(([state]) => state === "idle")).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });

  it("sends the text typed during the second answer on the live document before the frame loads again", async () => {
    const view = setup();
    const lost = { ...sent(3, merged), sum: SUM + 1 };
    const send = typesOn(view, [lost]);
    send.mockImplementationOnce(async () => {
      view.frame.regions = [first("Try this."), second("Try it now, please!")];
      view.result.current.changed();
      return lost as never;
    });
    send.mockResolvedValueOnce(sent(5));
    // The live document holds the second operation when it is read again.
    const PLEASE = "<p>Try this.</p><p>Try it now, please.</p>";
    live(MERGED, 3)
      .mockResolvedValueOnce({ source: MERGED, seq: 3 })
      .mockResolvedValueOnce({
        source: PLEASE,
        seq: 4,
      });
    view.patched([first("Try this."), second("Try it now, please.")]);

    await view.type("Try it now.");
    await act(() => vi.advanceTimersByTimeAsync(100));

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.lastCall![1]).toMatchObject({
      base_seq: 4,
      replacements: sourceEdits.replacementsBetween(
        PLEASE,
        PLEASE.replace("please.", "please!"),
      ),
    });
    expect(view.reload).toHaveBeenCalledOnce();
    expect(view.setState.mock.calls.every(([state]) => state === "idle")).toBe(true);
  });
});

it("applies the operations of other people in order", async () => {
  const BOTH = "<p>Try this.</p><p>Try it too.</p>";
  vi.spyOn(api, "documentChanges").mockResolvedValue({
    ...changes(3, SOURCE, THEIRS),
    ops: [
      sourceEdits.replacementsBetween(SOURCE, THEIRS),
      sourceEdits.replacementsBetween(THEIRS, BOTH),
    ],
  });
  const send = vi.spyOn(api, "sendOps").mockResolvedValue(sent(4));
  const { patch, patched, frameShows, type } = setup({ latest: 3 });
  patched([first("Try this."), second("Try it too.")]);

  await act(() => vi.advanceTimersByTimeAsync(0));

  expect(patch.mock.lastCall![0]).toEqual([
    { in: 0, after: null, before: null, html: "Try this.", marks: [[4, 8]] },
    { in: 14, after: null, before: null, html: "Try it too.", marks: [[6, 10]] },
  ]);
  expect(frameShows).toHaveBeenCalledExactlyOnceWith(3, "ver_1");
  // The head is the source after the last operation.
  await type("Try it too!");
  expect(send.mock.lastCall![1]).toMatchObject({
    base_seq: 3,
    replacements: [{ start: 26, end: 30, old_html: "too.", new_html: "too!" }],
  });
});

it("merges the text of the reader over each operation of the answer, in order", async () => {
  // Another person typed in the first paragraph, twice.
  const ONE = "<p>Try this.</p><p>Try it now.</p>";
  const TWO = "<p>Try this now.</p><p>Try it now.</p>";
  const { type, frame, patch, result } = setup();
  // The reader types on while the operation is on its way.
  const send = vi.spyOn(api, "sendOps").mockImplementationOnce(async () => {
    frame.regions = [second("Try it now!")];
    result.current.changed();
    return {
      ...sent(4),
      others: [
        sourceEdits.replacementsBetween(MINE, ONE),
        sourceEdits.replacementsBetween(ONE, TWO),
      ],
    };
  });
  send.mockResolvedValue(sent(5));
  patch.mockImplementationOnce(async () => {
    frame.regions = [first("Try this now."), second("Try it now!")];
    return { ...frame, ok: true, stale: false };
  });

  await type("Try it now.");
  await act(() => vi.advanceTimersByTimeAsync(100));

  expect(patch.mock.calls[0][0]).toEqual([
    { in: 0, after: null, before: null, html: "Try this now.", marks: [[4, 12]] },
  ]);
  expect(send.mock.lastCall![1]).toMatchObject({
    base_seq: 4,
    replacements: [{ start: 30, end: 34, old_html: "now.", new_html: "now!" }],
  });
});

describe("an operation that comes with its event", () => {
  const event = (prev_seq: number, seq: number, from: string, to: string) => ({
    seq,
    version_id: "ver_1",
    prev_seq,
    changes: changes(seq, from, to),
  });

  it("goes into the frame with no request when it is on the head", async () => {
    const get = vi.spyOn(api, "documentChanges");
    const { patched, frameShows, rerender } = setup();
    patched([first("Try this.")]);

    // The event comes before the page knows the new seq.
    rerender({ event: event(1, 2, SOURCE, THEIRS) });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(get).not.toHaveBeenCalled();
    expect(frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
  });

  it("asks for the changes when the event is not on the head", async () => {
    const get = vi
      .spyOn(api, "documentChanges")
      .mockResolvedValue(changes(3, SOURCE, MERGED));
    const { patched, frameShows, rerender } = setup();
    patched([first("Try this."), second("Try it now.")]);

    // This client did not get the event of seq 2.
    rerender({ event: event(2, 3, THEIRS, MERGED), latest: 3 });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(get).toHaveBeenCalledExactlyOnceWith("doc_1", 1);
    expect(frameShows).toHaveBeenCalledExactlyOnceWith(3, "ver_1");
  });
});

describe("a seq that the server no longer has", () => {
  const stale = new APIError(409, "stale", "pull again");

  it("takes the live document as the head when the changes are gone", async () => {
    vi.spyOn(api, "documentChanges").mockRejectedValue(stale);
    const get = live(THEIRS, 2);
    const { patch, patched, frameShows, reload } = setup({ latest: 2 });
    patched([first("Try this.")]);

    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(api.documentChanges).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledOnce();
    expect(patch).toHaveBeenCalledExactlyOnceWith(
      [{ in: 0, after: null, before: null, html: "Try this." }],
      0,
      true,
      false,
    );
    expect(frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
    expect(reload).not.toHaveBeenCalled();
  });

  it("loads the document again when the loaded source is gone", async () => {
    vi.mocked(api.versionSource).mockRejectedValue(stale);
    const { reload } = setup({ latest: 2 });

    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(reload).toHaveBeenCalledOnce();
  });

  it("merges the text of a person who comes back after a long time offline, and sends it on the new seq", async () => {
    const error = vi.spyOn(toast, "error");
    // The network is down, then the server no longer has the seq of the
    // reader, and other people wrote meanwhile.
    const send = vi
      .spyOn(api, "sendOps")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(stale)
      .mockResolvedValueOnce(sent(8));
    live(THEIRS, 7);
    const { type, patch, patched, frameShows, reload, setState } = setup();
    patched([first("Try this."), second("Try it now.")]);

    await type("Try it now.");
    await act(() => vi.advanceTimersByTimeAsync(5000));

    // The text goes on the live document, at its place in it.
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.lastCall![1]).toMatchObject({
      base_seq: 7,
      replacements: [{ start: 23, end: 26, old_html: "it.", new_html: "it now." }],
    });
    expect(send.mock.lastCall![1].client_op_id).not.toBe(
      send.mock.calls[0][1].client_op_id,
    );
    // The text of the other people goes into the frame, around it.
    expect(patch).toHaveBeenCalledExactlyOnceWith(
      [{ in: 0, after: null, before: null, html: "Try this." }],
      0,
      true,
      false,
    );
    expect(frameShows).toHaveBeenLastCalledWith(8, "ver_1");
    expect(setState.mock.calls.every(([state]) => state === "idle")).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(kept()).toBeUndefined();
  });

  it("tries again when the live document does not come", async () => {
    const send = vi
      .spyOn(api, "sendOps")
      .mockRejectedValueOnce(stale)
      .mockResolvedValueOnce(sent(8));
    // Neither the follow nor the send gets the live document at first.
    const get = live(THEIRS, 7)
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { type, setState } = setup();

    await type("Try it now.");
    expect(send).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(get).toHaveBeenCalledTimes(3);
    expect(send.mock.lastCall![1].base_seq).toBe(7);
    expect(setState.mock.calls.every(([state]) => state === "idle")).toBe(true);
  });

  it("keeps the text of the reader, with Copy my text, only when the live document is refused too", async () => {
    const error = vi.spyOn(toast, "error");
    const send = vi.spyOn(api, "sendOps").mockRejectedValue(stale);
    live(THEIRS, 7);
    const { type, patched, reload, setState } = setup();
    patched([first("Try this."), second("Try it now.")]);

    await type("Try it now.");

    expect(send).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
    expect(setState).toHaveBeenLastCalledWith("refused");
    expect(error).toHaveBeenLastCalledWith(
      "This edit no longer fits the document, so it cannot save.",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Copy my text" }),
      }),
    );
  });
});

it("patches again when a key came between the take and the patch", async () => {
  vi.spyOn(api, "documentChanges").mockResolvedValue(changes(2, SOURCE, THEIRS));
  const edit = vi.spyOn(api, "sendOps").mockResolvedValue(sent(3));
  const { frame, patch, patched, frameShows } = setup({ latest: 2 });
  patch.mockImplementationOnce(async () => {
    frame.regions = [second("Try it now.")];
    frame.edits = 1;
    return { ...frame, ok: false, stale: true };
  });
  patched([first("Try this."), second("Try it now.")]);

  await act(() => vi.advanceTimersByTimeAsync(0));

  expect(patch).toHaveBeenCalledTimes(2);
  expect(patch.mock.lastCall!.slice(1)).toEqual([1, false, false]);
  expect(frameShows).toHaveBeenCalledWith(2, "ver_1");
  // The frame holds the key: it goes out in the same run.
  expect(edit).toHaveBeenCalledExactlyOnceWith(
    "doc_1",
    expect.objectContaining({
      base_seq: 2,
      replacements: [{ start: 23, end: 26, old_html: "it.", new_html: "it now." }],
    }),
  );
});

it("tries the patch again a moment later when the keys do not stop", async () => {
  vi.spyOn(api, "documentChanges").mockResolvedValue(changes(2, SOURCE, THEIRS));
  const { frame, patch, patched, frameShows, reload } = setup({ latest: 2 });
  patch.mockImplementation(async () => ({ ...frame, ok: false, stale: true }));

  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(patch).toHaveBeenCalledTimes(4);

  patch.mockReset();
  patched([first("Try this.")]);
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
  // The frame did not load again: a stale patch is not a failed patch.
  expect(reload).not.toHaveBeenCalled();
});

it.each([
  ["refuses the patch", { ok: false }],
  ["does not show the target after the patch", { ok: true }],
])("loads the document again when the frame of an editor %s", async (_name, { ok }) => {
  vi.spyOn(api, "documentChanges").mockResolvedValue(changes(2, SOURCE, THEIRS));
  const { frame, patch, frameShows, reload } = setup({ latest: 2 });
  patch.mockImplementation(async () => ({ ...frame, ok, stale: false }));

  await act(() => vi.advanceTimersByTimeAsync(0));

  expect(frameShows).not.toHaveBeenCalled();
  expect(reload).toHaveBeenCalledExactlyOnceWith();
});

describe("a reader whose frame shows what its regions cannot write", () => {
  // A push adds text in a form that the regions do not give back, as a
  // table does: the frame applies the patch, and its regions stay as before.
  const pushed = () => {
    const get = vi
      .spyOn(api, "documentChanges")
      .mockResolvedValue(changes(2, SOURCE, THEIRS, false));
    const view = setup({ latest: 2, editing: false });
    view.patch.mockImplementation(async () => ({
      ...view.frame,
      ok: true,
      stale: false,
    }));
    return { ...view, get };
  };

  it("stays as it is, moves to the new seq, and takes the next change with no load", async () => {
    const { get, patch, frameShows, reload, rerender } = pushed();
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
    expect(reload).not.toHaveBeenCalled();

    // The next patch holds every change since the load: the frame changes
    // nothing where it already shows one.
    get.mockResolvedValue(changes(3, THEIRS, MERGED));
    rerender({ latest: 3 });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(patch).toHaveBeenLastCalledWith(
      [
        { in: 0, after: null, before: null, html: "Try this." },
        { in: 14, after: null, before: null, html: "Try it now.", marks: [[6, 10]] },
      ],
      0,
      false,
      false,
    );
    expect(frameShows).toHaveBeenLastCalledWith(3, "ver_1");
    expect(reload).not.toHaveBeenCalled();
  });

  it("loads the document again once, when Edit mode starts", async () => {
    const { reload, rerender } = pushed();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(reload).not.toHaveBeenCalled();

    rerender({ editing: true });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(reload).toHaveBeenCalledOnce();
  });

  it("loads the document again, and sends nothing, when a change comes from the frame", async () => {
    const send = vi.spyOn(api, "sendOps");
    const { reload, key } = pushed();
    await act(() => vi.advanceTimersByTimeAsync(0));

    await key();

    expect(reload).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("starts over on a new load", async () => {
    const send = vi.spyOn(api, "sendOps").mockResolvedValue(sent(3));
    const { reload, rerender, type } = pushed();
    await act(() => vi.advanceTimersByTimeAsync(0));

    rerender({ loaded: { version: "ver_1", seq: 2, url: "/render/1" }, editing: true });
    await type("Try it now.");

    expect(reload).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });
});

describe("a frame that loads itself again", () => {
  // The frame of a reader shows the text of another person at seq 2.
  const reading = async () => {
    const get = vi
      .spyOn(api, "documentChanges")
      .mockResolvedValue(changes(2, SOURCE, THEIRS));
    const send = vi.spyOn(api, "sendOps").mockResolvedValue(sent(4));
    const view = setup({ latest: 2, editing: false });
    view.patched([first("Try this.")]);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(view.frameShows).toHaveBeenLastCalledWith(2, "ver_1");
    // A script of the document loads it again: the frame shows the source
    // of seq 1, with no text of the other person.
    view.frame.regions = [];
    return { ...view, get, send };
  };

  it("starts over from the loaded seq, so that what the frame shows is never an edit of the reader", async () => {
    const { result, send, patch, patched, get, frameShows } = await reading();
    for (const mock of [patch, get, frameShows]) mock.mockClear();
    patched([first("Try this.")]);

    act(() => result.current.restarted());
    await act(() => vi.advanceTimersByTimeAsync(5000));

    // The frame shows seq 1 again, and gets the text of the other person
    // again.
    expect(frameShows.mock.calls).toEqual([
      [1, "ver_1"],
      [2, "ver_1"],
    ]);
    expect(get).toHaveBeenCalledExactlyOnceWith("doc_1", 1);
    expect(patch).toHaveBeenCalledExactlyOnceWith(
      [{ in: 0, after: null, before: null, html: "Try this.", marks: [[4, 8]] }],
      0,
      false,
      false,
    );
    expect(send).not.toHaveBeenCalled();
  });

  it("takes nothing more from the frame for the load that ended", async () => {
    const { result, send, take, key } = await reading();
    take.mockClear();

    // The frame tells of a change before the page starts the next load.
    act(() => {
      result.current.restarted();
      result.current.changed({ regions: [], scripts: [], edits: 0 });
    });
    await key();

    expect(send).not.toHaveBeenCalled();
  });

  it("never sends an operation for a reader who is not in Edit mode and typed nothing", async () => {
    // The page did not learn that the frame loaded again.
    const { send, get, patch, frame, key, rerender } = await reading();
    patch.mockImplementation(async () => ({ ...frame, ok: true, stale: false }));

    await key();
    get.mockResolvedValue(changes(3, THEIRS, MERGED));
    rerender({ latest: 3 });
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(send).not.toHaveBeenCalled();
  });

  it("sends the last draft of an editor, with no answer of the frame", async () => {
    const send = vi.spyOn(api, "sendOps").mockResolvedValue(sent(2));
    const { result, take } = setup();
    await act(() => vi.advanceTimersByTimeAsync(0));
    act(() => {
      result.current.changed({
        regions: [second("Try it now.")],
        scripts: [],
        edits: 1,
      });
    });

    act(() => result.current.restarted());
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(take).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      "doc_1",
      expect.objectContaining({
        replacements: [{ start: 21, end: 24, old_html: "it.", new_html: "it now." }],
      }),
    );
  });
});

it("loads the document again for a reader whose frame does not answer, and never says that text is not saved", async () => {
  vi.spyOn(api, "documentChanges").mockResolvedValue(changes(2, SOURCE, THEIRS));
  const send = vi.spyOn(api, "sendOps");
  const { take, reload, setState } = setup({ latest: 2, editing: false });
  take.mockRejectedValue(new Error("The document did not answer."));

  await act(() => vi.advanceTimersByTimeAsync(60_000));

  expect(reload).toHaveBeenCalledOnce();
  expect(take).toHaveBeenCalledOnce();
  expect(send).not.toHaveBeenCalled();
  expect(setState.mock.calls.every(([state]) => state === "idle")).toBe(true);
});

it("never sends the text of a patch that did not make its target", async () => {
  const edit = vi.spyOn(api, "sendOps").mockResolvedValue(sent(3, merged));
  const { frame, type, patch, reload } = setup();
  // The patch leaves other text in the frame.
  patch.mockImplementation(async () => {
    frame.regions = [first("Try what?"), second("Try it now.")];
    return { ...frame, ok: true, stale: false };
  });

  await type("Try it now.");
  await act(() => vi.advanceTimersByTimeAsync(1));

  expect(edit).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledExactlyOnceWith();
});

it("sends the text on screen before it loads a head that the frame cannot show", async () => {
  const order: string[] = [];
  vi.spyOn(api, "sendOps").mockImplementation(async () => {
    order.push("send");
    return sent(3, merged);
  });
  const { frame, type, patch, reload } = setup();
  patch.mockImplementation(async () => ({ ...frame, ok: false, stale: false }));
  reload.mockImplementation(() => order.push("load"));

  await type("Try it now.");
  // The send after the follow starts on the next tick.
  await act(() => vi.advanceTimersByTimeAsync(1));

  expect(order).toEqual(["send", "load"]);
  expect(reload).toHaveBeenCalledExactlyOnceWith();
});

it("shows live typing of another person to a reader in place, with no banner", async () => {
  const get = vi
    .spyOn(api, "documentChanges")
    .mockResolvedValue(changes(2, SOURCE, THEIRS));
  const { patch, patched, frameShows, holdUpdate, rerender } = setup();
  patched([first("Try this.")]);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(get).not.toHaveBeenCalled();

  rerender({ latest: 2 });
  await act(() => vi.advanceTimersByTimeAsync(0));

  expect(patch).toHaveBeenCalledExactlyOnceWith(
    [{ in: 0, after: null, before: null, html: "Try this.", marks: [[4, 8]] }],
    0,
    false,
    false,
  );
  expect(frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
  expect(holdUpdate).not.toHaveBeenCalledWith(expect.anything());

  // The next change comes from the new head.
  get.mockResolvedValue(changes(3, THEIRS, MERGED));
  patched([first("Try this."), second("Try it now.")]);
  rerender({ latest: 3 });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(get).toHaveBeenLastCalledWith("doc_1", 2);
  expect(frameShows).toHaveBeenLastCalledWith(3, "ver_1");
});

describe("a word that another person typed and took out again", () => {
  const TYPED = SOURCE.replace("Try it.", "Try it now.");

  it.each([true, false])(
    "goes out of the frame again, with no load (Edit mode: %s)",
    async (editing) => {
      const get = vi
        .spyOn(api, "documentChanges")
        .mockResolvedValue(changes(2, SOURCE, TYPED));
      const { patch, patched, frameShows, reload, rerender } = setup({ editing });
      patched([first("Try it now.")]);
      rerender({ latest: 2 });
      await act(() => vi.advanceTimersByTimeAsync(0));

      get.mockResolvedValue(changes(3, TYPED, SOURCE));
      patched([first("Try it.")]);
      rerender({ latest: 3 });
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(patch).toHaveBeenLastCalledWith(
        [{ in: 0, after: null, before: null, html: "Try it." }],
        0,
        false,
        false,
      );
      expect(frameShows).toHaveBeenLastCalledWith(3, "ver_1");
      expect(reload).not.toHaveBeenCalled();
    },
  );
});

it("does not follow a preview, or a frame that is not ready", async () => {
  const get = vi.spyOn(api, "documentChanges");
  setup({ latest: 2, live: false } as never);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(get).not.toHaveBeenCalled();
});

it("flashes a small change that is not live typing", async () => {
  vi.spyOn(api, "documentChanges").mockResolvedValue(changes(2, SOURCE, THEIRS, false));
  const { patch, patched, holdUpdate } = setup({ latest: 2, editing: false });
  patched([first("Try this.")]);

  await act(() => vi.advanceTimersByTimeAsync(0));

  // The frame is asked: it holds a change that the reader would see as more
  // than a small one. This one it takes.
  expect(patch).toHaveBeenCalledExactlyOnceWith(expect.anything(), 0, true, true);
  expect(holdUpdate).not.toHaveBeenCalledWith(expect.anything());
});

describe("a change that is not live typing", () => {
  const words = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
  const LARGE = `<p>${words}</p><p>Try it.</p>`;

  it("waits behind the banner when the frame holds it, and the frame stays as it is", async () => {
    vi.spyOn(api, "documentChanges").mockResolvedValue(
      changes(2, SOURCE, LARGE, false),
    );
    const { frame, patch, frameShows, reload, holdUpdate } = setup({
      latest: 2,
      editing: false,
    });
    // The change would change much of what the reader sees.
    patch.mockImplementation(async () => ({
      ...frame,
      ok: false,
      stale: false,
      withdrawn: true,
    }));

    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(patch).toHaveBeenCalledExactlyOnceWith(expect.anything(), 0, true, true);
    expect(holdUpdate).toHaveBeenLastCalledWith({ authors: [asha] });
    expect(frameShows).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("names on the banner only the people whose changes wait, not those who typed in the same changes", async () => {
    const admin = { type: "user" as const, id: "usr_admin", name: "admin" };
    vi.spyOn(api, "documentChanges").mockResolvedValue({
      ...changes(2, SOURCE, LARGE, false),
      authors: [asha, admin],
    });
    const { patch, holdUpdate, madeBy } = setup({ latest: 2, editing: false });
    madeBy.mockImplementation((after, upto) =>
      after === 1 && upto === 2 ? [admin] : undefined,
    );
    patch.mockResolvedValue({
      ok: false,
      stale: false,
      withdrawn: true,
    } as TextPatchResult);

    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(holdUpdate).toHaveBeenLastCalledWith({ authors: [admin] });
  });

  it("names nobody on the banner when the events named only typing there", async () => {
    vi.spyOn(api, "documentChanges").mockResolvedValue(
      changes(2, SOURCE, LARGE, false),
    );
    const { patch, holdUpdate, madeBy } = setup({ latest: 2, editing: false });
    madeBy.mockReturnValue([]);
    patch.mockResolvedValue({
      ok: false,
      stale: false,
      withdrawn: true,
    } as TextPatchResult);

    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(holdUpdate).toHaveBeenLastCalledWith({ authors: [] });
  });

  // The frame holds each change that asks.
  const waiting = async (props: { editing: boolean }) => {
    vi.spyOn(api, "documentChanges").mockResolvedValue(
      changes(2, SOURCE, LARGE, false),
    );
    const view = setup({ latest: 2, ...props });
    view.patch.mockImplementation(async (_patches, _edits, _flash, ask) => {
      if (!ask) view.frame.regions = [first(words)];
      return { ...view.frame, ok: !ask, stale: false, withdrawn: ask };
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    return view;
  };
  const hide = (state: DocumentVisibilityState) => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(state);
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
  };

  it("shows the change in place, where the reader is, when the reader asks for the latest", async () => {
    const { result, patch, frameShows, reload, holdUpdate } = await waiting({
      editing: false,
    });
    expect(holdUpdate).toHaveBeenLastCalledWith({ authors: [asha] });

    await act(() => result.current.showUpdate());

    // The frame is not asked this time: the change goes in, with no load.
    expect(patch).toHaveBeenLastCalledWith(expect.anything(), 0, true, false);
    expect(holdUpdate).toHaveBeenLastCalledWith(undefined);
    expect(frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
    expect(reload).not.toHaveBeenCalled();
  });

  it("holds the next change again after the reader saw the latest", async () => {
    const { result, patch, rerender, holdUpdate } = await waiting({ editing: false });
    await act(() => result.current.showUpdate());

    vi.mocked(api.documentChanges).mockResolvedValue({
      ...changes(3, LARGE, SOURCE, false),
    });
    rerender({ latest: 3 });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(patch).toHaveBeenLastCalledWith(expect.anything(), 0, true, true);
    expect(holdUpdate).toHaveBeenLastCalledWith({ authors: [asha] });
  });

  it("loads the document again, once, when the latest cannot go in in place", async () => {
    vi.spyOn(api, "documentChanges").mockResolvedValue(
      changes(2, SOURCE, `${SOURCE}<script>go()</script>`, false),
    );
    const { result, reload, holdUpdate } = setup({ latest: 2, editing: false });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(holdUpdate).toHaveBeenLastCalledWith({ authors: [asha] });

    await act(() => result.current.showUpdate());
    await act(() => result.current.showUpdate());

    expect(reload).toHaveBeenCalledOnce();
  });

  it("keeps the frame when the changes do not come, and tries again", async () => {
    const { result, reload, frameShows } = await waiting({ editing: false });
    vi.mocked(api.documentChanges).mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );

    await act(() => result.current.showUpdate());
    expect(reload).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
    expect(reload).not.toHaveBeenCalled();
  });

  it("shows the latest in place when the tab hides while it waits, or when Edit mode starts", async () => {
    const hidden = await waiting({ editing: false });
    hide("hidden");
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(hidden.frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
    expect(hidden.reload).not.toHaveBeenCalled();
    hidden.hook.unmount();
    hide("visible");

    const edited = await waiting({ editing: false });
    expect(edited.frameShows).not.toHaveBeenCalled();
    edited.rerender({ editing: true });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(edited.frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
    expect(edited.reload).not.toHaveBeenCalled();
  });

  it("applies a change that the frame held, when Edit mode started before the answer", async () => {
    vi.spyOn(api, "documentChanges").mockResolvedValue(
      changes(2, SOURCE, LARGE, false),
    );
    const view = setup({ latest: 2, editing: false });
    // The frame measures the change, and holds it.
    let answer = () => {};
    view.patch.mockImplementationOnce(
      () =>
        new Promise((done) => {
          answer = () =>
            done({ ...view.frame, ok: false, stale: false, withdrawn: true });
        }),
    );
    view.patched([first(words)]);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(view.patch).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      0,
      true,
      true,
    );

    // Edit mode starts before the frame answers.
    view.rerender({ editing: true });
    answer();
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(view.patch).toHaveBeenCalledTimes(2);
    expect(view.patch).toHaveBeenLastCalledWith(expect.anything(), 0, true, false);
    expect(view.frameShows).toHaveBeenCalledWith(2, "ver_1");
    expect(view.holdUpdate).not.toHaveBeenCalledWith(expect.anything());
  });

  it("asks the frame again when the reader scrolled, at most once in a second, and removes the banner when the frame takes the change", async () => {
    const { frame, result, patch, frameShows, holdUpdate } = await waiting({
      editing: false,
    });
    patch.mockClear();

    // The scroll rests two times in one second.
    act(() => result.current.scrolled());
    await act(() => vi.advanceTimersByTimeAsync(500));
    act(() => result.current.scrolled());
    await act(() => vi.advanceTimersByTimeAsync(499));
    expect(patch).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1));
    // The reader still reads the text that changed: the banner stays.
    expect(patch).toHaveBeenCalledExactlyOnceWith(expect.anything(), 0, true, true);
    expect(holdUpdate).toHaveBeenLastCalledWith({ authors: [asha] });
    expect(frameShows).not.toHaveBeenCalled();

    // The reader is far from the change now: the frame takes it.
    patch.mockImplementation(async () => {
      frame.regions = [first(words)];
      return { ...frame, ok: true, stale: false };
    });
    act(() => result.current.scrolled());
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(patch).toHaveBeenLastCalledWith(expect.anything(), 0, true, true);
    expect(frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
    expect(holdUpdate).toHaveBeenLastCalledWith(undefined);

    // Nothing waits: a scroll asks for nothing.
    patch.mockClear();
    act(() => result.current.scrolled());
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(patch).not.toHaveBeenCalled();
  });

  it("never waits in Edit mode", async () => {
    const { patch, frameShows, holdUpdate } = await waiting({ editing: true });

    expect(patch).toHaveBeenCalledExactlyOnceWith(expect.anything(), 0, true, false);
    expect(frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
    expect(holdUpdate).not.toHaveBeenCalledWith(expect.anything());
  });

  it("never waits in a tab that the reader does not see", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const { patch, frameShows, holdUpdate } = await waiting({ editing: false });

    expect(patch).toHaveBeenCalledExactlyOnceWith(expect.anything(), 0, true, false);
    expect(frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
    expect(holdUpdate).not.toHaveBeenCalledWith(expect.anything());
  });

  it("loads the document again in a hidden tab when the change needs a load", async () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    vi.spyOn(api, "documentChanges").mockResolvedValue(
      changes(2, SOURCE, `${SOURCE}<script>go()</script>`, false),
    );
    const { reload, holdUpdate } = setup({ latest: 2, editing: false });

    await act(() => vi.advanceTimersByTimeAsync(1));

    expect(holdUpdate).not.toHaveBeenCalledWith(expect.anything());
    expect(reload).toHaveBeenCalledOnce();
  });

  it("waits behind the banner when it needs a load of the frame", async () => {
    vi.spyOn(api, "documentChanges").mockResolvedValue(
      changes(2, SOURCE, `${SOURCE}<script>go()</script>`, false),
    );
    const { patch, frameShows, reload, holdUpdate } = setup({
      latest: 2,
      editing: false,
    });

    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(holdUpdate).toHaveBeenLastCalledWith({ authors: [asha] });
    expect(patch).not.toHaveBeenCalled();
    expect(frameShows).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("applies when the frame holds text that the server does not hold", async () => {
    vi.spyOn(api, "sendOps").mockResolvedValue(sent(3));
    vi.spyOn(api, "documentChanges").mockResolvedValue(
      changes(2, SOURCE, `<p>${words}</p><p>Try it.</p>`, false),
    );
    const { frame, patched, frameShows, holdUpdate, rerender } = setup();
    patched([first(words), second("Try it now.")]);

    // The reader typed, and the change came before the text went out.
    frame.regions = [second("Try it now.")];
    rerender({ latest: 2 });
    await act(() => vi.advanceTimersByTimeAsync(0));

    // The change goes in around the text of the reader, which then goes out.
    expect(holdUpdate).not.toHaveBeenCalledWith(expect.anything());
    expect(frameShows).toHaveBeenCalledWith(2, "ver_1");
    expect(api.sendOps).toHaveBeenCalledOnce();
    expect(vi.mocked(api.sendOps).mock.lastCall![1].base_seq).toBe(2);
  });
});

describe("typing of other people while a change waits behind the banner", () => {
  const PUSHED = "<p>Try it now please.</p><p>Try it.</p>";
  // The frame holds each change that asks, and applies each patch that a
  // test gives with patched.
  const holding = async () => {
    const get = vi
      .spyOn(api, "documentChanges")
      .mockResolvedValue(changes(2, SOURCE, PUSHED, false));
    const sendOps = vi.spyOn(api, "sendOps");
    const view = setup({ latest: 2, editing: false });
    view.patch.mockImplementation(async () => ({
      ...view.frame,
      ok: false,
      stale: false,
      withdrawn: true,
    }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(view.holdUpdate).toHaveBeenLastCalledWith({ authors: [asha] });
    // The next change of the document comes at seq.
    const comes = async (seq: number, from: string, to: string, typed = true) => {
      get.mockResolvedValue(changes(seq, from, to, typed));
      view.rerender({ latest: seq });
      await act(() => vi.advanceTimersByTimeAsync(0));
    };
    return { ...view, comes, sendOps };
  };

  it("shows the typing at once, without the change that waits, and both when the reader asks for the latest", async () => {
    const { comes, patch, patched, frameShows, holdUpdate, result, sendOps } =
      await holding();

    patched([second("Try it again.")]);
    await comes(3, PUSHED, "<p>Try it now please.</p><p>Try it again.</p>");

    // The typing goes in as typing: no ask, no flash, and the banner stays.
    expect(patch).toHaveBeenLastCalledWith(
      [{ in: 14, after: null, before: null, html: "Try it again.", marks: [[6, 12]] }],
      0,
      false,
      false,
    );
    expect(holdUpdate).toHaveBeenLastCalledWith({ authors: [asha] });
    expect(frameShows).not.toHaveBeenCalled();

    patched([first("Try it now please."), second("Try it again.")]);
    await act(() => result.current.showUpdate());

    expect(patch).toHaveBeenLastCalledWith(
      [{ in: 0, after: null, before: null, html: "Try it now please." }],
      0,
      true,
      false,
    );
    expect(holdUpdate).toHaveBeenLastCalledWith(undefined);
    expect(frameShows).toHaveBeenCalledExactlyOnceWith(3, "ver_1");
    // What the frame showed in place of the head is never an edit.
    expect(sendOps).not.toHaveBeenCalled();
  });

  it("holds a second change that is not typing too, and shows typing on the frame without both", async () => {
    const { comes, patch, patched, frameShows, holdUpdate, result } = await holding();
    const SECOND = "<p>Try it now please.</p><p>Do it.</p>";

    await comes(3, PUSHED, SECOND, false);

    // The frame is asked, and holds it.
    expect(patch).toHaveBeenLastCalledWith(expect.anything(), 0, true, true);
    expect(holdUpdate).toHaveBeenLastCalledWith({ authors: [asha] });

    // The typing goes around the text of the frame, which has neither
    // change.
    patched([second("Try it now.")]);
    await comes(4, SECOND, "<p>Try it now please.</p><p>Do it now.</p>");
    expect(patch).toHaveBeenLastCalledWith(
      [{ in: 14, after: null, before: null, html: "Try it now.", marks: [[6, 10]] }],
      0,
      false,
      false,
    );
    expect(frameShows).not.toHaveBeenCalled();

    patched([first("Try it now please."), second("Do it now.")]);
    await act(() => result.current.showUpdate());
    expect(patch).toHaveBeenLastCalledWith(expect.anything(), 0, true, false);
    expect(frameShows).toHaveBeenCalledExactlyOnceWith(4, "ver_1");
  });

  it("shows typing inside text that only the change that waits put in without that text, and with it after the reader asks", async () => {
    const { comes, patch, patched, result } = await holding();

    patched([first("Try it,.")]);
    await comes(3, PUSHED, "<p>Try it now, please.</p><p>Try it.</p>");
    // The change that waits takes out its text around the typing.
    expect(patch).toHaveBeenLastCalledWith(
      [{ in: 0, after: null, before: null, html: "Try it,.", marks: [[6, 7]] }],
      0,
      false,
      false,
    );

    patched([first("Try it now, please.")]);
    await act(() => result.current.showUpdate());
    expect(patch).toHaveBeenLastCalledWith(
      [{ in: 0, after: null, before: null, html: "Try it now, please." }],
      0,
      true,
      false,
    );
  });

  it.each([0, 1])(
    "never sends what the frame shows in place of the head when the frame does not answer, for a reader who typed %i times before",
    async (edits) => {
      vi.spyOn(api, "documentChanges").mockResolvedValue(
        changes(2, SOURCE, PUSHED, false),
      );
      const sendOps = vi.spyOn(api, "sendOps");
      const view = setup({ latest: 2, editing: false });
      // The text that the reader typed in this load of the frame before is
      // on the server.
      view.frame.edits = edits;
      view.patch.mockResolvedValue({
        ...view.frame,
        ok: false,
        stale: false,
        withdrawn: true,
      });
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(view.holdUpdate).toHaveBeenLastCalledWith({ authors: [asha] });

      view.patch.mockRejectedValueOnce(new Error("The frame did not answer."));
      vi.mocked(api.documentChanges).mockResolvedValue(
        changes(3, PUSHED, "<p>Try it now please.</p><p>Try it again.</p>"),
      );
      view.rerender({ latest: 3 });
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(sendOps).not.toHaveBeenCalled();
      expect(view.reload).toHaveBeenCalledOnce();
    },
  );

  it("sends the keys of a reader who starts Edit mode on the head with the change, never the frame without it", async () => {
    const { comes, patched, rerender, frame, key, sendOps } = await holding();
    patched([second("Try it again.")]);
    await comes(3, PUSHED, "<p>Try it now please.</p><p>Try it again.</p>");
    sendOps.mockResolvedValue(sent(4));

    // A key comes before the frame shows the change that waited.
    patched([first("Try it now please."), second("Try it again!")]);
    rerender({ editing: true });
    frame.regions = [second("Try it again!")];
    await key();

    expect(sendOps).toHaveBeenCalledExactlyOnceWith("doc_1", {
      base_seq: 3,
      client_op_id: expect.any(String),
      replacements: [{ start: 35, end: 41, old_html: "again.", new_html: "again!" }],
    });
  });
});

describe("a change of a start tag or a style", () => {
  const TAGGED = '<style>p{}</style><p class="a">Try it.</p><p>Try it.</p>';
  const OTHER = TAGGED.replace('"a"', '"b"');
  beforeEach(() => sources(TAGGED));

  it("goes into the frame of an editor in place, and stays in what the editor sends", async () => {
    const edit = vi.spyOn(api, "sendOps").mockResolvedValue(sent(3));
    const get = vi
      .spyOn(api, "documentChanges")
      .mockResolvedValue(changes(2, TAGGED, OTHER, false));
    const { patch, patched, frame, key, frameShows, reload, rerender } = setup();
    patched([]);
    rerender({ latest: 2 });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(patch).toHaveBeenCalledExactlyOnceWith(
      [{ tag: 18, html: '<p class="b">' }],
      0,
      true,
      false,
    );
    expect(frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
    expect(reload).not.toHaveBeenCalled();

    // The regions of the frame do not write the start tag.
    frame.regions = [paragraph(42, "Try it now.")];
    await key();
    expect(edit.mock.calls[0][1].replacements).toEqual([
      { start: 49, end: 52, old_html: "it.", new_html: "it now." },
    ]);

    // A change back to the loaded start tag goes into the frame too.
    const typed = OTHER.replace(/it\.<\/p>$/, "it now.</p>");
    get.mockResolvedValue(changes(4, typed, typed.replace('"b"', '"a"'), false));
    patched([paragraph(42, "Try it now.")]);
    rerender({ latest: 4 });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(patch).toHaveBeenLastCalledWith(
      [{ tag: 18, html: '<p class="a">' }],
      0,
      true,
      false,
    );
    expect(frameShows).toHaveBeenLastCalledWith(4, "ver_1");
    expect(reload).not.toHaveBeenCalled();
  });

  it("waits behind the banner for a reader when a style changes, and goes in place when they ask", async () => {
    vi.spyOn(api, "documentChanges").mockResolvedValue(
      changes(2, TAGGED, TAGGED.replace("p{}", "p{color:red}"), false),
    );
    const { patch, patched, reload, holdUpdate, result } = setup({
      latest: 2,
      editing: false,
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(holdUpdate).toHaveBeenLastCalledWith({ authors: [asha] });
    expect(patch).not.toHaveBeenCalled();

    patched([]);
    await act(() => result.current.showUpdate());
    expect(patch).toHaveBeenCalledExactlyOnceWith(
      [{ style: 0, html: "p{color:red}" }],
      0,
      true,
      false,
    );
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("a head that the server does not have", () => {
  const unfit = {
    ...changes(2, SOURCE, THEIRS),
    ops: [[{ start: 0, end: 3, old_html: "<h1", new_html: "<h2" }]],
  };
  const otherSum = { ...changes(2, SOURCE, THEIRS), sum: SUM + 1 };

  it.each([
    ["operations that do not fit", unfit],
    ["another sum", otherSum],
  ])(
    "takes the live document as the head, and shows it in place (%s)",
    async (_name, answer) => {
      vi.spyOn(api, "documentChanges").mockResolvedValue(answer);
      live(THEIRS, 2);
      const { reload, patched, frameShows } = setup({ latest: 2 });
      patched([first("Try this.")]);

      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
      expect(reload).not.toHaveBeenCalled();
    },
  );

  it("loads the document again, once, when the changes after the live document do not fit either", async () => {
    const get = vi.spyOn(api, "documentChanges").mockResolvedValue(unfit);
    live(THEIRS, 2);
    const { reload, patched, rerender } = setup({ latest: 2 });
    patched([first("Try this.")]);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(reload).not.toHaveBeenCalled();

    get.mockResolvedValue({ ...unfit, seq: 3 });
    rerender({ latest: 3 });
    await act(() => vi.advanceTimersByTimeAsync(0));
    rerender({ latest: 4 });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(reload).toHaveBeenCalledExactlyOnceWith();
  });

  it("sends text that the reader typed meanwhile on the live document", async () => {
    const error = vi.spyOn(toast, "error");
    const send = vi.spyOn(api, "sendOps").mockResolvedValue(sent(3));
    live(THEIRS, 2);
    const { frame, reload, result, setState, patch } = setup({ latest: 2 });
    vi.spyOn(api, "documentChanges").mockImplementation(async () => {
      frame.regions = [second("Try it now.")];
      result.current.changed();
      return unfit;
    });
    patch.mockImplementation(async () => {
      frame.regions = [first("Try this."), second("Try it now.")];
      return { ...frame, ok: true, stale: false };
    });

    await act(() => vi.advanceTimersByTimeAsync(100));

    expect(send).toHaveBeenCalledOnce();
    expect(send.mock.lastCall![1]).toMatchObject({
      base_seq: 2,
      replacements: [{ start: 23, end: 26, old_html: "it.", new_html: "it now." }],
    });
    expect(reload).not.toHaveBeenCalled();
    expect(setState.mock.calls.every(([state]) => state === "idle")).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });
});

it.each([403, 404])(
  "asks for the document again when the changes answer %i",
  async (status) => {
    vi.spyOn(api, "documentChanges").mockRejectedValue(
      new APIError(status, "forbidden", "no"),
    );
    const { client } = setup({ latest: 2 });
    const invalidate = vi.spyOn(client, "invalidateQueries");

    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      queryKey: queryKeys.document("doc_1"),
    });
    expect(api.documentChanges).toHaveBeenCalledOnce();
  },
);

it("asks for the changes again after a failure that can pass", async () => {
  const get = vi
    .spyOn(api, "documentChanges")
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValue(changes(2, SOURCE, THEIRS));
  const { patched, frameShows } = setup({ latest: 2 });
  patched([first("Try this.")]);

  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(frameShows).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(5000));

  expect(get).toHaveBeenCalledTimes(2);
  expect(frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
});

it("sends a change at once, as one operation for the events of one key", async () => {
  const send = vi.spyOn(api, "sendOps").mockResolvedValue(sent(2));
  const { frame, result, setState } = setup();

  frame.regions = [second("Try it now.")];
  act(() => result.current.changed());
  act(() => result.current.changed());
  await act(() => vi.advanceTimersByTimeAsync(49));
  expect(send).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));

  expect(send).toHaveBeenCalledOnce();
  // The bar shows nothing while the text goes to the server.
  expect(setState.mock.calls.every(([state]) => state === "idle")).toBe(true);
});

it("holds the next changes while an operation is on its way, and sends them as one", async () => {
  let land = () => {};
  const send = vi
    .spyOn(api, "sendOps")
    .mockImplementationOnce(() => new Promise((done) => (land = () => done(sent(2)))))
    .mockResolvedValueOnce(sent(3));
  const { frame, result, type } = setup();
  await type("Try it now.");
  expect(send).toHaveBeenCalledOnce();

  // Three keys come before the answer.
  for (const text of ["Try it now!", "Try it now!!", "Try it now!!!"]) {
    frame.regions = [second(text)];
    act(() => result.current.changed());
    await act(() => vi.advanceTimersByTimeAsync(100));
  }
  expect(send).toHaveBeenCalledOnce();

  land();
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.lastCall![1]).toMatchObject({
    base_seq: 2,
    replacements: [{ start: 24, end: 28, old_html: "now.", new_html: "now!!!" }],
  });
});

it("shows the text of other people after each send, before the keys that came meanwhile go", async () => {
  const order: string[] = [];
  const { type, frame, patch, result } = setup();
  // The reader types on while each operation is on its way, and the answer
  // of the first one names the text of another person.
  const send = vi.spyOn(api, "sendOps").mockImplementationOnce(async () => {
    order.push("send");
    frame.regions = [second("Try it now!")];
    result.current.changed();
    return sent(3, merged);
  });
  send.mockImplementation(async () => {
    order.push("send");
    return sent(4);
  });
  patch.mockImplementation(async () => {
    order.push("patch");
    frame.regions = [first("Try this."), second("Try it now!")];
    return { ...frame, ok: true, stale: false };
  });

  await type("Try it now.");
  await act(() => vi.advanceTimersByTimeAsync(50));

  expect(order).toEqual(["send", "patch", "send"]);
});

describe("a load of the frame", () => {
  it("keeps the text that is not sent when the page gives the same load again", async () => {
    const send = vi
      .spyOn(api, "sendOps")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(sent(2));
    const { type, rerender, holdUpdate } = setup();
    await type("Try it now.");
    holdUpdate.mockClear();

    // The page asked for the render token again, and got the same load.
    rerender({ loaded: { ...loaded } });
    expect(kept()).toBeDefined();
    expect(holdUpdate).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]).toEqual(send.mock.calls[0]);
  });

  it("waits for the text on screen, comes once, and the keys after it still go", async () => {
    const send = vi.spyOn(api, "sendOps").mockResolvedValueOnce(sent(3, merged));
    const { frame, type, patch, reload, result, rerender } = setup();
    // The frame cannot show the text of the other person in place.
    patch.mockImplementation(async () => ({ ...frame, ok: false, stale: false }));
    await type("Try it now.");
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(reload).toHaveBeenCalledOnce();

    // The frame on screen stays until the next one is there. A key in it
    // goes to the server, and asks for no other load.
    send.mockResolvedValueOnce(sent(4));
    await type("Try it now!");
    expect(send).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledOnce();

    // The last key comes as the frame goes: it goes from the draft.
    send.mockResolvedValueOnce(sent(5));
    act(() => {
      result.current.changed({ ...frame, regions: [second("Try it now!!")] });
    });
    rerender({ loaded: { version: "ver_1", seq: 3, url: "/render/1" } });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.lastCall![1].base_seq).toBe(4);
  });
});

describe("a page that the reader leaves", () => {
  const hide = () => {
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
  };

  it("sends the text at once, in a request that outlives the page, and keeps it in storage until the answer", async () => {
    let land = () => {};
    const send = vi
      .spyOn(api, "sendOps")
      .mockImplementation(() => new Promise((done) => (land = () => done(sent(2)))));
    const { frame, result } = setup();
    frame.regions = [second("Try it now.")];
    act(() => result.current.changed());

    hide();
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(send).toHaveBeenCalledExactlyOnceWith("doc_1", expect.anything());
    // Storage holds the operation with the id that it went with, so that the
    // server applies it once.
    expect(kept()).toEqual({
      version: "ver_1",
      op: send.mock.lastCall![1],
      updatedAt: expect.any(Number),
    });
    land();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(kept()).toBeUndefined();
  });

  describe("when the browser unloads the page", () => {
    // Nothing answers a page that goes: not the frame, and not the server.
    const unloading = async (props?: Parameters<typeof setup>[0]) => {
      const order: string[] = [];
      const send = vi.spyOn(api, "sendOps").mockImplementation(() => {
        order.push("send");
        return new Promise(() => {});
      });
      const view = setup(props);
      // An editor has the loaded source before the first key.
      await act(() => vi.advanceTimersByTimeAsync(0));
      view.take.mockImplementation(() => new Promise(() => {}));
      const draft = { regions: [second("Try it now.")], scripts: [], edits: 1 };
      act(() => {
        view.result.current.changed(draft);
      });
      // The page gets no timer and no answer after this: only the work of
      // the task itself is done.
      const unload = () =>
        act(async () => void window.dispatchEvent(new Event("pagehide")));
      return { ...view, order, send, unload };
    };

    it("sends the last draft with no answer of the frame, and nothing else", async () => {
      const fetched = vi.spyOn(globalThis, "fetch");
      const { order, send, take, unload } = await unloading();

      await unload();

      expect(order).toEqual(["send"]);
      expect(fetched).not.toHaveBeenCalled();
      expect(take).not.toHaveBeenCalled();
      expect(send.mock.lastCall![1]).toMatchObject({
        base_seq: 1,
        replacements: [{ start: 21, end: 24, old_html: "it.", new_html: "it now." }],
      });
      // The text also waits in storage, in case the request fails, as the
      // same operation.
      expect(kept()).toEqual({
        version: "ver_1",
        op: send.mock.lastCall![1],
        updatedAt: expect.any(Number),
      });
    });

    it("does not wait for a frame that it asked when the tab hid before", async () => {
      const { order, take, unload } = await unloading();
      hide();
      await act(async () => {});
      expect(take).toHaveBeenCalledOnce();
      expect(order).toEqual([]);

      await unload();

      expect(order).toEqual(["send"]);
    });

    it("sends the text of a reader who typed and left Edit mode", async () => {
      const { order, unload } = await unloading({ editing: false });

      await unload();

      expect(order).toEqual(["send"]);
    });

    it("loads the frame again when the browser shows the kept page again", async () => {
      const { reload, unload } = await unloading();
      await unload();

      const shown = new Event("pageshow");
      Object.assign(shown, { persisted: true });
      act(() => void window.dispatchEvent(shown));

      expect(reload).toHaveBeenCalledOnce();
    });
  });
});

it("sends and follows nothing when the server gives no seq", async () => {
  const send = vi.spyOn(api, "sendOps");
  const get = vi.spyOn(api, "documentChanges");
  const { type, frameShows, rerender } = setup();
  await act(() => vi.advanceTimersByTimeAsync(0));
  vi.mocked(api.versionSource).mockClear();
  rerender({
    loaded: { version: "ver_1", seq: undefined, url: "/render/1" },
    latest: 2,
  });

  await type("Try it now.");

  expect(send).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  // The frame shows no seq of a live document.
  expect(frameShows).toHaveBeenCalledExactlyOnceWith(undefined, "ver_1");
  expect(api.versionSource).not.toHaveBeenCalled();
});

it("tells the page the seq that the frame loaded, once the frame is ready", async () => {
  const { frameShows, rerender } = setup();
  rerender({ loaded: { version: "ver_2", seq: 7, url: "/render/1" } });
  expect(frameShows).toHaveBeenCalledExactlyOnceWith(7, "ver_2");
});

it("keeps text that cannot save on the page after a new load, until the reader discards it", async () => {
  const error = vi.spyOn(toast, "error");
  vi.spyOn(api, "sendOps").mockRejectedValue(
    new APIError(422, "edit_failed", "the edit does not fit"),
  );
  const { type, setState, rerender, reload } = setup();

  await type("Try it now.");
  expect(setState).toHaveBeenLastCalledWith("refused");
  rerender({ loaded: { version: "ver_1", seq: 2, url: "/render/1" } });
  expect(setState).toHaveBeenLastCalledWith("refused");
  expect(kept()).toBeDefined();

  // The new frame does not show the text: Discard loads nothing again.
  (error.mock.lastCall![1] as Actions).cancel.onClick();
  expect(setState).toHaveBeenLastCalledWith("idle");
  expect(reload).not.toHaveBeenCalled();
  expect(kept()).toBeUndefined();
});

it("sends the last draft, in a request that outlives the page, when the frame goes before it went out", async () => {
  const edit = vi.spyOn(api, "sendOps").mockResolvedValue(sent(2));
  const { result, hook, take } = setup();

  act(() => {
    result.current.changed({ regions: [second("Try it now.")], scripts: [], edits: 1 });
  });
  hook.unmount();
  await act(() => vi.advanceTimersByTimeAsync(0));

  expect(take).not.toHaveBeenCalled();
  expect(edit).toHaveBeenCalledExactlyOnceWith(
    "doc_1",
    expect.objectContaining({
      replacements: [{ start: 21, end: 24, old_html: "it.", new_html: "it now." }],
    }),
  );
  // The server holds the text: nothing waits for the next visit.
  expect(kept()).toBeUndefined();
});

it.each([403, 404])(
  "tries a failed read of the loaded source (%i) again, with no message",
  async (status) => {
    const error = vi.spyOn(toast, "error");
    const edit = vi.spyOn(api, "sendOps").mockResolvedValue(sent(2));
    // The read for the start of Edit mode fails, and so does the read for
    // the first operation.
    const gone = new APIError(status, "not_found", "gone");
    vi.mocked(api.versionSource)
      .mockRejectedValueOnce(gone)
      .mockRejectedValueOnce(gone);
    const { type, setState } = setup();

    await type("Try it now.");
    expect(edit).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(edit).toHaveBeenCalledOnce();
    expect(error).not.toHaveBeenCalled();
    expect(setState.mock.calls.every(([state]) => state === "idle")).toBe(true);
  },
);

it("sends nothing when the edits cannot be written into the source", async () => {
  const error = vi.spyOn(toast, "error");
  const edit = vi.spyOn(api, "sendOps");
  vi.mocked(sourceEdits.applyRegions).mockReturnValueOnce({
    refused: "A script moved this content.",
  });
  const { type, reload, setState, result } = setup();

  await type("Try it now.");

  expect(edit).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(
    "This edit no longer fits the document, so it cannot save.",
    expect.anything(),
  );
  expect(setState).toHaveBeenLastCalledWith("refused");

  // Retry, or Done, says why again, with the choices.
  error.mockClear();
  expect(await act(() => result.current.settle())).toBe(false);
  expect(error).toHaveBeenCalledExactlyOnceWith(
    "This edit no longer fits the document, so it cannot save.",
    expect.objectContaining({
      action: expect.objectContaining({ label: "Copy my text" }),
    }),
  );
});

// The toast actions that a test clicks.
type Actions = {
  action: { label: string; onClick: (e: { preventDefault(): void }) => void };
  cancel: { label: string; onClick: () => void };
};

function stubClipboard() {
  const write = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: write } });
  return write;
}

it.each([
  [403, "forbidden", "You can no longer edit this document, so your text cannot save."],
  [422, "edit_failed", "This edit no longer fits the document, so it cannot save."],
  [400, "bad_request", "The server did not take this change, so it cannot save."],
])(
  "keeps the text on screen until the reader chooses when the server refuses an operation with %i",
  async (status, code, message) => {
    const error = vi.spyOn(toast, "error");
    const write = stubClipboard();
    vi.spyOn(api, "sendOps").mockRejectedValue(new APIError(status, code, "no"));
    const { type, reload, frameShows, setState, result } = setup();

    act(() =>
      result.current.changed({
        regions: [second("Try it now.")],
        scripts: [],
        edits: 1,
      }),
    );
    await type("Try it now.");
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(frameShows).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(setState).toHaveBeenLastCalledWith("refused");
    const [said, options] = error.mock.lastCall!;
    expect(said).toBe(message);
    const { action, cancel, duration } = options as Actions & { duration: number };
    expect(duration).toBe(Infinity);
    expect([action.label, cancel.label]).toEqual(["Copy my text", "Discard my change"]);
    // The text also waits in storage, for a visit after this one.
    expect(kept()).toMatchObject({ version: "ver_1" });
    await act(async () => action.onClick({ preventDefault: vi.fn() }));
    expect(write).toHaveBeenCalledWith("Try it now.");
    // Discard loads the document again, which drops the draft.
    cancel.onClick();
    expect(reload).toHaveBeenCalledExactlyOnceWith();
  },
);

it("sends nothing when the edits went back to the loaded text", async () => {
  const edit = vi.spyOn(api, "sendOps");
  const { key, setState } = setup();

  await key();

  expect(edit).not.toHaveBeenCalled();
  expect(setState).toHaveBeenLastCalledWith("idle");
});

describe("an approved document", () => {
  const reviewer = { type: "user" as const, id: "usr_r", name: "Rev" };
  // The approvals that count on each version.
  const approvedOn = (approved: Record<string, boolean>) =>
    vi.spyOn(api, "listApprovals").mockImplementation(
      async (_doc, version) =>
        ({
          items: [
            { approver: reviewer, decision: approved[version!] ? "approved" : null },
          ],
        }) as ApprovalsList,
    );
  beforeEach(() =>
    vi
      .mocked(api.getDocument)
      .mockResolvedValue({ id: "doc_1", approval_status: "approved" } as Document),
  );

  it("says once, before the first key, that a change asks the approver again", async () => {
    const info = vi.spyOn(toast, "info");
    approvedOn({ ver_1: true });
    const { result } = setup();
    await act(() => vi.advanceTimersByTimeAsync(0));

    await act(() => result.current.focused());
    await act(() => result.current.focused());

    expect(info).toHaveBeenCalledExactlyOnceWith(
      "Your change asks Rev to approve again.",
      expect.anything(),
    );
  });

  it("says that the first operation on an approved version resets the approval", async () => {
    const info = vi.spyOn(toast, "info");
    const approvals = approvedOn({ ver_1: true });
    // The first operation starts a new version. The next one is in it.
    vi.spyOn(api, "sendOps")
      .mockResolvedValueOnce(sent(2, undefined, "ver_2"))
      .mockResolvedValueOnce(sent(3, undefined, "ver_2"));
    const { type } = setup();
    await act(() => vi.advanceTimersByTimeAsync(0));

    await type("Try it now.");
    expect(info.mock.lastCall![0]).toBe("The approval of Rev is reset.");
    // An operation in the same version asks for no approvals.
    info.mockClear();
    approvals.mockClear();
    await type("Try it now!");
    expect(approvals).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("says that an operation that starts a version gives an approval back", async () => {
    const info = vi.spyOn(toast, "info");
    approvedOn({ ver_2: true });
    vi.spyOn(api, "sendOps").mockResolvedValueOnce(sent(2, undefined, "ver_2"));
    const { type, result } = setup();
    await act(() => vi.advanceTimersByTimeAsync(0));

    await type("Try it now.");
    expect(info.mock.lastCall![0]).toBe("The approval of Rev is restored.");
    // The restored approval is news again before the next key.
    info.mockClear();
    await act(() => result.current.focused());
    expect(info).toHaveBeenCalledOnce();
  });
});

describe("text that cannot save", () => {
  const refuse = () =>
    vi
      .spyOn(api, "sendOps")
      .mockRejectedValue(new APIError(422, "edit_failed", "the edit does not fit"));

  it("waits in storage after the page goes, and is offered on the next visit", async () => {
    refuse();
    const first = setup();
    act(() =>
      first.result.current.changed({
        ...first.frame,
        regions: [second("Try it now.")],
      }),
    );
    await first.type("Try it now.");
    // The words typed after the refusal wait too.
    act(() =>
      first.result.current.changed({ ...first.frame, regions: [second("Keep it.")] }),
    );
    const dismiss = vi.spyOn(toast, "dismiss");
    await first.close();
    expect(dismiss).toHaveBeenCalledWith("live-text-refused");

    const error = vi.spyOn(toast, "error");
    const write = stubClipboard();
    setup();
    await act(() => vi.advanceTimersByTimeAsync(0));
    const [message, options] = error.mock.lastCall!;
    expect(message).toBe("You have text in this document that was not saved.");
    const { action, cancel } = options as Actions;
    await act(async () => action.onClick({ preventDefault: vi.fn() }));
    expect(write).toHaveBeenCalledWith("Keep it.");
    expect(cancel.label).toBe("Discard my change");
    cancel.onClick();
    expect(kept()).toBeUndefined();
  });

  it("stays in storage when the frame loads again for another reason than Discard", async () => {
    const edit = refuse();
    const { type, result, rerender } = setup();
    act(() =>
      result.current.changed({
        regions: [second("Try it now.")],
        scripts: [],
        edits: 1,
      }),
    );
    await type("Try it now.");
    edit.mockClear();

    // The reader went to another version, or the page loaded the frame.
    rerender({ loaded: { version: "ver_0", seq: 0, url: "/render/1" } });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(kept()).toMatchObject({ version: "ver_1", copy: "Try it now." });
    // The text that the server refused does not go again.
    expect(edit).not.toHaveBeenCalled();
  });

  it("leaves storage when the reader discards it, or when the server takes the text", async () => {
    const error = vi.spyOn(toast, "error");
    const edit = refuse();
    const { type, result, rerender, reload } = setup();
    act(() =>
      result.current.changed({
        regions: [second("Try it now.")],
        scripts: [],
        edits: 1,
      }),
    );
    await type("Try it now.");
    expect(kept()).toBeDefined();
    // Discard loads the document again, without the text.
    (error.mock.lastCall![1] as Actions).cancel.onClick();
    expect(reload).toHaveBeenCalledOnce();
    expect(kept()).toBeUndefined();
    // Nothing of the text goes again, also when the load ends.
    const sends = edit.mock.calls.length;
    rerender({ loaded: { version: "ver_1", seq: 2, url: "/render/1" } });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(edit).toHaveBeenCalledTimes(sends);
    expect(reload).toHaveBeenCalledOnce();
    expect(kept()).toBeUndefined();

    edit.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    edit.mockResolvedValueOnce(sent(3));
    await type("Try it again.");
    expect(kept()).toBeDefined();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(kept()).toBeUndefined();
  });

  // The draft of an earlier visit: an operation on seq 4 of ver_0 that did
  // not save, which puts text in the second paragraph.
  const OP = {
    base_seq: 4,
    client_op_id: "op_earlier",
    replacements: [{ start: 17, end: 20, old_html: "Try", new_html: "Keep" }],
  };
  const stored = (draft: Partial<TextDraft> = {}) =>
    writeTextDraft(ME, "doc_1", "earlier", { version: "ver_0", op: OP, ...draft });

  it("keeps the draft of an earlier visit until the reader discards it", async () => {
    stored();
    // The text of this visit waits in storage too, beside it, until the
    // server has it.
    const send = vi.spyOn(api, "sendOps").mockRejectedValue(new TypeError("offline"));
    const { type } = setup();

    await type("Try it now.");
    expect(Object.values(readTextDrafts(ME, "doc_1"))).toHaveLength(2);
    send.mockResolvedValue(sent(2));
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(kept()).toMatchObject({ version: "ver_0" });
  });

  it("removes only the draft of the load that sent its text, as after full screen", async () => {
    const send = vi.spyOn(api, "sendOps").mockRejectedValue(new TypeError("offline"));
    const { type, rerender } = setup();
    await type("Try it now.");
    rerender({ loaded: { version: "ver_1", seq: 1, url: "/render/1" } });
    await type("Try it again.");
    expect(Object.values(readTextDrafts(ME, "doc_1"))).toHaveLength(2);

    // The server takes the text of the load that ended, and the new load is
    // still offline.
    send.mockImplementation(async (_doc, { base_seq, replacements }) => {
      if (replacements.some((r) => r.new_html.includes("again")))
        throw new TypeError("offline");
      return sent(base_seq + 1);
    });
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(kept().op?.replacements).toMatchObject([
      { new_html: expect.stringContaining("again") },
    ]);
  });

  it("sends a draft of an earlier visit by itself, as the same operation", async () => {
    const error = vi.spyOn(toast, "error");
    const send = vi.spyOn(api, "sendOps").mockResolvedValue(sent(5));
    stored();

    setup({ editing: false });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(send).toHaveBeenCalledExactlyOnceWith("doc_1", OP);
    expect(error).not.toHaveBeenCalled();
    expect(kept()).toBeUndefined();
  });

  it("removes the draft of an earlier visit, with no message, when the server applied its operation before", async () => {
    const error = vi.spyOn(toast, "error");
    vi.spyOn(api, "sendOps").mockRejectedValue(
      new APIError(409, "stale", "gone", { applied: true }),
    );
    stored();

    setup({ editing: false });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(error).not.toHaveBeenCalled();
    expect(kept()).toBeUndefined();
  });

  it("offers a draft of an earlier visit to copy, and merges nothing, when the server no longer has its seq", async () => {
    const error = vi.spyOn(toast, "error");
    const write = stubClipboard();
    const send = vi
      .spyOn(api, "sendOps")
      .mockRejectedValue(new APIError(409, "stale", "gone"));
    stored();

    setup({ editing: false });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(send).toHaveBeenCalledOnce();
    const [message, options] = error.mock.lastCall!;
    expect(message).toBe("You have text in this document that was not saved.");
    await act(async () =>
      (options as Actions).action.onClick({ preventDefault: vi.fn() }),
    );
    expect(write).toHaveBeenCalledWith("Keep");
    expect(kept()).toMatchObject({ copy: "Keep" });
  });

  it("sends a draft of an earlier visit when the network is back, with no message before", async () => {
    const error = vi.spyOn(toast, "error");
    const send = vi.spyOn(api, "sendOps").mockRejectedValue(new TypeError("offline"));
    stored();
    setup({ editing: false });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(error).not.toHaveBeenCalled();
    expect(kept()).toBeDefined();

    send.mockResolvedValue(sent(5));
    await act(async () => void window.dispatchEvent(new Event("online")));

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.lastCall![1]).toEqual(OP);
    expect(kept()).toBeUndefined();
  });

  it("offers a draft of an earlier visit, with Copy my text, only when the server refuses it", async () => {
    const error = vi.spyOn(toast, "error");
    refuse();
    stored();

    setup({ editing: false });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(error).toHaveBeenCalledExactlyOnceWith(
      "You have text in this document that was not saved.",
      expect.anything(),
    );
    expect(kept()).toBeDefined();
  });

  it("never sends or offers the draft of another principal", async () => {
    const error = vi.spyOn(toast, "error");
    const send = vi.spyOn(api, "sendOps").mockResolvedValue(sent(5));
    writeTextDraft("usr_other", "doc_1", "earlier", { version: "ver_0", op: OP });
    writeTextDraft("usr_other", "doc_1", "refused", {
      version: "ver_0",
      copy: "Theirs",
    });

    setup({ editing: false });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(send).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(Object.keys(readTextDrafts("usr_other", "doc_1"))).toHaveLength(2);
  });

  it("keeps no text in storage for a reader with no principal", async () => {
    vi.spyOn(api, "sendOps").mockRejectedValue(new TypeError("offline"));
    const { type } = setup({ owner: undefined });

    await type("Try it now.");

    expect(localStorage.length).toBe(0);
  });

  it("leaves a draft that a live load holds, also in another tab, to that load", async () => {
    const send = vi.spyOn(api, "sendOps").mockRejectedValue(new TypeError("offline"));
    // A tab that hides keeps its text in storage, and still sends it.
    const other = setup();
    await other.type("Try it now.");
    expect(kept()).toBeDefined();
    send.mockClear();

    setup({ editing: false });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(send).not.toHaveBeenCalled();

    // The tab closes: its text goes from the next page that opens.
    send.mockResolvedValue(sent(2));
    await other.close();
    setup({ editing: false });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(send).toHaveBeenCalledWith(
      "doc_1",
      expect.objectContaining({ base_seq: 1 }),
    );
    expect(kept()).toBeUndefined();
  });
});

describe("text typed on an earlier visit", () => {
  // The answer that names the text that another person typed in the first
  // paragraph meanwhile.
  const theirs = { from: MINE, to: MERGED };

  it("goes once, also when the server holds the text before it", async () => {
    const send = vi
      .spyOn(api, "sendOps")
      .mockResolvedValueOnce(sent(2))
      .mockRejectedValue(new TypeError("offline"));
    const first = setup();
    // "now" is saved, and the browser is offline for " please".
    await first.type("Try it now.");
    await first.type("Try it now, please.");
    await first.close();
    const failed = send.mock.lastCall![1];

    send.mockReset().mockResolvedValue(sent(3));
    setup({ editing: false });
    await act(() => vi.advanceTimersByTimeAsync(0));

    // Only the operation that did not save goes, with its id: never the
    // text that the server holds.
    expect(send).toHaveBeenCalledExactlyOnceWith("doc_1", failed);
    expect(failed).toMatchObject({
      base_seq: 2,
      replacements: [{ old_html: "now.", new_html: "now, please." }],
    });
    expect(kept()).toBeUndefined();
  });

  it("sends the text typed while an operation was on its way after it, over the text of other people", async () => {
    const send = vi
      .spyOn(api, "sendOps")
      .mockImplementation(() => new Promise(() => {}));
    const first = setup();
    await first.type("Try it now.");
    // The page goes while the operation is on its way, with more text.
    first.frame.regions = [second("Try it now, please.")];
    act(() => first.result.current.changed({ ...first.frame }));
    act(() => void window.dispatchEvent(new Event("pagehide")));
    const [, op] = send.mock.calls[0];
    expect(kept()).toEqual({
      version: "ver_1",
      op,
      next: [{ start: 24, end: 28, old_html: "now.", new_html: "now, please." }],
      updatedAt: expect.any(Number),
    });
    await first.close();

    // The server answers the operation as it did the first time, and names
    // the text of another person.
    send
      .mockReset()
      .mockResolvedValueOnce(sent(3, theirs))
      .mockResolvedValueOnce(sent(4));
    setup({ editing: false });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(send.mock.calls.map(([, body]) => body)).toEqual([
      op,
      {
        base_seq: 3,
        client_op_id: expect.not.stringMatching(op.client_op_id),
        replacements: sourceEdits.replacementsBetween(
          MERGED,
          "<p>Try this.</p><p>Try it now, please.</p>",
        ),
      },
    ]);
    // The source that the operation was on is read at its seq.
    expect(api.versionSource).toHaveBeenCalledWith("doc_1", "ver_1", 1);
    expect(kept()).toBeUndefined();
  });

  it("offers the text typed after an operation to copy when the server applied it before and cannot say what came after it", async () => {
    const error = vi.spyOn(toast, "error");
    stubClipboard();
    vi.spyOn(api, "sendOps").mockRejectedValue(
      new APIError(409, "stale", "gone", { applied: true }),
    );
    writeTextDraft(ME, "doc_1", "earlier", {
      version: "ver_1",
      op: { base_seq: 1, client_op_id: "op_1", replacements: [] },
      next: [{ start: 17, end: 20, old_html: "Try", new_html: "Keep" }],
    });

    setup({ editing: false });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(error).toHaveBeenCalledOnce();
    expect(kept()).toMatchObject({ copy: "Keep" });
    expect(kept().op).toBeUndefined();
  });
});

describe("script text", () => {
  const SCRIPT = `<p></p><p></p><script>for (const p of document.querySelectorAll("p")) p.textContent = "Try it.";</script>`;
  const change = { locator: { at: 0, path: [] }, before: "Try it.", after: "Run it." };
  const literalAt = SCRIPT.indexOf(`"Try it."`);

  // A probe that runs the script above: the paragraphs show its string.
  const render =
    (
      shows = (html: string): string =>
        html.includes(`"Run it."`) ? "Run it." : "Try it.",
    ): Render =>
    async (html, _locator, strings) => ({
      text: shows(html),
      counts: strings.map((s) => (s === shows(html) ? 2 : 0)),
      texts: 2,
      errors: 0,
    });

  beforeEach(() => void sources(SCRIPT));

  describe("that another person changed", () => {
    const OTHER = SCRIPT.replace("Try it.", "Run it.");
    const scriptAt = SCRIPT.indexOf("<script>");
    const code = (html: string) => html.slice(scriptAt + 8, -9);

    it("changes in place in the frame of an editor, and stays in what the editor sends", async () => {
      const edit = vi.spyOn(api, "sendOps").mockResolvedValue(sent(3));
      vi.spyOn(api, "documentChanges").mockResolvedValue(
        changes(2, SCRIPT, OTHER, false),
      );
      const { patch, patched, probe, frame, key, frameShows, reload, rerender } =
        setup();
      probe.mockImplementation(render());
      patched([]);
      rerender({ latest: 2 });
      await act(() => vi.advanceTimersByTimeAsync(0));

      expect(patch).toHaveBeenCalledExactlyOnceWith(
        [
          {
            script: scriptAt,
            html: code(OTHER),
            from: "Try it.",
            to: "Run it.",
            places: 2,
          },
        ],
        0,
        true,
        false,
      );
      expect(frameShows).toHaveBeenCalledExactlyOnceWith(2, "ver_1");
      expect(reload).not.toHaveBeenCalled();

      // The regions of the frame do not write the script.
      frame.regions = [paragraph(0, "New")];
      await key();
      expect(edit.mock.calls[0][1].replacements).toEqual([
        { start: 3, end: 3, old_html: "", new_html: "New" },
      ]);
    });

    it("loads the frame when the reader typed in the same string, or the code changed in another way", async () => {
      vi.spyOn(api, "documentChanges").mockResolvedValue(
        changes(2, SCRIPT, OTHER, false),
      );
      const typed = setup();
      typed.probe.mockImplementation(
        render((html) => html.match(/textContent = "([^"]*)"/)![1]),
      );
      typed.frame.scripts = [{ ...change, after: "Try it!" }];
      vi.spyOn(api, "sendOps").mockResolvedValue(sent(2));
      typed.rerender({ latest: 2 });
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(typed.patch).not.toHaveBeenCalled();
      expect(typed.reload).toHaveBeenCalled();
      cleanup();

      const other = SCRIPT.replace("p.textContent", "p.title");
      vi.mocked(api.documentChanges).mockResolvedValue(
        changes(2, SCRIPT, other, false),
      );
      const coded = setup();
      coded.rerender({ latest: 2 });
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(coded.patch).not.toHaveBeenCalled();
      expect(coded.probe).not.toHaveBeenCalled();
      expect(coded.reload).toHaveBeenCalled();
    });
  });

  it("lets the reader type in text that one string holds", async () => {
    const { result } = setup();
    expect(await result.current.scriptEditable(" Try it. ")).toBe(true);
    expect(await result.current.scriptEditable("Run it.")).toBe(false);
  });

  it("sends a change that shows, and changes its other places in place", async () => {
    const edit = vi
      .spyOn(api, "sendOps")
      .mockResolvedValue(sent(2, undefined, "Changed “Try it.” to “Run it.”"));
    const { frame, probe, key, reload, replaceText } = setup();
    probe.mockImplementation(render());

    frame.scripts = [change];
    await key();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenLastCalledWith("doc_1", {
      base_seq: 1,
      client_op_id: expect.any(String),
      replacements: [
        { start: literalAt, end: literalAt + 4, old_html: '"Try', new_html: '"Run' },
      ],
      summary: "Changed “Try it.” to “Run it.”",
    });
    expect(reload).not.toHaveBeenCalled();
    expect(replaceText).toHaveBeenLastCalledWith("Try it.", "Run it.");
  });

  it("sends text typed back to its loaded text, and changes its other places back", async () => {
    const edit = vi.spyOn(api, "sendOps").mockResolvedValue(sent(2));
    const { frame, probe, key, replaceText } = setup();
    probe.mockImplementation(render());
    frame.scripts = [change];
    await key();

    edit.mockResolvedValue(sent(3));
    frame.scripts = [{ ...change, after: "Try it." }];
    await key();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenLastCalledWith(
      "doc_1",
      expect.objectContaining({
        base_seq: 2,
        replacements: [
          { start: literalAt, end: literalAt + 4, old_html: '"Run', new_html: '"Try' },
        ],
        summary: "Changed “Run it.” to “Try it.”",
      }),
    );
    expect(replaceText).toHaveBeenLastCalledWith("Run it.", "Try it.");
  });

  it("refuses a change that does not show where the reader typed it, and sends the rest", async () => {
    const error = vi.spyOn(toast, "error");
    const edit = vi.spyOn(api, "sendOps").mockResolvedValue(sent(2));
    const { frame, probe, key, reload, setState } = setup();
    probe.mockImplementation(render(() => "Try it."));

    frame.scripts = [change];
    await key();
    expect(edit).not.toHaveBeenCalled();
    // The text stays on screen, so the reader learns that it is not saved,
    // and may copy or discard it.
    expect(setState).toHaveBeenLastCalledWith("refused");
    expect(error).toHaveBeenCalledWith(
      "The page does not show the new text where you typed it.",
      expect.objectContaining({
        action: expect.objectContaining({ label: "Copy my text" }),
        cancel: expect.objectContaining({ label: "Discard my change" }),
      }),
    );

    // The next operation checks it no more, and holds the other edits.
    frame.regions = [
      {
        from: 7,
        to: 7,
        pieces: [{ element: 7, children: [{ text: "Hi" }] }],
        removed: [],
      },
    ];
    await key();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(setState).toHaveBeenLastCalledWith("refused");
    expect(edit.mock.lastCall![1].replacements).toEqual([
      { start: 10, end: 10, old_html: "", new_html: "Hi" },
    ]);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("the live document as the head, for a reader who was away", () => {
  const stale = new APIError(409, "stale", "pull again");
  const words = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
  const LARGE = `<p>${words}</p><p>Try it.</p>`;

  // The server no longer has the seq of the reader, and the live document
  // has a rewrite of what they read. The frame holds each change that asks.
  const away = async () => {
    const get = vi.spyOn(api, "documentChanges").mockRejectedValue(stale);
    live(LARGE, 9);
    const view = setup({ latest: 9, editing: false });
    view.patch.mockImplementation(async (_patches, _edits, _flash, ask) => {
      if (!ask) view.frame.regions = [first(words)];
      return { ...view.frame, ok: !ask, stale: false, withdrawn: ask };
    });
    await act(() => vi.advanceTimersByTimeAsync(0));
    return { ...view, get };
  };

  it("asks the frame, as for a change that is not typing, and the banner names no person", async () => {
    const { patch, holdUpdate, frameShows, reload } = await away();

    expect(patch).toHaveBeenCalledExactlyOnceWith(expect.anything(), 0, true, true);
    expect(holdUpdate).toHaveBeenLastCalledWith({ authors: [] });
    expect(frameShows).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("shows the change in place, with a flash, when the reader asks for the latest", async () => {
    const { result, patch, holdUpdate, frameShows, get } = await away();

    await act(() => result.current.showUpdate());

    // The live document is the head already: no request asks for it again.
    expect(get).toHaveBeenCalledOnce();
    expect(api.versionSource).toHaveBeenCalledTimes(2);
    expect(patch).toHaveBeenLastCalledWith(expect.anything(), 0, true, false);
    expect(holdUpdate).toHaveBeenLastCalledWith(undefined);
    expect(frameShows).toHaveBeenCalledExactlyOnceWith(9, "ver_1");
  });

  it("asks the frame again when the reader scrolled, and flashes a change that the frame takes", async () => {
    const { result, patch, frame, frameShows } = await away();
    patch.mockImplementation(async () => {
      frame.regions = [first(words)];
      return { ...frame, ok: true, stale: false };
    });

    act(() => result.current.scrolled());
    await act(() => vi.advanceTimersByTimeAsync(1000));

    expect(patch).toHaveBeenLastCalledWith(expect.anything(), 0, true, true);
    expect(frameShows).toHaveBeenCalledExactlyOnceWith(9, "ver_1");
  });

  it("shows typing that comes after it with no flash: the server names the changes again", async () => {
    const { result, patch, patched, get, rerender, frameShows } = await away();
    await act(() => result.current.showUpdate());
    const typed = `<p>${words}!</p><p>Try it.</p>`;
    get.mockResolvedValue(changes(10, LARGE, typed));
    patched([first(`${words}!`)]);

    rerender({ latest: 10 });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(get).toHaveBeenLastCalledWith("doc_1", 9);
    expect(patch).toHaveBeenLastCalledWith(expect.anything(), 0, false, false);
    expect(frameShows).toHaveBeenLastCalledWith(10, "ver_1");
  });
});

describe("an operation that the server applied before", () => {
  // The answer of the first try did not come. The server no longer has the
  // seq of the reader, and says that the document has the operation.
  const applied = new APIError(409, "stale", "pull again", { applied: true });
  const lostAnswer = () =>
    vi
      .spyOn(api, "sendOps")
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockRejectedValueOnce(applied);

  it("has the sent text one time: nothing goes again, and only the text of other people goes into the frame", async () => {
    const send = lostAnswer();
    live(MERGED, 7);
    const { type, patch, patched, frameShows, setState, reload } = setup();
    patched([first("Try this."), second("Try it now.")]);

    await type("Try it now.");
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][1]).toEqual(send.mock.calls[0][1]);
    expect(patch).toHaveBeenCalledExactlyOnceWith(
      [{ in: 0, after: null, before: null, html: "Try this." }],
      0,
      true,
      false,
    );
    expect(frameShows).toHaveBeenLastCalledWith(7, "ver_1");
    expect(setState.mock.calls.every(([state]) => state === "idle")).toBe(true);
    expect(reload).not.toHaveBeenCalled();
    expect(kept()).toBeUndefined();
  });

  it("sends only the text that the reader typed after it", async () => {
    const send = lostAnswer().mockResolvedValueOnce(sent(8));
    live(MERGED, 7);
    const { type, frame, key, patched } = setup();

    await type("Try it now.");
    // The reader types on before the next try.
    frame.regions = [second("Try it now, please.")];
    patched([first("Try this."), second("Try it now, please.")]);
    await key();
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.lastCall![1]).toMatchObject({
      base_seq: 7,
      replacements: [
        { start: 26, end: 30, old_html: "now.", new_html: "now, please." },
      ],
    });
  });

  it("loads the document again, with no word, when the live document was the head already", async () => {
    const error = vi.spyOn(toast, "error");
    const stale = new APIError(409, "stale", "pull again");
    const send = vi
      .spyOn(api, "sendOps")
      .mockRejectedValueOnce(stale)
      .mockRejectedValueOnce(applied);
    live(THEIRS, 7);
    const { type, patched, reload, setState } = setup();
    patched([first("Try this."), second("Try it now.")]);

    await type("Try it now.");

    expect(send).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledOnce();
    expect(setState.mock.calls.every(([state]) => state === "idle")).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });
});

describe("a load that ended with text that is not sent", () => {
  const offline = () =>
    vi.spyOn(api, "sendOps").mockRejectedValue(new TypeError("Failed to fetch"));

  it("sends it from its last draft, again each 5 s, until the server has it", async () => {
    const send = offline();
    const { type, rerender, take, client, setState } = setup();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await type("Try it now.");
    expect(send).toHaveBeenCalledOnce();

    // The frame loads again, as for a preview from the history.
    rerender({ loaded: { ...loaded, url: "/render/1" } });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(send).toHaveBeenCalledTimes(2);
    take.mockClear();

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(send).toHaveBeenCalledTimes(4);
    expect(kept()).toBeDefined();
    // The page says that the text of the load that ended is not saved.
    expect(setState).toHaveBeenLastCalledWith("failed");
    send.mockResolvedValue(sent(2));
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(send).toHaveBeenCalledTimes(5);
    expect(send.mock.lastCall![1]).toEqual(send.mock.calls[0][1]);
    // The new frame is not asked for the text.
    expect(take).not.toHaveBeenCalled();
    expect(setState).toHaveBeenLastCalledWith("idle");
    expect(kept()).toBeUndefined();
    // The page learns the new seq, so the new frame follows it.
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.document("doc_1") });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(send).toHaveBeenCalledTimes(5);
  });

  it("warns before an unload, and sends on Retry, until the server has it", async () => {
    const send = offline();
    const { type, rerender, result } = setup();
    await type("Try it now.");
    rerender({ loaded: { ...loaded, url: "/render/1" } });
    await act(() => vi.advanceTimersByTimeAsync(0));
    const sends = send.mock.calls.length;
    const unload = () =>
      !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    expect(unload()).toBe(true);

    send.mockResolvedValue(sent(2));
    await act(() => result.current.settle());

    expect(send).toHaveBeenCalledTimes(sends + 1);
    expect(unload()).toBe(false);
  });

  it("is on the page of the hook that comes after this one, as in full screen", async () => {
    const send = offline();
    const view = setup();
    await view.type("Try it now.");
    view.hook.unmount();
    // The frame mounts again, with a hook of its own.
    const next = renderHook(
      () => useLiveText({ ...view, loaded: { ...loaded, url: "/render/1" } }),
      {
        wrapper: ({ children }: { children: ReactNode }) => (
          <QueryClientProvider client={view.client}>{children}</QueryClientProvider>
        ),
      },
    );
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(view.setState).toHaveBeenLastCalledWith("failed");

    send.mockResolvedValue(sent(2));
    await act(() => next.result.current.settle());
    expect(view.setState).toHaveBeenLastCalledWith("idle");
    expect(kept()).toBeUndefined();
    next.unmount();
  });

  it("sends it on also when this hook ends and the page stays, as in full screen", async () => {
    const send = offline();
    const { type, hook } = setup();
    await type("Try it now.");

    hook.unmount();
    await act(() => vi.advanceTimersByTimeAsync(0));
    send.mockResolvedValue(sent(2));
    await act(() => vi.advanceTimersByTimeAsync(5000));

    expect(send).toHaveBeenCalledTimes(3);
    expect(kept()).toBeUndefined();
  });
});

it("loads the current version when the version that the frame loaded is gone", async () => {
  // The sitting of the loaded version ended on the text where it started.
  vi.mocked(api.versionSource).mockRejectedValue(
    new APIError(404, "not_found", "Version not found"),
  );
  const get = vi.spyOn(api, "documentChanges");
  const { client, reload, rerender } = setup({ latest: 2, editing: false });
  const order: string[] = [];
  vi.spyOn(client, "refetchQueries").mockImplementation(async () => {
    order.push("document");
  });
  reload.mockImplementation(() => order.push("frame"));

  await act(() => vi.advanceTimersByTimeAsync(0));

  // The page reads the document first: its current version is another one.
  expect(client.refetchQueries).toHaveBeenCalledWith({
    queryKey: queryKeys.document("doc_1"),
    exact: true,
  });
  expect(order).toEqual(["document", "frame"]);
  // The next events ask for nothing more.
  rerender({ latest: 3 });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(api.versionSource).toHaveBeenCalledOnce();
  expect(get).not.toHaveBeenCalled();
  expect(reload).toHaveBeenCalledOnce();
});

it("asks the server for nothing but the operation when Edit mode ends", async () => {
  const fetched = vi.spyOn(globalThis, "fetch");
  const send = vi.spyOn(api, "sendOps").mockResolvedValue(sent(2));
  const { frame, result, rerender } = setup();
  frame.regions = [second("Try it now.")];
  act(() => result.current.changed());

  // Done sends the edits on screen, and then Edit mode ends.
  expect(await act(() => result.current.settle())).toBe(true);
  rerender({ editing: false });
  await act(() => vi.advanceTimersByTimeAsync(60_000));

  expect(send).toHaveBeenCalledOnce();
  expect(fetched).not.toHaveBeenCalled();
});

it("gives the frame the exact place of text that another person put in among equal characters", async () => {
  const HERE = "<p>here. It</p>";
  sources(HERE);
  // The reader typed a space after "here.". Another person typed a space
  // at the same caret, and the server put it after the one of the reader.
  const others = [[{ start: 9, end: 9, old_html: "", new_html: " " }]];
  vi.spyOn(api, "sendOps").mockResolvedValue({ ...sent(3), others });
  const { frame, key, patch } = setup();
  patch.mockImplementationOnce(async () => {
    frame.regions = [first("here.   It")];
    return { ...frame, ok: true, stale: false };
  });

  frame.regions = [first("here.  It")];
  await key();

  expect(api.sendOps).toHaveBeenCalledOnce();
  expect(patch).toHaveBeenCalledExactlyOnceWith(
    [{ in: 0, after: null, before: null, html: "here.   It", marks: [[6, 7]] }],
    0,
    false,
    false,
  );
});

it("gives no marks when the operations of other people are not known", async () => {
  // The answer does not make the source of the server: the text of the
  // reader merges into the live document from the two sources.
  vi.spyOn(api, "sendOps").mockResolvedValue({ ...sent(3, merged), sum: SUM + 1 });
  live(MERGED, 3);
  const { type, patch, patched } = setup();
  patched([first("Try this."), second("Try it now.")]);

  await type("Try it now.");

  expect(patch.mock.calls[0][0]).toEqual([
    expect.not.objectContaining({ marks: expect.anything() }),
  ]);
});
