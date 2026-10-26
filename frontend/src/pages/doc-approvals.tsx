import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, CircleDashed, ClipboardCheck, X } from "lucide-react";

import {
  api,
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
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/queryKeys";
import { samePrincipal } from "@/lib/principals";
import { useDoc } from "./doc-context";

const STATUS_BADGE: Record<
  ApprovalStatus,
  { label: string; variant: "success" | "warning" | "danger" }
> = {
  approved: { label: "Approved", variant: "success" },
  pending: { label: "Pending", variant: "warning" },
  changes_requested: { label: "Changes requested", variant: "danger" },
};

// badgeText always names the subject. A bare "Pending (0/1)" chip in the
// document bar does not say what the count is about.
function badgeText(status: ApprovalStatus, approved?: number, total?: number) {
  const { label } = STATUS_BADGE[status];
  if (status === "pending" && total) {
    return `Approvals: ${label} ${approved ?? 0}/${total}`;
  }
  return `Approvals: ${label}`;
}

// ApprovalStatusBadge is the compact aggregate-status chip. Hidden entirely
// when the document has no assigned approvers.
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
  return (
    <Badge variant={STATUS_BADGE[status].variant} className="shrink-0">
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
        <ApprovalsDialogBody />
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          aria-label={`${badgeText(shownStatus, shownApproved, shownTotal)}. Open approvals`}
          className="shrink-0 rounded-full transition-transform duration-150 ease-out active:scale-[0.97] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
        >
          <Badge
            variant={STATUS_BADGE[shownStatus].variant}
            className="cursor-pointer hover:opacity-90"
          >
            {badgeText(shownStatus, shownApproved, shownTotal)}
          </Badge>
        </button>
      </DialogTrigger>
      <ApprovalsDialogBody />
    </Dialog>
  );
}

function ApprovalsDialogBody() {
  return (
    <DialogContent className="max-w-lg overflow-hidden p-0">
      <DialogHeader className="mb-0 border-b border-[var(--color-border)] px-5 py-4">
        <DialogTitle className="text-sm font-semibold">Approvals</DialogTitle>
        <DialogDescription>
          Who has signed off on the version you are viewing. Changing the document
          clears approvals, so approvers review the new version. Requesting changes
          needs a note.
        </DialogDescription>
      </DialogHeader>
      <Approvals />
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
        <X className="h-3.5 w-3.5" /> Changes requested
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-[var(--color-fg-muted)]">
      <CircleDashed className="h-3.5 w-3.5" /> Pending
    </span>
  );
}

// Approvals renders the per-approver decision list for the version being
// viewed, with decision actions for the signed-in approver and assignment
// controls for the owner.
export function Approvals() {
  const { docId, version, principal } = useDoc();
  const q = useQueryClient();
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState("");
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

  const invalidate = () => {
    q.invalidateQueries({ queryKey: queryKeys.approvalsAll(docId) });
    q.invalidateQueries({ queryKey: queryKeys.approvers(docId) });
    q.invalidateQueries({ queryKey: queryKeys.document(docId) });
    q.invalidateQueries({ queryKey: queryKeys.documents() });
  };

  const decide = useMutation({
    mutationFn: (input: { decision: ApprovalDecision; note?: string }) =>
      api.createApproval(docId, version, input.decision, input.note),
    onSuccess: (a) => {
      toast.success(a.decision === "approved" ? "Approved." : "Changes requested.");
      setNoteOpen(false);
      setNote("");
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

  const items = approvals.data?.items || [];
  const summary = approvals.data?.summary;
  const own = items.find((item) => samePrincipal(item.approver, principal));

  return (
    <div className="flex max-h-[70vh] flex-col">
      <div className="border-b border-[var(--color-border)] px-5 py-3">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs text-[var(--color-fg-muted)]">
            {summary?.total
              ? `${summary.approved}/${summary.total} approved`
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
      {own && !own.created_version && isCurrentVersion ? (
        <div className="border-t border-[var(--color-border)] p-3">
          {noteOpen ? (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (note.trim()) {
                  decide.mutate({ decision: "changes_requested", note: note.trim() });
                }
              }}
            >
              <Textarea
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={2000}
                placeholder="What needs to change?"
                className="min-h-[72px] text-xs"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  type="submit"
                  disabled={!note.trim() || decide.isPending}
                >
                  Request changes
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  type="button"
                  onClick={() => {
                    setNoteOpen(false);
                    setNote("");
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          ) : (
            <div className="flex gap-2">
              {own.decision !== "approved" ? (
                <Button
                  size="sm"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ decision: "approved" })}
                >
                  <Check className="h-3.5 w-3.5" /> Approve
                </Button>
              ) : null}
              {own.decision !== "changes_requested" ? (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={decide.isPending}
                  onClick={() => setNoteOpen(true)}
                >
                  Request changes
                </Button>
              ) : null}
              {own.decision && own.id ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(own.id!)}
                >
                  Revoke
                </Button>
              ) : null}
            </div>
          )}
        </div>
      ) : null}
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
