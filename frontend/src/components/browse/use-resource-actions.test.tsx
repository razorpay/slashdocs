import type { PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, APIError } from "@/api";
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

  it("uses the secure move contract for drag-and-drop and does not bypass access loss", async () => {
    vi.spyOn(api, "getMoveDestinations").mockResolvedValue({
      resource: {
        type: "document",
        id: "doc_1",
        title: "Plan",
        can_move: true,
        source: { kind: "folder", folder_id: "old", token: "ms1_drag" },
      },
      documents: {
        selectable: true,
        current: false,
        can_create_child: true,
        would_lose_access: true,
      },
      path: [],
      path_restricted_prefix: false,
      levels: [],
      focus: null,
    });
    vi.spyOn(api, "moveDocument").mockRejectedValue(
      new APIError(409, "access_loss_confirmation_required", "confirmation required"),
    );
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(useMoveResource, { wrapper });

    await expect(
      act(() =>
        hook.result.current.move.mutateAsync({
          type: "document",
          id: "doc_1",
          from: "old",
          to: null,
          toTitle: "Documents",
        }),
      ),
    ).rejects.toMatchObject({ code: "access_loss_confirmation_required" });

    expect(api.getMoveDestinations).toHaveBeenCalledWith("document", "doc_1");
    expect(api.moveDocument).toHaveBeenCalledWith(
      "doc_1",
      { kind: "root" },
      "ms1_drag",
    );
    expect(toast.error).toHaveBeenCalledWith(
      "Use Move to folder to review and confirm this move.",
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("does not offer an unsafe client-computed Undo for folder moves", async () => {
    vi.spyOn(api, "updateFolder").mockResolvedValue({
      id: "fld_1",
      title: "Folder",
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
        type: "folder",
        id: "fld_1",
        from: "restricted_parent",
        to: "new_parent",
        toTitle: "New parent",
      }),
    );

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const options = vi.mocked(toast.success).mock.calls[0]?.[1] as
      { action?: { onClick: () => void } } | undefined;
    expect(options?.action).toBeUndefined();
  });

  it("stops a drag when the document moved after the user picked it up", async () => {
    vi.spyOn(api, "getMoveDestinations").mockResolvedValue({
      resource: {
        type: "document",
        id: "doc_1",
        title: "Plan",
        can_move: true,
        source: { kind: "folder", folder_id: "new_source", token: "ms1_new" },
      },
      documents: { selectable: true, current: false, can_create_child: true },
      path: [],
      path_restricted_prefix: false,
      levels: [],
      focus: null,
    });
    const moveDocument = vi.spyOn(api, "moveDocument");
    const client = new QueryClient({
      defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
    });
    const wrapper = ({ children }: PropsWithChildren) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const hook = renderHook(useMoveResource, { wrapper });

    await expect(
      act(() =>
        hook.result.current.move.mutateAsync({
          type: "document",
          id: "doc_1",
          from: "old_source",
          to: "destination",
        }),
      ),
    ).rejects.toMatchObject({ code: "source_changed" });
    expect(moveDocument).not.toHaveBeenCalled();
  });
});
