import type { Comment } from "@/api";

// inDocumentOrder sorts threads by where the document shows them, top first.
// The threads that it does not show, as those whose text is gone, come last,
// in the order that they had.
export function inDocumentOrder<T extends Pick<Comment, "id">>(
  threads: T[],
  positions: ReadonlyMap<string, { top: number }>,
): T[] {
  const top = (c: T) => positions.get(c.id)?.top ?? Infinity;
  return [...threads].sort((a, b) => top(a) - top(b) || 0);
}

// nextThread gives the thread after `from` in order, or before it for a step
// of -1. It goes round from the end to the start. With no `from`, it starts
// at the first thread, or the last for a step of -1.
export function nextThread<T extends Pick<Comment, "id">>(
  order: T[],
  from: string | undefined,
  step: 1 | -1,
): string | undefined {
  const n = order.length;
  const at = order.findIndex((c) => c.id === from);
  const start = at >= 0 ? at : step > 0 ? -1 : n;
  return order[(((start + step) % n) + n) % n]?.id;
}
