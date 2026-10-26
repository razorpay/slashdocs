import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, CircleDashed, ClipboardCheck, X } from "lucide-react";

import {
  api,
  type Comment,
  type ApprovalDecision,
  type ApprovalListItem,
  type ApprovalStatus,
} from "@/api";
import { Avatar } from "@/components/ui/misc";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { COMMENT_STATUS } from "@/lib/constants";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/queryKeys";
import { samePrincipal } from "@/lib/principals";
import { useDoc } from "./doc-context";

const STATUS_BADGE: Record<
  ApprovalStatus,
  { label: string; variant: "success" | "warning" | "danger"; Icon: typeof Check }
> = {
  approved: { label: "Approved", variant: "success", Icon: Check },
  pending: { label: "Pending", variant: "warning", Icon: CircleDashed },
  changes_requested: { label: "Rejected", variant: "danger", Icon: X },
};

// badgeText leads with how many approvers have approved ("2 of 3 approved"):
// the count is the useful part, and a bare "Approved" does not say who. When
// someone rejected it, that comes first, because it blocks the rest.
function badgeText(status: ApprovalStatus, approved?: number, total?: number) {
  const counts = total ? `${approved ?? 0} of ${total} approved` : "";
  if (status === "changes_requested") {
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
// when the document has no assigned approvers.
export function ApprovalStatusBadge({
  status,
  approved,
  total,
  className = "",
}: {
  status?: ApprovalStatus;
  approved?: number;
  total?: number;
  className?: string;
}) {
  if (!status) return null;
  const { Icon, variant } = STATUS_BADGE[status];
  return (
    <Badge variant={variant} className={`shrink-0 gap-1 ${className}`}>
      <Icon className="h-3 w-3" aria-hidden="true" />
      {badgeText(status, approved, total)}
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
}: {
  status?: ApprovalStatus;
  approved?: number;
  total?: number;
  isOwner: boolean;
}) {
  const { docId, version } = useDoc();
  const [open, setOpen] = useState(false);
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
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
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
        <button
          type="button"
          aria-label={`${badgeAria(shownStatus, shownApproved, shownTotal)}. Open approvals`}
          className="shrink-0 rounded-full transition-transform duration-150 ease-out active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
        >
          <ApprovalStatusBadge
            status={shownStatus}
            approved={shownApproved}
            total={shownTotal}
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
      className="max-w-lg overflow-hidden p-0"
      aria-describedby={undefined}
    >
      <DialogHeader className="mb-0 border-b border-[var(--color-border)] px-5 py-4">
        <DialogTitle className="text-sm font-semibold">Approvals</DialogTitle>
      </DialogHeader>
      <Approvals onClose={onClose} />
    </DialogContent>
  );
}

// carriedSuffix names the version that received the explicit decision, so a
// carried approval reads "Approved on v3" rather than an opaque note that
// something was carried forward from somewhere.
function carriedSuffix(item: ApprovalListItem) {
  if (!item.carried_from_version_id) return null;
  return (
    <span className="font-normal text-[var(--color-fg-muted)]">
      {item.carried_from_version_number
        ? ` on v${item.carried_from_version_number}`
        : " (carried forward)"}
    </span>
  );
}

function decisionLabel(item: ApprovalListItem) {
  if (item.decision === "approved") {
    return (
      <span className="flex items-center gap-1 text-xs font-medium text-green-700 dark:text-green-300">
        <Check className="h-3.5 w-3.5" /> Approved
        {carriedSuffix(item)}
      </span>
    );
  }
  if (item.decision === "changes_requested") {
    return (
      <span className="flex items-center gap-1 text-xs font-medium text-red-700 dark:text-red-300">
        <X className="h-3.5 w-3.5" /> Rejected
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-[var(--color-fg-muted)]">
      <CircleDashed className="h-3.5 w-3.5" /> Pending
    </span>
  );
}

function useInvalidateApprovals(docId: string) {
  const q = useQueryClient();
  return () => {
    q.invalidateQueries({ queryKey: queryKeys.approvalsAll(docId) });
    q.invalidateQueries({ queryKey: queryKeys.approvers(docId) });
    q.invalidateQueries({ queryKey: queryKeys.document(docId) });
    q.invalidateQueries({ queryKey: queryKeys.documents() });
  };
}

// ReviewActions is the signed-in approver's own controls: Approve, Reject and
// Revoke. It renders nothing for anyone else, for an approver who created a
// version (they cannot decide), or while an older version is on screen. It lives
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
  const [requestOpen, setRequestOpen] = useState(false);
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
      setRequestOpen(false);
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
  if (!own || own.created_version || !isCurrentVersion) return null;

  const allResolved =
    own.decision === "changes_requested" &&
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
            <Button
              size="sm"
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
          {own.decision !== "changes_requested" ? (
            <Button
              size="sm"
              variant="danger"
              disabled={decide.isPending}
              onClick={() => setRequestOpen(true)}
            >
              Reject
            </Button>
          ) : null}
          {own.decision && own.id ? (
            <Button
              size="sm"
              variant="danger"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate(own.id!)}
            >
              Revoke
            </Button>
          ) : null}
        </div>
      )}
      <RejectDialog
        open={requestOpen}
        onOpenChange={setRequestOpen}
        comments={mine}
        pending={decide.isPending}
        onSubmit={(note) =>
          decide.mutate({ decision: "changes_requested", note: note || undefined })
        }
        onJump={(id) => {
          setRequestOpen(false);
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
        <DialogHeader className="mb-0 border-b border-[var(--color-border)] px-5 py-4">
          <DialogTitle className="text-sm font-semibold">Reject</DialogTitle>
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
                      className="w-full rounded-md px-1.5 py-1.5 text-left hover:bg-[var(--color-surface-muted)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
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

  const items = approvals.data?.items || [];
  const summary = approvals.data?.summary;
  const own = items.find((item) => samePrincipal(item.approver, principal));

  return (
    <div className="flex max-h-[70vh] flex-col">
      <div className="border-b border-[var(--color-border)] px-5 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-[var(--color-fg-muted)]">
            {summary?.total
              ? approvals.data?.version_number
                ? `On version ${approvals.data.version_number}`
                : "On this version"
              : "No approvers assigned"}
          </p>
          <ApprovalStatusBadge
            status={approvals.data?.status}
            approved={summary?.approved}
            total={summary?.total}
          />
        </div>
        {!isCurrentVersion ? (
          <p className="mt-1 text-[11px] text-[var(--color-fg-muted)]">
            Viewing decisions on an older version.
          </p>
        ) : null}
      </div>
      <div className="flex-1 space-y-1 overflow-y-auto p-3">
        {approvals.isLoading ? (
          <p className="px-1 text-xs text-[var(--color-fg-muted)]">Loading…</p>
        ) : items.length === 0 ? (
          <p className="px-1 text-xs text-[var(--color-fg-muted)]">
            No approvers yet.
            {isOwner
              ? " Add someone who has not worked on this document to request a review."
              : ""}
          </p>
        ) : (
          items.map((item) => (
            <ApproverRow
              key={item.approver.type + ":" + item.approver.id}
              item={item}
              docId={docId}
              isOwner={isOwner}
              onChanged={invalidate}
            />
          ))
        )}
      </div>
      {own?.created_version ? (
        <p className="border-t border-[var(--color-border)] p-3 text-xs text-[var(--color-fg-muted)]">
          You created a version of this document, so you can&apos;t approve it. Ask the
          owner to assign someone else.
        </p>
      ) : null}
      <ReviewActions
        className="border-t border-[var(--color-border)] p-3"
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
  onChanged,
}: {
  item: ApprovalListItem;
  docId: string;
  isOwner: boolean;
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
      toast.success("Approver removed.");
      onChanged();
    },
    onError: (e) => toast.error(errorMessage(e, "Could not remove approver")),
  });
  const request = approvers.data?.items.find((r) =>
    samePrincipal(r.approver, item.approver),
  );
  const label = item.approver.name || item.approver.email || item.approver.id;
  return (
    <div className="group flex items-start gap-2 rounded-md px-1.5 py-1.5 hover:bg-[var(--color-surface-muted)]">
      <Avatar name={label} src={item.approver.picture_url} size={24} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-xs font-medium">{label}</div>
        {item.created_version ? (
          <span className="text-xs text-[var(--color-fg-muted)]">
            Created a version, can&apos;t approve
            {isOwner ? ". Remove them and ask someone else." : ""}
          </span>
        ) : (
          decisionLabel(item)
        )}
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
          className="h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100"
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

function AddApprover({ docId, onAdded }: { docId: string; onAdded: () => void }) {
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
    mutationFn: (addr: string) => api.createApprover(docId, addr),
    onSuccess: () => {
      setAddress("");
      toast.success("Approver assigned.");
      onAdded();
    },
    onError: (e) => toast.error(errorMessage(e, "Could not assign approver")),
  });
  const items = suggestions.data?.items || [];
  return (
    <form
      className="border-t border-[var(--color-border)] p-3"
      onSubmit={(e) => {
        e.preventDefault();
        // Send the raw address so the server resolves either a user email or a
        // service-account (bot) address; assuming "user" here made bot
        // approvers impossible to assign from the UI.
        if (address.trim()) add.mutate(address.trim());
      }}
    >
      <div className="flex gap-2">
        <Input
          placeholder="Add approver by email or bot address…"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className="h-8 text-xs"
        />
        <Button size="sm" type="submit" disabled={!address.trim() || add.isPending}>
          Add
        </Button>
      </div>
      <p className="mt-1.5 text-[11px] text-[var(--color-fg-muted)]">
        Approvers need access to this document. Anyone who has uploaded a version,
        including you if you published it, can&apos;t approve it.
      </p>
      {address && items.length > 0 ? (
        <div className="mt-1 overflow-hidden rounded-md border border-[var(--color-border)]">
          {items.slice(0, 5).map((u) => (
            <button
              key={u.id}
              type="button"
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-[var(--color-surface-muted)]"
              onClick={() => setAddress(u.email || "")}
            >
              <span className="font-medium">{u.name || u.email}</span>
              <span className="text-[var(--color-fg-muted)]">{u.email}</span>
            </button>
          ))}
        </div>
      ) : null}
    </form>
  );
}
