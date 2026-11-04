import { useMemo, useState } from "react";
import { Link, useParams, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import { useTitle } from "@/lib/use-title";
import {
  ChevronRight,
  Folder as FolderIcon,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Plus,
  Share2,
  Trash2,
} from "lucide-react";
import { Page } from "@/components/layout/page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton, EmptyState } from "@/components/ui/misc";
import { ErrorState } from "@/components/error-state";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api, APIError, type FolderEntry } from "@/api";
import { canManageSharing } from "@/lib/constants";
import { queryKeys } from "@/lib/queryKeys";
import { samePrincipal } from "@/lib/principals";
import { viewModeStore } from "@/lib/view-mode";
import { ShareSheet } from "@/pages/doc-share-sheet";
import { Sheet, SheetTrigger } from "@/components/ui/sheet";
import { DRAG_TYPE, type ActiveDrag } from "@/components/browse/drag";
import { BrowseDragOverlay } from "@/components/browse/drag-overlay";
import { UnifiedGrid } from "@/components/browse/unified-grid";
import { UnifiedTable } from "@/components/browse/unified-table";
import { ViewModeToggle } from "@/components/browse/view-mode-toggle";
import { AccessWarningDialog, NewFolderDialog } from "@/components/browse/dialogs";
import { MoveDialog } from "@/components/browse/move-dialog";
import { useMoveResource } from "@/components/browse/use-resource-actions";
import { sortEntries } from "@/components/browse/sort-entries";
import { useBridgeHost } from "./use-bridge-host";
import { useDocumentEvents } from "./use-document-stream";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

