import { useQuery } from "@tanstack/react-query";
import { api, type ApprovalStatus } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { loadFailed } from "@/lib/query-retry";
import { useDoc } from "./doc-context";

type Approvals = { status?: ApprovalStatus; approved?: number; total?: number };

// The status of an older version is loading, or did not load.
type ShownApprovals = Approvals & { pending?: boolean; failed?: boolean };

// useShownApprovals is the approval status of the version on screen. The
// document gives the status of its current version. An older version has its
// own, so it loads, and until then it is unknown: the current counts would be
// false for it.
export function useShownApprovals(current: Approvals): ShownApprovals {
  const { docId, version } = useDoc();
  const doc = useQuery({
    queryKey: queryKeys.document(docId),
    queryFn: () => api.getDocument(docId),
  });
  const latest = doc.data?.current_version_id;
  const older = !!version && !!latest && version !== latest;
  const scoped = useQuery({
    queryKey: queryKeys.approvals(docId, version),
    queryFn: () => api.listApprovals(docId, version),
    enabled: !!docId && older,
  });
  // Until the document loads, it is not known which version is on screen.
  if (doc.isPending) return { pending: true };
  if (!older) return current;
  const failed = loadFailed(scoped);
  return {
    status: scoped.data?.status,
    approved: scoped.data?.summary.approved,
    total: scoped.data?.summary.total,
    pending: !scoped.data && !failed,
    failed,
  };
}
