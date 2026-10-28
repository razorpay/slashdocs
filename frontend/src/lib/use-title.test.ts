import { renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useTitle } from "./use-title";

afterEach(() => {
  document.title = "";
});

it("shows the page title with the product name", () => {
  const { unmount } = renderHook(() => useTitle("Plan"));
  expect(document.title).toBe("Plan · slashdocs");
  unmount();
});

// The server renders a document's title into its page, so the title before a
// page mounts can belong to a page the reader has left.
it("resets to the product name when the page unmounts", () => {
  document.title = "Plan · slashdocs";
  const { unmount } = renderHook(() => useTitle("Plan"));
  unmount();
  expect(document.title).toBe("slashdocs");
});
