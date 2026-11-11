import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, APIError, type ApprovalsList, type Document } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { findLiterals, type Render } from "@/lib/script-literals";
import * as sourceEdits from "@/lib/source-edits";
import { readTextDraft, writeTextDraft } from "@/lib/text-drafts";
import type { Patch, Region, ScriptChange } from "../../bridge/source-pieces";
import type { TextPatchResult } from "./doc-context";
import { useLiveText } from "./use-live-text";

vi.mock("@/lib/source-edits", { spy: true });

const SOURCE = "<p>Try it.</p><p>Try it.</p>";
const loaded = { version: "ver_1", load: 0 };

beforeEach(async () => {
  // parse5 and acorn load on the first parse. Load them before the timers
  // stop.
  await sourceEdits.parseSource("");
  await findLiterals("", "x");
  vi.mocked(sourceEdits.parseSource).mockClear();
  vi.useFakeTimers();
  vi.spyOn(api, "getVersionHTML").mockResolvedValue(SOURCE);
  vi.spyOn(api, "getDocument").mockResolvedValue({ id: "doc_1" } as Document);
});
afterEach(() => {
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

// The answer of the server for a save. others is the source of the new
// version when the server merged the save: then the answer names what turns
// the source that the save made into it.
const saved = (
  id: string,
  others?: { from: string; to: string },
  change_summary?: string,
) => ({
  id,
  number: Number(id.slice(4)),
  base_version_id: "ver_1",
  rebased: !!others,
  others: others && sourceEdits.replacementsBetween(others.from, others.to),
  change_summary,
});

const asha = { type: "user" as const, id: "usr_a", name: "Asha" };

// The answer of the server for the changes from one source to the source of
// its current version.
const changes = (version_id: string, from: string, to: string, live = true) => ({
  version_id,
  from_version_id: "ver_from",
  replacements: sourceEdits.replacementsBetween(from, to),
  live,
  authors: [asha],
});

function setup(props: { latest?: string; others?: boolean } = {}) {
  // What the frame shows: every region that changed since it loaded, and
  // the count of the reader's operations.
  const frame = { regions: [] as Region[], scripts: [] as ScriptChange[], edits: 0 };
  const options = {
    docId: "doc_1",
    loaded,
    latest: undefined as string | undefined,
    live: true,
    others: false,
    take: vi.fn(async () => ({ ...frame })),
    patch:
      vi.fn<
        (patches: Patch[], edits: number, flash: boolean) => Promise<TextPatchResult>
      >(),
    setState: vi.fn(),
    move: vi.fn(),
    reload: vi.fn(),
    holdUpdate: vi.fn(),
    probe: vi.fn<Render>(),
    replaceText: vi.fn(),
    ...props,
  };
  const client = new QueryClient();
  const hook = renderHook(() => useLiveText({ ...options }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  const { result } = hook;
  // The page gives new options to the hook.
  const rerender = (next: Partial<typeof options>) => {
    Object.assign(options, next);
    hook.rerender();
  };
  const pause = async () => {
    act(() => result.current.changed(1));
    await act(() => vi.advanceTimersByTimeAsync(1500));
  };
  // The reader types text in the second paragraph, then pauses.
  const type = async (text: string) => {
    frame.regions = [...frame.regions.filter((r) => r.from !== 14), second(text)];
    await pause();
  };
  // The frame applies each patch, and shows the regions after it.
  const patched = (regions: Region[]) =>
    options.patch.mockImplementationOnce(async () => {
      frame.regions = regions;
      return { ...frame, ok: true, stale: false };
    });
  return { ...options, client, frame, type, pause, patched, result, hook, rerender };
}

it("saves the edits as replacements on the loaded version", async () => {
  const edit = vi.spyOn(api, "editSource").mockResolvedValue(saved("ver_2"));
  const { type, move, setState } = setup();

  await type("Try it now.");

  expect(edit).toHaveBeenCalledWith("doc_1", {
    base_version_id: "ver_1",
    client_change_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    replacements: [{ start: 21, end: 24, old_html: "it.", new_html: "it now." }],
  });
  expect(move).toHaveBeenCalledExactlyOnceWith("ver_2", "ver_1");
  expect(setState).toHaveBeenLastCalledWith("saved");
});

it("settles the edits at once, after the save on its way, and says whether all saved", async () => {
  let land = () => {};
  const edit = vi
    .spyOn(api, "editSource")
    .mockImplementationOnce(
      () => new Promise((done) => (land = () => done(saved("ver_2")))),
    )
    .mockResolvedValueOnce(saved("ver_3"))
    .mockRejectedValueOnce(new TypeError("Failed to fetch"));
  const { type, frame, result } = setup();
  // Nothing typed: nothing to save.
  expect(await act(() => result.current.settle())).toBe(true);

  await type("Try it now.");
  // The reader typed more while the first save was on its way.
  frame.regions = [second("Try it now!")];
  act(() => result.current.changed(1));
  const settled = act(() => result.current.settle());
  land();
  expect(await settled).toBe(true);
  expect(edit).toHaveBeenCalledTimes(2);

  frame.regions = [second("Try it later.")];
  act(() => result.current.changed(1));
  expect(await act(() => result.current.settle())).toBe(false);
});

it("saves each pause on top of the last save", async () => {
  const edit = vi
    .spyOn(api, "editSource")
    .mockResolvedValueOnce(saved("ver_2"))
    .mockResolvedValueOnce(saved("ver_3"));
  const { type } = setup();

  await type("Try it now.");
  await type("Try it now!");

  const [first, next] = edit.mock.calls.map(([, input]) => input);
  expect(next.base_version_id).toBe("ver_2");
  expect(next.client_change_id).not.toBe(first.client_change_id);
  expect(sourceEdits.replacementsBetween).toHaveBeenLastCalledWith(
    "<p>Try it.</p><p>Try it now.</p>",
    "<p>Try it.</p><p>Try it now!</p>",
  );
  expect(next.replacements).toEqual([
    { start: 24, end: 28, old_html: "now.", new_html: "now!" },
  ]);
  // The loaded version is read and parsed once.
  expect(api.getVersionHTML).toHaveBeenCalledTimes(1);
  expect(sourceEdits.parseSource).toHaveBeenCalledTimes(1);
});

it("sends a failed save again with the same change id and body", async () => {
  const edit = vi
    .spyOn(api, "editSource")
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce(saved("ver_2"));
  const { type, setState, reload } = setup();

  await type("Try it now.");
  expect(setState).toHaveBeenLastCalledWith("failed");
  await act(() => vi.advanceTimersByTimeAsync(5000));

  expect(edit).toHaveBeenCalledTimes(2);
  expect(edit.mock.calls[1][1]).toEqual(edit.mock.calls[0][1]);
  expect(setState).toHaveBeenLastCalledWith("saved");
  expect(reload).not.toHaveBeenCalled();
});

const THEIRS = "<p>Try this.</p><p>Try it.</p>";
const MERGED = "<p>Try this.</p><p>Try it now.</p>";

const MINE = "<p>Try it.</p><p>Try it now.</p>";
const merged = { from: MINE, to: MERGED };

it("shows the text of other people that a merged save answers with, in place", async () => {
  const edit = vi
    .spyOn(api, "editSource")
    .mockResolvedValueOnce(saved("ver_3", merged));
  const get = vi.spyOn(api, "documentChanges");
  const { type, patch, patched, move, reload, holdUpdate } = setup();
  patched([first("Try this."), second("Try it now.")]);

  await type("Try it now.");

  // The answer of the save names the changes: no request asks for them.
  expect(get).not.toHaveBeenCalled();
  // The frame already shows the text of the reader: only the text of the
  // other person goes to it, and it does not flash.
  expect(patch).toHaveBeenCalledExactlyOnceWith(
    [{ in: 0, after: null, before: null, html: "Try this." }],
    0,
    false,
  );
  expect(move).toHaveBeenCalledExactlyOnceWith("ver_3", "ver_1");
  expect(holdUpdate).toHaveBeenLastCalledWith(undefined);
  expect(reload).not.toHaveBeenCalled();

  // The next save is on top of the merged version.
  edit.mockResolvedValueOnce(saved("ver_4"));
  await type("Try it now!");
  expect(edit.mock.lastCall![1]).toMatchObject({
    base_version_id: "ver_3",
    replacements: [{ start: 26, end: 30, old_html: "now.", new_html: "now!" }],
  });
  expect(move).toHaveBeenLastCalledWith("ver_4", "ver_1");
});

it("saves the text typed during a merged save on the version that holds that save", async () => {
  const { type, frame, patch, move } = setup();
  const edit = vi.spyOn(api, "editSource").mockImplementationOnce(async () => {
    frame.regions = [second("Try it now, please.")];
    frame.edits = 1;
    return saved("ver_3", merged);
  });
  edit.mockResolvedValueOnce(saved("ver_4"));
  // The frame does not answer for the patch in time: the words typed
  // meanwhile still save on the merged version, at their place in it.
  patch.mockRejectedValue(new Error("The document did not answer."));

  await type("Try it now.");
  await act(() => vi.advanceTimersByTimeAsync(1500));

  expect(edit).toHaveBeenCalledTimes(2);
  expect(edit.mock.lastCall![1]).toMatchObject({
    base_version_id: "ver_3",
    replacements: [{ start: 26, end: 30, old_html: "now.", new_html: "now, please." }],
  });
  expect(move).not.toHaveBeenCalledWith("ver_3", expect.anything());
});

it("reads the merged version when the answer of the save does not fit", async () => {
  vi.spyOn(api, "editSource").mockResolvedValueOnce({
    ...saved("ver_3", merged),
    others: [{ start: 0, end: 3, old_html: "<h1", new_html: "<h2" }],
  });
  const { type, patched, move } = setup();
  vi.mocked(api.getVersionHTML).mockImplementation(async (_doc, version) =>
    version === "ver_3" ? MERGED : SOURCE,
  );
  patched([first("Try this."), second("Try it now.")]);

  await type("Try it now.");

  expect(api.getVersionHTML).toHaveBeenLastCalledWith("doc_1", "ver_3");
  expect(move).toHaveBeenCalledExactlyOnceWith("ver_3", "ver_1");
});

it("patches again when a key came between the take and the patch", async () => {
  vi.spyOn(api, "documentChanges").mockResolvedValue(changes("ver_2", SOURCE, THEIRS));
  const edit = vi.spyOn(api, "editSource").mockResolvedValue(saved("ver_3"));
  const { frame, patch, patched, move } = setup({ latest: "ver_2" });
  patch.mockImplementationOnce(async () => {
    frame.regions = [second("Try it now.")];
    frame.edits = 1;
    return { ...frame, ok: false, stale: true };
  });
  patched([first("Try this."), second("Try it now.")]);

  await act(() => vi.advanceTimersByTimeAsync(0));

  expect(patch).toHaveBeenCalledTimes(2);
  expect(patch.mock.lastCall!.slice(1)).toEqual([1, false]);
  expect(move).toHaveBeenCalledExactlyOnceWith("ver_2", "ver_1");
  // The frame holds the key: it saves as a change does.
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(edit).toHaveBeenCalledExactlyOnceWith(
    "doc_1",
    expect.objectContaining({
      base_version_id: "ver_2",
      replacements: [{ start: 23, end: 26, old_html: "it.", new_html: "it now." }],
    }),
  );
});

it("tries the patch again at the next pause when the keys do not stop", async () => {
  vi.spyOn(api, "documentChanges").mockResolvedValue(changes("ver_2", SOURCE, THEIRS));
  const { frame, patch, patched, move, reload } = setup({ latest: "ver_2" });
  patch.mockImplementation(async () => ({ ...frame, ok: false, stale: true }));

  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(patch).toHaveBeenCalledTimes(4);

  patch.mockReset();
  patched([first("Try this.")]);
  await act(() => vi.advanceTimersByTimeAsync(1500));
  expect(move).toHaveBeenCalledExactlyOnceWith("ver_2", "ver_1");
  // The frame did not load again: a stale patch is not a failed patch.
  expect(reload).not.toHaveBeenCalled();
});

it.each([
  ["refuses the patch", { ok: false }],
  ["does not show the target after the patch", { ok: true }],
])("loads the head in the frame when the frame %s", async (_name, { ok }) => {
  vi.spyOn(api, "documentChanges").mockResolvedValue(changes("ver_2", SOURCE, THEIRS));
  const { frame, patch, move, reload } = setup({ latest: "ver_2" });
  patch.mockImplementation(async () => ({ ...frame, ok, stale: false }));

  await act(() => vi.advanceTimersByTimeAsync(0));

  expect(move).not.toHaveBeenCalled();
  expect(reload).toHaveBeenCalledExactlyOnceWith("ver_2");
});

it("never saves the text of a patch that did not make its target", async () => {
  const edit = vi.spyOn(api, "editSource").mockResolvedValue(saved("ver_3", merged));
  const { frame, type, patch, reload } = setup();
  // The patch leaves other text in the frame.
  patch.mockImplementation(async () => {
    frame.regions = [first("Try what?"), second("Try it now.")];
    return { ...frame, ok: true, stale: false };
  });

  await type("Try it now.");
  await act(() => vi.advanceTimersByTimeAsync(1));

  expect(edit).toHaveBeenCalledOnce();
  expect(reload).toHaveBeenCalledExactlyOnceWith("ver_3");
});

it("saves the text on screen before it loads a head that the frame cannot show", async () => {
  const order: string[] = [];
  vi.spyOn(api, "editSource").mockImplementation(async () => {
    order.push("save");
    return saved("ver_3", merged);
  });
  const { frame, type, patch, reload } = setup();
  patch.mockImplementation(async () => ({ ...frame, ok: false, stale: false }));
  reload.mockImplementation(() => order.push("load"));

  await type("Try it now.");
  // The save after the follow starts on the next tick.
  await act(() => vi.advanceTimersByTimeAsync(1));

  expect(order).toEqual(["save", "load"]);
  expect(reload).toHaveBeenCalledExactlyOnceWith("ver_3");
});

it("shows live typing of another person to a reader in place, with no banner", async () => {
  const get = vi
    .spyOn(api, "documentChanges")
    .mockResolvedValue(changes("ver_2", SOURCE, THEIRS));
  const { patch, patched, move, holdUpdate, rerender } = setup();
  patched([first("Try this.")]);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(get).not.toHaveBeenCalled();

  rerender({ latest: "ver_2" });
  await act(() => vi.advanceTimersByTimeAsync(0));

  expect(patch).toHaveBeenCalledExactlyOnceWith(
    [{ in: 0, after: null, before: null, html: "Try this." }],
    0,
    false,
  );
  expect(move).toHaveBeenCalledExactlyOnceWith("ver_2", "ver_1");
  expect(holdUpdate).not.toHaveBeenCalledWith(expect.anything());

  // The next change comes from the new head.
  get.mockResolvedValue(changes("ver_3", THEIRS, MERGED));
  patched([first("Try this."), second("Try it now.")]);
  rerender({ latest: "ver_3" });
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(get).toHaveBeenLastCalledWith("doc_1", "ver_2");
  expect(move).toHaveBeenLastCalledWith("ver_3", "ver_2");
});

it("does not follow a preview, or a frame that is not ready", async () => {
  const get = vi.spyOn(api, "documentChanges");
  setup({ latest: "ver_2", live: false } as never);
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(get).not.toHaveBeenCalled();
});

it("flashes a small change that is not live typing", async () => {
  vi.spyOn(api, "documentChanges").mockResolvedValue(
    changes("ver_2", SOURCE, THEIRS, false),
  );
  const { patch, patched, holdUpdate } = setup({ latest: "ver_2" });
  patched([first("Try this.")]);

  await act(() => vi.advanceTimersByTimeAsync(0));

  expect(patch).toHaveBeenCalledExactlyOnceWith(expect.anything(), 0, true);
  expect(holdUpdate).not.toHaveBeenCalledWith(expect.anything());
});

describe("a large change that is not live typing", () => {
  const words = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
  const LARGE = `<p>${words}</p><p>Try it.</p>`;

  it("waits behind the banner, and the head stays", async () => {
    const get = vi
      .spyOn(api, "documentChanges")
      .mockResolvedValue(changes("ver_2", SOURCE, LARGE, false));
    const { patch, move, holdUpdate, rerender } = setup({ latest: "ver_2" });

    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(holdUpdate).toHaveBeenLastCalledWith({ authors: [asha] });
    expect(patch).not.toHaveBeenCalled();
    expect(move).not.toHaveBeenCalled();

    // The next change asks for the whole difference again.
    rerender({ latest: "ver_3" });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(get).toHaveBeenLastCalledWith("doc_1", "ver_1");
  });

  it("applies when the frame holds text that was not saved", async () => {
    vi.spyOn(api, "editSource").mockResolvedValue(saved("ver_3"));
    vi.spyOn(api, "documentChanges").mockResolvedValue(
      changes("ver_2", SOURCE, `<p>${words}</p><p>Try it.</p>`, false),
    );
    const { frame, patched, move, holdUpdate, rerender } = setup();
    patched([first(words), second("Try it now.")]);

    // The reader typed, and the change came before the pause ended.
    frame.regions = [second("Try it now.")];
    rerender({ latest: "ver_2" });
    await act(() => vi.advanceTimersByTimeAsync(0));

    // The change goes in around the text of the reader, which then saves.
    expect(holdUpdate).not.toHaveBeenCalledWith(expect.anything());
    expect(move).toHaveBeenCalledExactlyOnceWith("ver_2", "ver_1");
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(api.editSource).toHaveBeenCalledOnce();
    expect(vi.mocked(api.editSource).mock.lastCall![1].base_version_id).toBe("ver_2");
  });
});

describe("a head that the server does not have", () => {
  const unfit = {
    ...changes("ver_2", SOURCE, THEIRS),
    replacements: [{ start: 0, end: 3, old_html: "<h1", new_html: "<h2" }],
  };

  it("loads the newest version when no text is unsaved", async () => {
    vi.spyOn(api, "documentChanges").mockResolvedValue(unfit);
    const { reload, patch } = setup({ latest: "ver_2" });

    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(patch).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledExactlyOnceWith("ver_2");
  });

  it("keeps text that the reader typed meanwhile, and says that it cannot save", async () => {
    const error = vi.spyOn(toast, "error");
    const { reload, result, setState } = setup({ latest: "ver_2" });
    vi.spyOn(api, "documentChanges").mockImplementation(async () => {
      result.current.changed(1);
      return unfit;
    });

    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(reload).not.toHaveBeenCalled();
    expect(setState).toHaveBeenLastCalledWith("refused");
    expect(error).toHaveBeenLastCalledWith(
      "This edit does not fit the latest version of the document, so it cannot save.",
      expect.objectContaining({
        cancel: expect.objectContaining({ label: "Discard my change" }),
      }),
    );
  });
});

it.each([403, 404])(
  "asks for the document again when the changes answer %i",
  async (status) => {
    vi.spyOn(api, "documentChanges").mockRejectedValue(
      new APIError(status, "forbidden", "no"),
    );
    const { client } = setup({ latest: "ver_2" });
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
    .mockResolvedValue(changes("ver_2", SOURCE, THEIRS));
  const { patched, move } = setup({ latest: "ver_2" });
  patched([first("Try this.")]);

  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(move).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(5000));

  expect(get).toHaveBeenCalledTimes(2);
  expect(move).toHaveBeenCalledExactlyOnceWith("ver_2", "ver_1");
});

it("saves fast while other people have the document open", async () => {
  const edit = vi.spyOn(api, "editSource").mockResolvedValue(saved("ver_2"));
  const { frame, result } = setup({ others: true });
  const key = (text: string) => {
    frame.regions = [second(text)];
    act(() => result.current.changed(1));
  };

  // A pause of 300 ms saves.
  key("Try it now.");
  await act(() => vi.advanceTimersByTimeAsync(299));
  expect(edit).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(1));
  expect(edit).toHaveBeenCalledTimes(1);

  // Keys without a pause save 700 ms after the first one.
  for (const text of ["a", "ab", "abc"]) {
    key(text);
    await act(() => vi.advanceTimersByTimeAsync(250));
  }
  expect(edit).toHaveBeenCalledTimes(2);
});

it("clears the unsaved state when a new load drops the draft", async () => {
  vi.spyOn(api, "editSource").mockRejectedValue(
    new APIError(422, "edit_failed", "the edit does not fit"),
  );
  const { type, setState, rerender } = setup();

  await type("Try it now.");
  expect(setState).toHaveBeenLastCalledWith("refused");
  rerender({ loaded: { version: "ver_2", load: 1 } });

  expect(setState).toHaveBeenLastCalledWith("idle");
});

it("saves the last draft when the frame goes before the pause", async () => {
  const edit = vi.spyOn(api, "editSource").mockResolvedValue(saved("ver_2"));
  const { result, hook, take } = setup();

  act(() => {
    result.current.drafted({ regions: [second("Try it now.")], scripts: [], edits: 1 });
    result.current.changed(1);
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
});

it("counts the attempts of a save that fails, and offers a copy", async () => {
  const error = vi.spyOn(toast, "error");
  vi.spyOn(api, "editSource").mockRejectedValue(new TypeError("Failed to fetch"));
  const { type } = setup();

  await type("Try it now.");
  await act(() => vi.advanceTimersByTimeAsync(5000));

  expect(error).toHaveBeenLastCalledWith(
    "Your edits are not saved yet. Trying again (attempt 2)…",
    expect.objectContaining({
      action: expect.objectContaining({ label: "Copy my text" }),
    }),
  );
});

it.each([403, 404])(
  "names a failed read of the saved version (%i), tries it again, and copies the words",
  async (status) => {
    const error = vi.spyOn(toast, "error");
    const edit = vi.spyOn(api, "editSource").mockResolvedValue(saved("ver_2"));
    vi.mocked(api.getVersionHTML).mockRejectedValueOnce(
      new APIError(status, "not_found", "gone"),
    );
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { type, setState } = setup();

    await type("Try it now.");

    expect(setState).toHaveBeenLastCalledWith("failed");
    expect(edit).not.toHaveBeenCalled();
    const [message, options] = error.mock.lastCall!;
    expect(message).toBe(
      "The saved version of this document did not load, so your edits are not saved yet. Trying again (attempt 1)…",
    );
    const { action, cancel } = options as unknown as {
      action: { label: string; onClick: (e: { preventDefault(): void }) => void };
      cancel: { label: string };
    };
    expect(cancel.label).toBe("Try now");
    await act(async () => action.onClick({ preventDefault() {} }));
    expect(writeText).toHaveBeenCalledWith("Try it now.");

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(edit).toHaveBeenCalled();
    expect(setState).toHaveBeenLastCalledWith("saved");
  },
);

it("saves nothing when the edits cannot be written into the source", async () => {
  const error = vi.spyOn(toast, "error");
  const edit = vi.spyOn(api, "editSource");
  vi.mocked(sourceEdits.applyRegions).mockReturnValueOnce({
    refused: "A script moved this content.",
  });
  const { type, reload, setState, result } = setup();

  await type("Try it now.");

  expect(edit).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(
    "This edit does not fit the source of the document, so it cannot save.",
    expect.anything(),
  );
  expect(setState).toHaveBeenLastCalledWith("refused");

  // Retry, or Done, says why again, with the choices.
  error.mockClear();
  expect(await act(() => result.current.settle())).toBe(false);
  expect(error).toHaveBeenCalledExactlyOnceWith(
    "This edit does not fit the source of the document, so it cannot save.",
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
  [
    422,
    "edit_failed",
    "This edit does not fit the latest version of the document, so it cannot save.",
  ],
  [400, "bad_request", "The server did not take this change, so it cannot save."],
])(
  "keeps the text on screen until the reader chooses when the server refuses a save with %i",
  async (status, code, message) => {
    const error = vi.spyOn(toast, "error");
    const write = stubClipboard();
    vi.spyOn(api, "editSource").mockRejectedValue(new APIError(status, code, "no"));
    const { type, reload, move, setState, result } = setup();

    act(() =>
      result.current.drafted({
        regions: [second("Try it now.")],
        scripts: [],
        edits: 1,
      }),
    );
    await type("Try it now.");
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(move).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(setState).toHaveBeenLastCalledWith("refused");
    const [shown, options] = error.mock.lastCall!;
    expect(shown).toBe(message);
    const { action, cancel, duration } = options as Actions & { duration: number };
    expect(duration).toBe(Infinity);
    expect([action.label, cancel.label]).toEqual(["Copy my text", "Discard my change"]);
    // The text also waits in storage, for a visit after this one.
    expect(readTextDraft("doc_1")).toMatchObject({ version: "ver_1" });
    await act(async () => action.onClick({ preventDefault: vi.fn() }));
    expect(write).toHaveBeenCalledWith("Try it now.");
    // Discard loads the saved version, which drops the draft.
    cancel.onClick();
    expect(reload).toHaveBeenCalledExactlyOnceWith("ver_1");
  },
);

it("says nothing is saved when the edits went back to the loaded text", async () => {
  const edit = vi.spyOn(api, "editSource");
  const { pause, setState } = setup();

  await pause();

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

  it("says that a save resets the approval, and that the save after it restores it", async () => {
    const info = vi.spyOn(toast, "info");
    approvedOn({ ver_1: true, ver_3: true });
    vi.spyOn(api, "editSource")
      .mockResolvedValueOnce(saved("ver_2", undefined, "Changed “it.” to “it now.”"))
      .mockResolvedValueOnce(saved("ver_3", undefined, "Changed “it now.” to “it.”"));
    const { type, result } = setup();
    await act(() => vi.advanceTimersByTimeAsync(0));

    await type("Try it now.");
    expect(info.mock.lastCall![0]).toBe("The approval of Rev is reset.");
    await type("Try it.");
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
      .spyOn(api, "editSource")
      .mockRejectedValue(new APIError(422, "edit_failed", "the edit does not fit"));

  it("waits in storage after the page goes, and is offered on the next visit", async () => {
    refuse();
    const first = setup();
    act(() =>
      first.result.current.drafted({
        ...first.frame,
        regions: [second("Try it now.")],
      }),
    );
    await first.type("Try it now.");
    // The words typed after the refusal wait too.
    act(() =>
      first.result.current.drafted({ ...first.frame, regions: [second("Keep it.")] }),
    );
    const dismiss = vi.spyOn(toast, "dismiss");
    first.hook.unmount();
    expect(dismiss).toHaveBeenCalledWith("autosave-refused");

    const error = vi.spyOn(toast, "error");
    const write = stubClipboard();
    setup();
    const [message, options] = error.mock.lastCall!;
    expect(message).toBe("You have text in this document that was not saved.");
    const { action, cancel } = options as Actions;
    await act(async () => action.onClick({ preventDefault: vi.fn() }));
    // The text is read from the version that the edits were typed on.
    expect(api.getVersionHTML).toHaveBeenLastCalledWith("doc_1", "ver_1");
    expect(write).toHaveBeenCalledWith("Keep it.");
    expect(cancel.label).toBe("Discard my change");
    cancel.onClick();
    expect(readTextDraft("doc_1")).toBeUndefined();
  });

  it("leaves storage when the text saves, or when the reader shows the saved version", async () => {
    const edit = refuse();
    const { type, result, rerender } = setup();
    act(() =>
      result.current.drafted({
        regions: [second("Try it now.")],
        scripts: [],
        edits: 1,
      }),
    );
    await type("Try it now.");
    expect(readTextDraft("doc_1")).toBeDefined();
    rerender({ loaded: { version: "ver_2", load: 1 } });
    expect(readTextDraft("doc_1")).toBeUndefined();

    edit.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    edit.mockResolvedValueOnce(saved("ver_3"));
    await type("Try it again.");
    expect(readTextDraft("doc_1")).toBeDefined();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(readTextDraft("doc_1")).toBeUndefined();
  });

  it("keeps the draft of an earlier visit until the reader discards it", async () => {
    writeTextDraft("doc_1", { version: "ver_0", edits: { regions: [], scripts: [] } });
    vi.spyOn(api, "editSource").mockResolvedValue(saved("ver_2"));
    const { type } = setup();

    await type("Try it now.");

    expect(readTextDraft("doc_1")).toMatchObject({ version: "ver_0" });
  });
});

describe("script text", () => {
  const SCRIPT = `<p></p><p></p><script>for (const p of document.querySelectorAll("p")) p.textContent = "Try it.";</script>`;
  const change = { locator: { at: 0, path: [] }, before: "Try it.", after: "Run it." };
  const literalAt = SCRIPT.indexOf(`"Try it."`);

  // A probe that runs the script above: the paragraphs show its string.
  const render =
    (
      shows = (html: string) => (html.includes(`"Run it."`) ? "Run it." : "Try it."),
    ): Render =>
    async (html, _locator, strings) => ({
      text: shows(html),
      counts: strings.map((s) => (s === shows(html) ? 2 : 0)),
      texts: 2,
      errors: 0,
    });

  beforeEach(() => vi.mocked(api.getVersionHTML).mockResolvedValue(SCRIPT));

  it("lets the reader type in text that one string holds", async () => {
    const { result } = setup();
    expect(await result.current.scriptEditable(" Try it. ")).toBe(true);
    expect(await result.current.scriptEditable("Run it.")).toBe(false);
  });

  it("saves a change that shows, and changes its other places in place", async () => {
    const edit = vi
      .spyOn(api, "editSource")
      .mockResolvedValue(
        saved("ver_2", undefined, "Changed “Try it.” to “Run it.” in 2 places"),
      );
    const { frame, probe, pause, reload, replaceText } = setup();
    probe.mockImplementation(render());

    frame.scripts = [change];
    await pause();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenLastCalledWith("doc_1", {
      base_version_id: "ver_1",
      client_change_id: expect.any(String),
      replacements: [
        { start: literalAt, end: literalAt + 4, old_html: '"Try', new_html: '"Run' },
      ],
      change_summary: "Changed “Try it.” to “Run it.” in 2 places",
    });
    expect(reload).not.toHaveBeenCalled();
    expect(replaceText).toHaveBeenLastCalledWith("Try it.", "Run it.");
  });

  it("saves text typed back to its loaded text, and changes its other places back", async () => {
    const edit = vi.spyOn(api, "editSource").mockResolvedValue(saved("ver_2"));
    const { frame, probe, pause, replaceText } = setup();
    probe.mockImplementation(render());
    frame.scripts = [change];
    await pause();

    edit.mockResolvedValue(saved("ver_3"));
    frame.scripts = [{ ...change, after: "Try it." }];
    await pause();

    expect(probe).toHaveBeenCalledTimes(2);
    expect(edit).toHaveBeenLastCalledWith(
      "doc_1",
      expect.objectContaining({
        base_version_id: "ver_2",
        replacements: [
          { start: literalAt, end: literalAt + 4, old_html: '"Run', new_html: '"Try' },
        ],
        change_summary: "Changed “Run it.” to “Try it.” in 2 places",
      }),
    );
    expect(replaceText).toHaveBeenLastCalledWith("Run it.", "Try it.");
  });

  it("refuses a change that does not show where the reader typed it, and saves the rest", async () => {
    const error = vi.spyOn(toast, "error");
    const edit = vi.spyOn(api, "editSource").mockResolvedValue(saved("ver_2"));
    const { frame, probe, pause, reload, setState } = setup();
    probe.mockImplementation(render(() => "Try it."));

    frame.scripts = [change];
    await pause();
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

    // The next save checks it no more, and saves the other edits.
    frame.regions = [
      {
        from: 7,
        to: 7,
        pieces: [{ element: 7, children: [{ text: "Hi" }] }],
        removed: [],
      },
    ];
    await pause();
    expect(probe).toHaveBeenCalledTimes(2);
    expect(setState).toHaveBeenLastCalledWith("refused");
    expect(edit.mock.lastCall![1].replacements).toEqual([
      { start: 10, end: 10, old_html: "", new_html: "Hi" },
    ]);
    expect(reload).not.toHaveBeenCalled();
  });
});
