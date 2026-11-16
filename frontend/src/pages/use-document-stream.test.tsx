import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import type { RemoteCursor } from "../../bridge/cursors";
import { useDocumentStream } from "./use-document-stream";

// FakeWebSocket lets a test open the live connection, send it events, and
// read the reports of the hook.
class FakeWebSocket {
  static readonly OPEN = 1;
  static all: FakeWebSocket[] = [];
  static get last() {
    return FakeWebSocket.all.at(-1)!;
  }
  readyState = 0;
  sent: unknown[] = [];
  onopen?: () => void;
  onmessage?: (message: { data: string }) => void;
  onclose?: ((close: { code: number }) => void) | null;
  constructor(public url: URL) {
    FakeWebSocket.all.push(this);
  }
  open() {
    this.readyState = FakeWebSocket.OPEN;
    act(() => this.onopen?.());
  }
  receive(kind: string, event: object = {}, id?: number) {
    act(() =>
      this.onmessage?.({ data: JSON.stringify({ id, event: { kind, ...event } }) }),
    );
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
  }
  drop(code: number) {
    this.readyState = 3;
    act(() => this.onclose?.({ code }));
  }
}

afterEach(() => {
  FakeWebSocket.all = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const asha = { type: "user" as const, id: "usr_a", name: "Asha" };

function setup(following = true) {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const onDocumentChange = vi.fn();
  const { result, unmount } = renderHook(
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
  return { result, unmount, invalidate, onDocumentChange, source: FakeWebSocket.last };
}

describe("useDocumentStream", () => {
  it("refreshes the approval state of every viewer on an approvals event", () => {
    const { invalidate, source } = setup();

    source.receive("approvals");

    const refreshed = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(refreshed).toEqual(
      expect.arrayContaining([
        queryKeys.document("doc_1"),
        queryKeys.approvalsAll("doc_1"),
        queryKeys.approvers("doc_1"),
      ]),
    );
  });

  it("tells the page of each change to the document, with its seq and version", () => {
    const { onDocumentChange, source } = setup();

    source.receive("document", { data: { seq: 44, version_id: "ver_2" } });
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      seq: 44,
      version_id: "ver_2",
      typed: false,
    });
    // The people are done: the seq and the version stay.
    source.receive("document", {
      data: { seq: 44, version_id: "ver_2", sealed: true },
    });
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      seq: 44,
      version_id: "ver_2",
      typed: false,
      sealed: true,
    });
    // A restore names the person who restored.
    source.receive("document", {
      updated_by: asha,
      data: { seq: 45, version_id: "ver_3", restored: true },
    });
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      seq: 45,
      version_id: "ver_3",
      typed: false,
      authors: [asha],
      restored: true,
      updated_by: asha,
    });
    // A small operation comes with its event, from the person who made it.
    const replacements = [{ start: 3, end: 3, old_html: "", new_html: "x" }];
    source.receive("document", {
      updated_by: asha,
      data: {
        seq: 45,
        version_id: "ver_2",
        prev_seq: 44,
        replacements,
        typed: true,
        sum: 9,
      },
    });
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      seq: 45,
      version_id: "ver_2",
      typed: true,
      authors: [asha],
      prev_seq: 44,
      changes: {
        seq: 45,
        version_id: "ver_2",
        ops: [replacements],
        typed: true,
        authors: [asha],
        sum: 9,
      },
    });
    // A large operation comes with no changes, and names who made it, and
    // whether they typed it.
    source.receive("document", {
      updated_by: asha,
      data: { seq: 46, version_id: "ver_2", typed: true },
    });
    expect(onDocumentChange).toHaveBeenLastCalledWith({
      seq: 46,
      version_id: "ver_2",
      typed: true,
      authors: [asha],
    });
    // A change of the title names no seq.
    source.receive("document");
    expect(onDocumentChange).toHaveBeenLastCalledWith(undefined);
  });

  // The server tells where the document is when the connection opens, so the
  // page does not ask for the document.
  it("reports this viewer when the connection opens, and asks for nothing", () => {
    const { onDocumentChange, source } = setup();

    source.open();

    expect(onDocumentChange).not.toHaveBeenCalled();
    expect(source.sent).toEqual([{ type: "presence", version: "ver_1" }]);
    expect(source.url.pathname).toBe("/v1/documents/doc_1/live");
    expect(source.url.protocol).toBe("ws:");
  });

  it("connects again after a wait, from the last stored event", () => {
    vi.useFakeTimers();
    const { onDocumentChange, source } = setup();
    source.open();
    source.receive("comments", {}, 7);
    source.receive("cursor", { data: {} });

    source.drop(1006);
    act(() => vi.advanceTimersByTime(499));
    expect(FakeWebSocket.all).toHaveLength(1);
    act(() => vi.advanceTimersByTime(501));

    expect(FakeWebSocket.last.url.searchParams.get("after_revision")).toBe("7");
    expect(onDocumentChange).not.toHaveBeenCalled();
  });

  // Each tab waits a random part of the second half of the wait, so that
  // tabs do not all connect again at once.
  it("waits longer after each failure, up to 30 seconds", () => {
    vi.useFakeTimers();
    setup();
    for (const wait of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
      const sockets = FakeWebSocket.all.length;
      FakeWebSocket.last.drop(1006);
      act(() => vi.advanceTimersByTime(wait / 2 - 1));
      expect(FakeWebSocket.all).toHaveLength(sockets);
      act(() => vi.advanceTimersByTime(wait / 2 + 1));
      expect(FakeWebSocket.all).toHaveLength(sockets + 1);
    }
    // A connection that opens starts the waits again.
    FakeWebSocket.last.open();
    FakeWebSocket.last.drop(1006);
    act(() => vi.advanceTimersByTime(1_000));
    expect(FakeWebSocket.all).toHaveLength(9);
  });

  it.each([4401, 4403, 4404])(
    "stops, and has the page ask for the document, when the server refuses (%i)",
    (code) => {
      vi.useFakeTimers();
      const { onDocumentChange, source } = setup();

      source.drop(code);
      act(() => vi.advanceTimersByTime(60_000));

      expect(FakeWebSocket.all).toHaveLength(1);
      expect(onDocumentChange).toHaveBeenCalledExactlyOnceWith();
    },
  );

  it("tells the others that this viewer left when the page goes", () => {
    const { unmount, source } = setup();
    source.open();

    unmount();

    expect(source.sent.at(-1)).toEqual({ type: "left" });
    expect(source.readyState).toBe(3);
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

      source.receive("cursor", cursorOn(same));
      expect(shown.at(-1)?.points.at(-1)?.hidden).toBeUndefined();
      source.receive("cursor", cursorOn(other));
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
      const { result, source } = setup(following);
      source.open();

      act(() => result.current.moveCursor({ path: "0", x: 1, y: 1 }));
      await act(() => vi.advanceTimersByTimeAsync(1000));

      expect(source.sent).toContainEqual(
        expect.objectContaining({ type: "cursor", version }),
      );
    },
  );
});
