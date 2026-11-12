import { useState } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Folder as FolderIcon, LockKeyhole, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RetryButton, Skeleton } from "@/components/ui/misc";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  APIError,
  api,
  type MoveDestinationNode,
  type MoveDestinationSearch,
} from "@/api";
import { useDebounced } from "@/lib/hooks";
import { queryKeys } from "@/lib/queryKeys";
import { AccessWarningDialog } from "./dialogs";
import { MoveTree } from "./move-tree";
import { destinationForSelection } from "./move-tree-state";
import { useMoveTree } from "./use-move-tree";
import { useMoveResource, type ResourceType } from "./use-resource-actions";

const searchPath = (node: MoveDestinationNode) =>
  [
    node.ancestors_truncated ? "…" : undefined,
    ...(node.ancestors?.map((ancestor) => ancestor.title) || []),
  ]
    .filter(Boolean)
    .join(" / ");

const cannotMoveCopy = (type: ResourceType, reason?: string) => {
  if (reason === "owner_required") return "Only the folder owner can move this folder.";
  if (reason === "source_editor_required")
    return "You need edit access to the current folder before you can move this document.";
  if (reason === "editor_required") return `You need edit access to move this ${type}.`;
  return `You cannot move this ${type}.`;
};
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
  const [revealError, setRevealError] = useState("");
  const [accessLossRequiredFor, setAccessLossRequiredFor] = useState("");
  const trimmedQuery = query.trim();
  const search = useDebounced(trimmedQuery, 250);
  const searchReady = trimmedQuery.length >= 2 && search.length >= 2;
  const tree = useMoveTree({ open, type, id });
  const results = useQuery({
    queryKey: queryKeys.moveDestinationSearch(type, id, search),
    queryFn: () => api.searchMoveDestinations(type, id, search),
    enabled: open && searchReady,
  });
  const { move, warning, clearWarning } = useMoveResource();
  const selectedDestination = destinationForSelection(tree.state.selected);
  const selectedTitle =
    selectedDestination?.kind === "root"
      ? "Documents"
      : selectedDestination
        ? tree.state.nodes[selectedDestination.folder_id]?.title
        : undefined;
  const source = tree.state.bootstrap?.resource.source;
  const resourceKey = `${type}:${id}`;
  const wouldLoseAccess =
    type === "document" &&
    selectedDestination?.kind === "root" &&
    (!!tree.state.bootstrap?.documents.would_lose_access ||
      accessLossRequiredFor === resourceKey);

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setQuery("");
      setRevealError("");
      setAccessLossRequiredFor("");
    }
  };

  const chooseSearchResult = async (node: MoveDestinationNode) => {
    setRevealError("");
    try {
      const revealed = await tree.reveal(node.id);
      if (!revealed) return;
      setQuery("");
    } catch {
      setRevealError("Could not show that folder in the tree");
    }
  };

  const confirm = () => {
    if (!selectedDestination || !tree.state.bootstrap) return;
    const token = source?.token;
    if (type === "document" && !token) {
      tree.dispatch({
        type: "announce",
        message: "The move information is out of date. Close and try again.",
      });
      return;
    }
    move.mutate(
      {
        type,
        id,
        // Document moves use the opaque server source token. Do not feed a
        // possibly hidden source folder ID into the legacy undo path.
        from:
          type === "folder"
            ? source?.kind === "folder"
              ? source.folder_id
              : parentId
            : undefined,
        to:
          selectedDestination.kind === "folder" ? selectedDestination.folder_id : null,
        toTitle: selectedTitle,
        sourceToken: type === "document" ? token : undefined,
        acknowledgeAccessLoss: wouldLoseAccess,
      },
      {
        onSuccess: () => close(false),
        onError: (error) => {
          if (error instanceof APIError && error.code === "source_changed") {
            void tree.refresh().then(() => {
              tree.dispatch({
                type: "announce",
                message: "The current location changed. Choose a destination again.",
              });
            });
          } else if (
            error instanceof APIError &&
            error.code === "access_loss_confirmation_required"
          ) {
            setAccessLossRequiredFor(resourceKey);
            tree.dispatch({
              type: "announce",
              message: "Access changed. Review the warning before moving.",
            });
          }
        },
      },
    );
  };

  const restrictedSource = source?.kind === "restricted";
  const cannotMove = tree.state.bootstrap?.resource.can_move === false;

  return (
    <>
      <Dialog open={open} onOpenChange={close}>
        <DialogContent
          anchor="top"
          className="flex h-[min(680px,calc(100dvh-2rem))] flex-col overflow-hidden p-0 max-md:h-[min(82dvh,680px)] max-md:max-h-none max-md:pb-0"
        >
          <div className="shrink-0 px-5 pt-5 md:px-6 md:pt-6">
            <DialogHeader className="mb-3">
              <DialogTitle className="break-words pe-2">Move “{title}”</DialogTitle>
              <DialogDescription>
                {restrictedSource
                  ? "Currently in a restricted folder. Choose a new location."
                  : "Choose a folder, then confirm the move."}
              </DialogDescription>
            </DialogHeader>
            <label htmlFor={`move-search-${id}`} className="sr-only">
              Search all folders
            </label>
            <div className="relative">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-fg-muted)]"
              />
              <Input
                id={`move-search-${id}`}
                type="search"
                placeholder="Search all folders"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || !query) return;
                  event.preventDefault();
                  event.stopPropagation();
                  setQuery("");
                }}
                className="h-11 ps-9 text-base md:text-sm"
              />
            </div>
          </div>

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 md:px-4">
            {tree.bootstrap.isPending ? (
              <div className="space-y-2 p-2" role="status" aria-label="Loading folders">
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-11 w-full" />
              </div>
            ) : tree.bootstrap.isError ? (
              <div className="flex min-h-28 items-center gap-3 p-3 text-sm">
                <span className="min-w-0 flex-1">Could not load folders.</span>
                <RetryButton query={tree.bootstrap} variant="outline" size="sm" />
              </div>
            ) : cannotMove ? (
              <div className="p-4 text-sm">
                {cannotMoveCopy(
                  type,
                  tree.state.bootstrap?.resource.cannot_move_reason,
                )}
              </div>
            ) : trimmedQuery.length === 1 ? (
              <p className="p-4 text-sm text-[var(--color-fg-muted)]">
                Type at least 2 characters to search all folders.
              </p>
            ) : trimmedQuery.length >= 2 && !searchReady ? (
              <div
                className="space-y-2 p-2"
                role="status"
                aria-label="Searching folders"
              >
                <Skeleton className="h-11 w-full" />
                <Skeleton className="h-11 w-full" />
              </div>
            ) : searchReady ? (
              <SearchResults
                query={search}
                results={results}
                onChoose={chooseSearchResult}
              />
            ) : tree.state.bootstrap ? (
              <MoveTree
                state={tree.state}
                dispatch={tree.dispatch}
                setExpanded={tree.setExpanded}
                loadChildren={tree.loadChildren}
                pending={move.isPending}
              />
            ) : null}
          </div>

          <div aria-live="polite" role="status" className="sr-only">
            {revealError || tree.state.announcement}
          </div>
          {revealError ? (
            <p
              role="alert"
              className="shrink-0 px-5 py-2 text-sm text-[var(--color-danger)] md:px-6"
            >
              {revealError}. Try again.
            </p>
          ) : null}
          {wouldLoseAccess ? (
            <p
              role="alert"
              className="mx-5 mb-3 shrink-0 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-sm md:mx-6"
            >
              Moving to Documents will remove your edit access to this document. You may
              not be able to edit it afterward.
            </p>
          ) : null}
          <DialogFooter className="mt-0 shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-5 pb-[calc(1rem+env(safe-area-inset-bottom,0px))] pt-4 md:px-6 md:pb-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => close(false)}
              className="min-h-11"
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={!selectedDestination || move.isPending || cannotMove}
              onClick={confirm}
              aria-label={
                selectedTitle && !move.isPending
                  ? wouldLoseAccess
                    ? "Move and lose access"
                    : `Move to ${selectedTitle}`
                  : undefined
              }
              className="min-h-11 min-w-0 max-w-full"
            >
              <span className="min-w-0 truncate">
                {move.isPending
                  ? "Moving…"
                  : selectedTitle
                    ? wouldLoseAccess
                      ? "Move and lose access"
                      : `Move to ${selectedTitle}`
                    : "Move"}
              </span>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AccessWarningDialog warning={warning} onClose={clearWarning} />
    </>
  );
}

