import type { Principal, Version } from "@/api";
import { samePrincipal } from "@/lib/principals";

// Edits by one person less than this far apart read as one session.
export const HISTORY_SESSION_GAP_MS = 30 * 60_000;

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
