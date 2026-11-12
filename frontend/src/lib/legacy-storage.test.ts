import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateLegacyStorage } from "./legacy-storage";

describe("migrateLegacyStorage", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("moves aidocs keys to slashdocs keys", () => {
    localStorage.setItem("aidocs.theme", '"dark"');
    localStorage.setItem("aidocs:view-mode", '"html"');
    localStorage.setItem("other", "kept");

    migrateLegacyStorage();

    expect(localStorage.getItem("slashdocs.theme")).toBe('"dark"');
    expect(localStorage.getItem("slashdocs:view-mode")).toBe('"html"');
    expect(localStorage.getItem("aidocs.theme")).toBeNull();
    expect(localStorage.getItem("aidocs:view-mode")).toBeNull();
    expect(localStorage.getItem("other")).toBe("kept");
  });

  it("keeps a value already saved under the new key", () => {
    localStorage.setItem("aidocs.theme", '"dark"');
    localStorage.setItem("slashdocs.theme", '"light"');

    migrateLegacyStorage();

    expect(localStorage.getItem("slashdocs.theme")).toBe('"light"');
    expect(localStorage.getItem("aidocs.theme")).toBeNull();
  });

  it("does not throw when storage is blocked", () => {
    vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    expect(() => migrateLegacyStorage()).not.toThrow();
  });
});
