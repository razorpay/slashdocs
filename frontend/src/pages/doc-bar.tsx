import { Tooltip } from "@/components/ui/tooltip";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { errorMessage } from "@/lib/errors";
import { cn } from "@/lib/cn";
import {
  ClipboardCheck,
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
  Pencil,
  Share2,
  Tag,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
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
import { DraftNotice } from "@/components/draft-notice";
import type { RetryQuery } from "@/components/ui/misc";
import { LoadErrorLine } from "@/components/error-state";
import { Sheet, SheetTrigger } from "@/components/ui/sheet";
import { DeleteDocumentDialog } from "@/components/delete-document-dialog";
import { MoveDialog } from "@/components/browse/move-dialog";
import {
  api,
  type ApprovalStatus,
  type ApprovalSummary,
  type Document,
  type Principal,
} from "@/api";
import { canManageSharing, ROLE_RANK } from "@/lib/constants";
import { useDocumentRole } from "@/lib/hooks";
import { useEditDraft } from "@/lib/edit-drafts";
import { queryKeys } from "@/lib/queryKeys";
import { loadFailed } from "@/lib/query-retry";
import { cursorsShownStore } from "@/lib/live-cursors";
import { principalColor } from "@/lib/principals";
import { ShareSheet } from "./doc-share-sheet";
import { ApprovalsDialog } from "./doc-approvals";
import { useShownApprovals } from "./use-shown-approvals";
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
  accessUnknown,
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
  // The query to retry when what the reader may do did not load.
  accessUnknown?: RetryQuery;
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
  const [approvalsDialogOpen, setApprovalsDialogOpen] = useState(!!approvalsOpen);
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
  // What a reader who cannot change the words may do. A signed-in reader's
  // role shows once it loads.
  const access =
    (ROLE_RANK[role || ""] || 0) >= ROLE_RANK.commenter
      ? "commenter"
      : role || signIn
        ? "viewer"
        : undefined;
  const [renaming, setRenaming] = useState(false);
  // Rename in the menu waits until the menu closes, so the menu does not
  // take the focus back from the title field.
  const renameOnClose = useRef(false);
  // The share sheet lists the requests. Their count waits on its button.
  const accessRequests = useQuery({
    queryKey: queryKeys.documentAccessRequests(docId),
    queryFn: () => api.documentAccessRequests(docId),
    enabled: canManageAccess && !signIn,
  });
  const requestCount = accessRequests.data?.items.length ?? 0;
  // The share sheet says why, with Retry.
  const requestsFailed = loadFailed(accessRequests);
  // The menu item gives the counts of the version on screen, as the chip does.
  const shownApprovals = useShownApprovals({
    status: approvalStatus,
    approved: approvalSummary?.approved,
    total: approvalSummary?.total,
  });
  // An unknown status is not "no approvers".
  const hasApprovals =
    !!shownApprovals.status || !!shownApprovals.pending || !!shownApprovals.failed;
  const shareFrameFocusRef = useRef<HTMLIFrameElement | null>(null);
  // The toast names the document, so that it reaches a reader who left. Only
  // a reader who stays on the document goes back.
  const del = useMutation({
    mutationFn: () => api.deleteDocument(docId),
    onSuccess: () => {
      toast.success(`Deleted “${title}”.`);
      q.invalidateQueries({ queryKey: queryKeys.documents() });
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
      title={
        <DocTitle
          docId={docId}
          title={title}
          canRename={canManage}
          renaming={renaming}
          onRenamingChange={setRenaming}
        />
      }
      meta={
        previewing ? null : accessUnknown ? (
          <LoadErrorLine query={accessUnknown} className="shrink-0 gap-2">
            <span className="sr-only sm:not-sr-only">Could not check your access</span>
          </LoadErrorLine>
        ) : (
          <EditStatus access={access} />
        )
      }
    >
      <ApprovalsDialog
        status={approvalStatus}
        approved={approvalSummary?.approved}
        total={approvalSummary?.total}
        isOwner={canManage}
        open={approvalsDialogOpen}
        onOpenChange={setApprovalsDialogOpen}
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
          size="sm"
          title="Show the latest version"
          aria-label="Show the latest version"
          className="shrink-0 px-2"
          onClick={onShowLatest}
        >
          <ArrowUpToLine className="h-4 w-4" />
          <span className="hidden sm:inline">Latest</span>
        </Button>
      ) : null}
      <HistoryDialog
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        docId={docId}
        current={current}
        latest={latest}
        canRestore={canChangeContent}
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
                requestsFailed
                  ? "Share, requests for access did not load"
                  : requestCount
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
              {requestCount || requestsFailed ? (
                // The inbox marks a list that did not load the same way.
                <span
                  data-state="open"
                  className={cn(
                    "pop absolute right-0.5 top-0.5 min-w-4 rounded-full px-1 text-[10px] font-medium leading-4 tabular-nums text-white",
                    requestsFailed
                      ? "bg-[var(--color-fg-muted)]"
                      : "bg-[var(--color-accent)]",
                  )}
                >
                  {requestsFailed ? "!" : requestCount}
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
        <DropdownContent
          onCloseAutoFocus={(event) => {
            if (!renameOnClose.current) return;
            renameOnClose.current = false;
            event.preventDefault();
            setRenaming(true);
          }}
        >
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
          {hasApprovals || canManage ? (
            <DropdownItem
              className="xs:hidden"
              onSelect={() => setApprovalsDialogOpen(true)}
            >
              <ClipboardCheck className="h-4 w-4" />
              {hasApprovals ? "Approvals" : "Request approval"}
              {shownApprovals.total ? (
                <span className="ml-auto pl-4 text-xs tabular-nums text-[var(--color-fg-muted)]">
                  {shownApprovals.approved ?? 0} of {shownApprovals.total}
                </span>
              ) : null}
            </DropdownItem>
          ) : null}
          {viewers.length ? (
            <DropdownGroup className="xs:hidden">
              <DropdownSeparator />
              <ViewerList
                viewers={viewers}
                onFollow={onFollowViewer}
                followedSession={followedSession}
                onUnfollow={onUnfollowViewer}
              />
              <CursorsItem />
              <DropdownSeparator />
            </DropdownGroup>
          ) : null}
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
              <DropdownItem onSelect={() => (renameOnClose.current = true)}>
                <Pencil className="h-4 w-4" /> Rename
              </DropdownItem>
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
          ) : canEdit ? (
            // An editor sees why they cannot rename, instead of no Rename.
            <DropdownItem disabled>
              <Pencil className="h-4 w-4" />
              <span className="flex flex-col">
                Rename
                <span className="text-xs">Only the owner can rename</span>
              </span>
            </DropdownItem>
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
            onConfirm={() => del.mutate(undefined, { onSuccess: () => nav(backTo) })}
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

// The title of the document. Its owner renames it in place, as in Google
// Docs: a click on it, or Rename in the More menu, makes it a field. Enter or
// a click away saves, and Esc keeps the old title.
// TitleField is the title while its owner renames it. The words are a draft
// of the document (`title:<docId>`), so that a route change or a reload keeps
// them. If someone else renames the document first, the field stays open
// with the reader's words, and saves nothing until the reader chooses. The
// bar shows the new title at once, and the old one again if the save fails.
function TitleField({
  docId,
  title,
  onDone,
}: {
  docId: string;
  title: string;
  onDone: (how: "enter" | "escape" | "away") => void;
}) {
  const q = useQueryClient();
  const name = useEditDraft(`title:${docId}`, title, title);
  const key = queryKeys.document(docId);
  const rename = useMutation({
    mutationFn: (next: string) => api.renameDocument(docId, next),
    onMutate: async (next) => {
      await q.cancelQueries({ queryKey: key });
      const before = q.getQueryData<Document>(key);
      q.setQueryData<Document>(key, (doc) => doc && { ...doc, title: next });
      return { before };
    },
    onSuccess: (_, next) => name.sent(next),
    // The old title comes back only if nobody renamed it since.
    onError: (e, next, context) => {
      q.setQueryData<Document>(key, (doc) =>
        doc?.title === next && context?.before ? context.before : doc,
      );
      toast.error(errorMessage(e, "Rename failed"));
    },
    onSettled: () => {
      q.invalidateQueries({ queryKey: key });
      q.invalidateQueries({ queryKey: queryKeys.documents() });
    },
  });
  const how = useRef<"enter" | "escape" | "away">("away");
  const field = useRef<HTMLInputElement>(null);
  return (
    <div className="relative w-full max-w-sm">
      <Input
        ref={field}
        aria-label="Document title"
        value={name.value}
        onChange={(e) => name.setValue(e.target.value)}
        autoFocus
        onFocus={(e) => e.currentTarget.select()}
        onKeyDown={(e) => {
          if (e.key !== "Enter" && e.key !== "Escape") return;
          // Esc leaves the field and does not reach the page's shortcuts.
          e.preventDefault();
          e.stopPropagation();
          how.current = e.key === "Escape" ? "escape" : "enter";
          e.currentTarget.blur();
        }}
        onBlur={() => {
          const done = how.current;
          how.current = "away";
          if (done === "escape") name.discard();
          // A title that changed elsewhere waits for the reader's choice.
          else if (name.stale) return;
          else {
            const next = name.value.trim();
            if (next && next !== title) rename.mutate(next);
            else name.discard();
          }
          onDone(done);
        }}
        className="h-8 w-full px-1.5 font-semibold"
      />
      {name.stale || name.conflict || name.cameBack ? (
        // A press in the notice keeps the focus in the field.
        <div
          className="absolute inset-x-0 top-full z-50 mt-1 rounded-md shadow-[var(--shadow-pop)]"
          onMouseDown={(e) => e.preventDefault()}
        >
          <DraftNotice
            draft={name}
            cameBack="Your title from earlier came back."
            stale={{
              say: "The document was renamed elsewhere. It is now:",
              quote: title,
              take: "Use the new title",
              keep: "Keep mine",
              onTake: () => {
                name.discard();
                onDone("away");
              },
              onKeep: () => {
                name.follow();
                field.current?.focus();
              },
            }}
            className="mt-0"
          />
        </div>
      ) : null}
    </div>
  );
}

function DocTitle({
  docId,
  title,
  canRename,
  renaming,
  onRenamingChange,
}: {
  docId: string;
  title: string;
  canRename: boolean;
  renaming: boolean;
  onRenamingChange: (renaming: boolean) => void;
}) {
  // Enter and Esc give the focus back to the title, as a click away does not.
  // After a rename that a click started, the title gets no focus ring: the
  // browser shows one after any field, and it looks like the field stays.
  const refocus = useRef(false);
  const clicked = useRef(false);
  const [quiet, setQuiet] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (renaming || !refocus.current) return;
    refocus.current = false;
    setQuiet(clicked.current);
    clicked.current = false;
    button.current?.focus();
  }, [renaming]);
  if (renaming) {
    return (
      <TitleField
        docId={docId}
        title={title}
        onDone={(how) => {
          refocus.current = how !== "away";
          onRenamingChange(false);
        }}
      />
    );
  }
  const text =
    "truncate rounded-sm border border-transparent px-1.5 text-sm font-semibold";
  return canRename ? (
    <button
      ref={button}
      type="button"
      title={title}
      aria-label={`Rename ${title}`}
      onClick={(e) => {
        // A click from the keyboard has no detail.
        clicked.current = e.detail > 0;
        onRenamingChange(true);
      }}
      onBlur={() => setQuiet(false)}
      className={cn(
        text,
        "h-8 min-w-0 cursor-text text-left transition-[border-color] duration-150 ease-out hover:border-[var(--color-border)]",
        quiet && "focus-visible:outline-none",
      )}
    >
      {title}
    </button>
  ) : (
    <div title={title} className={cn(text, "min-w-0")}>
      {title}
    </div>
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
      <AnimatePresence initial={false}>
        {followed ? (
          <StopFollowing
            key="following"
            viewer={followed}
            onUnfollow={actions.onUnfollow}
          />
        ) : null}
      </AnimatePresence>
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
            className="relative hidden shrink-0 xs:max-sm:inline-flex"
          >
            <Users className="h-4 w-4" />
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

// StopFollowing tells, in the followed viewer's color, whom the view follows,
// and stops following on a click. It sits in the bar, over no text of the
// document. On a phone only the face shows.
function StopFollowing({
  viewer,
  onUnfollow,
}: {
  viewer: Viewer;
  onUnfollow: () => void;
}) {
  const name = principalLabel(viewer.principal);
  return (
    <motion.div
      className="shrink-0"
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
      transition={{ type: "spring", duration: 0.25, bounce: 0 }}
    >
      <Button
        variant="ghost"
        size="sm"
        onClick={onUnfollow}
        aria-label={`Stop following ${name}`}
        tooltip={`Stop following ${name} (Esc)`}
        style={{ background: principalColor(viewer.principal) }}
        className="gap-1.5 rounded-full pl-1 pr-2 text-white hover:opacity-90 touch:h-10"
      >
        <PersonAvatar who={viewer.principal} size={22} />
        <span className="hidden max-w-32 truncate sm:inline">Following {name}</span>
        <X className="h-3.5 w-3.5" />
      </Button>
    </motion.div>
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

// The form mounts each time the dialog opens, however it was opened. Its
// words are a draft of the document (`labels:<docId>`) that starts from the
// saved labels, and stays through a close, a failure and a reload. If the
// labels change elsewhere while the form has words, it keeps them and saves
// nothing until the reader chooses. A late save closes only its own form.
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
  const saved = labels.join(", ");
  const draft = useEditDraft(`labels:${docId}`, saved, saved);
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (sent: string) =>
      api.replaceDocumentLabels(
        docId,
        sent
          .split(",")
          .map((label) => label.trim())
          .filter(Boolean),
      ),
    onSuccess: (_, sent) => {
      draft.sent(sent);
      qc.invalidateQueries({ queryKey: queryKeys.document(docId) });
      qc.invalidateQueries({ queryKey: queryKeys.documents() });
    },
    onError: (e) => toast.error(errorMessage(e, "Could not update labels")),
  });
  return (
    <>
      <Input
        aria-label="Labels"
        value={draft.value}
        onChange={(event) => draft.setValue(event.target.value)}
        placeholder="runbook, payments, onboarding"
        disabled={!canEdit}
      />
      <DraftNotice
        draft={draft}
        cameBack="Your labels from earlier came back. They are not saved yet."
        stale={{
          say: "The labels changed elsewhere. They now say:",
          quote: saved || "No labels",
          take: "Use the new labels",
          keep: "Keep mine",
        }}
      />
      <DialogFooter>
        {canEdit ? (
          <Button
            onClick={() => save.mutate(draft.value, { onSuccess: onSaved })}
            disabled={draft.stale}
            busy={save.isPending}
          >
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
