import { Trash2 } from "lucide-react";
import { useDraggable, useDroppable } from "@dnd-kit/core";
import { Button } from "@/components/ui/button";
import { Avatar, revealOnHover } from "@/components/ui/misc";
import { RelativeTime } from "@/components/ui/relative-time";
import { DeleteDocumentDialog } from "@/components/delete-document-dialog";
import { docID, docTitle, type FolderEntry, type Principal } from "@/api";
import { cn } from "@/lib/cn";
import { principalColor, principalLabel, samePrincipal } from "@/lib/principals";
import { DRAG_TYPE } from "./drag";
import { ENTRY_ROW, EntryName, EntryTable, WIDE_ONLY } from "./entry-table";
import { AccessRequestMark } from "./access-request-mark";
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
    <EntryTable
      columns={["Name", "Owner", "Updated", ""]}
      widths={{ Owner: "w-64" }}
      wideOnly={["Owner", "Updated"]}
    >
      {entries.map((e) => {
        if (e.type === "folder" && e.folder) {
          return (
            <DraggableEntryRow
              key={e.folder.id}
              type="folder"
              id={e.folder.id}
              title={e.folder.title}
              owner={e.folder.owner}
              updated={e.last_active}
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
              updated={e.last_active}
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
  updated,
  canDelete,
  pinned,
  snippet,
}: {
  type: ResourceType;
  id: string;
  title: string;
  owner?: Principal;
  updated?: string;
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
  const del = useDeleteResource(type, id, title);

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
          {isFolder ? null : <AccessRequestMark documentId={id} />}
        </EntryName>
        {/* Narrow screens hide the owner and time columns and show them here. */}
        <div className="mt-0.5 truncate pl-6 text-xs text-[var(--color-fg-muted)] sm:hidden">
          {principalLabel(owner)}
          {updated && (
            <>
              {" · "}
              <RelativeTime iso={updated} />
            </>
          )}
        </div>
        {snippet ? (
          <SearchSnippet text={snippet} className="mt-1 line-clamp-2 pl-6 text-xs" />
        ) : null}
      </td>
      <td className={cn("px-4 py-3", WIDE_ONLY)}>
        <OwnerCell owner={owner} />
      </td>
      <td
        className={cn(
          "whitespace-nowrap px-4 py-3 text-[var(--color-fg-muted)]",
          WIDE_ONLY,
        )}
      >
        <RelativeTime iso={updated} />
      </td>
      <td className="px-2 py-3">
        <div
          className={cn("flex gap-0.5 transition-opacity", revealOnHover)}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        >
          <PinButton
            resourceType={type}
            resourceId={id}
            pinned={pinned}
            className="cursor-pointer"
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
                  className="cursor-pointer text-[var(--color-fg-muted)] hover:text-[var(--color-danger)]"
                  aria-label={isFolder ? "Delete folder" : "Delete document"}
                >
                  <Trash2 className="h-3.5 w-3.5" />
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
        ? "Bot"
        : "Owner";
  return (
    <div className="flex min-w-0 items-center gap-2">
      <Avatar
        name={label}
        src={owner?.picture_url}
        size={28}
        color={owner && principalColor(owner)}
      />
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{label}</div>
        <div className="truncate text-xs text-[var(--color-fg-muted)]">{detail}</div>
      </div>
    </div>
  );
}
