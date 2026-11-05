import { useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import type { Version } from "@/api";
import { useDoc } from "./doc-context";

// useShowSaved gives, as a save starts, the way to go to the version that it
// makes here, even when the event for it came first and kept the reader on
// the one before. It goes only while the reader still previews what they
// previewed at the start: a save that ends after they opened another version
// of the history leaves them there. The saved data refreshes in any case.
// It must stay mounted while the save goes, as the page does, so that it
// sees what the reader opened.
export function useShowSaved() {
  const { showLatest, stayOnVersion } = useDoc();
  const preview = useRef<string | null>(null);
  preview.current = useSearchParams()[0].get("version");
  return useCallback(() => {
    const started = preview.current;
    return (saved: Version) => {
      if (preview.current !== started) return;
      showLatest();
      stayOnVersion(saved.id);
    };
  }, [showLatest, stayOnVersion]);
}

export type ShowSaved = ReturnType<typeof useShowSaved>;
