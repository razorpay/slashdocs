import { Tooltip } from "@/components/ui/tooltip";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import {
  ExternalLink,
  Eye,
  EyeOff,
  FileDown,
  FolderInput,
  History,
  ArrowUpToLine,
  Maximize2,
  Keyboard,
  LocateFixed,
  MoreHorizontal,
  MousePointer2,
  MousePointer2Off,
  Share2,
  Tag,
  Trash2,
  Users,
} from "lucide-react";
import { AccountMenu } from "@/components/layout/topbar";
import { CommentsToggle, DocBarFrame } from "@/components/layout/doc-bar-frame";
import { Button } from "@/components/ui/button";
import {
  Dropdown,
  DropdownContent,
  DropdownGroup,
  DropdownItem,
  DropdownLabel,
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
import { MoveDialog } from "@/components/browse/move-dialog";
import { api, type Principal, type ApprovalStatus, type ApprovalSummary } from "@/api";
import { canManageSharing } from "@/lib/constants";
import { useDocumentRole } from "@/lib/hooks";
import { queryKeys } from "@/lib/queryKeys";
import { cursorsShownStore } from "@/lib/live-cursors";
import { principalColor } from "@/lib/principals";
import { ShareSheet } from "./doc-share-sheet";
import { ApprovalsDialog } from "./doc-approvals";
import { PersonAvatar } from "./doc-comment-parts";
import { useDoc } from "./doc-context";
import { useShowSaved } from "./use-show-saved";
import { UploadVersionMenuItem, UploadVersionSheet } from "./doc-upload-version";
import { EditStatus } from "./doc-edit-status";
import { HistoryDialog } from "./doc-history";
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
  previewing,
  canChangeContent,
  labels,
  onSelectVersion,
  onShowLatest,
  viewers,
  onFollowViewer,
  followedSession,
  onUnfollowViewer = () => {},
  commentsOpen,
  onToggleComments,
  onShowShortcuts,
  approvalStatus,
  approvalSummary,
  approvalsOpen,
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
  // An earlier version from the history is on screen.
  previewing: boolean;
  // The reader may change the content: an editor who is not an assigned
  // approver.
  canChangeContent: boolean;
  labels: string[];
  onSelectVersion: (versionID: string) => void;
  onShowLatest: () => void;
  viewers: Viewer[];
  // Goes to a viewer once, or follows them continuously.
  onFollowViewer: (viewer: Viewer, continuous?: boolean) => void;
  // The session of the viewer the reader follows, if any.
  followedSession?: string;
  onUnfollowViewer?: () => void;
  commentsOpen: boolean;
  onToggleComments: () => void;
  onShowShortcuts: () => void;
  approvalStatus?: ApprovalStatus;
  approvalSummary?: ApprovalSummary;
  // Opens the approvals dialog on load, for links from notifications.
  approvalsOpen?: boolean;
  shareOpen: boolean;
  onShareOpenChange: (open: boolean) => void;
}) {
  const nav = useNavigate();
  const q = useQueryClient();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const backTo = parentFolder ? `/app/folders/${parentFolder.id}` : "/app/documents";
  const config = useQuery({ queryKey: queryKeys.config(), queryFn: api.getConfig });
  // Behind: the document changed elsewhere while the reader stayed on the
  // version on screen. A preview is not behind: it has its own banner.
  const behind = !previewing && !!current && !!latest && current !== latest;
  const {
    isOwner: canManage,
    role,
    canEdit,
  } = useDocumentRole(docId, owner, principal);
  const { printDocument: exportPDF, signIn } = useDoc();
  const canManageAccess = canManageSharing(role);
  // The share sheet lists the requests. Their count waits on its button.
  const accessRequests = useQuery({
    queryKey: queryKeys.documentAccessRequests(docId),
    queryFn: () => api.documentAccessRequests(docId),
    enabled: canManageAccess && !signIn,
  });
  const requestCount = accessRequests.data?.items.length ?? 0;
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
  const showSaved = useShowSaved();
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
      meta={previewing ? null : <EditStatus />}
    >
      <ApprovalsDialog
        status={approvalStatus}
        approved={approvalSummary?.approved}
        total={approvalSummary?.total}
        isOwner={canManage}
        defaultOpen={approvalsOpen}
      />
      <Viewers
        viewers={viewers}
        latest={latest}
        onFollow={onFollowViewer}
        followedSession={followedSession}
        onUnfollow={onUnfollowViewer}
      />
      {viewers.length ? <CursorsToggle /> : null}
      {behind ? (
        <Button
          variant="ghost"
          size="icon"
          title="Show the latest edits"
          aria-label="Show the latest edits"
          className="shrink-0"
          onClick={onShowLatest}
        >
          <ArrowUpToLine className="h-4 w-4" />
        </Button>
      ) : null}
      <HistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        docId={docId}
        current={current}
        latest={latest}
        onSelectVersion={onSelectVersion}
      />
      {config.data?.labels_enabled === true ? (
        <LabelsDialog
          open={labelsOpen}
          onOpenChange={setLabelsOpen}
          docId={docId}
          labels={labels}
          canEdit={canEdit}
        />
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
              className="relative shrink-0"
              title="Share"
              aria-label={
                requestCount
                  ? `Share, ${requestCount} ${requestCount === 1 ? "request" : "requests"} for access`
                  : "Share"
              }
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
              {requestCount ? (
                <span
                  data-state="open"
                  className="pop absolute right-0.5 top-0.5 min-w-4 rounded-full bg-[var(--color-accent)] px-1 text-[10px] font-medium leading-4 tabular-nums text-white"
                >
                  {requestCount}
                </span>
              ) : null}
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
          <DropdownItem className="sm:hidden" onSelect={() => setHistoryOpen(true)}>
            <History className="h-4 w-4" /> History
          </DropdownItem>
          {config.data?.labels_enabled === true ? (
            <DropdownItem className="lg:hidden" onSelect={() => setLabelsOpen(true)}>
              <Tag className="h-4 w-4" /> Document labels
            </DropdownItem>
          ) : null}
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
              {canChangeContent ? (
                <UploadVersionMenuItem onSelect={() => setUploadOpen(true)} />
              ) : null}
              <DropdownItem onSelect={() => setMoveOpen(true)}>
                <FolderInput className="h-4 w-4" /> Move to folder
              </DropdownItem>
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
            onUploaded={showSaved}
            open={uploadOpen}
            onOpenChange={setUploadOpen}
          />
          <MoveDialog
            open={moveOpen}
            onOpenChange={setMoveOpen}
            type="document"
            id={docId}
            title={title}
            parentId={parentFolder?.id}
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

type ViewerActions = {
  onFollow: (viewer: Viewer, continuous?: boolean) => void;
  onUnfollow: () => void;
  followedSession?: string;
};

// Viewers shows who else reads the document, in the colors of their cursors.
// A click on an avatar opens a menu: jump to where the viewer is, once, or
// follow them until the reader moves. Viewers past the first few are in a
// "+N" menu. A narrow bar has no room for avatars: one People menu holds
// every viewer and the cursors switch.
function Viewers({
  viewers,
  latest,
  ...actions
}: { viewers: Viewer[]; latest: string } & ViewerActions) {
  if (!viewers.length) return null;
  const followed = viewers.find((viewer) => viewer.session === actions.followedSession);
  const hidden = viewers.slice(MAX_VIEWER_AVATARS);
  return (
    <>
      <div
        role="group"
        aria-label="People viewing this document"
        className="hidden shrink-0 items-center -space-x-1.5 pr-1 sm:flex"
      >
        {viewers.slice(0, MAX_VIEWER_AVATARS).map((viewer) => (
          <ViewerAvatar
            key={viewer.session}
            viewer={viewer}
            latest={latest}
            {...actions}
          />
        ))}
        {hidden.length > 0 ? (
          <Dropdown>
            <DropdownTrigger asChild>
              <button
                type="button"
                aria-label={`${hidden.length} more ${hidden.length === 1 ? "viewer" : "viewers"}`}
                aria-pressed={hidden.some((viewer) => viewer === followed)}
                className="relative flex h-7 min-w-7 items-center justify-center rounded-full bg-[var(--color-surface-muted)] px-1.5 text-xs font-medium tabular-nums text-[var(--color-fg-muted)] ring-2 ring-[var(--color-surface)] transition-[translate,scale] duration-150 ease-out hover:z-10 hover:-translate-y-0.5 hover:text-[var(--color-fg)] active:translate-y-0 active:scale-95 aria-pressed:text-[var(--color-fg)] aria-pressed:ring-[var(--color-accent)] focus-visible:z-10 motion-reduce:transition-none"
              >
                +{hidden.length}
              </button>
            </DropdownTrigger>
            <DropdownContent>
              <ViewerList viewers={hidden} {...actions} />
            </DropdownContent>
          </Dropdown>
        ) : null}
      </div>
      <Dropdown>
        <DropdownTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label="People"
            className="relative shrink-0 sm:hidden"
          >
            {followed ? (
              <FollowedFace viewer={followed} />
            ) : (
              <Users className="h-4 w-4" />
            )}
            <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-[var(--color-accent)] px-1 text-[10px] font-medium leading-4 tabular-nums text-white">
              {viewers.length}
            </span>
          </Button>
        </DropdownTrigger>
        <DropdownContent>
          <ViewerList viewers={viewers} {...actions} />
          <DropdownSeparator />
          <CursorsItem />
        </DropdownContent>
      </Dropdown>
    </>
  );
}

function ViewerAvatar({
  viewer,
  latest,
  ...actions
}: { viewer: Viewer; latest: string } & ViewerActions) {
  // A context menu opens the same menu.
  const [menuOpen, setMenuOpen] = useState(false);
  const name = principalLabel(viewer.principal);
  const earlier = !!viewer.version && viewer.version !== latest;
  const following = viewer.session === actions.followedSession;
  const color = principalColor(viewer.principal);
  let label = earlier ? `${name} · viewing an earlier edit` : name;
  if (following) label = `Following ${name}`;
  return (
    <Dropdown open={menuOpen} onOpenChange={setMenuOpen}>
      <Tooltip label={label}>
        <DropdownTrigger asChild>
          <button
            type="button"
            aria-label={label}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuOpen(true);
            }}
            style={{
              // The surface parts the stacked avatars. Followed: a ring in the
              // viewer's color after it, as a pressed state.
              boxShadow: following
                ? `0 0 0 2px var(--color-surface), 0 0 0 4px ${color}`
                : "0 0 0 2px var(--color-surface)",
            }}
            className="relative rounded-full transition-[translate,scale,box-shadow] duration-150 ease-out hover:z-10 hover:-translate-y-0.5 active:translate-y-0 active:scale-95 focus-visible:z-10 motion-reduce:transition-none"
          >
            <PersonAvatar who={viewer.principal} size={28} />
          </button>
        </DropdownTrigger>
      </Tooltip>
      <DropdownContent>
        <ViewerItems viewer={viewer} {...actions} />
      </DropdownContent>
    </Dropdown>
  );
}

// ViewerList names each viewer over their actions.
function ViewerList({ viewers, ...actions }: { viewers: Viewer[] } & ViewerActions) {
  return viewers.map((viewer) => (
    <DropdownGroup key={viewer.session}>
      <DropdownLabel className="flex items-center gap-2 normal-case tracking-normal">
        <PersonAvatar who={viewer.principal} size={18} />
        <span className="min-w-0 flex-1 truncate">
          {principalLabel(viewer.principal)}
        </span>
      </DropdownLabel>
      <ViewerItems viewer={viewer} {...actions} />
    </DropdownGroup>
  ));
}

function ViewerItems({
  viewer,
  onFollow,
  onUnfollow,
  followedSession,
}: { viewer: Viewer } & ViewerActions) {
  const name = principalLabel(viewer.principal);
  return (
    <>
      <DropdownItem onSelect={() => onFollow(viewer)}>
        <LocateFixed className="h-4 w-4" /> Jump to {name}
      </DropdownItem>
      {viewer.session === followedSession ? (
        <DropdownItem onSelect={onUnfollow}>
          <EyeOff className="h-4 w-4" /> Stop following {name}
        </DropdownItem>
      ) : (
        <DropdownItem onSelect={() => onFollow(viewer, true)}>
          <Eye className="h-4 w-4" /> Follow {name}
        </DropdownItem>
      )}
    </>
  );
}

// FollowedFace is the followed viewer's avatar in a ring of their color.
function FollowedFace({ viewer }: { viewer: Viewer }) {
  return (
    <span
      className="shrink-0 rounded-full"
      style={{ boxShadow: `0 0 0 2px ${principalColor(viewer.principal)}` }}
    >
      <PersonAvatar who={viewer.principal} size={22} />
    </span>
  );
}

function useCursorsSwitch() {
  const shown = cursorsShownStore.useStore();
  return {
    shown,
    toggle: () => cursorsShownStore.write(!shown),
    label: shown ? "Hide cursors" : "Show cursors",
    Icon: shown ? MousePointer2 : MousePointer2Off,
  };
}

function CursorsToggle() {
  const { shown, toggle, label, Icon } = useCursorsSwitch();
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={label}
      tooltip={`${label} (Esc M)`}
      aria-pressed={shown}
      className="hidden shrink-0 sm:inline-flex"
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}

function CursorsItem() {
  const { toggle, label, Icon } = useCursorsSwitch();
  return (
    <DropdownItem onSelect={toggle}>
      <Icon className="h-4 w-4" /> {label}
    </DropdownItem>
  );
}

function LabelsDialog({
  open,
  onOpenChange,
  docId,
  labels,
  canEdit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  docId: string;
  labels: string[];
  canEdit: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
        <LabelsForm
          docId={docId}
          labels={labels}
          canEdit={canEdit}
          onSaved={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

// The form mounts each time the dialog opens, however it was opened, so the
// draft always starts from the saved labels.
function LabelsForm({
  docId,
  labels,
  canEdit,
  onSaved,
}: {
  docId: string;
  labels: string[];
  canEdit: boolean;
  onSaved: () => void;
}) {
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
      onSaved();
    },
    onError: (e) => toast.error(errorMessage(e, "Could not update labels")),
  });
  return (
    <>
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
    </>
  );
}

function principalLabel(p?: Principal) {
  if (!p) return "Unknown";
  if (p.name) return p.name;
  if (p.email) return p.email;
  if (p.type === "service_account") return p.id || "Service account";
  return p.id || "Unknown";
}
