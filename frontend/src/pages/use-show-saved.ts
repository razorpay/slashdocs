import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { queryKeys } from "@/lib/queryKeys";
import { useDoc } from "./doc-context";

// useShowSaved gives, as a save starts, the way to show the document with
// the version that the save makes: the page leaves the preview and loads
// the document again. The page must know the new version first, because
// the frame loads the version that the page has. It goes only while the
// reader still previews what they previewed at the start: a save that ends
// after they opened another version of the history leaves them there. It
// must stay mounted while the save goes, as the page does, so that it sees
// what the reader opened.
export function useShowSaved() {
  const { docId, showCurrent } = useDoc();
  const q = useQueryClient();
  const preview = useRef<string | null>(null);
  preview.current = useSearchParams()[0].get("version");
  return useCallback(() => {
    const started = preview.current;
    return async () => {
      await q.refetchQueries({ queryKey: queryKeys.document(docId), exact: true });
      if (preview.current === started) showCurrent();
    };
  }, [q, docId, showCurrent]);
}

export type ShowSaved = ReturnType<typeof useShowSaved>;
