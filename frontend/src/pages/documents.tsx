import { useTitle } from "@/lib/use-title";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useOnboarding, autoMarkFirstDoc, onboardingProgress } from "@/lib/onboarding";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import { MoreHorizontal, Plus, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/layout/page";
import { beat } from "@/lib/enter";
import { Skeleton, EmptyState } from "@/components/ui/misc";
import { Dropdown, DropdownContent, DropdownTrigger } from "@/components/ui/dropdown";
import { api, docID, docTitle, type Folder, type FolderEntry } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { viewModeStore } from "@/lib/view-mode";
import { DRAG_TYPE, type ActiveDrag } from "@/components/browse/drag";
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
  const [searchParams] = useSearchParams();
  const urlQ = searchParams.get("q") || "";
  const [q, setQ] = useState(urlQ);
  const [debouncedQ, setDebouncedQ] = useState(urlQ.trim());
  useEffect(() => {
    if (urlQ) setQ(urlQ);
  }, [urlQ]);
  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const me = useQuery({ queryKey: queryKeys.me(), queryFn: api.me });
  const docs = useQuery({
    queryKey: [...queryKeys.documents(), debouncedQ],
    queryFn: () => api.listDocuments(debouncedQ || undefined),
    placeholderData: (prev) => prev,
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
  });
  const { state: onb } = useOnboarding();
  const nav = useNavigate();
  useEffect(() => {
    if (onb.status === "active" && onboardingProgress(onb).done === 0) {
      nav("/app/start", { replace: true });
    }
  }, [onb, nav]);
  useEffect(() => {
    if (docs.data && (docs.data.items || []).length > 0) {
      autoMarkFirstDoc();
    }
  }, [docs.data]);
  const documents = useMemo(() => docs.data?.items || [], [docs.data]);
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

  // Browsing sorts by pinned status, last activity, then title. Search
  // results keep the server's order, which is by relevance.
  const merged = useMemo(
    () =>
      [...entries].sort((a, b) => {
        const ap = pinnedIds.has(a.folder?.id || docID(a.document!));
        const bp = pinnedIds.has(b.folder?.id || docID(b.document!));
        if (ap !== bp) return ap ? -1 : 1;
        const ta = a.last_active || "";
        const tb = b.last_active || "";
        if (ta && tb) return tb.localeCompare(ta);
        if (tb) return 1;
        if (ta) return -1;
        const na = (a.folder?.title || a.document?.title || "").toLowerCase();
        const nb = (b.folder?.title || b.document?.title || "").toLowerCase();
        return na.localeCompare(nb);
      }),
    [entries, pinnedIds],
  );

  const viewMode = viewModeStore.useStore();
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const qc = useQueryClient();

  // Drag and drop
  const [activeDrag, setActiveDrag] = useState<ActiveDrag | null>(null);
  const [accessWarning, setAccessWarning] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const moveMutation = useMutation({
    mutationFn: async ({
      dragType,
      dragId,
      targetFolderId,
    }: {
      dragType: string;
      dragId: string;
      targetFolderId: string;
    }) => {
      if (dragType === DRAG_TYPE.folder) {
        return api.updateFolder(dragId, undefined, targetFolderId);
      } else {
        return api.moveDocumentToFolder(targetFolderId, dragId);
      }
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: queryKeys.foldersAll() });
      qc.invalidateQueries({ queryKey: queryKeys.documents() });
      const warning = (data as Record<string, unknown>)?.permission_warning as
        { message?: string } | undefined;
      if (warning?.message) {
        setAccessWarning(warning.message);
      } else {
        toast.success("Moved.");
      }
    },
    onError: (e) => toast.error(errorMessage(e, "Move failed")),
  });

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
    moveMutation.mutate({ dragType, dragId, targetFolderId });
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
  const empty = !searching && documents.length === 0 && folders.length === 0;

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
          <Button
            variant="outline"
            size="md"
            aria-label="New folder"
            tooltip="New folder"
            onClick={() => setNewFolderOpen(true)}
            className="shrink-0 px-3 sm:px-4"
          >
            <Plus className="h-3.5 w-3.5 sm:mr-1.5" />{" "}
            <span className="hidden sm:inline">New folder</span>
          </Button>
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

      {docs.error ? (
        <EmptyState
          title={searching ? "Search query not valid" : "Could not load documents"}
          description={errorMessage(docs.error, "Could not search documents.")}
        />
      ) : empty ? (
        <EmptyDocs />
      ) : searching ? (
        documents.length === 0 && folders.length === 0 ? (
          <EmptyState
            title="No matches"
            description={`We read every page of every document. "${q}" is not on any of them.`}
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

      <NewFolderDialog open={newFolderOpen} onOpenChange={setNewFolderOpen} />
      <UploadBackupDialog open={uploadOpen} onOpenChange={setUploadOpen} />

      <AccessWarningDialog
        warning={accessWarning}
        onClose={() => setAccessWarning(null)}
      />
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
