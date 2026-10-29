import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { FileText, Folder as FolderIcon, Trash2 } from "lucide-react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { DeleteDocumentDialog } from "@/components/delete-document-dialog";
import { api, docID, docTitle, type FolderEntry, type Principal } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { principalLabel, samePrincipal } from "@/lib/principals";
import { DRAG_TYPE } from "./drag";
import { PinButton, PinnedMark } from "./pin-button";
import { SearchSnippet } from "./search-snippet";
import {
  FOLDER_DELETE_DESCRIPTION,
  useDeleteResource,
  type ResourceType,
} from "./use-resource-actions";

export function UnifiedGrid({
  entries,
  pinnedIds,
}: {
  entries: FolderEntry[];
  pinnedIds?: Set<string>;
}) {
  const me = useQuery({ queryKey: queryKeys.me(), queryFn: api.me });
  return (
    <div className="stagger-grid grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {entries.map((e) => {
        if (e.type === "folder" && e.folder) {
          return (
            <DraggableEntryCard
              key={e.folder.id}
              type="folder"
              id={e.folder.id}
              title={e.folder.title}
              owner={e.folder.owner}
              canDelete={samePrincipal(me.data?.principal, e.folder.owner)}
              pinned={pinnedIds?.has(e.folder.id)}
            />
          );
        }
        if (e.type === "document" && e.document) {
          const inaccessible = e.document.caller_role === "";
          return (
            <DraggableEntryCard
              key={docID(e.document)}
              type="document"
              id={docID(e.document)}
              title={docTitle(e.document)}
              owner={e.document.owner}
              canDelete={samePrincipal(me.data?.principal, e.document.owner)}
              pinned={pinnedIds?.has(docID(e.document))}
              snippet={e.document.snippet}
              inaccessible={inaccessible}
            />
          );
        }
        return null;
      })}
    </div>
  );
}

function DraggableEntryCard({
  type,
  id,
  title,
  owner,
  canDelete,
  pinned,
  snippet,
  inaccessible,
}: {
  type: ResourceType;
  id: string;
  title: string;
  owner?: Principal;
  canDelete: boolean;
  pinned?: boolean;
  snippet?: string;
  inaccessible?: boolean;
}) {
  const isFolder = type === "folder";
  const {
    attributes,
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({
    id: `${isFolder ? DRAG_TYPE.folder : DRAG_TYPE.document}:${id}`,
  });
  // Only folders accept drops; the droppable is disabled (and never attached)
  // for documents.
  const { setNodeRef: dropRef, isOver } = useDroppable({
    id: `drop:${id}`,
    disabled: !isFolder,
  });

  return (
    <div
      ref={(node) => {
        dragRef(node);
        if (isFolder) dropRef(node);
      }}
      {...listeners}
      {...attributes}
      className={`group relative overflow-hidden rounded-lg border bg-[var(--color-surface)] bg-[radial-gradient(ellipse_at_85%_0%,rgb(84_120_205/0.12),transparent_65%)] shadow-[var(--shadow-card)] transition-[border-color,transform] duration-200 ease-out hover:-translate-y-0.5 ${isOver ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent)]/30" : "border-[var(--color-border)] hover:border-[var(--color-border-strong)] dark:border-transparent dark:hover:border-[var(--color-border)]"} ${isDragging ? "opacity-40" : ""}`}
    >
      <Link
        to={isFolder ? `/app/folders/${id}` : `/app/d/${id}`}
        className="flex h-40 cursor-default flex-col p-4"
        draggable={false}
      >
        <span className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-sm bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
            {isFolder ? (
              <FolderIcon className="h-[18px] w-[18px]" />
            ) : (
              <FileText className="h-[18px] w-[18px]" />
            )}
          </span>
          {pinned && <PinnedMark />}
        </span>
        {snippet && (
          <SearchSnippet text={snippet} className="mt-3 line-clamp-2 text-xs" />
        )}
        <span className="mt-auto min-w-0">
          <span className="line-clamp-2 font-heading text-[15px] font-medium leading-snug">
            {title}
          </span>
          <span className="mt-1 block truncate text-xs text-[var(--color-fg-muted)]">
            {principalLabel(owner)}
          </span>
          {inaccessible ? (
            <span className="mt-0.5 block truncate text-[11px] text-[var(--color-fg-muted)] opacity-75">
              No access · folder owner can eject
            </span>
          ) : null}
        </span>
      </Link>
      <GridCardActions
        resourceType={type}
        resourceId={id}
        canDelete={canDelete}
        title={title}
        pinned={pinned}
      />
    </div>
  );
}

function GridCardActions({
  resourceType,
  resourceId,
  canDelete,
  title,
  pinned,
}: {
  resourceType: ResourceType;
  resourceId: string;
  canDelete: boolean;
  title: string;
  pinned?: boolean;
}) {
  const del = useDeleteResource(resourceType, resourceId);
  return (
    <div
      className="absolute right-2 top-2 flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [&_button]:cursor-pointer"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <PinButton
        resourceType={resourceType}
        resourceId={resourceId}
        pinned={pinned}
        className="h-7 w-7"
      />
      {canDelete && (
        <DeleteDocumentDialog
          title={title}
          description={
            resourceType === "folder" ? FOLDER_DELETE_DESCRIPTION : undefined
          }
          onConfirm={() => del.mutate()}
          trigger={
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label="Delete"
              onClick={(e) => e.stopPropagation()}
            >
              <Trash2 className="h-3.5 w-3.5 text-[var(--color-danger)]" />
            </Button>
          }
        />
      )}
    </div>
  );
}
