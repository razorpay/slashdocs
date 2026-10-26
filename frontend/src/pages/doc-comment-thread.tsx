import { X } from "lucide-react";
import type { Comment } from "@/api";
import { COMMENT_STATUS } from "@/lib/constants";
import { Button } from "@/components/ui/button";
import { useDoc } from "./doc-context";
import {
  Message,
  MoreMenu,
  ReplyRow,
  Replies,
  ResolveButton,
} from "./doc-comment-parts";

// ThreadPopover is a whole thread, for the popover beside its pin: a header
// with the thread's actions, its first comment with the replies set in under
// it, and the reply field.
export function ThreadPopover({
  c,
  docId,
  onClose,
}: {
  c: Comment;
  docId: string;
  onClose: () => void;
}) {
  const { signIn } = useDoc();
  const resolved = c.status === COMMENT_STATUS.resolved;
  return (
    <div data-thread={c.id}>
      <div className="flex items-center gap-0.5 border-b border-[var(--color-border)] py-1.5 pl-3 pr-1.5">
        <span className="flex-1 text-sm font-semibold">
          {resolved ? "Resolved comment" : "Comment"}
        </span>
        <MoreMenu c={c} docId={docId} thread />
        {!signIn ? <ResolveButton c={c} docId={docId} /> : null}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close comment"
          onClick={onClose}
          className="h-8 w-8 shrink-0 text-[var(--color-fg-muted)]"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
      <div className="max-h-[50vh] overflow-y-auto px-3 py-3">
        <Message c={c} docId={docId} thread />
        <Replies c={c} docId={docId} />
      </div>
      {/* Pinned under the messages, at the replies' level. */}
      <ReplyRow c={c} docId={docId} className="border-0 pb-3 pl-10 pt-1" />
    </div>
  );
}
