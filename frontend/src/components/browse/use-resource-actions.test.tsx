import type { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "@/api";
import { useMoveResource } from "./use-resource-actions";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("useMoveResource", () => {
  it("uses the server-provided destination and source token for undo", async () => {
    const moveDocument = vi
      .spyOn(api, "moveDocument")
      .mockResolvedValueOnce({
        document_id: "doc_1",
        moved: true,
        destination: { kind: "folder", folder_id: "new" },
        undo: {
          destination: { kind: "folder", folder_id: "old" },
          source_token: "ms1_undo",
        },
      })
      .mockResolvedValueOnce({
        document_id: "doc_1",
        moved: true,
        destination: { kind: "folder", folder_id: "old" },
        undo: null,
      });
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(useMoveResource, { wrapper });

    await act(() =>
      hook.result.current.move.mutateAsync({
        type: "document",
        id: "doc_1",
        from: "old",
        to: "new",
        toTitle: "New",
        sourceToken: "ms1_source",
      }),
    );

    expect(moveDocument).toHaveBeenNthCalledWith(
      1,
      "doc_1",
      { kind: "folder", folder_id: "new" },
      "ms1_source",
    );
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const options = vi.mocked(toast.success).mock.calls[0]?.[1] as
      { action?: { onClick: () => void } } | undefined;
    expect(options?.action).toBeDefined();

    act(() => options?.action?.onClick());
    await waitFor(() =>
      expect(moveDocument).toHaveBeenNthCalledWith(
        2,
        "doc_1",
        { kind: "folder", folder_id: "old" },
        "ms1_undo",
      ),
    );
  });
});
