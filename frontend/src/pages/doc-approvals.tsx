import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ClipboardCheck, Clock, X } from "lucide-react";

import {
  api,
  APIError,
  docTitle,
  type Comment,
  type ApprovalDecision,
  type ApprovalListItem,
  type ApprovalRequest,
  type ApprovalStatus,
} from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Combobox } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { DraftNotice } from "@/components/draft-notice";
import { RetryButton, revealOnHover, Skeleton } from "@/components/ui/misc";
import { ErrorState, LoadErrorLine } from "@/components/error-state";
import { cn } from "@/lib/cn";
import { useEditDraft } from "@/lib/edit-drafts";
import { ADDRESS_PATTERN, COMMENT_STATUS, ROLE_RANK } from "@/lib/constants";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/queryKeys";
import { loadFailed } from "@/lib/query-retry";
import { principalNames, samePrincipal } from "@/lib/principals";
import { useDoc } from "./doc-context";
import { useInvalidateApprovals } from "./use-invalidate-approvals";
import { useShownApprovals } from "./use-shown-approvals";
import { PersonAvatar } from "./doc-comment-parts";

const STATUS_BADGE: Record<
  ApprovalStatus,
  { label: string; variant: "success" | "warning" | "danger"; Icon: typeof Check }
> = {
  approved: { label: "Approved", variant: "success", Icon: Check },
  pending: { label: "Pending", variant: "warning", Icon: Clock },
  rejected: { label: "Rejected", variant: "danger", Icon: X },
};

// badgeText leads with how many approvers have approved ("2 of 3 approved"):
// the count is the useful part, and a bare "Approved" does not say who. When
// someone rejected it, that comes first, because it blocks the rest.
function badgeText(status: ApprovalStatus, approved?: number, total?: number) {
  const counts = total ? `${approved ?? 0} of ${total} approved` : "";
  if (status === "rejected") {
    return counts ? `Rejected · ${counts}` : "Rejected";
  }
  return counts || STATUS_BADGE[status].label;
}

// approvalsLabel names the approvals icon by its state and count, as
// "Approvals: pending, 1 of 3 approved". The badge shows the state by color
// and glyph alone.
function approvalsLabel(status: ApprovalStatus, approved?: number, total?: number) {
  const counts = total ? `${approved ?? 0} of ${total} approved` : "";
  const state = status === "approved" && counts ? "" : STATUS_BADGE[status].label;
  return `Approvals: ${[state.toLowerCase(), counts].filter(Boolean).join(", ")}`;
}

// ApprovalStatusBadge is the aggregate-status chip of the approvals dialog.
// Hidden entirely when the document has no assigned approvers.
export function ApprovalStatusBadge({
  status,
  approved,
  total,
}: {
  status?: ApprovalStatus;
  approved?: number;
  total?: number;
}) {
  if (!status) return null;
  const { Icon, variant } = STATUS_BADGE[status];
  return (
    <Badge variant={variant} className="shrink-0 gap-1">
      <Icon className="h-3 w-3" aria-hidden="true" />
      {badgeText(status, approved, total)}
    </Badge>
  );
}

// The badge of each state of the approvals: a color and a glyph. "failed" is
// approvals that did not load, as the Share button marks its requests.
const ICON_BADGE: Record<
  ApprovalStatus | "failed",
  { color: string; glyph: ReactNode }
> = {
  pending: {
    color: "bg-[var(--color-warning)]",
    glyph: <Clock className="size-2" strokeWidth={3} />,
  },
  approved: {
    color: "bg-[var(--color-success)]",
    glyph: <Check className="size-2" strokeWidth={4} />,
  },
  rejected: { color: "bg-[var(--color-danger)]", glyph: "!" },
  failed: { color: "bg-[var(--color-fg-muted)]", glyph: "!" },
};

