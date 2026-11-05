import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createPersistentStore, useUnsavedWords } from "./persistent-store";

afterEach(() => vi.restoreAllMocks());

it("keeps a value in this tab when storage is full, and does not throw", () => {
  const store = createPersistentStore<string[]>("slashdocs.test-full", []);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  expect(() => store.write(["words"])).not.toThrow();
  expect(store.read()).toEqual(["words"]);
});

it("tells which words only this tab holds while storage refuses them", () => {
  const store = createPersistentStore<string[]>(
    "slashdocs.test-words",
    [],
    undefined,
    (value) => value,
  );
  const { result } = renderHook(() => useUnsavedWords());
  const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  act(() => store.write(["my reply", " "]));
  expect(result.current).toEqual(["my reply"]);
  setItem.mockRestore();
  act(() => store.write(["my reply"]));
  expect(result.current).toEqual([]);
});
