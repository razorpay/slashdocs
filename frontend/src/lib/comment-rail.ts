export type CommentRailItem = {
  id: string;
  anchorTop: number;
  height: number;
  atStart?: boolean;
};

export type CommentRailPlacement = CommentRailItem & { y: number };

export type CommentRailLayoutOptions = {
  padding?: number;
  gap?: number;
  priorityId?: string;
  viewport?: { top: number; height: number };
};

// Places unanchored cards at the start of the document timeline, then anchored
// cards near their highlight. Cards are pushed down only enough to avoid overlap.
export function layoutCommentRail(
  items: CommentRailItem[],
  contentHeight: number,
  options: CommentRailLayoutOptions = {},
): CommentRailPlacement[] {
  const padding = options.padding ?? 12;
  const gap = options.gap ?? 12;
  const atStart = items.filter((item) => item.atStart);
  const anchored = items
    .filter((item) => !item.atStart)
    .sort((a, b) => a.anchorTop - b.anchorTop || a.id.localeCompare(b.id));
  const ordered = [...atStart, ...anchored];
  const priority = anchored.find((item) => item.id === options.priorityId);
  let reserved: CommentRailPlacement | undefined;
  if (priority) {
    const height = Math.max(1, priority.height);
    let y = Math.max(padding, priority.anchorTop);
    const viewport = options.viewport;
    // Keep the active box beside a visible highlight, shifting it upward only
    // enough to fit. It should still scroll away when its highlight does.
    if (viewport && y >= viewport.top && y < viewport.top + viewport.height) {
      const minY = viewport.top + padding;
      const maxY = Math.max(minY, viewport.top + viewport.height - padding - height);
      y = Math.max(minY, Math.min(y, maxY));
    }
    reserved = { ...priority, y };
  }

  const placements: CommentRailPlacement[] = reserved ? [reserved] : [];
  let cursor = padding;
  for (const item of ordered) {
    if (item.id === reserved?.id) continue;
    const height = Math.max(1, item.height);
    const maxY = Math.max(cursor, contentHeight - padding - height);
    const desired = item.atStart
      ? cursor
      : Math.min(maxY, Math.max(padding, item.anchorTop));
    let y = Math.max(cursor, desired);
    // Reserve the focused item's space first. Nearby cards that cannot fit
    // above it move below it, rather than pushing the focused item offscreen.
    if (
      reserved &&
      y < reserved.y + reserved.height + gap &&
      y + height + gap > reserved.y
    ) {
      y = reserved.y + Math.max(1, reserved.height) + gap;
    }
    placements.push({ ...item, y });
    cursor = y + height + gap;
  }
  if (reserved) placements.sort((a, b) => a.y - b.y);

  return placements;
}

export type CommentTicksInput = {
  ids: string[];
  positions: ReadonlyMap<string, { top: number }>;
  scrollHeight: number;
  viewportHeight: number;
  topInset: number;
};

// Where each thread sits in the document, as a fraction (0-1) of the rail
// timeline, in document order. Uses the same coordinates as layoutCommentRail.
// Returns null when there is nothing worth marking: no positioned thread, or a
// document that already fits on screen.
export function commentTicks({
  ids,
  positions,
  scrollHeight,
  viewportHeight,
  topInset,
}: CommentTicksInput): { id: string; y: number }[] | null {
  const timeline = scrollHeight - topInset;
  if (timeline <= viewportHeight) return null;
  const ticks = ids
    .flatMap((id) => {
      const position = positions.get(id);
      return position ? [{ id, top: position.top }] : [];
    })
    .sort((a, b) => a.top - b.top || a.id.localeCompare(b.id))
    .map(({ id, top }) => ({
      id,
      y: Math.min(1, Math.max(0, (top - topInset) / timeline)),
    }));
  return ticks.length > 0 ? ticks : null;
}
