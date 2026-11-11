import { docID, type FolderEntry } from "@/api";
import type { SortOrder } from "@/lib/view-mode";

// Names compare as people read them: "Chapter 2" comes before "Chapter 10".
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// The order of a folder's contents, as in most file browsers: pinned entries
// first, then folders before documents. Then the latest activity and the
// name, or the name only. Entries with no activity time come after those with
// one.
export function sortEntries(
  entries: FolderEntry[],
  pinnedIds: Set<string>,
  order: SortOrder = "recent",
) {
  const pinned = (e: FolderEntry) =>
    pinnedIds.has(e.folder?.id || (e.document ? docID(e.document) : ""));
  const name = (e: FolderEntry) => e.folder?.title || e.document?.title || "";
  const recent = (a: FolderEntry, b: FolderEntry) =>
    Number(!!b.last_active) - Number(!!a.last_active) ||
    (b.last_active || "").localeCompare(a.last_active || "");
  return [...entries].sort(
    (a, b) =>
      Number(pinned(b)) - Number(pinned(a)) ||
      Number(b.type === "folder") - Number(a.type === "folder") ||
      (order === "recent" && recent(a, b)) ||
      byName.compare(name(a), name(b)),
  );
}
