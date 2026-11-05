import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, ClipboardCheck, Clock, X } from "lucide-react";

import {
  api,
  APIError,
  type Comment,
  type ApprovalDecision,
  type ApprovalListItem,
  type ApprovalStatus,
} from "@/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { RetryButton, revealOnHover, Skeleton } from "@/components/ui/misc";
import { ErrorState } from "@/components/error-state";
import { cn } from "@/lib/cn";
import { ADDRESS_PATTERN, COMMENT_STATUS } from "@/lib/constants";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/queryKeys";
import { samePrincipal } from "@/lib/principals";
import { useDoc } from "./doc-context";
import { useInvalidateApprovals } from "./use-invalidate-approvals";
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

// badgeAria spells the status out. For approved and pending the visible text is
// only the count, so the status would otherwise be carried by colour and icon.
function badgeAria(status: ApprovalStatus, approved?: number, total?: number) {
  const label = `Approval ${STATUS_BADGE[status].label.toLowerCase()}`;
  return total ? `${label}: ${approved ?? 0} of ${total} approved` : label;
}

// ApprovalStatusBadge is the compact aggregate-status chip. Hidden entirely
// when the document has no assigned approvers. A narrow badge shows only the
// icon and the count below the sm breakpoint, so the title keeps its space.
export function ApprovalStatusBadge({
  status,
  approved,
  total,
  narrow = false,
  className = "",
}: {
  status?: ApprovalStatus;
  approved?: number;
  total?: number;
  narrow?: boolean;
  className?: string;
}) {
  if (!status) return null;
  const { Icon, variant } = STATUS_BADGE[status];
  const text = badgeText(status, approved, total);
  return (
    <Badge variant={variant} className={`shrink-0 gap-1 ${className}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {narrow ? (
        <>
          {total ? (
            <span className="tabular-nums sm:hidden">
              {approved ?? 0}/{total}
            </span>
          ) : null}
          <span className="hidden sm:inline">{text}</span>
        </>
      ) : (
        text
      )}
    </Badge>
  );
}

// ApprovalsDialog is the document bar's entry point into approvals: the status
// chip is the trigger, so a reader who sees "Pending 0/1" can click straight
// through to who still owes a decision. Approvals live here rather than in the
// comments sidebar — they are a different concern from discussion.
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
  const { docId, version } = useDoc();
  const doc = useQuery({
    queryKey: queryKeys.document(docId),
    queryFn: () => api.getDocument(docId),
  });
  // The props describe the document's *current* version. When an older
  // version is on screen the dialog lists that version's decisions, so the
  // chip has to be scoped the same way or the two contradict each other.
  const latest = doc.data?.current_version_id;
  const viewingOlder = !!version && !!latest && version !== latest;
  const scoped = useQuery({
    queryKey: queryKeys.approvals(docId, version),
    queryFn: () => api.listApprovals(docId, version),
    enabled: !!docId && viewingOlder,
  });
  // Fall back to the document-level numbers until the scoped ones land, so
  // the chip does not blink out while an older version loads.
  const shownStatus = (viewingOlder ? scoped.data?.status : status) ?? status;
  const shownApproved =
    (viewingOlder ? scoped.data?.summary.approved : approved) ?? approved;
  const shownTotal = (viewingOlder ? scoped.data?.summary.total : total) ?? total;

  // With no approvers the API omits the status entirely. The owner still
  // needs a way in, because this dialog is the only place approvers can be
  // assigned; without a trigger the first approver could never be added. It is
  // a real button, not a chip: asking for a review is the point of the feature.
  if (!shownStatus) {
    if (!isOwner) return null;
    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          {/* On a phone only the icon shows, so it looks like the other icons
              of the bar and not like a pressed toggle. */}
          <Button
            variant="outline"
            size="sm"
            className="hidden shrink-0 xs:inline-flex max-sm:bg-transparent max-sm:shadow-none"
            aria-label="Request approval"
          >
            <ClipboardCheck className="h-4 w-4" />
            <span className="hidden sm:inline">Request approval</span>
          </Button>
        </DialogTrigger>
        <ApprovalsDialogBody onClose={() => setOpen(false)} />
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* The pseudo-element makes a 40px tall target. */}
        <button
          type="button"
          aria-label={`${badgeAria(shownStatus, shownApproved, shownTotal)}. Open approvals`}
          className="relative hidden shrink-0 rounded-full transition-transform xs:block duration-150 ease-out active:scale-[0.97] after:absolute after:inset-x-0 after:-inset-y-2"
        >
          <ApprovalStatusBadge
            status={shownStatus}
            approved={shownApproved}
            total={shownTotal}
            narrow
            className="cursor-pointer hover:opacity-90"
          />
        </button>
      </DialogTrigger>
      <ApprovalsDialogBody onClose={() => setOpen(false)} />
    </Dialog>
  );
}

function ApprovalsDialogBody({ onClose }: { onClose: () => void }) {
  return (
    <DialogContent
      anchor="top"
      className="max-w-lg overflow-hidden p-0"
      aria-describedby={undefined}
    >
      {/* The content has no padding, so the lists run edge to edge. */}
      <DialogHeader className="px-6 pt-6">
        <DialogTitle>Approvals</DialogTitle>
      </DialogHeader>
      <Approvals onClose={onClose} />
    </DialogContent>
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

// ReviewActions is the signed-in approver's own controls: Approve, Reject and
// Revoke. It renders nothing for anyone else, or while an older version is on
// screen. It lives
// only in the approvals dialog, beside the approver's own row, so the decision
// and what it currently says are read together.
export function ReviewActions({
  className,
  onNavigate,
}: {
  className?: string;
  // Called when the reader jumps to a comment, so a surrounding dialog can close.
  onNavigate?: () => void;
}) {
  const { docId, version, principal, comments, setActiveComment } = useDoc();
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
  const decide = useMutation({
    mutationFn: (input: { decision: ApprovalDecision; note?: string }) =>
      api.createApproval(docId, version, input.decision, input.note),
    onSuccess: (a) => {
      toast.success(a.decision === "approved" ? "Approved." : "Rejected.");
      setRejectOpen(false);
      setConfirmApprove(false);
      invalidate();
    },
    onError: (e) => {
      toast.error(errorMessage(e, "Could not record decision"));
      // A newer version may have been pushed while this one was open: reload
      // the document and decisions so the next click is on the latest one.
      invalidate();
    },
  });
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
  if (!own || !isCurrentVersion) return null;

  const allResolved =
    own.decision === "rejected" &&
    (own.comments_total ?? 0) > 0 &&
    (own.comments_open ?? 0) === 0;
  const plural = mine.length === 1 ? "comment" : "comments";

  return (
    <div className={className}>
      {allResolved ? (
        <p className="mb-2 text-xs text-[var(--color-fg-muted)]">
          All your comments are resolved. Ready to approve?
        </p>
      ) : null}
      {confirmApprove ? (
        <div className="space-y-2">
          <p className="text-xs">
            You have {mine.length} open {plural}. Approve anyway?
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ decision: "approved" })}
            >
              <Check className="h-3.5 w-3.5" /> Approve anyway
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={decide.isPending}
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
              disabled={decide.isPending}
              onClick={() =>
                mine.length > 0
                  ? setConfirmApprove(true)
                  : decide.mutate({ decision: "approved" })
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
              disabled={decide.isPending}
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
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(own.id!)}
            >
              Revoke
            </Button>
          ) : null}
        </div>
      )}
      <RejectDialog
        open={rejectOpen}
        onOpenChange={setRejectOpen}
        comments={mine}
        pending={decide.isPending}
        onSubmit={(note) =>
          decide.mutate({ decision: "rejected", note: note || undefined })
        }
        onJump={(id) => {
          setRejectOpen(false);
          onNavigate?.();
          setActiveComment(id);
        }}
      />
    </div>
  );
}

// RejectDialog lists the reviewer's open comments, which go with the
// rejection, and takes an optional reason. With no comments the reason is
// required: a bare rejection tells the author nothing.
function RejectDialog({
  open,
  onOpenChange,
  comments,
  pending,
  onSubmit,
  onJump,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  comments: Comment[];
  pending: boolean;
  onSubmit: (note: string) => void;
  onJump: (commentId: string) => void;
}) {
  const [note, setNote] = useState("");
  useEffect(() => {
    if (!open) setNote("");
  }, [open]);
  const hasComments = comments.length > 0;
  const canSubmit = !pending && (hasComments || note.trim().length > 0);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-lg overflow-hidden p-0"
        aria-describedby={undefined}
      >
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Reject</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) onSubmit(note.trim());
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
              value={note}
              onChange={(e) => setNote(e.target.value)}
              maxLength={2000}
              placeholder={
                hasComments ? "Reason (optional)" : "Why are you rejecting this?"
              }
              aria-label="Reason"
              className="min-h-[72px] text-xs"
            />
            <div className="flex gap-2">
              <Button size="sm" type="submit" variant="danger" disabled={!canSubmit}>
                Reject
              </Button>
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
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

  const summary = approvals.data?.summary;

  return (
    <div className="flex max-h-[70vh] flex-col">
      <div className="flex min-h-9 items-center justify-between gap-2 border-b border-[var(--color-border)] px-6 pb-3">
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
        ) : approvals.data.items.length === 0 ? (
          isOwner ? (
            <p className="px-2 text-xs text-[var(--color-fg-muted)]">
              Add someone who has not worked on this document to request a review.
            </p>
          ) : null
        ) : (
          approvals.data.items.map((item) => (
            <ApproverRow
              key={item.approver.type + ":" + item.approver.id}
              item={item}
              docId={docId}
              isOwner={isOwner}
              current={isCurrentVersion}
              onChanged={invalidate}
            />
          ))
        )}
      </div>
      <ReviewActions
        className="border-t border-[var(--color-border)] px-6 py-3"
        onNavigate={onClose}
      />
      {isOwner ? <AddApprover docId={docId} onAdded={invalidate} /> : null}
    </div>
  );
}

function ApproverRow({
  item,
  docId,
  isOwner,
  current,
  onChanged,
}: {
  item: ApprovalListItem;
  docId: string;
  isOwner: boolean;
  // The list is about the current version.
  current: boolean;
  onChanged: () => void;
}) {
  const approvers = useQuery({
    queryKey: queryKeys.approvers(docId),
    queryFn: () => api.listApprovers(docId),
    enabled: isOwner,
    staleTime: 30_000,
  });
  const remove = useMutation({
    mutationFn: (approverId: string) => api.deleteApprover(docId, approverId),
    onSuccess: () => {
      onChanged();
    },
    onError: (e) => toast.error(errorMessage(e, "Could not remove approver")),
  });
  const request = approvers.data?.items.find((r) =>
    samePrincipal(r.approver, item.approver),
  );
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
      {isOwner && request ? (
        <Button
          size="icon"
          variant="ghost"
          className={cn("h-6 w-6 transition-opacity", revealOnHover)}
          aria-label={`Remove ${label} as approver`}
          disabled={remove.isPending}
          onClick={() => remove.mutate(request.id)}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

// AddApprover assigns an approver. Its errors show under the field. A person
// who cannot open the document can be shared with as a viewer and added in
// one step.
function AddApprover({ docId, onAdded }: { docId: string; onAdded: () => void }) {
  const q = useQueryClient();
  const [address, setAddress] = useState("");
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
  const add = useMutation({
    mutationFn: async ({ addr, share }: { addr: string; share?: boolean }) => {
      if (share) await api.createGrant(docId, addr, "viewer");
      return api.createApprover(docId, addr);
    },
    onSuccess: (_, { share }) => {
      setAddress("");
      if (share) q.invalidateQueries({ queryKey: queryKeys.documentAccess(docId) });
      onAdded();
    },
    onError: () => {},
  });
  const noAccess =
    add.error instanceof APIError && add.error.code === "approver_no_access";
  const trimmed = address.trim();
  const options = (suggestions.data?.items || [])
    .filter((u) => u.email !== trimmed)
    .slice(0, 5)
    .map((u) => ({
      key: u.id,
      name: u.name || u.email || u.id,
      detail: u.name ? u.email : undefined,
      address: u.email || "",
      icon: <PersonAvatar who={u} size={24} />,
    }));
  return (
    <form
      className="border-t border-[var(--color-border)] px-6 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        // Send the raw address so the server resolves either a user email or a
        // service-account (bot) address; assuming "user" here made bot
        // approvers impossible to assign from the UI.
        if (ADDRESS_PATTERN.test(trimmed)) add.mutate({ addr: trimmed });
      }}
    >
      <div className="flex gap-2">
        <div className="flex-1">
          <Combobox
            aria-label="Approver"
            placeholder="Email or bot address"
            aria-invalid={!!add.error || undefined}
            value={address}
            onValueChange={(next) => {
              setAddress(next);
              add.reset();
            }}
            options={options}
            onPick={(u) => setAddress(u.address)}
            listAbove
          />
        </div>
        <Button
          type="submit"
          disabled={!ADDRESS_PATTERN.test(trimmed) || add.isPending}
        >
          Add
        </Button>
      </div>
      {add.error ? (
        <div className="mt-1.5 flex items-start gap-2">
          <p role="alert" className="text-xs text-[var(--color-danger)]">
            {errorMessage(add.error, "Could not assign approver.")}
          </p>
          {noAccess ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              disabled={add.isPending}
              onClick={() => add.mutate({ addr: trimmed, share: true })}
            >
              Share as viewer and add
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="mt-1.5 text-xs text-[var(--color-fg-muted)]">
          Approvers need access to this document. Anyone who edited it, in the browser,
          by upload, or by an agent, can&apos;t approve it. This includes you. An edit
          that its author undid does not count.
        </p>
      )}
    </form>
  );
}
