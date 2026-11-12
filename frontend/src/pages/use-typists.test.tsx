import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DocumentEvent, Principal } from "@/api";
import { TYPING_MS, useTypists } from "./use-typists";

const reader: Principal = { type: "user", id: "usr_r", name: "Ravi" };
const admin: Principal = { type: "user", id: "usr_a", name: "admin" };

// The event of an operation of these people. A large operation comes with
// no changes, and names its authors all the same.
const event = (seq: number, authors: Principal[], typed = true): DocumentEvent => ({
  seq,
  version_id: "ver_1",
  typed,
  authors,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const setup = (shown?: number) =>
  renderHook(({ shown }) => useTypists(reader, shown), { initialProps: { shown } });

it("names the other people who typed, until they stop for 10 s", () => {
  const { result } = setup();
  act(() => result.current.hear(event(2, [admin, reader])));
  expect(result.current.typists).toEqual([admin]);

  // A later key keeps them in the list.
  act(() => vi.advanceTimersByTime(TYPING_MS - 1_000));
  act(() => result.current.hear(event(3, [admin])));
  act(() => vi.advanceTimersByTime(TYPING_MS - 1_000));
  expect(result.current.typists).toEqual([admin]);

  act(() => vi.advanceTimersByTime(1_000));
  expect(result.current.typists).toEqual([]);
  expect(TYPING_MS).toBe(10_000);
});

it("hears each event, also two that come in one render", () => {
  const { result } = setup();
  const asha: Principal = { type: "user", id: "usr_s", name: "Asha" };
  act(() => {
    result.current.hear(event(2, [admin]));
    result.current.hear(event(3, [asha]));
  });
  expect(result.current.typists).toEqual([admin, asha]);
});

it("does not count a change that is not typing, or the typing of the reader", () => {
  const { result } = setup();
  act(() => {
    result.current.hear(event(2, [admin], false));
    result.current.hear(event(3, [reader]));
  });
  expect(result.current.typists).toEqual([]);
});

it("gives the people who made the changes that are not typing between two seqs", () => {
  const { result } = setup();
  const asha: Principal = { type: "user", id: "usr_s", name: "Asha" };
  act(() => {
    result.current.hear(event(2, [admin], false));
    result.current.hear(event(3, [asha]));
    result.current.hear(event(4, [admin], false));
  });
  expect(result.current.madeBy(1, 4)).toEqual([admin]);
  // All of the changes there were typing, which no banner names.
  expect(result.current.madeBy(2, 3)).toEqual([]);
  // No event named a change there.
  expect(result.current.madeBy(4, 6)).toBeUndefined();
});

it("forgets the seqs at or before the seq that the frame shows", () => {
  const { result, rerender } = setup();
  act(() => {
    result.current.hear(event(2, [admin], false));
    result.current.hear(event(3, [admin], false));
  });
  rerender({ shown: 2 });
  expect(result.current.madeBy(0, 3)).toEqual([admin]);
  expect(result.current.madeBy(0, 2)).toBeUndefined();
});

it("does not take the person who sealed a version for an author of the typing before it", () => {
  const { result } = setup();
  act(() => {
    result.current.hear(event(2, [admin]));
    // An approval seals the version at the same seq.
    result.current.hear(event(2, [reader], false));
  });
  expect(result.current.madeBy(1, 2)).toEqual([]);
});
