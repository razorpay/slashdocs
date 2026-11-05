import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  clearOneTimeKeys,
  closeOneTimeKey,
  keepOneTimeKey,
  useOneTimeKeys,
} from "./one-time-keys";

afterEach(() => clearOneTimeKeys());

const made = (token: string) => ({ bot: "a@bots.bot", keyName: "k", token });

it("keeps each key that comes, in the order they come, until it is closed", async () => {
  const { result } = renderHook(() => useOneTimeKeys());
  await act(() => keepOneTimeKey(Promise.resolve("second"), made));
  await act(() => keepOneTimeKey(Promise.resolve("first"), made));
  expect(result.current.map((k) => k.token)).toEqual(["second", "first"]);
  act(() => closeOneTimeKey(result.current[0].id));
  expect(result.current.map((k) => k.token)).toEqual(["first"]);
});

it("keeps no key of a request made before a sign-out", async () => {
  const { result } = renderHook(() => useOneTimeKeys());
  let answer!: (token: string) => void;
  const late = keepOneTimeKey(new Promise<string>((r) => (answer = r)), made);
  await act(() => keepOneTimeKey(Promise.resolve("shown"), made));
  act(() => clearOneTimeKeys());
  expect(result.current).toEqual([]);
  await act(async () => {
    answer("late");
    await late;
  });
  expect(result.current).toEqual([]);
});

it("stores no key in the browser", async () => {
  await keepOneTimeKey(Promise.resolve("sd_never_stored"), made);
  const stored = [localStorage, sessionStorage].flatMap((s) =>
    Object.keys(s).map((k) => s.getItem(k)),
  );
  expect(stored.join()).not.toContain("sd_never_stored");
  expect(location.href).not.toContain("sd_never_stored");
});