export function FolderPage() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();

  const folder = useQuery({
    queryKey: queryKeys.folder(id),
    queryFn: () => api.getFolder(id),
    enabled: !!id,
    meta: { suppressGlobalError: true },
  });
  const contents = useQuery({
    queryKey: queryKeys.folders(id),
    queryFn: () => api.listFolders(id),
    enabled: !!id,
    meta: { suppressGlobalError: true },
  });
  const pins = useQuery({
    queryKey: queryKeys.pins(),
    queryFn: api.listPins,
  });
  const me = useQuery({ queryKey: queryKeys.me(), queryFn: api.me });
  const isOwner = samePrincipal(me.data?.principal, folder.data?.owner);
  // As for a document, the grants are asked for once the folder loads.
  const access = useQuery({
    queryKey: queryKeys.folderAccess(id),
    queryFn: () => api.folderAccess(id),
    enabled: !!folder.data && !!me.data?.principal && !isOwner,
    staleTime: 30_000,
  });
  const currentAccessRole = access.data?.current_role;
  const canManageAccess = isOwner || canManageSharing(currentAccessRole);

  const viewMode = viewModeStore.useStore();
  useTitle(folder.data?.title || "Folder");

  const pinnedIds = useMemo(
    () => new Set((pins.data?.items || []).map((p) => p.resource_id)),
    [pins.data],
  );

  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");

  const delFolder = useMutation({
    mutationFn: () => api.deleteFolder(id),
    onSuccess: () => {
      setDeleteOpen(false);
      toast.success("Deleted folder.");
      qc.invalidateQueries({ queryKey: queryKeys.foldersAll() });
      qc.invalidateQueries({ queryKey: queryKeys.documents() });
      qc.invalidateQueries({ queryKey: queryKeys.pins() });
      qc.removeQueries({ queryKey: queryKeys.folder(id) });
      nav("/app/documents");
    },
    onError: (e) => toast.error(errorMessage(e, "Delete failed")),
  });

  const renameFolder = useMutation({
    mutationFn: () => api.updateFolder(id, renameTitle),
    onSuccess: () => {
      setRenameOpen(false);
      qc.invalidateQueries({ queryKey: queryKeys.folder(id) });
      toast.success("Renamed.");
    },
    onError: (e) => toast.error(errorMessage(e, "Rename failed")),
  });

  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const { move, warning, clearWarning } = useMoveResource();

  if (folder.isLoading || contents.isLoading) {
    return (
      <Page backdrop={false}>
        <Skeleton className="mb-3 h-9 w-48" />
        <Skeleton className="h-64 w-full" />
      </Page>
    );
  }
  const error = folder.error || contents.error;
  if (error) {
    const apiError = error instanceof APIError ? error : undefined;
    return (
      <Page backdrop={false}>
        {apiError?.status === 404 ? (
          <ErrorState
            title="Folder not found"
            description="This folder may have been deleted, or the link may be incorrect."
          />
        ) : apiError?.code === "group_membership_unavailable" ? (
          <ErrorState
            title="Group access is temporarily unavailable"
            description="Google Group membership could not be refreshed. Try again shortly; stale group content has not been shown."
          />
        ) : (
          <ErrorState
            title="Could not load folder"
            description="Something went wrong while loading this folder. Please try again."
            retry={folder.error ? folder : contents}
          />
        )}
      </Page>
    );
  }

  const f = folder.data!;
  const items = contents.data?.items || [];
  const readme = items.find(
    (entry) => entry.type === "document" && entry.document?.title === "README.html",
  )?.document;
  const visibleItems = readme
    ? items.filter((entry) => entry.document?.id !== readme.id)
    : items;
  const breadcrumbs = f.ancestors || [];

  function handleDragStart(event: DragStartEvent) {
    const raw = event.active.id as string;
    const [type, did] = raw.split(":", 2);
    const entry = items.find((e) =>
      type === DRAG_TYPE.folder ? e.folder?.id === did : e.document?.id === did,
    );
    const title =
      type === DRAG_TYPE.folder
        ? entry?.folder?.title || "Folder"
        : entry?.document?.title || "Document";
    setActiveDrag({ type, id: did, title });
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDrag(null);
    const { active, over } = event;
    if (!over) return;
    const [dragType, dragId] = (active.id as string).split(":", 2);
    const targetFolderId = (over.id as string).replace("drop:", "");
    if (dragType === DRAG_TYPE.folder && dragId === targetFolderId) return;
    if (targetFolderId === id) return;
    const toRoot = targetFolderId === "__root__";
    move.mutate({
      type: dragType === DRAG_TYPE.folder ? "folder" : "document",
      id: dragId,
      from: id,
      to: toRoot ? null : targetFolderId,
      toTitle: toRoot
        ? "Documents"
        : [...breadcrumbs, ...items.flatMap((e) => (e.folder ? [e.folder] : []))].find(
            (f) => f.id === targetFolderId,
          )?.title,
    });
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <Page>
        {/* Breadcrumbs */}
        {/* The negative margin lines up the first crumb's text with the title. */}
        <nav className="-ml-1.5 mb-4 flex min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap text-sm text-[var(--color-fg-muted)]">
          <DroppableBreadcrumb
            dropId="drop:__root__"
            to="/app/documents"
            label="Documents"
            isDragging={!!activeDrag}
          />
          {breadcrumbs.map((b) => (
            <span key={b.id} className="flex shrink-0 items-center gap-1">
              <ChevronRight className="h-3 w-3" />
              <DroppableBreadcrumb
                dropId={`drop:${b.id}`}
                to={`/app/folders/${b.id}`}
                label={b.title}
                isDragging={!!activeDrag}
              />
            </span>
          ))}
          <ChevronRight className="h-3 w-3" />
          <span className="shrink-0 font-medium text-[var(--color-fg)]">{f.title}</span>
        </nav>

        {/* Header */}
        <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
              <FolderIcon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h1 className="enter truncate text-xl font-semibold tracking-[-0.01em] md:text-2xl">
                {f.title}
              </h1>
              <p className="truncate text-sm text-[var(--color-fg-muted)]">
                {f.owner?.name || f.owner?.email || ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <ViewModeToggle />
            <Button
              variant="outline"
              size="md"
              onClick={() => setNewFolderOpen(true)}
              aria-label="New subfolder"
              className="shrink-0 px-3 sm:px-4"
            >
              <Plus className="h-3.5 w-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">New subfolder</span>
            </Button>
            <Sheet>
              <SheetTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="Share folder"
                  className="shrink-0 px-2.5 sm:px-3"
                >
                  <Share2 className="h-3.5 w-3.5 sm:mr-1.5" />
                  <span className="hidden sm:inline">Share</span>
                </Button>
              </SheetTrigger>
              <ShareSheet
                resourceType="folder"
                resourceId={id}
                canManageAccess={canManageAccess}
              />
            </Sheet>
            <Dropdown>
              <DropdownTrigger asChild>
                <Button variant="outline" size="icon" aria-label="More folder actions">
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownTrigger>
              <DropdownContent>
                <DropdownItem
                  onSelect={() => {
                    setRenameTitle(f.title);
                    setRenameOpen(true);
                  }}
                >
                  <Pencil className="h-4 w-4" /> Rename
                </DropdownItem>
                <DropdownItem onSelect={() => setNewFolderOpen(true)}>
                  <Plus className="h-4 w-4" /> New subfolder
                </DropdownItem>
                <DropdownItem onSelect={() => setMoveOpen(true)}>
                  <FolderInput className="h-4 w-4" /> Move folder
                </DropdownItem>
                <DropdownItem
                  onSelect={() => window.setTimeout(() => setDeleteOpen(true), 0)}
                  className="text-[var(--color-danger)]"
                >
                  <Trash2 className="h-4 w-4" /> Delete folder
                </DropdownItem>
              </DropdownContent>
            </Dropdown>
          </div>
        </div>

        <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogTitle>Delete "{f.title}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This deletes the folder and its subfolders. Documents inside them will
              move to root.
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="danger"
                onClick={(e) => {
                  e.preventDefault();
                  delFolder.mutate();
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* Contents */}
        {visibleItems.length === 0 && !readme ? (
          <EmptyState
            icon={<FolderIcon className="h-5 w-5" />}
            title="Empty folder"
            description={
              <>
                Publish into it with {/* The command breaks only at its spaces. */}
                <code className="font-mono">
                  slashdocs docs create file.html{" "}
                  <span className="whitespace-nowrap">--folder-id</span> {id}
                </code>
                , or open a document and choose Move to folder in its More menu.
              </>
            }
            action={
              <Button variant="outline" onClick={() => setNewFolderOpen(true)}>
                <Plus className="h-4 w-4" /> New subfolder
              </Button>
            }
          />
        ) : (
          <FolderContents items={visibleItems} pinnedIds={pinnedIds} />
        )}
        {readme ? <FolderReadme document={readme} /> : null}

        {/* New subfolder dialog */}
        <NewFolderDialog
          open={newFolderOpen}
          onOpenChange={setNewFolderOpen}
          parentFolderId={id}
        />

        {/* Rename dialog */}
        <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Rename folder</DialogTitle>
            </DialogHeader>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (renameTitle.trim()) renameFolder.mutate();
              }}
            >
              <Input
                aria-label="Folder name"
                value={renameTitle}
                onChange={(e) => setRenameTitle(e.target.value)}
                autoFocus
              />
              <DialogFooter className="mt-4">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setRenameOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={!renameTitle.trim() || renameFolder.isPending}
                >
                  Rename
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>

        <MoveDialog
          open={moveOpen}
          onOpenChange={setMoveOpen}
          type="folder"
          id={id}
          title={f.title}
          parentId={f.parent_folder_id}
        />

        <AccessWarningDialog warning={warning} onClose={clearWarning} />
      </Page>
      <BrowseDragOverlay activeDrag={activeDrag} viewMode={viewMode} />
    </DndContext>
  );
}

