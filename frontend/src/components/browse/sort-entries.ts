import { docID, type FolderEntry } from "@/api";

// The order of a folder's contents, as in most file browsers: pinned entries
// first, then folders before documents, then the latest activity, and then
// the title. Entries with no activity time come after those with one.
export function sortEntries(entries: FolderEntry[], pinnedIds: Set<string>) {
  const pinned = (e: FolderEntry) =>
    pinnedIds.has(e.folder?.id || (e.document ? docID(e.document) : ""));
  const title = (e: FolderEntry) =>
    (e.folder?.title || e.document?.title || "").toLowerCase();
  return [...entries].sort(
    (a, b) =>
      Number(pinned(b)) - Number(pinned(a)) ||
      Number(b.type === "folder") - Number(a.type === "folder") ||
      Number(!!b.last_active) - Number(!!a.last_active) ||
      (b.last_active || "").localeCompare(a.last_active || "") ||
      title(a).localeCompare(title(b)),
  );
}
