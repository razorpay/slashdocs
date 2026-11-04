import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "@/api";
import { errorMessage } from "@/lib/errors";
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
  const togglePin = useMutation({
    mutationFn: () =>
      isPinned
        ? api.deletePin(resourceType, resourceId)
        : api.putPin(resourceType, resourceId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.pins() });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return { isPinned, togglePin };
}

// Delete mutation shared by every card/row action cluster.
export function useDeleteResource(resourceType: ResourceType, resourceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      resourceType === "folder"
        ? api.deleteFolder(resourceId)
        : api.deleteDocument(resourceId),
    onSuccess: () => {
      toast.success("Deleted.");
      qc.invalidateQueries({ queryKey: queryKeys.foldersAll() });
      qc.invalidateQueries({ queryKey: queryKeys.documents() });
      qc.invalidateQueries({ queryKey: queryKeys.pins() });
    },
    onError: (e) => toast.error(errorMessage(e, "Delete failed")),
  });
}

// A move of a document or folder into the folder `to`, or to the top level
// when `to` is null. A document leaves the top level through `from`, the
// folder that it is in.
export type Move = {
  type: ResourceType;
  id: string;
  from?: string;
  to: string | null;
};

// Move mutation shared by drag and drop and the Move dialog. A move that
// changes who has access gives a warning to show instead of the toast.
export function useMoveResource() {
  const qc = useQueryClient();
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
    onSuccess: (warning, { type, id }) => {
      qc.invalidateQueries({ queryKey: queryKeys.foldersAll() });
      qc.invalidateQueries({ queryKey: queryKeys.documents() });
      qc.invalidateQueries({ queryKey: queryKeys.pins() });
      qc.invalidateQueries({
        queryKey: type === "folder" ? queryKeys.folder(id) : queryKeys.document(id),
      });
      if (warning) setWarning(warning);
      else toast.success("Moved.");
    },
    onError: (e) => toast.error(errorMessage(e, "Move failed")),
  });
  return { move, warning, clearWarning: () => setWarning(null) };
}