function FolderReadme({
  document,
}: {
  document: NonNullable<FolderEntry["document"]>;
}) {
  const token = useQuery({
    queryKey: ["folder-readme-render", document.id, document.current_version_id],
    queryFn: () => api.renderToken(document.id, document.current_version_id || ""),
    enabled: !!document.current_version_id,
    staleTime: 4 * 60_000,
  });
  // The README is a full document: it follows the theme and reads and
  // writes its KV state, live, like on the document page.
  const bridge = useBridgeHost(document.id, token.data?.url);
  useDocumentEvents(document.id, { kv: bridge.deliverKV });
  return (
    <section className="mt-8 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
        <div>
          <div className="text-sm font-semibold">README.html</div>
          <div className="text-xs text-[var(--color-fg-muted)]">Folder overview</div>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to={`/app/d/${document.id}`}>Open document</Link>
        </Button>
      </div>
      {bridge.frameSrc ? (
        <iframe
          ref={bridge.ref}
          title="Folder README"
          src={bridge.frameSrc}
          className="h-[min(70vh,760px)] w-full border-0"
          sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        />
      ) : (
        <div className="p-6 text-sm text-[var(--color-fg-muted)]">
          {token.error ? "Could not render README.html." : "Preparing README.html…"}
        </div>
      )}
    </section>
  );
}

function FolderContents({
  items,
  pinnedIds,
}: {
  items: FolderEntry[];
  pinnedIds: Set<string>;
}) {
  const me = useQuery({ queryKey: queryKeys.me(), queryFn: api.me });
  const viewMode = viewModeStore.useStore();

  const entries = sortEntries(items, pinnedIds);

  return viewMode === "list" ? (
    <UnifiedTable
      entries={entries}
      principal={me.data?.principal}
      pinnedIds={pinnedIds}
    />
  ) : (
    <UnifiedGrid entries={entries} pinnedIds={pinnedIds} />
  );
}

function DroppableBreadcrumb({
  dropId,
  to,
  label,
  isDragging,
}: {
  dropId: string;
  to: string;
  label: string;
  isDragging: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: dropId });
  return (
    <Link
      ref={setNodeRef}
      to={to}
      className={`rounded px-1.5 py-0.5 transition-colors hover:underline ${
        isDragging ? "ring-1 ring-[var(--color-border)] ring-dashed" : ""
      } ${isOver ? "bg-[var(--color-accent)]/15 ring-2 ring-[var(--color-accent)] font-medium text-[var(--color-accent)]" : ""}`}
    >
      {label}
    </Link>
  );
}
