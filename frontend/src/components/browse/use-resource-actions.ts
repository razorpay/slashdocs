import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, APIError } from "@/api";
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
};

// Move mutation shared by drag and drop and the Move dialog. A move that
// changes who has access gives a warning to show instead of the toast, in a
// dialog while the page that moved it is on screen, or else in a toast.
export function useMoveResource() {
  const qc = useQueryClient();
  const mounted = useMounted();
  const [warning, setWarning] = useState<string | null>(null);
  const move = useMutation({
    // The result is the warning, if the server gives one.
    mutationFn: async ({ type, id, from, to }: Move) => {
      if (type === "folder") {
        return (await api.updateFolder(id, undefined, to)).permission_warning?.message;
      }
      if (to)
        return (await api.moveDocumentToFolder(to, id)).permission_warning?.message;
      await api.moveDocumentToRoot(from!, id);
    },
    onSuccess: (warning, { type, id, from, to, toTitle }) => {
      qc.invalidateQueries({ queryKey: queryKeys.foldersAll() });
      qc.invalidateQueries({ queryKey: queryKeys.documents() });
      qc.invalidateQueries({ queryKey: queryKeys.pins() });
      qc.invalidateQueries({
        queryKey: type === "folder" ? queryKeys.folder(id) : queryKeys.document(id),
      });
      if (warning && mounted.current) setWarning(warning);
      else if (warning)
        toast.warning(warning, { duration: Infinity, closeButton: true });
      else
        toast.success(toTitle ? `Moved to ${toTitle}.` : "Moved.", {
          action: {
            label: "Undo",
            onClick: () =>
              move.mutate({ type, id, from: to ?? undefined, to: from ?? null }),
          },
        });
    },
    onError: (e) =>
      toast.error(
        e instanceof APIError && e.status === 403
          ? "You cannot move it there. Ask for edit access to the folder."
          : errorMessage(e, "Move failed"),
      ),
  });
  return { move, warning, clearWarning: () => setWarning(null) };
}
