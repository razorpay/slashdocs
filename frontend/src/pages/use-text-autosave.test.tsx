import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, APIError } from "@/api";
import { findLiterals, type Render } from "@/lib/script-literals";
import * as sourceEdits from "@/lib/source-edits";
import type { Region, ScriptChange } from "../../bridge/source-pieces";
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
});
afterEach(() => {
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

const saved = (id: string, rebased = false) => ({
  id,
  number: Number(id.slice(4)),
  base_version_id: "ver_1",
  rebased,
});

function setup() {
  // What the frame shows: every region that changed since it loaded.
  const frame = { regions: [] as Region[], scripts: [] as ScriptChange[] };
  const options = {
    docId: "doc_1",
    loaded,
    take: vi.fn(async () => ({ ...frame })),
    setState: vi.fn(),
    onSaved: vi.fn(),
    reload: vi.fn(),
    probe: vi.fn<Render>(),
  };
  const { result } = renderHook(() => useTextAutosave(options));
  const pause = async () => {
    act(() => result.current.changed(1));
    await act(() => vi.advanceTimersByTimeAsync(1500));
  };
  // The reader types text in the second paragraph, then pauses.
  const type = async (text: string) => {
    frame.regions = [second(text)];
    await pause();
  };
  return { ...options, frame, type, pause, result };
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
  expect(reload).toHaveBeenCalledTimes(1);
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
  action.onClick({ preventDefault: vi.fn() });
  expect(write).toHaveBeenCalledWith("Try it now.");
  cancel.onClick();
  expect(reload).toHaveBeenCalledTimes(1);
});

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
  expect(error).toHaveBeenCalledWith("A script moved this content.", expect.anything());
  expect(setState).toHaveBeenLastCalledWith("failed");
});

it("shows the latest version when the frame no longer matches its source", async () => {
  vi.spyOn(api, "editSource").mockRejectedValue(
    new APIError(422, "edit_failed", "old_html does not match"),
  );
  const { type, reload, onSaved } = setup();

  await type("Try it now.");

  expect(onSaved).not.toHaveBeenCalled();
  expect(reload).toHaveBeenCalledTimes(1);
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
    });

  beforeEach(() => vi.mocked(api.getVersionHTML).mockResolvedValue(SCRIPT));

  it("lets the reader type in text that one string holds", async () => {
    const { result } = setup();
    expect(await result.current.scriptEditable(" Try it. ")).toBe(true);
    expect(await result.current.scriptEditable("Run it.")).toBe(false);
  });

  it("saves a change that shows, says where it shows, and undoes it", async () => {
    const success = vi.spyOn(toast, "success");
    const edit = vi
      .spyOn(api, "editSource")
      .mockResolvedValueOnce(saved("ver_2"))
      .mockResolvedValueOnce(saved("ver_3"));
    const { frame, probe, pause, reload, onSaved } = setup();
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
    });
    expect(reload).toHaveBeenCalledTimes(1);
    const [message, options] = success.mock.lastCall!;
    expect(message).toBe("Changed in 2 places");
    const { action } = options as { action: { label: string; onClick: () => void } };
    expect(action.label).toBe("Undo");

    action.onClick();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(edit).toHaveBeenLastCalledWith("doc_1", {
      base_version_id: "ver_2",
      client_change_id: expect.any(String),
      replacements: [
        { start: literalAt, end: literalAt + 4, old_html: '"Run', new_html: '"Try' },
      ],
    });
    expect(onSaved).toHaveBeenLastCalledWith("ver_3", false);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("refuses a change that does not show where the reader typed it, and saves the rest", async () => {
    const error = vi.spyOn(toast, "error");
    const edit = vi.spyOn(api, "editSource").mockResolvedValue(saved("ver_2"));
    const { frame, probe, pause, reload } = setup();
    probe.mockImplementation(render(() => "Try it."));

    frame.scripts = [change];
    await pause();
    expect(edit).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(
      "The page does not show the new text where you typed it.",
      expect.anything(),
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
    expect(error).toHaveBeenCalledTimes(1);
    expect(edit.mock.lastCall![1].replacements).toEqual([
      { start: 10, end: 10, old_html: "", new_html: "Hi" },
    ]);
    expect(reload).not.toHaveBeenCalled();
  });
});
