import { createPersistentStore } from "@/lib/persistent-store";

export type ViewMode = "list" | "gallery";
export const viewModeStore = createPersistentStore<ViewMode>(
  "slashdocs:view-mode",
  "gallery",
);

// The order of each folder that the reader sorts by name, so that numbered
// documents read in order. Other folders show the latest activity first.
export type SortOrder = "recent" | "name";
export const folderSortStore = createPersistentStore<Record<string, SortOrder>>(
  "slashdocs:folder-sort",
  {},
  (parsed) =>
    parsed && typeof parsed === "object" ? (parsed as Record<string, SortOrder>) : {},
);
