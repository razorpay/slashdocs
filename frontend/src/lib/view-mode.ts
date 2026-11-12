import { createPersistentStore } from "@/lib/persistent-store";

export type ViewMode = "list" | "gallery";
export const viewModeStore = createPersistentStore<ViewMode>(
  "slashdocs:view-mode",
  "gallery",
);
