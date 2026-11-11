import { useCallback, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queryKeys";
import { useInvalidateApprovals } from "./use-invalidate-approvals";

// Live typing makes a version about each second. The lists refresh at most
// this often while the changes come.
const REFRESH_MS = 2_000;

// useRefreshLists gives the function to call on each change of a document.
// It refreshes what lists the versions of the document and their approvals:
// at once for the first change, and then at most each REFRESH_MS. The last
// change always refreshes.
export function useRefreshLists(docId: string) {
  const q = useQueryClient();
  const invalidateApprovals = useInvalidateApprovals(docId);
  const refresh = useRef(() => {});
  refresh.current = () => {
    invalidateApprovals();
    q.invalidateQueries({ queryKey: queryKeys.versions(docId) });
  };
  const last = useRef(0);
  const timer = useRef<number | undefined>(undefined);
  const run = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    last.current = Date.now();
    refresh.current();
  }, []);
  // A refresh that waits when the page goes runs then.
  useEffect(() => () => void (timer.current !== undefined && run()), [run]);
  return useCallback(() => {
    const wait = last.current + REFRESH_MS - Date.now();
    if (wait <= 0) run();
    else timer.current ??= window.setTimeout(run, wait);
  }, [run]);
}
