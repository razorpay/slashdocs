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

// withoutUndone leaves out each edit that its author undid with the next
// one: an entry that brings back the content of the entry before the edit,
// as Undo and Redo do. The entries in keep stay, so that the newest entry and
// the one on screen always show.
export function withoutUndone(
  versions: Version[],
  keep: ReadonlySet<string>,
): Version[] {
  const kept: Version[] = [];
  for (const v of [...versions].sort((a, b) => a.number - b.number)) {
    const [before, edit] = kept.slice(-2);
    if (
      edit &&
      v.sha256 &&
      v.sha256 === before?.sha256 &&
      samePrincipal(edit.created_by, v.created_by) &&
      !keep.has(edit.id) &&
      !keep.has(v.id)
    ) {
      kept.pop();
    } else kept.push(v);
  }
  return kept;
}
