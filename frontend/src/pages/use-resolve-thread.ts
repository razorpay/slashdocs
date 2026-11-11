import { useCallback, useState, type Dispatch, type SetStateAction } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, type Comment } from "@/api";
import { COMMENT_STATUS } from "@/lib/constants";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/queryKeys";

// The check of the Resolve button draws for this long, then the thread
// leaves: its popover, pin, highlight and list row go out for this long.
export const CHECK_MS = 200;
export const LEAVE_MS = 200;
// How long the toast offers Undo.
const UNDO_MS = 5000;

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

// useResolveThread resolves a thread with its exit: the check draws, the
// thread leaves, and a toast offers Undo, which reopens the thread and opens
// it again. `leaving` is the thread on its way out.
export function useResolveThread(
  docId: string,
  setActiveComment: Dispatch<SetStateAction<string | undefined>>,
) {
  const q = useQueryClient();
  const [leaving, setLeaving] = useState<string>();
  const resolveThread = useCallback(
    async (id: string) => {
      const key = queryKeys.comments(docId);
      const toastId = `resolved:${id}`;
      let undone = false;
      const setStatus = (status: string) =>
        q.setQueryData<{ items: Comment[] }>(
          key,
          (data) =>
            data && {
              ...data,
              items: data.items.map((c) => (c.id === id ? { ...c, status } : c)),
            },
        );
      // Each change shows at once, and the next load has the server's word.
      const save = (status: string) =>
        api.patchComment(docId, id, { status }).then(
          () => null,
          (e: unknown) => e,
        );
      const failed = (e: unknown) => {
        toast.error(errorMessage(e, "Could not update comment"), { id: toastId });
        return q.invalidateQueries({ queryKey: key });
      };
      const saved = save(COMMENT_STATUS.resolved);
      await sleep(CHECK_MS);
      setLeaving(id);
      setActiveComment((active) => (active === id ? undefined : active));
      toast("Resolved", {
        id: toastId,
        duration: UNDO_MS,
        action: {
          label: "Undo",
          onClick: async () => {
            undone = true;
            setStatus(COMMENT_STATUS.open);
            setActiveComment(id);
            const e = await save(COMMENT_STATUS.open);
            if (e) return failed(e);
            return q.invalidateQueries({ queryKey: key });
          },
        },
      });
      await sleep(LEAVE_MS);
      if (!undone) setStatus(COMMENT_STATUS.resolved);
      setLeaving((now) => (now === id ? undefined : now));
      const e = await saved;
      if (e) return failed(e);
      return q.invalidateQueries({ queryKey: key });
    },
    [docId, q, setActiveComment],
  );
  return { leaving, resolveThread };
}