function SearchResults({
  query,
  results,
  onChoose,
}: {
  query: string;
  results: UseQueryResult<MoveDestinationSearch, Error>;
  onChoose: (node: MoveDestinationNode) => Promise<void>;
}) {
  if (results.isPending)
    return (
      <div className="space-y-2 p-2" role="status" aria-label="Searching folders">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-11 w-full" />
      </div>
    );
  if (results.isError)
    return (
      <div className="flex min-h-28 items-center gap-3 p-3 text-sm">
        <span className="min-w-0 flex-1">Could not search folders.</span>
        <RetryButton query={results} variant="outline" size="sm" />
      </div>
    );
  if (!results.data.items.length)
    return (
      <p className="p-4 text-sm text-[var(--color-fg-muted)]">
        No folders match “{query}”. Try a different search.
      </p>
    );
  return (
    <ul aria-label="Folder search results" className="py-1">
      {results.data.items.map((node) => {
        const path = searchPath(node);
        const viewOnly = node.access === "view" || node.reason === "view_only";
        return (
          <li key={node.id}>
            <button
              type="button"
              onClick={() => void onChoose(node)}
              className="flex min-h-11 w-full touch-manipulation items-center gap-2 rounded-md px-3 py-1.5 text-start text-sm outline-none hover:bg-[var(--color-surface-muted)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
            >
              <FolderIcon
                aria-hidden="true"
                className="h-4 w-4 shrink-0 text-[var(--color-accent)]"
              />
              <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                <span className="block font-medium">{node.title}</span>
                <span className="block text-xs text-[var(--color-fg-muted)]">
                  {node.restricted_parent
                    ? "In a restricted folder"
                    : path || "Documents"}
                </span>
              </span>
              {viewOnly ? (
                <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs text-[var(--color-fg-muted)]">
                  <LockKeyhole aria-hidden="true" className="h-3.5 w-3.5" /> View only
                </span>
              ) : null}
            </button>
          </li>
        );
      })}
      {results.data.has_more ? (
        <li className="px-3 py-2 text-xs text-[var(--color-fg-muted)]">
          Refine your search to see more results.
        </li>
      ) : null}
    </ul>
  );
}
