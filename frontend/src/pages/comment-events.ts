import type { Comment, DocumentKVEvent, Principal } from "@/api";
import { samePrincipal } from "@/lib/principals";

// The data of a comments event: the thread that changed, as it is now. It
// has no read state, which is the reader's own. A thread that is gone has no
// thread.
type CommentEvent = { id: string; thread?: Comment };

// withThread gives the comments with the change of a comments event. It
// gives undefined for an event with no thread data, as from an older server:
// the comments must then load again.
export function withThread(
  items: Comment[],
  event: DocumentKVEvent,
  reader?: Principal,
): Comment[] | undefined {
  const data = event.data as CommentEvent | undefined;
  if (!data?.id) return undefined;
  if (!data.thread) return items.filter((c) => c.id !== data.id);
  const before = items.find((c) => c.id === data.id);
  const thread = forReader(data.thread, before, reader);
  return before
    ? items.map((c) => (c.id === thread.id ? thread : c))
    : [...items, thread];
}

// forReader gives a thread the read state of the reader. They reacted where
// they are among the reactors. A message by someone else that the thread did
// not have before makes it unread, as the server does.
function forReader(thread: Comment, before?: Comment, reader?: Principal): Comment {
  const known = new Set(messages(before).map((m) => m.id));
  const reacted = (c: Comment): Comment => ({
    ...c,
    reactions: c.reactions?.map((r) => ({
      ...r,
      reacted: !!r.reactors?.some((p) => samePrincipal(p, reader)),
    })),
  });
  return {
    ...reacted(thread),
    replies: thread.replies?.map(reacted),
    unread:
      !!reader &&
      (!!before?.unread ||
        messages(thread).some(
          (m) => !known.has(m.id) && !samePrincipal(m.author, reader),
        )),
  };
}

const messages = (thread?: Comment) =>
  thread ? [thread, ...(thread.replies ?? [])] : [];
