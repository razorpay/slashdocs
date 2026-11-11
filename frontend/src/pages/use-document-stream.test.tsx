import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import type { RemoteCursor } from "../../bridge/cursors";
import { useDocumentStream } from "./use-document-stream";

// FakeEventSource lets a test open the stream and send named events to the
// hook.
class FakeEventSource {
  static last?: FakeEventSource;
  listeners = new Map<string, (message: MessageEvent) => void>();
  onopen?: () => void;
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener(kind: string, listener: (message: MessageEvent) => void) {
    this.listeners.set(kind, listener);
  }
  send(kind: string, event: object = {}) {
    this.listeners.get(kind)?.(new MessageEvent(kind, { data: JSON.stringify(event) }));
  }
  close() {}
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const asha = { type: "user" as const, id: "usr_a", name: "Asha" };

function setup(following = true) {
  vi.stubGlobal("EventSource", FakeEventSource);
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const onDocumentChange = vi.fn();
  const { result } = renderHook(
    () =>
      useDocumentStream({
        docId: "doc_1",
        enabled: true,
        version: "ver_1",
        following,
        principal: { type: "user", id: "usr_me" },
        onDocumentChange,
      }),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    },
  );
  return { result, invalidate, onDocumentChange, source: FakeEventSource.last! };
}

describe("useDocumentStream", () => {
  it("refreshes the approval state of every viewer on an approvals event", () => {
    const { invalidate, source } = setup();

    source.send("approvals");

    const refreshed = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(refreshed).toEqual(
      expect.arrayContaining([
        queryKeys.document("doc_1"),
        queryKeys.approvalsAll("doc_1"),
        queryKeys.approvers("doc_1"),
      ]),
    );
  });

  it("tells the page of each change to the document, with the version that it made", () => {
    const { onDocumentChange, source } = setup();

    source.send("document", { data: { version_id: "ver_2" } });
    expect(onDocumentChange).toHaveBeenLastCalledWith("ver_2");
    // A change of the title makes no version.
    source.send("document");
    expect(onDocumentChange).toHaveBeenLastCalledWith(undefined);
  });

  it("tells the page when the stream opens, because it sent no event before that", () => {
    const { onDocumentChange, source } = setup();

    act(() => source.onopen?.());

    expect(onDocumentChange).toHaveBeenCalledExactlyOnceWith();
  });

  // The cursor of another viewer, on a version.
  const cursorOn = (version: string) => ({
    updated_by: asha,
    data: { session: "ses_a", version, points: [{ t: 1, path: "0", x: 1, y: 1 }] },
  });

  it.each([
    ["follows the newest version", true, "live", "ver_1"],
    ["stays on a version", false, "ver_1", "live"],
  ])(
    "shows the cursors of the viewers on the same version when the page %s",
    (_name, following, same, other) => {
      const { result, source } = setup(following);
      const shown: RemoteCursor[] = [];
      result.current.subscribeCursors((cursor) => shown.push(cursor));

      source.send("cursor", cursorOn(same));
      expect(shown.at(-1)?.points.at(-1)?.hidden).toBeUndefined();
      source.send("cursor", cursorOn(other));
      expect(shown.at(-1)?.points.at(-1)?.hidden).toBe(true);
    },
  );

  it.each([
    [true, "live"],
    [false, "ver_1"],
  ])(
    "sends the cursor with its version (following: %s)",
    async (following, version) => {
      vi.useFakeTimers();
      const post = vi.spyOn(api, "postDocumentCursor").mockResolvedValue();
      const { result } = setup(following);

      act(() => result.current.moveCursor({ path: "0", x: 1, y: 1 }));
      await act(() => vi.advanceTimersByTimeAsync(1000));

      expect(post).toHaveBeenCalledWith("doc_1", expect.objectContaining({ version }));
    },
  );
});
