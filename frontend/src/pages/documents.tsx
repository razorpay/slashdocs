import { useTitle } from "@/lib/use-title";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useOnboarding, autoMarkFirstDoc, onboardingProgress } from "@/lib/onboarding";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { errorMessage } from "@/lib/errors";
import { useDebounced } from "@/lib/hooks";
import { MoreHorizontal, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/layout/page";
import { beat } from "@/lib/enter";
import { Skeleton, EmptyState } from "@/components/ui/misc";
import { LoadError, LoadErrorLine } from "@/components/error-state";
import { Dropdown, DropdownContent, DropdownTrigger } from "@/components/ui/dropdown";
import { api, APIError, docID, docTitle, type Folder, type FolderEntry } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { viewModeStore } from "@/lib/view-mode";
import { DRAG_TYPE, type ActiveDrag } from "@/components/browse/drag";
import { useMoveResource } from "@/components/browse/use-resource-actions";
import { BrowseDragOverlay } from "@/components/browse/drag-overlay";
import { UnifiedGrid } from "@/components/browse/unified-grid";
import { UnifiedTable } from "@/components/browse/unified-table";
import { ViewModeToggle } from "@/components/browse/view-mode-toggle";
import { AccessWarningDialog, NewFolderDialog } from "@/components/browse/dialogs";
import {
  UploadBackupDialog,
  UploadBackupMenuItem,
} from "@/components/browse/upload-backup";
import { DocumentSearchInput } from "@/components/browse/document-search-input";
import { FeaturedItems } from "@/components/browse/featured-items";
import { sortEntries } from "@/components/browse/sort-entries";
import { hasDocumentSearchOperators } from "@/lib/search-query";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";

export function DocumentsPage() {
  useTitle("Documents");
  // The search is in the URL, so Back from a result returns to the results.
  // The field keeps its own value, because a URL update can come after the
  // next key and drop a letter. The URL follows the field after a pause, and
  // replaces the history entry, so Back does not step through letters.
  const [params, setParams] = useSearchParams();
  const urlQ = params.get("q") || "";
  const [q, setQ] = useState(urlQ);
  // The query that the URL has, from the field or from Back, forward or a
  // link. A query that the field did not write replaces the field.
  const [seenQ, setSeenQ] = useState(urlQ);
  if (urlQ !== seenQ) {
    setSeenQ(urlQ);
    setQ(urlQ);
  }
  const pausedQ = useDebounced(q, 250);
  useEffect(() => {
    if (pausedQ !== q || pausedQ === seenQ) return;
    setSeenQ(pausedQ);
    setParams(pausedQ ? { q: pausedQ } : {}, { replace: true });
  }, [pausedQ, q, seenQ, setParams]);
  const debouncedQ = pausedQ.trim();
  const me = useQuery({ queryKey: queryKeys.me(), queryFn: api.me });
  // The server sends documents a page at a time.
  const docs = useInfiniteQuery({
    queryKey: [...queryKeys.documents(), debouncedQ],
    queryFn: ({ pageParam }) => api.listDocuments(debouncedQ || undefined, pageParam),
    initialPageParam: 0,
    getNextPageParam: (last, pages) =>
      last.has_more ? pages.reduce((n, page) => n + page.items.length, 0) : undefined,
    placeholderData: (prev) => prev,
    // The page shows the error.
    meta: { suppressGlobalError: true },
  });
  const pins = useQuery({
    queryKey: queryKeys.pins(),
    queryFn: api.listPins,
  });
  const structuredSearch = hasDocumentSearchOperators(debouncedQ);
  const rootFolders = useQuery({
    queryKey: [...queryKeys.folders(), debouncedQ],
    queryFn: () => api.listFolders(undefined, undefined, debouncedQ || undefined),
    placeholderData: (prev) => prev,
    enabled: !structuredSearch,
    // The page shows the error.
    meta: { suppressGlobalError: true },
  });
  // Folders that did not load are not an empty list: the page says so.
  const foldersFailed = !structuredSearch && rootFolders.isError;
  const documents = useMemo(
    () => docs.data?.pages.flatMap((page) => page.items) || [],
    [docs.data],
  );
  // A new reader, with no documents and no setup progress on this browser,
  // starts at the setup guide.
  const { state: onb } = useOnboarding();
  const nav = useNavigate();
  const noDocuments =
    docs.isSuccess && !docs.isPlaceholderData && !debouncedQ && documents.length === 0;
  useEffect(() => {
    if (noDocuments && onb.status === "active" && onboardingProgress(onb).done === 0) {
      nav("/app/start", { replace: true });
    }
  }, [noDocuments, onb, nav]);
  useEffect(() => {
    if (documents.length > 0) autoMarkFirstDoc();
  }, [documents]);
  const folderEntries = (structuredSearch ? [] : rootFolders.data?.items || []).filter(
    (e): e is FolderEntry & { folder: Folder } => e.type === "folder" && !!e.folder,
  );
  const folders = folderEntries.map((e) => e.folder);

  const pinnedIds = useMemo(
    () => new Set((pins.data?.items || []).map((p) => p.resource_id)),
    [pins.data],
  );

  const entries = useMemo<FolderEntry[]>(
    () => [
      ...folderEntries.map((e) => ({
        type: "folder" as const,
        folder: e.folder,
        last_active: e.last_active,
      })),
      ...documents.map((d) => ({
        type: "document" as const,
        document: d,
        last_active: d.updated_at,
      })),
    ],
    [folderEntries, documents],
  );

  // Search results keep the server's order: documents with the words in the
  // title first, then the latest.
  const merged = useMemo(() => sortEntries(entries, pinnedIds), [entries, pinnedIds]);

  const viewMode = viewModeStore.useStore();
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);

  // Drag and drop
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const { move, warning, clearWarning } = useMoveResource();

  function handleDragStart(event: DragStartEvent) {
    const raw = event.active.id as string;
    const [type, id] = raw.split(":", 2);
    const dragged =
      type === DRAG_TYPE.folder
        ? folders.find((f) => f.id === id)?.title
        : (() => {
            const doc = documents.find((d) => docID(d) === id);
            return doc ? docTitle(doc) : undefined;
          })();
    // The entry can vanish mid-drag (e.g. a background refetch removed it);
    // fall back to a generic label rather than crashing.
    const title = dragged || (type === DRAG_TYPE.folder ? "Folder" : "Document");
    setActiveDrag({ type, id, title });
  }
  function handleDragEnd(event: DragEndEvent) {
    setActiveDrag(null);
    const { active, over } = event;
    if (!over) return;
    const [dragType, dragId] = (active.id as string).split(":", 2);
    const targetFolderId = (over.id as string).replace("drop:", "");
    if (dragType === DRAG_TYPE.folder && dragId === targetFolderId) return;
    move.mutate({
      type: dragType === DRAG_TYPE.folder ? "folder" : "document",
      id: dragId,
      to: targetFolderId,
      toTitle: folders.find((f) => f.id === targetFolderId)?.title,
    });
  }

  if (docs.isLoading) {
    return (
      <Page backdrop={false}>
        <Skeleton className="mx-auto mb-8 mt-16 h-14 max-w-2xl rounded-[18px]" />
        <Skeleton className="h-64 w-full" />
      </Page>
    );
  }
  const searching = debouncedQ.length > 0;
  const empty =
    !searching && !foldersFailed && documents.length === 0 && folders.length === 0;
  // The server rejects a search it cannot read with a 400 and says why.
  const invalidSearch =
    searching && docs.error instanceof APIError && docs.error.status === 400;

  const name = (me.data?.user || me.data?.principal)?.name?.split(" ")[0];

  return (
    <Page backdrop="halo">
      <section className="pb-12 pt-8 text-center md:pb-16 md:pt-16">
        <p className="enter text-lg text-[var(--color-fg-muted)]">
          {name ? `Hi, ${name}` : "Welcome back"}
        </p>
        <h1
          className="enter mt-2 text-[32px] font-normal leading-tight tracking-[-0.02em] md:text-[44px]"
          style={beat(1)}
        >
          What did your agents publish?
        </h1>
        <div className="enter mx-auto mt-8 max-w-2xl" style={beat(2)}>
          <DocumentSearchInput value={q} onChange={setQ} />
        </div>
      </section>
      <div
        className="enter mb-4 flex items-center justify-between gap-2"
        style={beat(3)}
      >
        <h2 className="text-base font-semibold">
          {searching ? "Results" : "Documents"}
        </h2>
        <div className="flex items-center gap-2">
          <ViewModeToggle />
          {!searching && (
            <Button
              variant="outline"
              size="md"
              aria-label="New folder"
              onClick={() => setNewFolderOpen(true)}
              className="shrink-0 px-3 sm:px-4"
            >
              <Plus className="h-3.5 w-3.5 sm:mr-1.5" />{" "}
              <span className="hidden sm:inline">New folder</span>
            </Button>
          )}
          <Dropdown>
            <DropdownTrigger asChild>
              <Button
                variant="outline"
                size="icon"
                className="shrink-0"
                aria-label="More"
              >
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownTrigger>
            <DropdownContent>
              <UploadBackupMenuItem onSelect={() => setUploadOpen(true)} />
            </DropdownContent>
          </Dropdown>
        </div>
      </div>

      {!searching && <FeaturedItems />}

      {foldersFailed ? (
        <LoadErrorLine boxed query={rootFolders}>
          Could not load folders. Documents show below.
        </LoadErrorLine>
      ) : null}
      {pins.isError && entries.length ? (
        <LoadErrorLine boxed query={pins}>
          Could not load your pins. Pinned items show in their usual place.
        </LoadErrorLine>
      ) : null}

      {docs.isRefetchError ? (
        <LoadErrorLine boxed query={docs}>
          Could not refresh the documents. The list may be out of date.
        </LoadErrorLine>
      ) : null}

      {docs.error && !docs.data ? (
        invalidSearch ? (
          <EmptyState
            title="Search query not valid"
            description={errorMessage(docs.error)}
          />
        ) : (
          <LoadError
            title={
              searching ? "Could not search documents" : "Could not load documents"
            }
            error={docs.error}
            query={docs}
          />
        )
      ) : empty ? (
        <EmptyDocs />
      ) : searching ? (
        documents.length === 0 && folders.length === 0 ? (
          <EmptyState
            title="No matches"
            description={`We read every page of every document. "${q}" is not on any of them.`}
            action={
              <Button variant="outline" onClick={() => setQ("")}>
                Clear search
              </Button>
            }
          />
        ) : viewMode === "list" ? (
          <UnifiedTable
            entries={entries}
            principal={me.data?.principal}
            pinnedIds={pinnedIds}
          />
        ) : (
          <UnifiedGrid entries={entries} pinnedIds={pinnedIds} />
        )
      ) : (
        <DndContext
          sensors={sensors}
          onDragStart={handleDragStart}
          onDragEnd={handleDragEnd}
        >
          {viewMode === "list" ? (
            <UnifiedTable
              entries={merged}
              principal={me.data?.principal}
              pinnedIds={pinnedIds}
            />
          ) : (
            <UnifiedGrid entries={merged} pinnedIds={pinnedIds} />
          )}
          <BrowseDragOverlay activeDrag={activeDrag} viewMode={viewMode} />
        </DndContext>
      )}

      {/* The pages of the last search show while a new search loads. */}
      {docs.isFetchNextPageError ? (
        <LoadErrorLine
          query={{ isFetching: docs.isFetchingNextPage, refetch: docs.fetchNextPage }}
          className="mx-auto mt-6 max-w-md"
        >
          Could not load more documents.
        </LoadErrorLine>
      ) : docs.hasNextPage && !docs.isPlaceholderData ? (
        <div className="mt-6 flex justify-center">
          <Button
            variant="outline"
            disabled={docs.isFetchingNextPage}
            onClick={() => docs.fetchNextPage()}
          >
            Show more documents
          </Button>
        </div>
      ) : null}

      <NewFolderDialog open={newFolderOpen} onOpenChange={setNewFolderOpen} />
      <UploadBackupDialog open={uploadOpen} onOpenChange={setUploadOpen} />

      <AccessWarningDialog warning={warning} onClose={clearWarning} />
    </Page>
  );
}

function EmptyDocs() {
  return (
    <div className="mx-auto max-w-xl space-y-4">
      <div className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
          <Sparkles className="h-5 w-5" />
        </div>
        <h3 className="text-base font-semibold">Set up your agent</h3>
        <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
          Documents are published by your AI agent. Walk through the three-step setup so
          it knows how to use slashdocs.
        </p>
        <div className="mt-4">
          <Button asChild>
            <Link to="/app/start">Open setup guide</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
