import type { Principal, Version } from "@/api";
import { samePrincipal } from "@/lib/principals";

// Edits by one person less than this far apart read as one session.
export const HISTORY_SESSION_GAP_MS = 5 * 60_000;

// A session of the history: entries by one person, newest first.
export type HistorySession = { author?: Principal; entries: Version[] };

// historySessions groups a document's history, newest first, into sessions
// of one person's entries with no long pause between them. Edits save as
// people type, so each pause makes an entry; a session is what a person did
// in one sitting.
export function historySessions(
  versions: Version[],
  gapMs = HISTORY_SESSION_GAP_MS,
): HistorySession[] {
  const sessions: HistorySession[] = [];
  for (const v of [...versions].sort((a, b) => b.number - a.number)) {
    const session = sessions.at(-1);
    const later = session?.entries.at(-1);
    if (
      session &&
      later &&
      samePrincipal(later.created_by, v.created_by) &&
      createdAt(later) - createdAt(v) <= gapMs
    ) {
      session.entries.push(v);
    } else sessions.push({ author: v.created_by, entries: [v] });
  }
  return sessions;
}

const createdAt = (v: Version) => Date.parse(v.created_at || "") || 0;

// withoutUndone leaves out each run of edits by one person that ends on the
// content where it started, as Undo and Redo do: the edits of the run and the
// entry that ends it. The entry before the run stays, and it has the content
// of the run's end. The entries in keep stay, so that the entry on screen
// always shows.
export function withoutUndone(
  versions: Version[],
  keep: ReadonlySet<string>,
): Version[] {
  const kept: Version[] = [];
  for (const v of [...versions].sort((a, b) => a.number - b.number)) {
    const start = runStart(kept, v, keep);
    if (start < 0) kept.push(v);
    else kept.length = start + 1;
  }
  return kept;
}

// runStart finds the entry, before the newest of kept, that has the content
// of v, with only edits by v's author after it. It returns -1 when there is
// none.
function runStart(kept: Version[], v: Version, keep: ReadonlySet<string>) {
  if (!v.sha256 || keep.has(v.id)) return -1;
  for (let i = kept.length - 1; i >= 0; i--) {
    if (i < kept.length - 1 && kept[i].sha256 === v.sha256) return i;
    if (keep.has(kept[i].id) || !samePrincipal(kept[i].created_by, v.created_by))
      return -1;
  }
  return -1;
}
