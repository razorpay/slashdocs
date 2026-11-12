import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, APIError } from "@/api";
import type { TextEditResult } from "./doc-context";
import { useTextAutosave } from "./use-text-autosave";

const SOURCE = "<p>TTL of 10 minutes.</p><p>Retry twice.</p>";
const loaded = { version: "ver_1", load: 0 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(bursts: TextEditResult[]) {
  const take = vi.fn(async () => bursts.shift() ?? { changes: [], unsupported: false });
  const options = {
    docId: "doc_1",
    loaded,
    take,
    setState: vi.fn(),
    onSaved: vi.fn(),
    reload: vi.fn(),
  };
  const { result } = renderHook(() => useTextAutosave(options));
  // A change in the frame, then the pause that saves it.
  const typeAndPause = async () => {
    act(() => result.current(1));
    await act(() => vi.advanceTimersByTimeAsync(1500));
  };
  return { ...options, typeAndPause };
}

const burst = (before: string, after: string): TextEditResult => ({
  changes: [{ before, after }],
  unsupported: false,
});

it("saves each pause as edits on the source the last save left", async () => {
  const html = vi.spyOn(api, "getVersionHTML").mockResolvedValue(SOURCE);
  const edit = vi
    .spyOn(api, "editDocument")
    .mockResolvedValueOnce({
      id: "ver_2",
      number: 2,
      base_version_id: "ver_1",
      edits_applied: 1,
    })
    .mockResolvedValueOnce({
      id: "ver_3",
      number: 3,
      base_version_id: "ver_2",
      edits_applied: 1,
    });
  const { typeAndPause, onSaved, setState } = setup([
    burst("TTL of 10 minutes.", "TTL of 5 minutes."),
    burst("TTL of 5 minutes.", "TTL of 50 minutes."),
  ]);

  await typeAndPause();
  await typeAndPause();

  expect(edit.mock.calls.map(([, input]) => input.edits)).toEqual([
    [{ old_string: "10", new_string: "5" }],
    [{ old_string: "5", new_string: "50" }],
  ]);
  // The second save matched against the first one's result, not a new read.
  expect(html).toHaveBeenCalledTimes(1);
  expect(onSaved.mock.calls).toEqual([
    ["ver_2", true],
    ["ver_3", true],
  ]);
  expect(setState).toHaveBeenLastCalledWith("saved");
});

it("marks a save on top of someone else's edits as not clean", async () => {
  vi.spyOn(api, "getVersionHTML").mockResolvedValue(SOURCE);
  vi.spyOn(api, "editDocument").mockResolvedValue({
    id: "ver_3",
    number: 3,
    base_version_id: "ver_2",
    edits_applied: 1,
  });
  const { typeAndPause, onSaved } = setup([burst("Retry twice.", "Retry once.")]);

  await typeAndPause();

  expect(onSaved).toHaveBeenCalledWith("ver_3", false);
});

it("shows the latest version when someone else changed the same text", async () => {
  vi.spyOn(api, "getVersionHTML").mockResolvedValue(SOURCE);
  vi.spyOn(api, "editDocument").mockRejectedValue(
    new APIError(422, "edit_failed", "edit 0: old_string was not found"),
  );
  const { typeAndPause, reload, onSaved } = setup([
    burst("Retry twice.", "Retry once."),
  ]);

  await typeAndPause();

  expect(onSaved).not.toHaveBeenCalled();
  expect(reload).toHaveBeenCalledTimes(1);
});

it("tries a failed save again with the same changes", async () => {
  vi.spyOn(api, "getVersionHTML").mockResolvedValue(SOURCE);
  const edit = vi
    .spyOn(api, "editDocument")
    .mockRejectedValueOnce(new TypeError("Failed to fetch"))
    .mockResolvedValueOnce({
      id: "ver_2",
      number: 2,
      base_version_id: "ver_1",
      edits_applied: 1,
    });
  const { typeAndPause, setState, reload } = setup([
    burst("Retry twice.", "Retry once."),
  ]);

  await typeAndPause();
  expect(setState).toHaveBeenLastCalledWith("failed");
  await act(() => vi.advanceTimersByTimeAsync(5000));

  expect(edit).toHaveBeenCalledTimes(2);
  expect(edit.mock.calls[1][1].edits).toEqual(edit.mock.calls[0][1].edits);
  expect(setState).toHaveBeenLastCalledWith("saved");
  expect(reload).not.toHaveBeenCalled();
});
