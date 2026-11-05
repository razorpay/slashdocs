import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceIdStore, readerSettingsStore } from "./reader-store";

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("deviceIdStore", () => {
  it("makes a 16-character id once and keeps it", () => {
    const id = deviceIdStore.read();
    expect(id).toMatch(/^[a-z0-9]{16}$/);
    expect(deviceIdStore.read()).toBe(id);
    expect(localStorage.getItem("slashdocs.reader.device")).toBe(JSON.stringify(id));
  });

  it("still returns an id when storage throws", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const id = deviceIdStore.read();
    expect(id).toMatch(/^[a-z0-9]{16}$/);
    expect(deviceIdStore.read()).toBe(id);
  });
});

describe("readerSettingsStore", () => {
  it("falls back to defaults for bad stored values", () => {
    localStorage.setItem(
      "slashdocs.reader.settings",
      JSON.stringify({ size: "huge", theme: "paper" }),
    );
    expect(readerSettingsStore.read()).toEqual({
      size: "m",
      width: "comfortable",
      theme: "paper",
      shortcuts: true,
    });
  });
});
