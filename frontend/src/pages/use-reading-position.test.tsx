import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "@/api";
import { booksApi } from "@/lib/books";
import { FITS_READ_MS, useReadingPosition } from "./use-reading-position";

const base = { bookId: "b1", documentId: "doc_a", versionId: "v1", enabled: true };
const view = (progression: number, section = "intro") => ({
  section,
  progression,
  anchor: { quote: "hello" },
});
const fits = { section: "", progression: 0, anchor: { quote: "hello" }, fits: true };
const ends = () => progress.mock.calls.filter((c: unknown[]) => c[4] === true);
const steps = () => progress.mock.calls.filter((c: unknown[]) => c[4] === false);
// Lets rejected requests run their handlers.
const settle = () => act(async () => {});

let save: ReturnType<typeof vi.spyOn>;
let progress: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  save = vi.spyOn(booksApi, "savePosition").mockResolvedValue(undefined);
  progress = vi.spyOn(booksApi, "progress").mockResolvedValue(undefined);
});
afterEach(() => {
  // Unmount, so no earlier visit answers this test's visibility events.
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(props = base) {
  const hook = renderHook((p) => useReadingPosition(p), { initialProps: props });
  act(() => hook.result.current.onRestored());
  return hook;
}

function hide() {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
}

describe("useReadingPosition", () => {
  it("throttles saves to one per 3 seconds and flushes when hidden", () => {
    const { result } = setup();
    act(() => {
      for (let i = 0; i < 5; i++) result.current.onViewport(view(0.1 + i / 100));
    });
    expect(save).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(3000));
    expect(save).toHaveBeenCalledTimes(2);
    act(() => {
      result.current.onViewport(view(0.3));
      hide();
    });
    expect(save).toHaveBeenCalledTimes(3);
    const sent = save.mock.calls[2]![1];
    expect(sent).toMatchObject({
      document_id: "doc_a",
      version_id: "v1",
      section_id: "intro",
      progression: 0.3,
    });
    expect(sent.device_id).toMatch(/^[a-z0-9]{16}$/i);
  });

  it("reports reached_end once near the bottom", () => {
    const { result } = setup();
    act(() => {
      result.current.onViewport(view(0.5));
      result.current.onViewport(view(0.99));
      result.current.onViewport(view(0.995));
    });
    expect(ends()).toHaveLength(1);
    expect(progress).toHaveBeenCalledWith("b1", "doc_a", "v1", 0.99, true);
  });

  // A position saved at the end of the chapter restores there. Landing on it
  // is not reading it, so the update stays unseen (R18).
  it("does not report reached_end for landing at the end after a restore", () => {
    const { result } = setup();
    act(() => result.current.onViewport(view(0.99)));
    act(() => void vi.advanceTimersByTime(3000));
    act(() => result.current.onViewport(view(0.995)));
    expect(ends()).toHaveLength(0);
    // Scrolling away and back to the end does count.
    act(() => {
      result.current.onViewport(view(0.5));
      result.current.onViewport(view(0.99));
    });
    expect(ends()).toHaveLength(1);
  });

  // A chapter that does not scroll (short, or scrolled inside a container
  // the bridge could not measure) is read only after time on screen.
  it("reports a chapter that fits on screen only after time on screen", () => {
    const { result } = setup();
    act(() => result.current.onViewport(fits));
    expect(ends()).toHaveLength(0);
    act(() => void vi.advanceTimersByTime(FITS_READ_MS - 1));
    expect(ends()).toHaveLength(0);
    act(() => void vi.advanceTimersByTime(1));
    expect(ends()).toHaveLength(1);
    expect(progress).toHaveBeenCalledWith("b1", "doc_a", "v1", 1, true);
  });

  it("does not count time while the page is hidden", () => {
    const { result } = setup();
    act(() => result.current.onViewport(fits));
    act(() => void vi.advanceTimersByTime(FITS_READ_MS - 1000));
    act(() => hide());
    act(() => void vi.advanceTimersByTime(FITS_READ_MS));
    expect(ends()).toHaveLength(0);
  });

  it("forgets the time on screen once the chapter scrolls", () => {
    const { result } = setup();
    act(() => result.current.onViewport(fits));
    act(() => result.current.onViewport(view(0.2)));
    act(() => void vi.advanceTimersByTime(FITS_READ_MS * 2));
    expect(ends()).toHaveLength(0);
  });

  // Fails the first reached_end with err; progress(false) succeeds.
  function failFirstEnd(err: APIError) {
    let failed = false;
    progress.mockImplementation(async (...args: unknown[]) => {
      if (args[4] === true && !failed) {
        failed = true;
        throw err;
      }
    });
  }

  it("retries reached_end after it fails", async () => {
    failFirstEnd(new APIError(503, "group_membership_unavailable", ""));
    const { result } = setup();
    act(() => {
      result.current.onViewport(view(0.5));
      result.current.onViewport(view(0.99));
    });
    await settle();
    act(() => result.current.onViewport(view(0.995)));
    expect(ends()).toHaveLength(2);
  });

  it("does not retry reached_end the server refused", async () => {
    failFirstEnd(new APIError(404, "not_found", ""));
    const { result } = setup();
    act(() => {
      result.current.onViewport(view(0.5));
      result.current.onViewport(view(0.99));
    });
    await settle();
    act(() => result.current.onViewport(view(0.995)));
    expect(ends()).toHaveLength(1);
  });

  it("keeps a failed save and resends it when the page is hidden", async () => {
    save.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { result } = setup();
    act(() => result.current.onViewport(view(0.4)));
    await settle();
    act(() => hide());
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![1]).toEqual(save.mock.calls[0]![1]);
  });

  it("retries a failed save once on its own", async () => {
    save.mockRejectedValue(new APIError(503, "group_membership_unavailable", ""));
    const { result } = setup();
    act(() => result.current.onViewport(view(0.4)));
    await settle();
    act(() => void vi.advanceTimersByTime(3000));
    expect(save).toHaveBeenCalledTimes(2);
    await settle();
    act(() => void vi.advanceTimersByTime(30_000));
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("drops a save the server refuses", async () => {
    save.mockRejectedValueOnce(new APIError(404, "not_found", ""));
    const { result } = setup();
    act(() => result.current.onViewport(view(0.4)));
    await settle();
    act(() => hide());
    act(() => void vi.advanceTimersByTime(10_000));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("backs off for a minute when rate limited, except on hide", async () => {
    save.mockRejectedValueOnce(new APIError(429, "rate_limited", ""));
    const { result } = setup();
    act(() => result.current.onViewport(view(0.4)));
    await settle();
    act(() => void vi.advanceTimersByTime(3000));
    act(() => result.current.onViewport(view(0.5)));
    act(() => void vi.advanceTimersByTime(30_000));
    expect(save).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(30_000));
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![1]).toMatchObject({ progression: 0.5 });

    save.mockRejectedValueOnce(new APIError(429, "rate_limited", ""));
    act(() => result.current.onViewport(view(0.6)));
    act(() => void vi.advanceTimersByTime(3000));
    act(() => result.current.onViewport(view(0.7)));
    await settle();
    act(() => result.current.onViewport(view(0.8)));
    // The last save before the page goes away is sent regardless.
    act(() => hide());
    expect(save.mock.calls.at(-1)![1]).toMatchObject({ progression: 0.8 });
  });

  // Position and progress share one 120/min budget per user.
  it("sends progress only when it advanced", () => {
    const { result } = setup();
    act(() => result.current.onViewport(view(0.3)));
    expect(steps()).toHaveLength(1);
    expect(progress).toHaveBeenCalledWith("b1", "doc_a", "v1", 0.3, false);
    for (const p of [0.305, 0.2, 0.5]) {
      act(() => void vi.advanceTimersByTime(3000));
      act(() => result.current.onViewport(view(p)));
    }
    expect(save).toHaveBeenCalledTimes(4);
    expect(steps().map((c: unknown[]) => c[3])).toEqual([0.3, 0.5]);
  });

  it("flushes on unmount", () => {
    const { result, unmount } = setup();
    act(() => {
      result.current.onViewport(view(0.1));
      result.current.onViewport(view(0.2)); // throttled, pending
    });
    expect(save).toHaveBeenCalledTimes(1);
    unmount();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![1]).toMatchObject({ progression: 0.2 });
  });

  it("ignores viewport reports before restore completes", () => {
    const hook = renderHook(() => useReadingPosition(base));
    act(() => hook.result.current.onViewport(view(0.0)));
    expect(save).not.toHaveBeenCalled();
    act(() => hook.result.current.onRestored());
    act(() => hook.result.current.onViewport(view(0.4)));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("stops waiting for the restore after 3 seconds", () => {
    const hook = renderHook(() => useReadingPosition(base));
    act(() => void vi.advanceTimersByTime(3000));
    act(() => hook.result.current.onViewport(view(0.4)));
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("does not carry a pending save into the next chapter", () => {
    const hook = setup();
    act(() => {
      hook.result.current.onViewport(view(0.1));
      hook.result.current.onViewport(view(0.2));
    });
    hook.rerender({ ...base, documentId: "doc_b", versionId: "v9" });
    // Chapter change flushes the old chapter under its own ids.
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]![1]).toMatchObject({
      document_id: "doc_a",
      version_id: "v1",
    });
    act(() => void vi.advanceTimersByTime(2000));
    expect(save).toHaveBeenCalledTimes(2);
    // The new chapter waits for its own restore.
    act(() => hook.result.current.onViewport(view(0.0)));
    expect(save).toHaveBeenCalledTimes(2);
    act(() => hook.result.current.onRestored());
    act(() => hook.result.current.onViewport(view(0.05)));
    expect(save.mock.calls[2]![1]).toMatchObject({
      document_id: "doc_b",
      version_id: "v9",
    });
  });

  it("does nothing when disabled", () => {
    const { result } = setup({ ...base, enabled: false });
    act(() => result.current.onViewport(view(0.99)));
    expect(save).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
  });
});
