import { Tooltip } from "@/components/ui/tooltip";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import {
  Check,
  ExternalLink,
  FileDown,
  ArrowUpToLine,
  Maximize2,
  GitBranch,
  Keyboard,
  MoreHorizontal,
  MousePointer2,
  MousePointer2Off,
  Share2,
  Tag,
  Trash2,
} from "lucide-react";
import { AccountMenu } from "@/components/layout/topbar";
import { CommentsToggle, DocBarFrame } from "@/components/layout/doc-bar-frame";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/misc";
import {
  Dropdown,
  DropdownContent,
  DropdownItem,
  DropdownSeparator,
  DropdownTrigger,
} from "@/components/ui/dropdown";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Sheet, SheetTrigger } from "@/components/ui/sheet";
import { DeleteDocumentDialog } from "@/components/delete-document-dialog";
import { api, type Principal, type Version } from "@/api";
import { canManageSharing, ROLE_RANK } from "@/lib/constants";
import { changeSummaryLines } from "@/lib/change-summary";
import { RelativeTime } from "@/components/ui/relative-time";
import { queryKeys } from "@/lib/queryKeys";
import { cursorsShownStore } from "@/lib/live-cursors";
import { principalColor, samePrincipal } from "@/lib/principals";
import { ShareSheet } from "./doc-share-sheet";
import { useDoc } from "./doc-context";
import { UploadVersionMenuItem, UploadVersionSheet } from "./doc-upload-version";
import type { Viewer } from "./use-document-stream";

const MAX_VIEWER_AVATARS = 4;

export function DocBar({
  title,
  docId,
  owner,
  principal,
  accountUser,
  parentFolder,
  current,
  latest,
  versions,
  labels,
  onSelectVersion,
  viewers,
  onFollowViewer,
  followedSession,
  commentsOpen,
  onToggleComments,
  onShowShortcuts,
  shareOpen,
  onShareOpenChange,
}: {
  title: string;
  docId: string;
  owner?: Principal;
  principal?: Principal;
  accountUser?: Principal;
  parentFolder?: { id: string; title: string };
  current: string;
  latest: string;
  versions: Version[];
  labels: string[];
  onSelectVersion: (versionID: string) => void;
  viewers: Viewer[];
  onFollowViewer: (viewer: Viewer) => void;
  // The session of the viewer the reader follows, if any.
  followedSession?: string;
  commentsOpen: boolean;
  onToggleComments: () => void;
  onShowShortcuts: () => void;
  shareOpen: boolean;
  onShareOpenChange: (open: boolean) => void;
}) {
  const nav = useNavigate();
  const q = useQueryClient();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const backTo = parentFolder ? `/app/folders/${parentFolder.id}` : "/app/documents";
  const config = useQuery({ queryKey: queryKeys.config(), queryFn: api.getConfig });
  const currentVersion = versions.find((v) => v.id === current);
  const isViewingOlder = !!current && !!latest && current !== latest;
  const canManage = samePrincipal(principal, owner);
  const access = useQuery({
    queryKey: queryKeys.documentAccess(docId),
    queryFn: () => api.documentAccess(docId),
    enabled: !!docId && !!principal && !canManage,
    staleTime: 30_000,
  });
  const currentAccessRole = access.data?.current_role;
  const canManageAccess = canManage || canManageSharing(currentAccessRole);
  const canEdit =
    canManage || (ROLE_RANK[currentAccessRole || ""] || 0) >= ROLE_RANK.editor;
  const shareFrameFocusRef = useRef<HTMLIFrameElement | null>(null);
  const del = useMutation({
    mutationFn: () => api.deleteDocument(docId),
    onSuccess: () => {
      toast.success("Document deleted.");
      q.invalidateQueries({ queryKey: queryKeys.documents() });
      nav(backTo);
    },
    onError: (e) => toast.error(errorMessage(e, "Delete failed")),
  });
  const { printDocument: exportPDF, signIn } = useDoc();
  return (
    <DocBarFrame
      home="/app/documents"
      folder={
        parentFolder && {
          to: `/app/folders/${parentFolder.id}`,
          title: parentFolder.title,
        }
      }
      title={title}
      meta={
        currentVersion && (
          <span
            className={`hidden shrink-0 text-xs tabular-nums sm:inline ${isViewingOlder ? "text-amber-600 dark:text-amber-300" : "text-[var(--color-fg-muted)]"}`}
            title={isViewingOlder ? "Viewing an older version" : "Latest version"}
          >
            v{currentVersion.number}
            {isViewingOlder ? " · older" : ""}
          </span>
        )
      }
    >
      <Viewers
        viewers={viewers}
        versions={versions}
        onFollow={onFollowViewer}
        followedSession={followedSession}
      />
      {viewers.length ? <CursorsToggle /> : null}
      {isViewingOlder ? (
        <Button
          variant="ghost"
          size="icon"
          title="Back to latest version"
          aria-label="Back to latest version"
          className="shrink-0"
          onClick={() => onSelectVersion(latest)}
        >
          <ArrowUpToLine className="h-4 w-4" />
        </Button>
      ) : null}
      <VersionHistoryDialog
        current={current}
        latest={latest}
        versions={versions}
        onSelectVersion={onSelectVersion}
      />
      {config.data?.labels_enabled === true ? (
        <LabelsDialog docId={docId} labels={labels} canEdit={canEdit} />
      ) : null}
      <Button
        asChild
        variant="ghost"
        size="icon"
        className="hidden shrink-0 sm:inline-flex"
      >
        <Link
          to={`/app/d/${docId}?fullscreen=1&version=${current}`}
          title="Full screen (Esc F)"
          aria-label="Full screen"
        >
          <Maximize2 className="h-4 w-4" />
        </Link>
      </Button>
      {!signIn && (
        <Sheet modal={false} open={shareOpen} onOpenChange={onShareOpenChange}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0"
              title="Share"
              aria-label="Share"
              onPointerDown={() => {
                const active = document.activeElement;
                shareFrameFocusRef.current =
                  active instanceof HTMLIFrameElement &&
                  active.title === "Rendered document"
                    ? active
                    : null;
              }}
            >
              <Share2 className="h-4 w-4" />
            </Button>
          </SheetTrigger>
          <ShareSheet
            docId={docId}
            canManageAccess={canManageAccess}
            onOpenAutoFocus={(event) => {
              const frame = shareFrameFocusRef.current;
              shareFrameFocusRef.current = null;
              if (!frame?.isConnected) return;
              event.preventDefault();
              frame.focus();
            }}
            onInteractOutside={(event) => {
              const target = event.target;
              if (
                target instanceof HTMLIFrameElement &&
                target.title === "Rendered document"
              ) {
                event.preventDefault();
              }
            }}
          />
        </Sheet>
      )}
      <CommentsToggle open={commentsOpen} onToggle={onToggleComments} />
      <Dropdown>
        <DropdownTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            aria-label="More"
            title="More document actions"
          >
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
          <DropdownItem onSelect={() => void exportPDF()}>
            <FileDown className="h-4 w-4" /> Export as PDF
          </DropdownItem>
          <DropdownItem className="hidden sm:flex" onSelect={onShowShortcuts}>
            <Keyboard className="h-4 w-4" /> Keyboard shortcuts
            <kbd className="ml-auto pl-4 font-mono text-xs text-[var(--color-fg-muted)]">
              ?
            </kbd>
          </DropdownItem>
          {canManage ? (
            <>
              <UploadVersionMenuItem onSelect={() => setUploadOpen(true)} />
              <DropdownSeparator />
              <DropdownItem
                onSelect={() => setDeleteOpen(true)}
                className="text-[var(--color-danger)] data-[highlighted]:bg-red-50 dark:data-[highlighted]:bg-red-950/40"
              >
                <Trash2 className="h-4 w-4" /> Delete document
              </DropdownItem>
            </>
          ) : null}
        </DropdownContent>
      </Dropdown>
      {canManage ? (
        <>
          <UploadVersionSheet
            docId={docId}
            baseVersion={latest || current}
            open={uploadOpen}
            onOpenChange={setUploadOpen}
          />
          <DeleteDocumentDialog
            title={title}
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            onConfirm={() => del.mutate()}
          />
        </>
      ) : null}
      {accountUser && (
        <div className="shrink-0 border-l border-[var(--color-border)] pl-2">
          <AccountMenu user={accountUser} />
        </div>
      )}
      {signIn && (
        <Button size="sm" className="ml-1 shrink-0" onClick={signIn}>
          Sign in
        </Button>
      )}
    </DocBarFrame>
  );
}

