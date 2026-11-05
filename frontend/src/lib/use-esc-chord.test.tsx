import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useEscChord } from "./use-esc-chord";

afterEach(cleanup);

// Keys come to the page, as a key from the document does too.
const press = (key: string) => {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event;
};

it("keeps the letter of a chord from the keys of the page", () => {
  // The page listens first, as the pins do.
  const page = vi.fn();
  window.addEventListener("keydown", page);
  const onRun = vi.fn();
  renderHook(() => useEscChord({ available: ["c"], onRun, onEscape: () => {} }));

  press("Escape");
  const c = press("c");
  expect(onRun).toHaveBeenCalledWith("c");
  expect(c.defaultPrevented).toBe(true);
  expect(page.mock.calls.map(([event]) => event.key)).toEqual(["Escape"]);

  // Without the chord, C is the page's again.
  expect(press("c").defaultPrevented).toBe(false);
  expect(page).toHaveBeenCalledTimes(2);
  window.removeEventListener("keydown", page);
});
