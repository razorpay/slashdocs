import { Trash2 } from "lucide-react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/misc";
import { DeleteDocumentDialog } from "@/components/delete-document-dialog";
import { docID, docTitle, type FolderEntry, type Principal } from "@/api";
import { principalLabel, samePrincipal } from "@/lib/principals";
import { DRAG_TYPE } from "./drag";
import { ENTRY_ROW, EntryName, EntryTable } from "./entry-table";
import { PinButton, PinnedMark } from "./pin-button";
import { SearchSnippet } from "./search-snippet";
import {
  FOLDER_DELETE_DESCRIPTION,
  useDeleteResource,
  type ResourceType,
} from "./use-resource-actions";

export function UnifiedTable({
  entries,
  principal,
  pinnedIds,
}: {
  entries: FolderEntry[];
  principal?: Principal;
  pinnedIds?: Set<string>;
}) {
  return (
    <EntryTable columns={["Name", "Owner", ""]}>
      {entries.map((e) => {
        if (e.type === "folder" && e.folder) {
          return (
            <DraggableEntryRow
              key={e.folder.id}
              type="folder"
              id={e.folder.id}
              title={e.folder.title}
              owner={e.folder.owner}
              canDelete={samePrincipal(principal, e.folder.owner)}
              pinned={pinnedIds?.has(e.folder.id)}
            />
          );
        }
        if (e.type === "document" && e.document) {
          return (
            <DraggableEntryRow
              key={docID(e.document)}
              type="document"
              id={docID(e.document)}
              title={docTitle(e.document)}
              owner={e.document.owner}
              canDelete={samePrincipal(principal, e.document.owner)}
              pinned={pinnedIds?.has(docID(e.document))}
              snippet={e.document.snippet}
            />
          );
        }
        return null;
      })}
    </EntryTable>
  );
}

function DraggableEntryRow({
  type,
  id,
  title,
  owner,
  canDelete,
  pinned,
  snippet,
}: {
  type: ResourceType;
  id: string;
  title: string;
  owner?: Principal;
  canDelete: boolean;
  pinned?: boolean;
  snippet?: string;
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
  const del = useDeleteResource(type, id);

  return (
    <tr
      ref={(node) => {
        dragRef(node);
        if (isFolder) dropRef(node);
      }}
      {...listeners}
      {...attributes}
      className={`group border-t transition-colors ${isOver ? "bg-[var(--color-accent)]/10 border-[var(--color-accent)]" : ENTRY_ROW} ${isDragging ? "opacity-40" : ""}`}
    >
      <td className="px-4 py-3">
        <EntryName
          to={isFolder ? `/app/folders/${id}` : `/app/d/${id}`}
          folder={isFolder}
          title={title}
        >
          {pinned && <PinnedMark />}
        </EntryName>
        {snippet ? (
          <SearchSnippet text={snippet} className="mt-1 line-clamp-2 pl-6 text-xs" />
        ) : null}
      </td>
      <td className="px-4 py-3">
        <OwnerCell owner={owner} />
      </td>
      <td className="px-2 py-3">
        <div
          className="flex gap-0.5"
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <PinButton
            resourceType={type}
            resourceId={id}
            pinned={pinned}
            className="cursor-pointer opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          />
          {canDelete && (
            <DeleteDocumentDialog
              title={title}
              description={isFolder ? FOLDER_DELETE_DESCRIPTION : undefined}
              onConfirm={() => del.mutate()}
              trigger={
                <Button
                  variant="ghost"
                  size="icon"
                  className="cursor-pointer opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                  aria-label={isFolder ? "Delete folder" : "Delete document"}
                >
                  <Trash2 className="h-3.5 w-3.5 text-[var(--color-danger)]" />
                </Button>
              }
            />
          )}
        </div>
      </td>
    </tr>
  );
}

function OwnerCell({ owner }: { owner?: Principal }) {
  const label = principalLabel(owner);
  const detail =
    owner?.email && owner.email !== label
      ? owner.email
      : owner?.type === "service_account"
        ? "Service account"
        : "Owner";
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Avatar name={label} src={owner?.picture_url} size={28} />
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="truncate text-xs text-[var(--color-fg-muted)]">{detail}</div>
      </div>
    </div>
  );
}