// Other people viewing the document, in the colors of their cursors.
// Clicking one goes to their cursor, or else to what they see.
function Viewers({
  viewers,
  versions,
  onFollow,
  followedSession,
}: {
  viewers: Viewer[];
  versions: Version[];
  onFollow: (viewer: Viewer) => void;
  followedSession?: string;
}) {
  if (!viewers.length) return null;
  const hidden = viewers.length - MAX_VIEWER_AVATARS;
  return (
    <div
      role="group"
      aria-label="People viewing this document"
      className="hidden shrink-0 items-center -space-x-1.5 pr-1 sm:flex"
    >
      {viewers.slice(0, MAX_VIEWER_AVATARS).map((viewer) => {
        const name = principalLabel(viewer.principal);
        const number = versions.find((v) => v.id === viewer.version)?.number;
        const following = viewer.session === followedSession;
        let label = number ? `${name} · viewing v${number}` : name;
        if (following) label = `Following ${name} · click to stop`;
        return (
          <Tooltip
            key={`${viewer.principal.type}:${viewer.principal.id}`}
            label={label}
          >
            <button
              type="button"
              aria-label={following ? `Stop following ${name}` : `Follow ${name}`}
              aria-pressed={following}
              onClick={() => onFollow(viewer)}
              style={{
                boxShadow: `0 0 0 2px ${principalColor(viewer.principal)}, 0 0 0 4px var(--color-surface)`,
              }}
              className="relative rounded-full transition-transform duration-150 ease-out hover:z-10 hover:-translate-y-0.5 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)] motion-reduce:transition-none"
            >
              <Avatar size={28} name={name} src={viewer.principal.picture_url} />
            </button>
          </Tooltip>
        );
      })}
      {hidden > 0 ? (
        <span
          title={viewers
            .slice(MAX_VIEWER_AVATARS)
            .map((viewer) => principalLabel(viewer.principal))
            .join(", ")}
          className="relative flex h-7 min-w-7 items-center justify-center rounded-full bg-[var(--color-surface-muted)] px-1.5 text-xs font-medium tabular-nums text-[var(--color-fg-muted)] ring-2 ring-[var(--color-surface)]"
        >
          +{hidden}
        </span>
      ) : null}
    </div>
  );
}

