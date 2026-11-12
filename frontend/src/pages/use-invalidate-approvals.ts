import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";

// useInvalidateApprovals refreshes everything that shows the approval state
// of a document.
export function useInvalidateApprovals(docId: string) {
  const q = useQueryClient();
  return () => {
    q.invalidateQueries({ queryKey: queryKeys.approvalsAll(docId) });
    q.invalidateQueries({ queryKey: queryKeys.approvers(docId) });
    q.invalidateQueries({ queryKey: queryKeys.document(docId) });
    q.invalidateQueries({ queryKey: queryKeys.documents() });
    q.invalidateQueries({ queryKey: queryKeys.inbox() });
  };
}
