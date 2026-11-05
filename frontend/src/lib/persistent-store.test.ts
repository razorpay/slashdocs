import { afterEach, expect, it, vi } from "vitest";
import { createPersistentStore } from "./persistent-store";

afterEach(() => vi.restoreAllMocks());

it("keeps a value in this tab when storage is full, and does not throw", () => {
  const store = createPersistentStore<string[]>("slashdocs.test-full", []);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("full", "QuotaExceededError");
  });
  expect(() => store.write(["words"])).not.toThrow();
  expect(store.read()).toEqual(["words"]);
});
