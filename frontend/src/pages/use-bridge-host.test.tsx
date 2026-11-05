import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useBridgeHost } from "./use-bridge-host";

const ORIGIN = "https://render.example";
const URL_A = `${ORIGIN}/v/doc_a/ver_a`;

// jsdom has no media queries.
beforeEach(() => {
  vi.useFakeTimers();
  window.matchMedia = () =>
    ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

// The hook with an iframe in the page, as a consumer mounts it.
function setup(url = URL_A, refresh = vi.fn(async () => undefined)) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const hook = renderHook(
    ({ url }) => {
      const bridge = useBridgeHost("doc_a", url, { refresh });
      bridge.ref.current = frame;
      return bridge;
    },
    { initialProps: { url } },
  );
  const send = (data: object, source: Window | null = frame.contentWindow) =>
    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", { origin: ORIGIN, source, data }),
      );
    });
  return { ...hook, frame, send, refresh };
}

it("fails a frame that loaded and sent no ready message, as an error page of the render URL", () => {
  const { result } = setup();
  act(() => result.current.onLoad());
  expect(result.current.failed).toBe(false);
  act(() => vi.advanceTimersByTime(3_000));
  expect(result.current.failed).toBe(true);
  expect(result.current.ready).toBe(false);
});

it("fails a frame that never loads, after a longer wait", () => {
  const { result } = setup();
  act(() => vi.advanceTimersByTime(29_000));
  expect(result.current.failed).toBe(false);
  act(() => vi.advanceTimersByTime(1_000));
  expect(result.current.failed).toBe(true);
});

it("does not fail a frame that is ready", () => {
  const { result, send } = setup();
  send({ type: "slashdocs:ready" });
  act(() => result.current.onLoad());
  act(() => vi.advanceTimersByTime(60_000));
  expect(result.current.ready).toBe(true);
  expect(result.current.failed).toBe(false);
});

it("ignores a ready message from another window or origin", () => {
  const { result, send } = setup();
  send({ type: "slashdocs:ready" }, window);
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://evil.example",
        source: window,
        data: { type: "slashdocs:ready" },
      }),
    );
  });
  act(() => result.current.onLoad());
  act(() => vi.advanceTimersByTime(3_000));
  expect(result.current.ready).toBe(false);
  expect(result.current.failed).toBe(true);
});

it("gives a new URL its own wait: a ready of the old URL does not count", () => {
  const { result, rerender, send } = setup();
  send({ type: "slashdocs:ready" });
  rerender({ url: `${ORIGIN}/v/doc_a/ver_b` });
  expect(result.current.ready).toBe(false);
  act(() => result.current.onLoad());
  act(() => vi.advanceTimersByTime(3_000));
  expect(result.current.failed).toBe(true);
});

it("Retry gets a fresh token first, then waits for the frame again", async () => {
  const { result, refresh, send } = setup();
  act(() => result.current.onLoad());
  act(() => vi.advanceTimersByTime(3_000));
  expect(result.current.failed).toBe(true);

  await act(async () => {
    await result.current.retry.refetch();
  });
  expect(refresh).toHaveBeenCalledOnce();
  expect(result.current.failed).toBe(false);
  expect(result.current.retry.isFetching).toBe(false);
  // The wait starts again, from the frame's new load.
  act(() => vi.advanceTimersByTime(2_000));
  expect(result.current.failed).toBe(false);
  send({ type: "slashdocs:ready" });
  expect(result.current.ready).toBe(true);
});
