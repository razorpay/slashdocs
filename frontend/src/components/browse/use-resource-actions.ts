import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, APIError, type MoveDestination } from "@/api";
import { errorMessage } from "@/lib/errors";
import { useMounted } from "@/lib/hooks";
import { queryKeys } from "@/lib/queryKeys";

export type ResourceType = "document" | "folder";

export const FOLDER_DELETE_DESCRIPTION =
  "This deletes the folder and its subfolders. Documents inside them will move to root.";

// Pin state + toggle mutation shared by every card/row action cluster. When
// `pinned` is provided by the parent (already-fetched pin set) it wins;
// otherwise we fall back to the pins query.
export function useTogglePin(
  resourceType: ResourceType,
  resourceId: string,
  pinned?: boolean,
) {
  const qc = useQueryClient();
  const pins = useQuery({ queryKey: queryKeys.pins(), queryFn: api.listPins });
  const isPinned =
    pinned ??
    (pins.data?.items || []).some(
      (p) => p.resource_type === resourceType && p.resource_id === resourceId,
    );
  // The mutation sends the state that the reader asked for, and stays busy
  // until the pins load again, so that the mark never shows the old state
  // as the result and a second press waits.
  const togglePin = useMutation({
    mutationFn: (pin: boolean) =>
      pin
        ? api.putPin(resourceType, resourceId)
        : api.deletePin(resourceType, resourceId),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.pins() }),
    onError: (e, pin) =>
      toast.error(errorMessage(e, pin ? "Could not pin it" : "Could not unpin it")),
  });
  // When the pins failed to load, the state is unknown, so that a failed
  // list never reads as "not pinned".
  return { unknown: pins.isError && !pins.data, isPinned, togglePin };
}

// Delete mutation shared by every card/row action cluster. The toast names
// the item, as its card is gone when the toast shows.
export function useDeleteResource(
  resourceType: ResourceType,
  resourceId: string,
  title: string,
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      resourceType === "folder"
        ? api.deleteFolder(resourceId)
        : api.deleteDocument(resourceId),
    onSuccess: () => {
      toast.success(`Deleted “${title}”.`);
      qc.invalidateQueries({ queryKey: queryKeys.foldersAll() });
      qc.invalidateQueries({ queryKey: queryKeys.documents() });
      qc.invalidateQueries({ queryKey: queryKeys.pins() });
    },
    onError: (e) => toast.error(errorMessage(e, "Delete failed")),
  });
}

// A move of a document or folder into the folder `to`, or to the top level
// when `to` is null. A document leaves the top level through `from`, the
// folder that it is in. The toast names the folder `toTitle`.
export type Move = {
  type: ResourceType;
  id: string;
  from?: string;
  to: string | null;
  toTitle?: string;
  // Documents moved from the picker use the server's opaque source token.
  // Drag-and-drop resolves this token from the same destination read model
  // before it moves, so it cannot bypass access-loss confirmation.
  sourceToken?: string;
  acknowledgeAccessLoss?: boolean;
  offerUndo?: boolean;
};

// Move mutation shared by drag and drop and the Move dialog. A move that
// changes who has access gives a warning to show instead of the toast, in a
// dialog while the page that moved it is on screen, or else in a toast.
export function useMoveResource() {
  const qc = useQueryClient();
  const mounted = useMounted();
  const [warning, setWarning] = useState<string | null>(null);
  const move = useMutation({
    mutationFn: async ({
      type,
      id,
      from,
      to,
      sourceToken,
      acknowledgeAccessLoss,
    }: Move) => {
      if (type === "folder") {
        return {
          warning: (await api.updateFolder(id, undefined, to)).permission_warning
            ?.message,
          // Folder PATCH does not return a concurrency-safe source token.
          // Do not offer an Undo that could move a restricted folder to root.
          legacyUndo: false,
        };
      }
      const destination: MoveDestination = to
        ? { kind: "folder", folder_id: to }
        : { kind: "root" };
      let resolvedSourceToken = sourceToken;
      if (!resolvedSourceToken) {
        const bootstrap = await api.getMoveDestinations("document", id);
        const actualSource = bootstrap.resource.source;
        const sourceStillMatches = from
          ? actualSource.kind === "folder" && actualSource.folder_id === from
          : actualSource.kind === "root";
        if (!sourceStillMatches)
          throw new APIError(409, "source_changed", "current location changed");
        resolvedSourceToken = actualSource.token;
      }
      if (!resolvedSourceToken) throw new Error("Move source is unavailable");
      const result = acknowledgeAccessLoss
        ? await api.moveDocument(id, destination, resolvedSourceToken, true)
        : await api.moveDocument(id, destination, resolvedSourceToken);
      return {
        warning:
          result.permission_warning?.message ||
          (result.access_lost
            ? "Moved to Documents. You no longer have edit access to this document."
            : undefined),
        undo: result.undo,
      };
    },
    onSuccess: (result, { type, id, from, to, toTitle, offerUndo = true }) => {
      qc.invalidateQueries({ queryKey: queryKeys.foldersAll() });
      qc.invalidateQueries({ queryKey: queryKeys.documents() });
      qc.invalidateQueries({ queryKey: queryKeys.pins() });
      qc.invalidateQueries({ queryKey: queryKeys.moveDestinationsAll() });
      qc.invalidateQueries({
        queryKey: type === "folder" ? queryKeys.folder(id) : queryKeys.document(id),
      });
      if (result.warning && mounted.current) setWarning(result.warning);
      else if (result.warning)
        toast.warning(result.warning, { duration: Infinity, closeButton: true });
      else {
        const undoDestination = result.undo?.destination;
        toast.success(toTitle ? `Moved to ${toTitle}.` : "Moved.", {
          action:
            offerUndo && (result.undo || result.legacyUndo)
              ? {
                  label: "Undo",
                  onClick: () =>
                    move.mutate({
                      type,
                      id,
                      from: to ?? undefined,
                      to: result.undo
                        ? undoDestination?.kind === "folder"
                          ? undoDestination.folder_id
                          : null
                        : (from ?? null),
                      sourceToken: result.undo?.source_token,
                      offerUndo: false,
                    }),
                }
              : undefined,
        });
      }
    },
    onError: (e, { type, id, sourceToken, offerUndo = true }) => {
      if (
        type === "document" &&
        e instanceof APIError &&
        e.code === "access_loss_confirmation_required"
      ) {
        // The picker renders this warning inline. Drag-and-drop and Undo have
        // no inline confirmation surface, so never fail silently there.
        if (!sourceToken || !offerUndo)
          toast.error("Use Move to folder to review and confirm this move.");
        return;
      }
      if (type === "document" && e instanceof APIError && e.code === "source_changed") {
        qc.invalidateQueries({ queryKey: queryKeys.document(id) });
        qc.invalidateQueries({ queryKey: queryKeys.foldersAll() });
      }
      toast.error(
        e instanceof APIError && e.status === 403
          ? "You cannot move it there. Ask for edit access to the folder."
          : errorMessage(e, "Move failed"),
      );
    },
  });
  return { move, warning, clearWarning: () => setWarning(null) };
}
