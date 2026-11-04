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
