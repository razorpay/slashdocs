import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { useDocumentStream } from "./use-document-stream";

// FakeEventSource lets a test send named events to the hook.
class FakeEventSource {
  static last?: FakeEventSource;
  listeners = new Map<string, (message: MessageEvent) => void>();
  constructor() {
    FakeEventSource.last = this;
  }
  addEventListener(kind: string, listener: (message: MessageEvent) => void) {
    this.listeners.set(kind, listener);
  }
  send(kind: string) {
    this.listeners.get(kind)?.(new MessageEvent(kind, { data: "{}" }));
  }
  close() {}
}

afterEach(() => vi.unstubAllGlobals());

describe("useDocumentStream", () => {
  it.each(["approvals", "document"])(
    "refreshes the approval state of every viewer on a %s event",
    (kind) => {
      vi.stubGlobal("EventSource", FakeEventSource);
      const client = new QueryClient();
      const invalidate = vi.spyOn(client, "invalidateQueries");
      renderHook(
        () =>
          useDocumentStream({
            docId: "doc_1",
            enabled: true,
            version: "ver_1",
            onDocumentChange: () => {},
          }),
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <QueryClientProvider client={client}>{children}</QueryClientProvider>
          ),
        },
      );

      FakeEventSource.last!.send(kind);

      const refreshed = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
      expect(refreshed).toEqual(
        expect.arrayContaining([
          queryKeys.document("doc_1"),
          queryKeys.approvalsAll("doc_1"),
          queryKeys.approvers("doc_1"),
        ]),
      );
    },
  );
});
