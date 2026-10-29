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

it("shows the product name without a page title", () => {
  document.title = "Plan · slashdocs";
  const { unmount } = renderHook(() => useTitle());
  expect(document.title).toBe("slashdocs");
  unmount();
});

// The server renders a document's title into its page, so the tab shows it
// before the app has loaded the document.
it("keeps the title while the page loads", () => {
  document.title = "Plan · slashdocs";
  const { rerender, unmount } = renderHook(
    ({ title, loading }) => useTitle(title, { loading }),
    { initialProps: { title: undefined as string | undefined, loading: true } },
  );
  expect(document.title).toBe("Plan · slashdocs");
  rerender({ title: "Plan", loading: false });
  expect(document.title).toBe("Plan · slashdocs");
  unmount();
});

// Opening another document must not show the previous document's title while
// the next one loads, or on its error page.
it("resets to the product name when the page title goes away", () => {
  const { rerender, unmount } = renderHook(
    ({ title, loading }) => useTitle(title, { loading }),
    { initialProps: { title: "Plan" as string | undefined, loading: false } },
  );
  rerender({ title: undefined, loading: true });
  expect(document.title).toBe("slashdocs");
  unmount();
});

it("resets to the product name when the page unmounts", () => {
  const { unmount } = renderHook(() => useTitle("Plan"));
  unmount();
  expect(document.title).toBe("slashdocs");
});