// ApprovalBadge marks an icon at its top right with the state of the
// approvals. It pops in when the state changes, not when the page loads.
export function ApprovalBadge({
  status,
  failed,
  className,
}: {
  status?: ApprovalStatus;
  failed?: boolean;
  className?: string;
}) {
  const state = status ?? (failed ? "failed" : undefined);
  return (
    <AnimatePresence initial={false}>
      {state ? (
        <motion.span
          key={state}
          aria-hidden="true"
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{
            opacity: 1,
            scale: 1,
            transition: { type: "spring", duration: 0.2, bounce: 0 },
          }}
          exit={{ opacity: 0, transition: { duration: 0.1 } }}
          className={cn(
            "absolute right-0.5 top-0.5 grid size-3 place-items-center rounded-full text-[9px] font-bold leading-none text-white ring-2 ring-[var(--color-chrome)]",
            ICON_BADGE[state].color,
            className,
          )}
        >
          {ICON_BADGE[state].glyph}
        </motion.span>
      ) : null}
    </AnimatePresence>
  );
}

// ApprovalsDialog is the document bar's entry point into approvals: an icon
// whose badge gives their state, so a reader who sees it pending can click
// straight through to who still owes a decision. Approvals live here rather
// than in the comments sidebar: they are a different concern from
// discussion. A phone bar has no room for the icon: the More menu opens the
// dialog, and its button carries the badge.
export function ApprovalsDialog({
  status,
  approved,
  total,
  isOwner,
  open,
  onOpenChange: setOpen,
}: {
  status?: ApprovalStatus;
  approved?: number;
  total?: number;
  isOwner: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // The props describe the document's *current* version. The dialog lists
  // the decisions on the version on screen, so the icon does too.
  const shown = useShownApprovals({ status, approved, total });

  // With no approvers the API omits the status entirely. The owner still
  // needs a way in, because this dialog is the only place approvers can be
  // assigned; without a trigger the first approver could never be added.
  const unassigned = !shown.status && !shown.failed && !shown.pending;
  if (unassigned && !isOwner) return null;
  const label = shown.status
    ? approvalsLabel(shown.status, shown.approved, shown.total)
    : shown.failed
      ? "Approvals did not load"
      : shown.pending
        ? "Approvals"
        : "Request approval";

  // The dialog stays mounted while the badge changes, so an open dialog
  // stays open when the status of an older version loads.
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="chrome"
          size="icon-sm"
          aria-label={label}
          className={cn(
            "relative hidden shrink-0 sm:inline-flex",
            !shown.status && "text-[var(--color-fg-muted)]",
          )}
        >
          <ClipboardCheck className="size-4" />
          <ApprovalBadge status={shown.status} failed={shown.failed} />
        </Button>
      </DialogTrigger>
      <DialogContent
        anchor="top"
        className="max-w-lg overflow-hidden p-0"
        aria-describedby={undefined}
      >
        {/* The content has no padding, so the lists run edge to edge. */}
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Approvals</DialogTitle>
        </DialogHeader>
        <Approvals onClose={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

// decisionLabel says where an approver stands. A pending approver who
// decided before the latest edits sees that their decision no longer counts,
// because edits save as people type.
function decisionLabel(item: ApprovalListItem, current: boolean) {
  if (item.decision === "approved") {
    return (
      <span className="flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-300">
        <Check className="h-3.5 w-3.5" /> Approved
      </span>
    );
  }
  if (item.decision === "rejected") {
    return (
      <span className="flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-300">
        <X className="h-3.5 w-3.5" /> Rejected
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-[var(--color-fg-muted)]">
      <Clock className="h-3.5 w-3.5" /> Pending
      {current && item.earlier
        ? ` · ${item.earlier.decision === "approved" ? "approved" : "rejected"} before the latest edits`
        : null}
    </span>
  );
}

type Decision = {
  version: string;
  decision: ApprovalDecision;
  note?: string;
  // The document, for the toast of an answer that comes after the reader left.
  title: string;
};

// useDecide records a decision on the version on screen when the reader
// decided. Every form that decides has its own, so a late answer closes only
// the form that sent it, while it is open. The toast, the refresh and
// onDecided come always. Each form waits while any of them decides.
function useDecide(docId: string, onDecided?: (d: Decision) => void) {
  // The approver decides on the state of the document that they see.
  const { shownSeq } = useDoc();
  const invalidate = useInvalidateApprovals(docId);
  const mutationKey = [...queryKeys.approvalsAll(docId), "decide"];
  const decide = useMutation({
    mutationKey,
    mutationFn: (d: Decision) =>
      api.createApproval(docId, d.version, d.decision, d.note, shownSeq),
    onSuccess: (_, d) => {
      toast.success(
        `${d.decision === "approved" ? "Approved" : "Rejected"} “${d.title}”.`,
      );
      onDecided?.(d);
      invalidate();
    },
    onError: (e) => {
      toast.error(errorMessage(e, "Could not record decision"));
      // The server says why, as when people still type in the document. The
      // document and the decisions load again, so that the next decision is
      // on what the server has.
      invalidate();
    },
  });
  return { decide, deciding: useIsMutating({ mutationKey }) > 0 };
}

// ReviewActions is the signed-in approver's own controls: Approve, Reject and
// Revoke. It shows them to nobody else, and not while an older version is on
// screen. It lives only in the approvals dialog, beside the approver's own
// row, so the decision and what it currently says are read together. An open
// Reject stays open when a new version comes, so that its reason stays.
export function ReviewActions({
  className,
  onNavigate,
}: {
  className?: string;
  // Called when the reader jumps to a comment, so a surrounding dialog can close.
  onNavigate?: () => void;
}) {
  const { docId, version, principal, comments, setActiveComment, typists } = useDoc();
  const invalidate = useInvalidateApprovals(docId);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [confirmApprove, setConfirmApprove] = useState(false);
  const doc = useQuery({
    queryKey: queryKeys.document(docId),
    queryFn: () => api.getDocument(docId),
  });
  const approvals = useQuery({
    queryKey: queryKeys.approvals(docId, version),
    queryFn: () => api.listApprovals(docId, version),
    enabled: !!docId,
  });
  const { decide, deciding } = useDecide(docId);
  const approve = () =>
    decide.mutate(
      { version, decision: "approved", title: docTitle(doc.data || {}) },
      { onSuccess: () => setConfirmApprove(false) },
    );
  const revoke = useMutation({
    mutationFn: (approvalId: string) => api.deleteApproval(docId, approvalId),
    onSuccess: () => {
      toast.success("Decision revoked.");
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e, "Could not revoke decision")),
  });

  // The reviewer's own open comment threads: what a request for changes is
  // about, so they need not retype it.
  const mine = useMemo(
    () =>
      comments.filter(
        (c) =>
          !c.parent_comment_id &&
          c.status !== COMMENT_STATUS.resolved &&
          samePrincipal(c.author, principal),
      ),
    [comments, principal],
  );

  const own = approvals.data?.items.find((item) =>
    samePrincipal(item.approver, principal),
  );
  const latest = doc.data?.current_version_id;
  const isCurrentVersion = !version || !latest || version === latest;
  const reject = (
    <RejectDialog
      open={rejectOpen}
      onOpenChange={setRejectOpen}
      comments={mine}
      title={docTitle(doc.data || {})}
      onJump={(id) => {
        setRejectOpen(false);
        onNavigate?.();
        setActiveComment(id);
      }}
    />
  );
  const allResolved =
    own?.decision === "rejected" &&
    (own.comments_total ?? 0) > 0 &&
    (own.comments_open ?? 0) === 0;
  const plural = mine.length === 1 ? "comment" : "comments";
  // The server takes no approval while another person types, so Approve
  // waits, and comes back by itself when they stop.
  const typing = typists.length > 0;

  return (
    <>
      {own && isCurrentVersion ? (
        <div className={className}>
          {allResolved ? (
            <p className="mb-2 text-xs text-[var(--color-fg-muted)]">
              All your comments are resolved. Ready to approve?
            </p>
          ) : null}
          {typing && own.decision !== "approved" ? (
            <p className="mb-2 text-xs text-[var(--color-fg-muted)]">
              {principalNames(typists)} {typists.length === 1 ? "is" : "are"} editing.
              You can approve when they stop.
            </p>
          ) : null}
          {confirmApprove ? (
            <div className="space-y-2">
              <p className="text-xs">
                You have {mine.length} open {plural}. Approve anyway?
              </p>
              <div className="flex gap-2">
                <Button size="sm" disabled={typing} busy={deciding} onClick={approve}>
                  <Check className="h-3.5 w-3.5" /> Approve anyway
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={deciding}
                  onClick={() => setConfirmApprove(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {own.decision !== "approved" ? (
                // The decision is why the approver opens the dialog, so Approve
                // takes the first focus.
                <Button
                  size="sm"
                  autoFocus
                  disabled={deciding || typing}
                  busy={decide.isPending}
                  onClick={() =>
                    mine.length > 0 ? setConfirmApprove(true) : approve()
                  }
                >
                  <Check className="h-3.5 w-3.5" /> Approve
                </Button>
              ) : null}
              {own.decision !== "rejected" ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-[var(--color-danger)]"
                  disabled={deciding}
                  onClick={() => setRejectOpen(true)}
                >
                  Reject
                </Button>
              ) : null}
              {own.decision && own.id ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="text-[var(--color-danger)]"
                  busy={revoke.isPending}
                  onClick={() => revoke.mutate(own.id!)}
                >
                  Revoke
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
      {reject}
    </>
  );
}

// RejectDialog lists the reviewer's open comments, which go with the
// rejection, and takes an optional reason. With no comments the reason is
// required: a bare rejection tells the author nothing.
function RejectDialog({
  open,
  onOpenChange,
  ...form
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
} & Omit<Parameters<typeof RejectForm>[0], "onClose">) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg overflow-hidden p-0"
        aria-describedby={undefined}
      >
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Reject</DialogTitle>
        </DialogHeader>
        <RejectForm {...form} onClose={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

// The form mounts each time the dialog opens. Its reason is a draft of the
// document (`reject:<docId>`), written for the version that was the latest
// when the reviewer started it. It stays through a close, a reload and a new
// version. A rejection is on that version only: after a new version, the
// reviewer uses the reason for it, or discards it. A late rejection closes
// only the form that sent it, and clears only the reason that it sent.
function RejectForm({
  comments,
  title,
  onJump,
  onClose,
}: {
  comments: Comment[];
  title: string;
  onJump: (commentId: string) => void;
  onClose: () => void;
}) {
  const { docId, version, showCurrent } = useDoc();
  const doc = useQuery({
    queryKey: queryKeys.document(docId),
    queryFn: () => api.getDocument(docId),
  });
  const latest = doc.data?.current_version_id || version;
  const reason = useEditDraft(`reject:${docId}`, latest);
  const { decide, deciding } = useDecide(docId, (d) => reason.sent(d.note ?? ""));
  const versions = useQuery({
    queryKey: queryKeys.versions(docId),
    queryFn: () => api.listVersions(docId),
    enabled: reason.stale,
  });
  const named = (id: string) => {
    const number = versions.data?.items.find((v) => v.id === id)?.number;
    return number ? `version ${number}` : "an earlier version";
  };
  const note = reason.value.trim();
  const hasComments = comments.length > 0;
  const canSubmit = !reason.stale && (hasComments || note.length > 0);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit && !deciding)
          decide.mutate(
            {
              version: reason.about,
              decision: "rejected",
              note: note || undefined,
              title,
            },
            { onSuccess: onClose },
          );
      }}
    >
      {hasComments ? (
        <div className="max-h-48 overflow-y-auto border-b border-[var(--color-border)] p-3">
          <p className="px-1 pb-1 text-xs font-medium">
            Your open comments ({comments.length})
          </p>
          <ul className="space-y-0.5">
            {comments.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onJump(c.id)}
                  className="w-full rounded-md px-1.5 py-1.5 text-left hover:bg-[var(--color-surface-muted)] focus-visible:-outline-offset-2"
                >
                  <span className="block truncate text-xs font-medium">
                    {c.selected_text || "Comment"}
                  </span>
                  <span className="block truncate text-xs text-[var(--color-fg-muted)]">
                    {c.body}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="space-y-2 p-3">
        <Textarea
          autoFocus
          value={reason.value}
          onChange={(e) => reason.setValue(e.target.value)}
          maxLength={2000}
          placeholder={
            hasComments ? "Reason (optional)" : "Why are you rejecting this?"
          }
          aria-label="Reason"
          className="min-h-[72px] text-xs"
        />
        <DraftNotice
          draft={reason}
          cameBack="Your reason from earlier came back."
          stale={{
            say:
              version === reason.about
                ? `A new version was published. You wrote this reason for ${named(reason.about)}.`
                : `You wrote this reason for ${named(reason.about)}. This is ${named(latest)}.`,
            take: "Discard",
            keep: `Use it for ${named(latest)}`,
            onKeep: () => {
              reason.follow();
              if (version !== latest) showCurrent();
            },
          }}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            type="submit"
            variant="danger"
            disabled={!canSubmit}
            busy={deciding}
          >
            Reject
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
}

// Approvals renders the per-approver decision list for the version being
// viewed, with decision actions for the signed-in approver and assignment
// controls for the owner.
export function Approvals({ onClose }: { onClose?: () => void }) {
  const { docId, version, principal } = useDoc();
  const invalidate = useInvalidateApprovals(docId);
  const doc = useQuery({
    queryKey: queryKeys.document(docId),
    queryFn: () => api.getDocument(docId),
  });
  const isOwner = samePrincipal(principal, doc.data?.owner);
  const latest = doc.data?.current_version_id;
  const isCurrentVersion = !version || !latest || version === latest;
  const approvals = useQuery({
    queryKey: queryKeys.approvals(docId, version),
    queryFn: () => api.listApprovals(docId, version),
    enabled: !!docId,
  });
  // The owner removes an approver by the ID of its assignment, which only
  // this list gives.
  const approvers = useQuery({
    queryKey: queryKeys.approvers(docId),
    queryFn: () => api.listApprovers(docId),
    enabled: isOwner,
    staleTime: 30_000,
  });

  const summary = approvals.data?.summary;
  const items = approvals.data?.items;
  // While the decisions load, the document says if its current version has
  // approvers, as the bar does. With none, no list holds a place for them.
  const empty = approvals.isPending
    ? isCurrentVersion && doc.isSuccess && !doc.data.approval_status
    : items?.length === 0;

  return (
    // The parts divide by lines, so a part that is not there leaves no line.
    <div className="flex max-h-[70vh] flex-col divide-y divide-[var(--color-border)]">
      <div className="flex min-h-9 items-center justify-between gap-2 px-6 pb-3">
        {summary ? (
          <>
            <p className="text-xs text-[var(--color-fg-muted)]">
              {!summary.total
                ? "No approvers assigned"
                : isCurrentVersion
                  ? "On the current document"
                  : "On earlier content"}
            </p>
            <ApprovalStatusBadge
              status={approvals.data?.status}
              approved={summary.approved}
              total={summary.total}
            />
          </>
        ) : null}
      </div>
      {empty ? null : (
        <div className="flex-1 space-y-1 overflow-y-auto px-4 py-3">
          {approvals.isPending ? (
            <>
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </>
          ) : approvals.isError ? (
            <ErrorState
              title="Could not load approvals"
              description={errorMessage(approvals.error, "Try again in a moment.")}
              action={<RetryButton query={approvals} />}
            />
          ) : (
            <>
              {approvals.data.items.map((item) => (
                <ApproverRow
                  key={item.approver.type + ":" + item.approver.id}
                  item={item}
                  docId={docId}
                  isOwner={isOwner}
                  assignments={approvers.data?.items}
                  current={isCurrentVersion}
                  onChanged={invalidate}
                />
              ))}
              {isOwner && loadFailed(approvers) ? (
                <LoadErrorLine query={approvers} className="px-2 pt-1">
                  Could not load the approvers. Remove waits until they load.
                </LoadErrorLine>
              ) : null}
            </>
          )}
        </div>
      )}
      <ReviewActions className="px-6 py-3" onNavigate={onClose} />
      {isOwner ? <AddApprover docId={docId} onAdded={invalidate} /> : null}
    </div>
  );
}

function ApproverRow({
  item,
  docId,
  isOwner,
  assignments,
  current,
  onChanged,
}: {
  item: ApprovalListItem;
  docId: string;
  isOwner: boolean;
  // The owner's list of approvers, once it loads.
  assignments?: ApprovalRequest[];
  // The list is about the current version.
  current: boolean;
  onChanged: () => void;
}) {
  const remove = useMutation({
    mutationFn: ({ id }: { id: string; label: string }) =>
      api.deleteApprover(docId, id),
    onSuccess: (_, { label }) => {
      toast.success(`Removed ${label} as approver.`);
      onChanged();
    },
    onError: (e, { label }) =>
      toast.error(errorMessage(e, `Could not remove ${label} as approver`)),
  });
  const request = assignments?.find((r) => samePrincipal(r.approver, item.approver));
  const label = item.approver.name || item.approver.email || item.approver.id;
  return (
    <div className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-[var(--color-surface-muted)]">
      <PersonAvatar who={item.approver} size={24} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{label}</div>
        {decisionLabel(item, current)}
        {item.comments_total ? (
          <span className="block text-[11px] text-[var(--color-fg-muted)]">
            {item.comments_open ?? 0} open of {item.comments_total}{" "}
            {item.comments_total === 1 ? "comment" : "comments"}
          </span>
        ) : null}
        {item.note ? (
          <p className="mt-1 whitespace-pre-wrap break-words text-xs text-[var(--color-fg-muted)]">
            {item.note}
          </p>
        ) : null}
      </div>
      {/* Until the list of approvers loads, Remove shows, but is off. */}
      {isOwner && (request || !assignments) ? (
        <Button
          size="icon"
          variant="ghost"
          className={cn("h-6 w-6 transition-opacity", revealOnHover)}
          aria-label={`Remove ${label} as approver`}
          tooltip={request ? undefined : "Remove waits until the approvers load"}
          disabled={!request || remove.isPending}
          onClick={() => request && remove.mutate({ id: request.id, label })}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

// What a person who cannot edit the document can do on it, by their role.
const CANNOT_EDIT: Record<string, string> = {
  "": "can't open",
  viewer: "can only view",
  commenter: "can only comment on",
};

// The note of a person in the search, by their role, when they cannot edit.
const ACCESS_NOTE: Record<string, string> = {
  "": "No access",
  viewer: "Viewer",
  commenter: "Commenter",
};

const rank = (role: string) => ROLE_RANK[role] ?? 0;
// A person needs editor access when their role loaded and is less.
const needsAccess = (role?: string): role is string =>
  role !== undefined && rank(role) < ROLE_RANK.editor;

// A person to add as an approver, who cannot edit the document yet.
type Asked = { address: string; name: string; role: string };

// AddApprover assigns an approver. An approver can edit the document, so a
// person who cannot edit it gets editor access first, once the owner says
// so. Its errors show under the field, or in a toast when the dialog closed
// before the answer. The address is a draft of the document
// (`approver:<docId>`), so that it stays through a failure, a close and a
// reload.
function AddApprover({ docId, onAdded }: { docId: string; onAdded: () => void }) {
  const q = useQueryClient();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);
  const field = useRef<HTMLInputElement>(null);
  const draft = useEditDraft(`approver:${docId}`, "");
  const address = draft.value;
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(address.trim()), 250);
    return () => window.clearTimeout(t);
  }, [address]);
  const suggestions = useQuery({
    queryKey: queryKeys.userSearch(debounced),
    queryFn: () => api.searchUsers(debounced),
    enabled: debounced.length >= 2,
    staleTime: 30_000,
  });
  const access = useQuery({
    queryKey: queryKeys.documentAccess(docId),
    queryFn: () => api.documentAccess(docId),
  });
  // roleOf is the role on the document of the person at an address: their
  // own access or everyone's, as the server reads it for an approver. It is
  // "" for no access, and undefined until the access loads.
  const roleOf = (addr: string) =>
    access.data?.items
      .filter(
        ({ principal: p }) =>
          p.type === "anyone" || (p.type === "user" ? p.email : p.name) === addr,
      )
      .map((item) => item.effective_role)
      .reduce((best, role) => (rank(role) > rank(best) ? role : best), "");
  // The confirmation stays filled while it closes.
  const [asked, setAsked] = useState<Asked>();
  const [asking, setAsking] = useState(false);
  const ask = (person: Asked) => {
    setAsked(person);
    setAsking(true);
  };
  const add = useMutation({
    mutationFn: async ({ addr, grant }: { addr: string; grant?: boolean }) => {
      if (!grant) return api.createApprover(docId, addr);
      await api.createGrant(docId, addr, "editor");
      return api.createApprover(docId, addr).catch((e: unknown) => {
        throw new Error(
          `Gave ${addr} editor access, but could not add them as approver. ${errorMessage(e, "Try Add again.")}`,
        );
      });
    },
    onSuccess: ({ approver }, { addr, grant }) => {
      draft.sent(addr);
      const name = approver.name || addr;
      toast.success(
        grant
          ? `Gave ${name} editor access and added them as approver.`
          : `Added ${name} as approver.`,
      );
      onAdded();
    },
    onError: (e, { addr }) => {
      if (!mounted.current) toast.error(errorMessage(e, "Could not assign approver."));
      // The access did not load, so the server says who cannot open the
      // document.
      if (e instanceof APIError && e.code === "approver_no_access")
        ask({ address: addr, name: addr, role: "" });
    },
    onSettled: (_, __, { grant }) => {
      if (grant) q.invalidateQueries({ queryKey: queryKeys.documentAccess(docId) });
    },
  });
  // choose adds a person who can edit the document, and first asks to give
  // editor access to a person who cannot.
  const choose = (addr: string, name = addr) => {
    const role = roleOf(addr);
    if (needsAccess(role)) ask({ address: addr, name, role });
    else add.mutate({ addr });
  };
  const trimmed = address.trim();
  const options = (suggestions.data?.items || [])
    .filter((u) => u.email !== trimmed)
    .slice(0, 5)
    .map((u) => {
      const address = u.email || "";
      const role = roleOf(address);
      return {
        key: u.id,
        name: u.name || u.email || u.id,
        detail: [
          u.name ? u.email : undefined,
          needsAccess(role) ? ACCESS_NOTE[role] : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
        address,
        icon: <PersonAvatar who={u} size={24} />,
      };
    });
  return (
    <form
      className="px-6 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        // Send the raw address so the server resolves either a user email or a
        // service-account (bot) address; assuming "user" here made bot
        // approvers impossible to assign from the UI.
        if (ADDRESS_PATTERN.test(trimmed)) choose(trimmed);
      }}
    >
      <div className="flex gap-2">
        <div className="flex-1">
          <Combobox
            ref={field}
            autoFocus
            aria-label="Approver"
            placeholder="Email or bot address"
            aria-invalid={!!add.error || undefined}
            value={address}
            onValueChange={(next) => {
              draft.setValue(next);
              add.reset();
            }}
            options={options}
            onPick={(u) => {
              draft.setValue(u.address);
              choose(u.address, u.name);
            }}
            listAbove
            busy={suggestions.isFetching}
          />
        </div>
        <Button
          type="submit"
          disabled={!ADDRESS_PATTERN.test(trimmed) || add.isPending}
          busy={add.isPending}
        >
          Add
        </Button>
      </div>
      {add.error ? (
        <p role="alert" className="mt-1.5 text-xs text-[var(--color-danger)]">
          {errorMessage(add.error, "Could not assign approver.")}
        </p>
      ) : loadFailed(suggestions) ? (
        // A failed search keeps its line while Retry runs.
        <LoadErrorLine query={suggestions} className="mt-1.5">
          Could not search people. You can still enter a full address.
        </LoadErrorLine>
      ) : null}
      <DraftNotice draft={draft} cameBack="Your address from earlier came back." />
      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent
          // The focus goes back to the search, also after a click on Add.
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            field.current?.focus();
          }}
        >
          <AlertDialogTitle>Give {asked?.name} editor access?</AlertDialogTitle>
          <AlertDialogDescription>
            {asked?.name} {CANNOT_EDIT[asked?.role ?? ""]} this document. Give them
            editor access and add them as an approver?
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => asked && add.mutate({ addr: asked.address, grant: true })}
            >
              Give access and add
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  );
}