function CursorsToggle() {
  const shown = cursorsShownStore.useStore();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => cursorsShownStore.write(!shown)}
      aria-label={shown ? "Hide cursors" : "Show cursors"}
      tooltip={shown ? "Hide cursors (Esc M)" : "Show cursors (Esc M)"}
      aria-pressed={shown}
      className="hidden shrink-0 sm:inline-flex"
    >
      {shown ? (
        <MousePointer2 className="h-4 w-4" />
      ) : (
        <MousePointer2Off className="h-4 w-4" />
      )}
    </Button>
  );
}

function LabelsDialog({
  docId,
  labels,
  canEdit,
}: {
  docId: string;
  labels: string[];
  canEdit: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(labels.join(", "));
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: () =>
      api.replaceDocumentLabels(
        docId,
        draft
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean),
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.document(docId) });
      qc.invalidateQueries({ queryKey: queryKeys.documents() });
      setOpen(false);
      toast.success("Labels updated.");
    },
    onError: (e) => toast.error(errorMessage(e, "Could not update labels")),
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setDraft(labels.join(", "));
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="hidden shrink-0 lg:inline-flex"
          aria-label="Document labels"
          title={labels.length ? `Labels: ${labels.join(", ")}` : "Document labels"}
        >
          <Tag className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Document labels</DialogTitle>
          <DialogDescription>
            Add comma-separated labels. Labels are normalized to lowercase and can be
            used from the documents search page.
          </DialogDescription>
        </DialogHeader>
        <Input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="runbook, payments, onboarding"
          disabled={!canEdit}
        />
        <DialogFooter>
          {canEdit ? (
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              Save labels
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function VersionHistoryDialog({
  current,
  latest,
  versions,
  onSelectVersion,
}: {
  current: string;
  latest: string;
  versions: Version[];
  onSelectVersion: (versionID: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const sorted = [...versions].sort((a, b) => b.number - a.number);
  const select = (versionID: string) => {
    if (versionID === current) return;
    onSelectVersion(versionID);
    setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="hidden shrink-0 sm:inline-flex"
          aria-label="Version history"
          title="Version history"
        >
          <GitBranch className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Immutable HTML revisions for this document. Open any version to inspect the
            exact HTML your reviewers saw.
          </DialogDescription>
        </DialogHeader>
        {sorted.length === 0 ? (
          <div className="rounded-lg border border-[var(--color-border)] p-4 text-sm text-[var(--color-fg-muted)]">
            No versions available yet.
          </div>
        ) : (
          <div className="max-h-[60vh] space-y-2 overflow-auto pr-1">
            {sorted.map((v) => (
              <button
                key={v.id}
                type="button"
                onClick={() => select(v.id)}
                className={`flex w-full gap-3 rounded-xl border border-[var(--color-border)] p-4 text-left transition-colors hover:bg-[var(--color-surface-muted)]/60 ${
                  v.id === current
                    ? "bg-[var(--color-accent-muted)]/35"
                    : "bg-[var(--color-surface)]"
                }`}
                aria-current={v.id === current ? "true" : undefined}
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-muted)] text-sm font-semibold text-[var(--color-accent)]">
                  {v.number}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="font-medium">Version {v.number}</div>
                    {v.id === current ? (
                      <Badge variant="accent">
                        <Check className="h-3 w-3" /> Viewing
                      </Badge>
                    ) : null}
                    {v.id === latest ? <Badge variant="muted">Latest</Badge> : null}
                  </div>
                  <ChangeSummary version={v} />
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--color-fg-muted)]">
                    <span>Created by {principalLabel(v.created_by)}</span>
                    {v.created_at ? <RelativeTime iso={v.created_at} /> : null}
                    <span className="font-mono">{v.id}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ChangeSummary({ version }: { version: Version }) {
  const lines = changeSummaryLines(version.change_summary);
  const className = "mt-1 text-sm text-[var(--color-fg-muted)]";
  if (lines.length > 1) {
    return (
      <ul className={`${className} list-disc space-y-0.5 pl-5`}>
        {lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    );
  }
  return (
    <p className={className}>
      {lines[0] || (version.number === 1 ? "Initial version" : "No change summary")}
    </p>
  );
}

function principalLabel(p?: Principal) {
  if (!p) return "Unknown";
  if (p.name) return p.name;
  if (p.email) return p.email;
  if (p.type === "service_account") return p.id || "Service account";
  return p.id || "Unknown";
}
