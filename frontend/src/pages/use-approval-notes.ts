import { useCallback, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Principal } from "@/api";
import { principalNames, samePrincipal } from "@/lib/principals";
import { queryKeys } from "@/lib/queryKeys";

const APPROVALS_TOAST = "live-text-approvals";

// useApprovalNotes tells an editor what their change does to the approvals
// of the document, as it is about more than the words. Without approvers,
// it says nothing.
export function useApprovalNotes(docId: string) {
  // Set when the document has approvers, whose approvals an edit resets.
  const reviewed = useRef(false);
  reviewed.current = !!useQuery({
    queryKey: queryKeys.document(docId),
    queryFn: () => api.getDocument(docId),
  }).data?.approval_status;
  // The version whose approvers the editor was told about.
  const noted = useRef<string | undefined>(undefined);

  // The approvers whose approval counts on a version.
  const approvedOn = useCallback(
    async (version: string): Promise<Principal[]> => {
      if (!reviewed.current) return [];
      try {
        const { items } = await api.listApprovals(docId, version);
        return items.filter((i) => i.decision === "approved").map((i) => i.approver);
      } catch {
        return [];
      }
    },
    [docId],
  );

  // Before the first key on an approved version, the editor learns that a
  // change asks its approvers to approve again. They learn it once for each
  // version that has approvals.
  const beforeEdit = useCallback(
    async (version: string) => {
      if (noted.current === version) return;
      noted.current = version;
      const approvers = await approvedOn(version);
      if (approvers.length)
        toast.info(`Your change asks ${principalNames(approvers)} to approve again.`, {
          id: APPROVALS_TOAST,
        });
    },
    [approvedOn],
  );

  // The first operation after a version that has approvals starts a new
  // version, which resets them, or gives them back.
  const afterEdit = useCallback(
    async (before: string, after: string) => {
      if (before === after) return;
      const [was, now] = await Promise.all([approvedOn(before), approvedOn(after)]);
      const without = (a: Principal[], b: Principal[]) =>
        a.filter((p) => !b.some((other) => samePrincipal(p, other)));
      const note = [
        approvalsText(without(was, now), "reset"),
        approvalsText(without(now, was), "restored"),
      ]
        .filter(Boolean)
        .join(" ");
      if (note) toast.info(note, { id: APPROVALS_TOAST });
    },
    [approvedOn],
  );

  return { beforeEdit, afterEdit };
}

// approvalsText says that the approvals of people are reset or restored.
function approvalsText(people: Principal[], change: "reset" | "restored") {
  if (!people.length) return "";
  const many = people.length > 1;
  return `The ${many ? "approvals" : "approval"} of ${principalNames(people)} ${many ? "are" : "is"} ${change}.`;
}
