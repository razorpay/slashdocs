import type { Version } from "@/api";
import { useDoc } from "./doc-context";

// useShowSaved goes to a version that the reader made here, even when the
// event for it came first and kept them on the one before.
export function useShowSaved() {
  const { showLatest, stayOnVersion } = useDoc();
  return (saved: Version) => {
    showLatest();
    stayOnVersion(saved.id);
  };
}
