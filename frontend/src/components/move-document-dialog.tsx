import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FolderIcon, Search } from "lucide-react";
import { toast } from "sonner";
import { api, APIError, type ExpectedSource, type Folder } from "@/api";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AccessWarningDialog } from "@/components/browse/dialogs";

const ROOT_ID = "__workspace_root__";

type CurrentFolder = { id: string; title: string };

type MoveDialogViewportStyle = CSSProperties & {
  "--move-dialog-viewport-height"?: string;
  "--move-dialog-viewport-offset-top"?: string;
};

export function MoveDocumentDialog({
  open,
  onOpenChange,
  docId,
  currentFolder,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  docId: string;
  currentFolder?: CurrentFolder;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(
    currentFolder ? ROOT_ID : null,
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pendingWarning, setPendingWarning] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [viewportStyle, setViewportStyle] = useState<MoveDialogViewportStyle>({});
  const optionRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const currentFolderId = currentFolder?.id;

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    setDebouncedSearch("");
    setSelectedId(currentFolder ? ROOT_ID : null);
    setActiveIndex(0);
    setError(null);
  }, [currentFolder, open]);

  useEffect(() => {
    if (!open) {
      setViewportStyle({});
      return;
    }

    const viewport = window.visualViewport;
    if (!viewport) {
      // The scoped CSS keeps the 100dvh behavior when VisualViewport is not
      // available (for example, older browsers and the test DOM).
      setViewportStyle({});
      return;
    }

    const updateViewportStyle = () => {
      setViewportStyle({
        "--move-dialog-viewport-height": `${viewport.height}px`,
        "--move-dialog-viewport-offset-top": `${viewport.offsetTop}px`,
      });
    };

    updateViewportStyle();
    viewport.addEventListener("resize", updateViewportStyle);
    viewport.addEventListener("scroll", updateViewportStyle);

    return () => {
      viewport.removeEventListener("resize", updateViewportStyle);
      viewport.removeEventListener("scroll", updateViewportStyle);
    };
  }, [open]);

  // A warning is intentionally opened on a later turn, after Radix has closed
  // the move dialog. This prevents two modal focus traps from overlapping.
  useEffect(() => {
    if (open || !pendingWarning) return;
    const timer = window.setTimeout(() => {
      setWarning(pendingWarning);
      setPendingWarning(null);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, pendingWarning]);

  const folders = useQuery({
    queryKey: queryKeys.foldersSearch(debouncedSearch),
    queryFn: () => api.listFolders(undefined, undefined, debouncedSearch, "editor"),
    enabled: open,
    staleTime: 15_000,
  });

  const destinations = useMemo(() => {
    const result: Array<{ id: string; folder?: Folder; isRoot?: boolean }> = [];
    if (currentFolderId) result.push({ id: ROOT_ID, isRoot: true });
    for (const entry of folders.data?.items || []) {
      if (
        entry.type === "folder" &&
        entry.folder &&
        entry.folder.id !== currentFolderId
      ) {
        result.push({ id: entry.folder.id, folder: entry.folder });
      }
    }
    return result;
  }, [currentFolderId, folders.data?.items]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(destinations.length - 1, 0)));
  }, [destinations.length]);

  const move = useMutation({
    mutationFn: async (destinationId: string) => {
      if (destinationId === ROOT_ID) {
        // Root is only rendered when the source is a folder, so this cannot be
        // a root-to-root move.
        if (!currentFolder) {
          throw new Error("A root document is already at the workspace root.");
        }
        return api.moveDocumentToRoot(currentFolder.id, docId);
      }
      const expectedSource: ExpectedSource = currentFolder
        ? { kind: "folder", folder_id: currentFolder.id }
        : { kind: "root" };
      return api.moveDocumentToFolder(destinationId, docId, expectedSource);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.document(docId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.documentAccess(docId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.documents() });
      queryClient.invalidateQueries({ queryKey: queryKeys.foldersAll() });
      queryClient.invalidateQueries({ queryKey: queryKeys.folderAccessAll() });
      onOpenChange(false);
      const message =
        data && "permission_warning" in data
          ? data.permission_warning?.message
          : undefined;
      if (message) setPendingWarning(message);
      else if (data && "moved" in data && !data.moved)
        toast("Document is already in that folder.");
      else toast.success("Document moved.");
    },
    onError: (cause) => {
      if (cause instanceof APIError && cause.status === 403) {
        setError("You do not have permission to move this document.");
      } else if (
        cause instanceof APIError &&
        (cause.status === 409 || cause.code === "source_changed")
      ) {
        setError("The document changed location. Refresh and try again.");
      } else {
        setError(errorMessage(cause, "Move failed."));
      }
    },
  });

  function updateActiveIndex(nextIndex: number) {
    const boundedIndex = Math.max(
      0,
      Math.min(nextIndex, Math.max(destinations.length - 1, 0)),
    );
    setActiveIndex(boundedIndex);
    const destination = destinations[boundedIndex];
    optionRefs.current[destination?.id || ""]?.scrollIntoView?.({
      block: "nearest",
      behavior: "auto",
    });
  }

  function onInputKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      updateActiveIndex(activeIndex + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      updateActiveIndex(activeIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      updateActiveIndex(0);
    } else if (event.key === "End") {
      event.preventDefault();
      updateActiveIndex(destinations.length - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const destination = destinations[activeIndex];
      if (destination) setSelectedId(destination.id);
    }
  }

  const activeDestination = destinations[activeIndex];
  const selectedLabel = destinations.find(
    (destination) => destination.id === selectedId,
  );

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && move.isPending) return;
          onOpenChange(next);
        }}
      >
        <DialogContent
          className="move-dialog-content flex max-w-xl flex-col"
          style={viewportStyle}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>Move document</DialogTitle>
            <DialogDescription>
              Choose a folder where you have editor access. Search results only include
              folders available to you.
            </DialogDescription>
          </DialogHeader>
          <div className="move-dialog-search shrink-0 relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-fg-muted)]" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setSelectedId(null);
                setActiveIndex(0);
                setError(null);
              }}
              onKeyDown={onInputKeyDown}
              placeholder="Search folders"
              role="combobox"
              aria-label="Search destination folders"
              aria-autocomplete="list"
              aria-controls="move-folder-list"
              aria-expanded
              aria-busy={folders.isFetching}
              aria-activedescendant={
                activeDestination ? `move-folder-${activeDestination.id}` : undefined
              }
              autoFocus
              className="move-dialog-search-input pl-10"
            />
          </div>
          <div
            id="move-folder-list"
            role="listbox"
            aria-label="Destination folders"
            aria-busy={folders.isFetching}
            className="move-dialog-list h-64 min-h-64 max-h-64 overflow-y-auto overscroll-contain rounded-[10px] border border-[var(--color-border)] p-1"
          >
            {folders.isLoading ? (
              <div
                className="flex min-h-full items-center p-3 text-sm text-[var(--color-fg-muted)]"
                role="status"
              >
                Loading folders…
              </div>
            ) : folders.isError ? (
              <div
                className="flex min-h-full items-center justify-between gap-3 p-3"
                role="alert"
              >
                <span className="text-sm text-[var(--color-danger)]">
                  {errorMessage(folders.error, "Could not load folders.")}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => void folders.refetch()}
                >
                  Retry
                </Button>
              </div>
            ) : destinations.length === 0 ? (
              <div className="flex min-h-full items-center p-3 text-sm text-[var(--color-fg-muted)]">
                No folders found.
              </div>
            ) : (
              destinations.map((destination, index) => {
                const isSelected = destination.id === selectedId;
                const isActive = index === activeIndex;
                return (
                  <button
                    key={destination.id}
                    ref={(element) => {
                      optionRefs.current[destination.id] = element;
                    }}
                    id={`move-folder-${destination.id}`}
                    type="button"
                    role="option"
                    tabIndex={-1}
                    aria-selected={isSelected}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => setSelectedId(destination.id)}
                    className={`move-dialog-option flex min-h-12 w-full items-start gap-3 rounded-md px-3 py-2 text-left outline-none motion-safe:transition-[transform,opacity] motion-safe:duration-150 motion-safe:ease-[cubic-bezier(0.23,1,0.32,1)] motion-safe:active:scale-[0.985] ${
                      isActive ? "bg-[var(--color-surface-muted)]" : ""
                    }`}
                  >
                    <FolderIcon className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" />
                    <span className="min-w-0 flex-1">
                      {destination.isRoot ? (
                        <span className="block text-sm font-medium">
                          Workspace root
                        </span>
                      ) : (
                        <>
                          <span className="block truncate text-sm font-medium">
                            {folderPath(destination.folder!)}
                          </span>
                          <span className="mt-0.5 block truncate text-xs text-[var(--color-fg-muted)]">
                            Owner: {principalLabel(destination.folder?.owner)}
                          </span>
                        </>
                      )}
                    </span>
                    {isSelected ? (
                      <span className="shrink-0 pt-0.5 text-xs text-[var(--color-accent)]">
                        Selected
                      </span>
                    ) : null}
                  </button>
                );
              })
            )}
          </div>
          <div className="move-dialog-error flex min-h-5 shrink-0 items-center text-sm text-[var(--color-danger)]">
            {error ? <p role="alert">{error}</p> : null}
          </div>
          <DialogFooter className="move-dialog-footer shrink-0">
            <Button
              type="button"
              variant="ghost"
              disabled={move.isPending}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!selectedLabel || move.isPending}
              onClick={() => {
                if (selectedLabel) move.mutate(selectedLabel.id);
              }}
            >
              {move.isPending ? "Moving…" : "Move"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AccessWarningDialog warning={warning} onClose={() => setWarning(null)} />
    </>
  );
}

function folderPath(folder: Folder) {
  const ancestors = folder.ancestors || [];
  const parts = [
    ...(folder.ancestors_truncated ? ["…"] : []),
    ...ancestors.map((ancestor) => ancestor.title),
    folder.title,
  ];
  return parts.join(" / ");
}

function principalLabel(principal?: Folder["owner"]) {
  if (!principal) return "Unknown";
  return principal.name || principal.email || principal.id || "Unknown";
}
