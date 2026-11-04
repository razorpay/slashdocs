import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { booksApi } from "@/lib/books";
import { useReadingPosition } from "./use-reading-position";

const base = { bookId: "b1", documentId: "doc_a", versionId: "v1", enabled: true };
const view = (progression: number, section = "intro") => ({
  section,
  progression,
  anchor: { quote: "hello" },
});

let save: ReturnType<typeof vi.spyOn>;
let progress: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  save = vi.spyOn(booksApi, "savePosition").mockResolvedValue(undefined);
  progress = vi.spyOn(booksApi, "progress").mockResolvedValue(undefined);
});
afterEach(() => {
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
      result.current.onViewport(view(0.99));
      result.current.onViewport(view(0.995));
    });
    const ends = progress.mock.calls.filter((c: unknown[]) => c[4] === true);
    expect(ends).toHaveLength(1);
    expect(progress).toHaveBeenCalledWith("b1", "doc_a", "v1", 0.99, true);
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
