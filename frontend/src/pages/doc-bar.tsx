import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import {
  ArrowLeft,
  ExternalLink,
  FolderIcon,
  Maximize2,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Share2,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import { Sheet, SheetTrigger } from "@/components/ui/sheet";
import { DeleteDocumentDialog } from "@/components/delete-document-dialog";
import { api, type Principal, type Version } from "@/api";
import { canManageSharing } from "@/lib/constants";
import { queryKeys } from "@/lib/queryKeys";
import { samePrincipal } from "@/lib/principals";
import { ShareSheet } from "./doc-share-sheet";
import { UploadVersionItem } from "./doc-upload-version";
import { VersionHistoryDialog } from "./doc-version-history";

export function DocBar({
  title,
  docId,
  owner,
  principal,
  parentFolder,
  current,
  latest,
  versions,
  onSelectVersion,
  commentsOpen,
  onToggleComments,
}: {
  title: string;
  docId: string;
  owner?: Principal;
  principal?: Principal;
  parentFolder?: { id: string; title: string };
  current: string;
  latest: string;
  versions: Version[];
  onSelectVersion: (versionID: string) => void;
  commentsOpen: boolean;
  onToggleComments: () => void;
}) {
  const nav = useNavigate();
  const q = useQueryClient();
  const currentVersion = versions.find((v) => v.id === current);
  const isViewingOlder = !!current && !!latest && current !== latest;
  const canManage = samePrincipal(principal, owner);
  const access = useQuery({
    queryKey: queryKeys.documentAccess(docId),
    queryFn: () => api.documentAccess(docId),
    enabled: !!docId && !!principal && !canManage,
    staleTime: 30_000,
  });
  const currentAccessRole = access.data?.items.find((item) =>
    samePrincipal(item.principal, principal),
  )?.effective_role;
  const canManageAccess = canManage || canManageSharing(currentAccessRole);
  const del = useMutation({
    mutationFn: () => api.deleteDocument(docId),
    onSuccess: () => {
      toast.success("Document deleted.");
      q.invalidateQueries({ queryKey: queryKeys.documents() });
      nav("/app/documents");
    },
    onError: (e) => toast.error(errorMessage(e, "Delete failed")),
  });
  return (
    <div className="flex h-16 items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-2 sm:gap-3 sm:px-4">
      <Button asChild variant="ghost" size="icon" className="shrink-0">
        <Link to="/app/documents" aria-label="Back to documents">
          <ArrowLeft className="h-4 w-4" />
        </Link>
      </Button>
      <div className="min-w-0 flex-1">
        {parentFolder ? (
          <div className="flex items-center gap-1 text-xs text-[var(--color-fg-muted)]">
            <FolderIcon className="h-3 w-3 shrink-0" />
            <Link
              to={`/app/folders/${parentFolder.id}`}
              className="hover:text-[var(--color-fg)] hover:underline"
            >
              {parentFolder.title}
            </Link>
          </div>
        ) : null}
        <div className="truncate text-base font-semibold leading-tight">{title}</div>
        {isViewingOlder && currentVersion ? (
          <div className="truncate text-[11px] text-amber-600 dark:text-amber-300">
            {`Viewing older version - version ${currentVersion.number}`}
          </div>
        ) : null}
      </div>
      {isViewingOlder ? (
        <Button
          variant="secondary"
          size="sm"
          className="shrink-0 px-2 sm:px-3"
          onClick={() => onSelectVersion(latest)}
        >
          <span className="hidden sm:inline">Back to latest</span>
          <span className="sm:hidden">Latest</span>
        </Button>
      ) : null}
      <VersionHistoryDialog
        current={current}
        latest={latest}
        versions={versions}
        onSelectVersion={onSelectVersion}
      />
      <Button asChild variant="outline" size="sm" className="hidden sm:inline-flex">
        <Link to={`/app/d/${docId}?fullscreen=1&version=${current}`}>
          <Maximize2 className="h-4 w-4" /> Full screen
        </Link>
      </Button>
      <Sheet>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 px-2.5 sm:px-3"
            aria-label="Share"
          >
            <Share2 className="h-4 w-4" />
            <span className="hidden sm:inline">Share</span>
          </Button>
        </SheetTrigger>
        <ShareSheet docId={docId} canManageAccess={canManageAccess} />
      </Sheet>
      <Button
        variant="ghost"
        size="icon"
        onClick={onToggleComments}
        aria-label={commentsOpen ? "Hide comments" : "Show comments"}
        className="shrink-0"
      >
        {commentsOpen ? (
          <PanelRightClose className="h-4 w-4" />
        ) : (
          <PanelRightOpen className="h-4 w-4" />
        )}
      </Button>
      <Dropdown>
        <DropdownTrigger asChild>
          <Button variant="ghost" size="icon" className="shrink-0" aria-label="More">
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </DropdownTrigger>
        <DropdownContent>
          <DropdownItem
            className="sm:hidden"
            onSelect={() => nav(`/app/d/${docId}?fullscreen=1&version=${current}`)}
          >
            <Maximize2 className="h-4 w-4" /> Full screen
          </DropdownItem>
          <DropdownItem
            onSelect={() =>
              window.open(
                `/v1/documents/${docId}/versions/${current}/html`,
                "_blank",
                "noopener,noreferrer",
              )
            }
          >
            <ExternalLink className="h-4 w-4" /> Open raw HTML
          </DropdownItem>
          {canManage ? (
            <>
              <UploadVersionItem docId={docId} baseVersion={latest || current} />
              <DropdownSeparator />
              <DeleteDocumentDialog
                title={title}
                onConfirm={() => del.mutate()}
                trigger={
                  <DropdownItem
                    onSelect={(e) => e.preventDefault()}
                    className="text-[var(--color-danger)] data-[highlighted]:bg-red-50 dark:data-[highlighted]:bg-red-950/40"
                  >
                    <Trash2 className="h-4 w-4" /> Delete document
                  </DropdownItem>
                }
              />
            </>
          ) : null}
        </DropdownContent>
      </Dropdown>
    </div>
  );
}
