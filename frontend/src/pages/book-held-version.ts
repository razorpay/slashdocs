import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export const NEW_VERSION = "A new version of this chapter is available.";

// The version of a chapter being read. It follows the newest version until
// the reader starts reading, so a stale cached manifest never starts a visit
// on an old version. From then on it is pinned for the chapter visit: a newer
// one, whether the live stream or a manifest refetch brings it, only offers a
// switch, and the frame never swaps under the reader (A7).
//
// The offer is a persistent "New version · View" control in the reader bar
// (viewNewest is set while a newer version is held back), plus a toast as a
// brief nudge. The toast is bound to the chapter that raised it: it is
// dismissed when the chapter changes, and a late View click on it does
// nothing to another chapter.
export function useHeldVersion({
  docId,
  latest,
  reading,
  beforeView,
}: {
  docId: string;
  // The newest version the manifest knows.
  latest: string;
  // The reader has started reading this chapter.
  reading: boolean;
  // Called just before switching to the newer version.
  beforeView: () => void;
}): { current: string; viewNewest?: () => void } {
  const [held, setHeld] = useState({ doc: docId, version: latest });
  if (
    held.doc !== docId ||
    (!held.version && latest) ||
    (!reading && held.version !== latest)
  ) {
    setHeld({ doc: docId, version: latest });
  }
  const current = (held.doc === docId && held.version) || latest;

  const docRef = useRef(docId);
  docRef.current = docId;
  const beforeViewRef = useRef(beforeView);
  beforeViewRef.current = beforeView;
  const offered = useRef("");
  const toastId = useRef<string | number | undefined>(undefined);
  const view = useCallback((forDoc: string, version: string) => {
    if (docRef.current !== forDoc) return;
    if (toastId.current !== undefined) toast.dismiss(toastId.current);
    toastId.current = undefined;
    beforeViewRef.current();
    setHeld({ doc: forDoc, version });
  }, []);
  useEffect(() => {
    if (!latest || current === latest || offered.current === latest) return;
    offered.current = latest;
    const forDoc = docId;
    toastId.current = toast.info(NEW_VERSION, {
      action: { label: "View", onClick: () => view(forDoc, latest) },
    });
  }, [docId, latest, current, view]);
  useEffect(
    () => () => {
      if (toastId.current !== undefined) toast.dismiss(toastId.current);
      toastId.current = undefined;
    },
    [docId],
  );
  const newer = !!latest && current !== latest;
  const viewNewest = useCallback(() => view(docId, latest), [view, docId, latest]);
  return { current, viewNewest: newer ? viewNewest : undefined };
}
