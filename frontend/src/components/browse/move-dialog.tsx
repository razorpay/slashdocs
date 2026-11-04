import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Folder as FolderIcon, Home } from "lucide-react";
import { Input } from "@/components/ui/input";
import { RetryButton, Skeleton } from "@/components/ui/misc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/api";
import { useDebounced } from "@/lib/hooks";
import { queryKeys } from "@/lib/queryKeys";
import { AccessWarningDialog } from "./dialogs";
import { useMoveResource, type ResourceType } from "./use-resource-actions";

// The keyboard way to do what drag and drop does: pick the folder that a
// document or folder moves to. The list shows the top level and its folders,
// and a search finds any folder. The current place cannot be picked, and a
// folder does not list itself.
export function MoveDialog({
  open,
  onOpenChange,
  type,
  id,
  title,
  parentId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  type: ResourceType;
  id: string;
  title: string;
  parentId?: string;
}) {
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim(), 250);
  const folders = useQuery({
    queryKey: [...queryKeys.folders(), search],
    queryFn: () => api.listFolders(undefined, undefined, search || undefined),
    enabled: open,
    placeholderData: (prev) => prev,
  });
  const { move, warning, clearWarning } = useMoveResource();
  const destinations = [
    ...(search ? [] : [{ id: null, title: "Documents", ancestors: [] }]),
    ...(folders.data?.items || []).flatMap((e) =>
      e.type === "folder" && e.folder && e.folder.id !== id ? [e.folder] : [],
    ),
  ];
  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) setQuery("");
  };

  return (
    <>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent anchor="top">
          <DialogHeader>
            <DialogTitle>Move “{title}”</DialogTitle>
            <DialogDescription>Choose the folder to move it to.</DialogDescription>
          </DialogHeader>
          <Input
            type="search"
            aria-label="Search folders"
            placeholder="Search all folders"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <ul aria-label="Folders" className="-mx-1 mt-3 max-h-72 overflow-y-auto p-1">
            {folders.isLoading ? (
              <li className="space-y-1">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </li>
            ) : folders.error ? (
              <li className="flex items-center gap-3 px-3 py-2 text-sm">
                <span className="flex-1">Could not load folders.</span>
                <RetryButton query={folders} variant="outline" size="sm" />
              </li>
            ) : (
              destinations.map((d) => {
                const current = (d.id ?? undefined) === parentId;
                const Icon = d.id ? FolderIcon : Home;
                // The path tells apart folders with the same title.
                const path = d.ancestors?.map((a) => a.title).join(" / ");
                return (
                  <li key={d.id ?? "top"}>
                    <button
                      type="button"
                      aria-label={[d.title, path && `in ${path}`, current && "current"]
                        .filter(Boolean)
                        .join(", ")}
                      disabled={current || move.isPending}
                      onClick={() =>
                        move.mutate(
                          { type, id, from: parentId, to: d.id, toTitle: d.title },
                          { onSuccess: () => close(false) },
                        )
                      }
                      className="wash-link flex min-h-10 w-full items-center gap-3 rounded-sm px-3 py-1.5 text-left text-sm disabled:pointer-events-none disabled:opacity-50"
                    >
                      <Icon className="h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{d.title}</span>
                        {path ? (
                          <span className="block truncate text-xs text-[var(--color-fg-muted)]">
                            {path}
                          </span>
                        ) : null}
                      </span>
                      {current && (
                        <span className="text-xs text-[var(--color-fg-muted)]">
                          Current
                        </span>
                      )}
                    </button>
                  </li>
                );
              })
            )}
            {search && folders.isSuccess && destinations.length === 0 ? (
              <li className="px-3 py-2 text-sm text-[var(--color-fg-muted)]">
                No folders match “{search}”.
              </li>
            ) : null}
          </ul>
        </DialogContent>
      </Dialog>
      <AccessWarningDialog warning={warning} onClose={clearWarning} />
    </>
  );
}
