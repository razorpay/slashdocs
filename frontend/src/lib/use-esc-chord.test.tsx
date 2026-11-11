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

it("arms only on an Esc that nothing else uses", () => {
  // A handler before the chord may use the Esc.
  let use = false;
  const used = (event: KeyboardEvent) => use && event.preventDefault();
  window.addEventListener("keydown", used, true);
  const onRun = vi.fn();
  let open = true;
  const { result } = renderHook(() =>
    useEscChord({
      available: ["c"],
      onRun,
      onEscape: () => {},
      takeEscape: () => (open ? !(open = false) : false),
    }),
  );
  const pressIn = (el: Element, key: string) =>
    el.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );

  // An open thread takes the first Esc, and keeps it from the page. C after
  // it is the page's.
  expect(press("Escape").defaultPrevented).toBe(true);
  expect(result.current.phase).toBe("idle");
  expect(press("c").defaultPrevented).toBe(false);

  // An Esc in a popover or a menu closes it.
  const layer = document.createElement("div");
  layer.setAttribute("role", "dialog");
  layer.append(document.createElement("button"));
  document.body.append(layer);
  pressIn(layer.firstElementChild!, "Escape");
  expect(result.current.phase).toBe("idle");
  layer.remove();

  // An Esc that a handler before the chord used arms nothing.
  use = true;
  press("Escape");
  use = false;
  expect(result.current.phase).toBe("idle");

  // A free Esc arms it.
  press("Escape");
  expect(press("c").defaultPrevented).toBe(true);
  expect(onRun).toHaveBeenCalledTimes(1);
  window.removeEventListener("keydown", used, true);
});
