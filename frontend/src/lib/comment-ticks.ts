export type CommentTicksInput = {
  ids: string[];
  positions: ReadonlyMap<string, { top: number }>;
  scrollHeight: number;
  viewportHeight: number;
};

// Where each thread sits in the document, as a fraction (0-1) of its scroll
// height, in document order. Returns null when there is nothing worth
// marking: no positioned thread, or a document that already fits on screen.
export function commentTicks({
  ids,
  positions,
  scrollHeight,
  viewportHeight,
}: CommentTicksInput): { id: string; y: number }[] | null {
  if (scrollHeight <= viewportHeight) return null;
  const ticks = ids
    .flatMap((id) => {
      const position = positions.get(id);
      return position ? [{ id, top: position.top }] : [];
    })
    .sort((a, b) => a.top - b.top || a.id.localeCompare(b.id))
    .map(({ id, top }) => ({ id, y: Math.min(1, Math.max(0, top / scrollHeight)) }));
  return ticks.length > 0 ? ticks : null;
}
