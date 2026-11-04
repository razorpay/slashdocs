import { useCallback, useEffect, useRef } from "react";
import type { Anchor } from "@/api";
import { booksApi, type ReadingPosition } from "@/lib/books";
import { deviceIdStore } from "@/lib/reader-store";

const SAVE_INTERVAL_MS = 3000;
const RESTORE_TIMEOUT_MS = 3000;
const END_PROGRESSION = 0.98;

type Viewport = { anchor?: Partial<Anchor>; section: string; progression: number };

type Visit = {
  restored: boolean;
  lastSent: number;
  reachedEnd: boolean;
  pending: ReadingPosition | null;
  timer?: ReturnType<typeof setTimeout>;
  restoreTimer?: ReturnType<typeof setTimeout>;
  flush?: () => void;
};
const newVisit = (): Visit => ({
  restored: false,
  lastSent: 0,
  reachedEnd: false,
  pending: null,
});

// Saves where the reader is, at most every 3 s, and tells the server when the
// chapter is finished. Everything is keyed by book, chapter and version, so a
// pending save is flushed under the ids it was made with and never leaks into
// the next chapter.
export function useReadingPosition(opts: {
  bookId: string;
  documentId: string;
  versionId: string;
  enabled: boolean;
}): {
  onViewport: (v: Viewport) => void;
  // Call when the frame has restored the saved position (reader.onRestored).
  onRestored: () => void;
} {
  const { bookId, documentId, versionId, enabled } = opts;
  // Per-visit state; replaced when the chapter changes.
  const visit = useRef<Visit>(newVisit());

  useEffect(() => {
    if (!enabled) return;
    const v = newVisit();
    visit.current = v;
    v.restoreTimer = setTimeout(() => {
      v.restored = true;
    }, RESTORE_TIMEOUT_MS);

    const flush = () => {
      clearTimeout(v.timer);
      v.timer = undefined;
      const p = v.pending;
      if (!p) return;
      v.pending = null;
      v.lastSent = Date.now();
      booksApi.savePosition(bookId, p).catch(() => {});
      if (!v.reachedEnd) {
        booksApi
          .progress(bookId, documentId, versionId, p.progression, false)
          .catch(() => {});
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    v.flush = flush;
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(v.restoreTimer);
      flush();
      // Anything arriving after cleanup belongs to no visit.
      v.restored = false;
    };
  }, [bookId, documentId, versionId, enabled]);

  const onViewport = useCallback(
    (view: Viewport) => {
      const v = visit.current;
      if (!enabled || !v.restored || !v.flush) return;
      v.pending = {
        device_id: deviceIdStore.read(),
        document_id: documentId,
        version_id: versionId,
        section_id: view.section,
        anchor: view.anchor ?? {},
        progression: view.progression,
        client_ts: new Date().toISOString(),
      };
      if (!v.reachedEnd && view.progression >= END_PROGRESSION) {
        v.reachedEnd = true;
        booksApi
          .progress(bookId, documentId, versionId, view.progression, true)
          .catch(() => {});
      }
      const wait = v.lastSent + SAVE_INTERVAL_MS - Date.now();
      if (wait <= 0) v.flush();
      else if (v.timer === undefined) v.timer = setTimeout(v.flush, wait);
    },
    [bookId, documentId, versionId, enabled],
  );

  const onRestored = useCallback(() => {
    const v = visit.current;
    v.restored = true;
    clearTimeout(v.restoreTimer);
  }, []);

  return { onViewport, onRestored };
}
