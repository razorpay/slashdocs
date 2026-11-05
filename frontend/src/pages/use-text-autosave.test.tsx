import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, APIError, type ApprovalsList, type Document } from "@/api";
import { findLiterals, type Render } from "@/lib/script-literals";
import * as sourceEdits from "@/lib/source-edits";
import { readTextDraft, writeTextDraft } from "@/lib/text-drafts";
import type { Region, ScriptChange } from "../../bridge/source-pieces";
import type { SaveNote } from "./doc-context";
import { useTextAutosave } from "./use-text-autosave";

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

// The second paragraph, with new text.
const second = (text: string): Region => ({
  from: 14,
  to: 14,
  pieces: [{ element: 14, children: [{ text }] }],
  removed: [],
});

const saved = (id: string, rebased = false, change_summary?: string) => ({
  id,
  number: Number(id.slice(4)),
  base_version_id: "ver_1",
  rebased,
  change_summary,
});

function setup() {
  // What the frame shows: every region that changed since it loaded.
  const frame = { regions: [] as Region[], scripts: [] as ScriptChange[] };
  const options = {
    docId: "doc_1",
    loaded,
    take: vi.fn(async () => ({ ...frame })),
    setState: vi.fn(),
    note: vi.fn<(note?: SaveNote) => void>(),
    onSaved: vi.fn(),
    reload: vi.fn(),
    undo: vi.fn(),
    probe: vi.fn<Render>(),
    replaceText: vi.fn(),
  };
  const client = new QueryClient();
  const hook = renderHook(
    (props: { loaded: typeof loaded }) => useTextAutosave({ ...options, ...props }),
    {
      initialProps: { loaded },
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  const { result } = hook;
  const pause = async () => {
    act(() => result.current.changed(1));
    await act(() => vi.advanceTimersByTimeAsync(1500));
  };
  // The reader types text in the second paragraph, then pauses.
  const type = async (text: string) => {
    frame.regions = [second(text)];
    await pause();
  };
  return { ...options, frame, type, pause, result, hook };
}

it("saves the edits as replacements on the loaded version", async () => {
  const edit = vi.spyOn(api, "editSource").mockResolvedValue(saved("ver_2"));
  const { type, onSaved, setState } = setup();

  await type("Try it now.");

  expect(edit).toHaveBeenCalledWith("doc_1", {
    base_version_id: "ver_1",
    client_change_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
    replacements: [{ start: 21, end: 24, old_html: "it.", new_html: "it now." }],
  });
  expect(onSaved).toHaveBeenCalledWith("ver_2", true);
  expect(setState).toHaveBeenLastCalledWith("saved");
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

it("shows the merged version after a rebased save when nothing more was typed", async () => {
  vi.spyOn(api, "editSource").mockResolvedValue(saved("ver_3", true));
  const { type, onSaved, reload } = setup();

  await type("Try it now.");

  expect(onSaved).toHaveBeenCalledWith("ver_3", false);
  // The load shows the version that the save made, not the one before it.
  expect(reload).toHaveBeenCalledExactlyOnceWith("ver_3");
});

it("keeps the frame after a rebased save when the reader typed during it", async () => {
  const error = vi.spyOn(toast, "error");
  const { type, frame, reload, setState } = setup();
  vi.spyOn(api, "editSource").mockImplementation(async () => {
    frame.regions = [second("Try it now, please.")];
    return saved("ver_3", true);
  });

  await type("Try it now.");

  expect(reload).not.toHaveBeenCalled();
  expect(setState).toHaveBeenLastCalledWith("paused");
  expect(error).toHaveBeenCalledWith(
    expect.stringContaining("not saved"),
    expect.objectContaining({
      action: expect.objectContaining({ label: "Show the latest version" }),
    }),
  );
});

it("keeps the draft and stops saving when someone else changed the same text", async () => {
  const error = vi.spyOn(toast, "error");
  const write = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText: write } });
  const edit = vi
    .spyOn(api, "editSource")
    .mockRejectedValue(new APIError(409, "edit_conflict", "the text changed"));
  const { type, reload, setState } = setup();

  await type("Try it now.");
  await type("Try it now!");

  expect(edit).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
  expect(setState).toHaveBeenLastCalledWith("paused");
  const [message, actions] = error.mock.lastCall!;
  expect(message).toBe(
    "Someone else changed the same text. Your text stays on screen and is not saved.",
  );
  const { action, cancel } = actions as {
    action: { label: string; onClick: (e: { preventDefault(): void }) => void };
    cancel: { label: string; onClick: () => void };
  };
  expect([action.label, cancel.label]).toEqual(["Copy my text", "Show their version"]);
  // The copy holds what the reader typed after the conflict too.
  await act(async () => action.onClick({ preventDefault: vi.fn() }));
  expect(write).toHaveBeenCalledWith("Try it now!");
  cancel.onClick();
  expect(reload).toHaveBeenCalledTimes(1);
});

it("clears the unsaved state when a new load drops the draft", async () => {
  vi.spyOn(api, "editSource").mockRejectedValue(
    new APIError(409, "edit_conflict", "the text changed"),
  );
  const { type, setState, hook } = setup();

  await type("Try it now.");
  expect(setState).toHaveBeenLastCalledWith("paused");
  hook.rerender({ loaded: { version: "ver_2", load: 1 } });

  expect(setState).toHaveBeenLastCalledWith("idle");
});

it("saves the last draft when the frame goes before the pause", async () => {
  const edit = vi.spyOn(api, "editSource").mockResolvedValue(saved("ver_2"));
  const { result, hook, take } = setup();

  act(() => {
    result.current.drafted({ regions: [second("Try it now.")], scripts: [] });
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
  const { type, reload, setState } = setup();

  await type("Try it now.");

  expect(edit).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
  expect(error).toHaveBeenCalledWith(
    "This edit does not fit the source of the document, so it cannot save.",
    expect.anything(),
  );
  expect(setState).toHaveBeenLastCalledWith("refused");
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
    const { type, reload, onSaved, setState, result } = setup();

    act(() =>
      result.current.drafted({ regions: [second("Try it now.")], scripts: [] }),
    );
    await type("Try it now.");
    await act(() => vi.advanceTimersByTimeAsync(10_000));

    expect(onSaved).not.toHaveBeenCalled();
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
    // Discard shows the saved version, which drops the draft.
    cancel.onClick();
    expect(reload).toHaveBeenCalledExactlyOnceWith(undefined);
  },
);

it("says nothing is saved when the edits went back to the loaded text", async () => {
  const edit = vi.spyOn(api, "editSource");
  const { pause, setState, note } = setup();

  await pause();

  expect(edit).not.toHaveBeenCalled();
  expect(setState).toHaveBeenLastCalledWith("idle");
  expect(note).not.toHaveBeenCalled();
});

it("offers Undo once, for eight seconds, in the bar after the first save of a visit", async () => {
  const success = vi.spyOn(toast, "success");
  vi.spyOn(api, "editSource")
    .mockResolvedValueOnce(saved("ver_2", false, "Changed “it.” to “it now.”"))
    .mockResolvedValueOnce(saved("ver_3"));
  const { type, undo, note } = setup();

  await type("Try it now.");
  await type("Try it now!");

  // The note says what changed, as the history does, with no message over
  // the words.
  expect(note).toHaveBeenCalledOnce();
  expect(success).not.toHaveBeenCalled();
  const shown = note.mock.lastCall![0]!;
  expect(shown.said).toBe("Changed “it.” to “it now.”");
  await act(() => vi.advanceTimersByTimeAsync(8000));
  expect(note).toHaveBeenLastCalledWith(undefined);
  shown.undo!();
  expect(undo).toHaveBeenCalledOnce();
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
      .mockResolvedValueOnce(saved("ver_2", false, "Changed “it.” to “it now.”"))
      .mockResolvedValueOnce(saved("ver_3", false, "Changed “it now.” to “it.”"));
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
  const conflict = () =>
    vi
      .spyOn(api, "editSource")
      .mockRejectedValue(new APIError(409, "edit_conflict", "the text changed"));

  it("waits in storage after the page goes, and is offered on the next visit", async () => {
    conflict();
    const first = setup();
    act(() =>
      first.result.current.drafted({ regions: [second("Try it now.")], scripts: [] }),
    );
    await first.type("Try it now.");
    // The words typed after the conflict wait too.
    act(() =>
      first.result.current.drafted({ regions: [second("Keep it.")], scripts: [] }),
    );
    const dismiss = vi.spyOn(toast, "dismiss");
    first.hook.unmount();
    expect(dismiss).toHaveBeenCalledWith("autosave-paused");

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
    const edit = conflict();
    const { type, result, hook } = setup();
    act(() =>
      result.current.drafted({ regions: [second("Try it now.")], scripts: [] }),
    );
    await type("Try it now.");
    expect(readTextDraft("doc_1")).toBeDefined();
    hook.rerender({ loaded: { version: "ver_2", load: 1 } });
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

  it("saves a change that shows, changes its other places in place, and undoes it", async () => {
    const edit = vi
      .spyOn(api, "editSource")
      .mockResolvedValue(
        saved("ver_2", false, "Changed “Try it.” to “Run it.” in 2 places"),
      );
    const { frame, probe, pause, reload, replaceText, note } = setup();
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
    const shown = note.mock.lastCall![0]!;
    expect(shown.said).toBe("Changed “Try it.” to “Run it.” in 2 places.");

    // Undo puts the text back on the page, which the next save saves.
    shown.undo!();
    expect(replaceText).toHaveBeenLastCalledWith("Run it.", "Try it.");
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
