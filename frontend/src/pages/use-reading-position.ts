import { useCallback, useEffect, useRef } from "react";
import type { Anchor } from "@/api";
import { booksApi, readingWriteFailure, type ReadingPosition } from "@/lib/books";
import { deviceIdStore } from "@/lib/reader-store";

const SAVE_INTERVAL_MS = 3000;
const RESTORE_TIMEOUT_MS = 3000;
const END_PROGRESSION = 0.98;
// A chapter that fits on screen counts as read after this long on screen.
export const FITS_READ_MS = 15_000;
// Progress is sent only when it grows by more than this.
const PROGRESS_STEP = 0.01;
// The server's Retry-After for 429 rate_limited.
const RATE_LIMIT_BACKOFF_MS = 60_000;

type Viewport = {
  anchor?: Partial<Anchor>;
  section: string;
  progression: number;
  fits?: boolean;
};

type Visit = {
  restored: boolean;
  closed: boolean;
  lastSent: number;
  // A report below the end has arrived since the restore; see onViewport.
  armed: boolean;
  reachedEnd: boolean;
  // The largest progression sent with progress(false) this visit.
  furthestSent: number;
  // The latest report said nothing scrolls.
  fits: boolean;
  // An automatic retry is already scheduled or spent since the last success.
  retried: boolean;
  backoffUntil: number;
  pending: ReadingPosition | null;
  timer?: ReturnType<typeof setTimeout>;
  restoreTimer?: ReturnType<typeof setTimeout>;
  fitsTimer?: ReturnType<typeof setTimeout>;
  flush?: (final?: boolean) => void;
  reachEnd?: (progression: number) => void;
};
const newVisit = (): Visit => ({
  restored: false,
  closed: false,
  lastSent: 0,
  armed: false,
  reachedEnd: false,
  furthestSent: 0,
  fits: false,
  retried: false,
  backoffUntil: 0,
  pending: null,
});

const visible = () => document.visibilityState !== "hidden";

// Saves where the reader is, at most every 3 s, and tells the server when the
// chapter is finished. Everything is keyed by book, chapter and version, so a
// pending save is flushed under the ids it was made with and never leaks into
// the next chapter.
//
// Reaching the end marks the version seen, which cannot be undone, so it
// needs evidence from this visit (R18: opening a chapter does not clear it):
// - Scrolled to the end: a report at or past 98% that follows a report below
//   it. A restore that lands at the end does not count until the reader
//   scrolls away and back.
// - Fits on screen: nothing in the chapter scrolls, and it stays on screen,
//   with the page visible, for FITS_READ_MS.
//
// Failed writes: 4xx refusals are dropped. Outages and network errors keep
// the position pending, retry once after 3 s, and otherwise go with the next
// report or page hide. 429 holds throttled saves for a minute; the save on
// page hide is sent anyway, since it is the last chance.
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

    const schedule = (wait: number) => {
      if (v.timer === undefined) v.timer = setTimeout(() => flush(), wait);
    };
    // Returns whether the write is worth sending again.
    const failed = (err: unknown): boolean => {
      if (v.closed) return false;
      const kind = readingWriteFailure(err);
      if (kind === "drop") return false;
      if (kind === "rate_limited") v.backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
      if (!v.retried) {
        v.retried = true;
        schedule(Math.max(SAVE_INTERVAL_MS, v.backoffUntil - Date.now()));
      }
      return true;
    };

    const flush = (final = false) => {
      clearTimeout(v.timer);
      v.timer = undefined;
      const p = v.pending;
      if (!p) return;
      const wait = v.backoffUntil - Date.now();
      if (!final && wait > 0) return schedule(wait);
      v.pending = null;
      v.lastSent = Date.now();
      booksApi.savePosition(bookId, p).then(
        () => {
          v.retried = false;
        },
        (err: unknown) => {
          // A newer position replaces the failed one.
          if (failed(err) && v.pending === null) v.pending = p;
        },
      );
      if (!v.reachedEnd && p.progression > v.furthestSent + PROGRESS_STEP) {
        const before = v.furthestSent;
        v.furthestSent = p.progression;
        booksApi
          .progress(bookId, documentId, versionId, p.progression, false)
          .catch((err: unknown) => {
            if (v.furthestSent === p.progression) v.furthestSent = before;
            failed(err);
          });
      }
    };

    const reachEnd = (progression: number) => {
      if (v.reachedEnd || v.closed || Date.now() < v.backoffUntil) return;
      v.reachedEnd = true;
      booksApi
        .progress(bookId, documentId, versionId, progression, true)
        .catch((err: unknown) => {
          // Sent again with the next report at the end.
          if (failed(err)) v.reachedEnd = false;
        });
    };

    const onVisibility = () => {
      if (!visible()) {
        clearTimeout(v.fitsTimer);
        v.fitsTimer = undefined;
        flush(true);
      } else if (v.fits) startFitsTimer(v);
    };
    document.addEventListener("visibilitychange", onVisibility);
    v.flush = flush;
    v.reachEnd = reachEnd;
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(v.restoreTimer);
      clearTimeout(v.fitsTimer);
      flush(true);
      clearTimeout(v.timer);
      // Anything arriving after cleanup belongs to no visit.
      v.closed = true;
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
      v.fits = !!view.fits;
      if (v.fits) {
        startFitsTimer(v);
      } else {
        clearTimeout(v.fitsTimer);
        v.fitsTimer = undefined;
        if (view.progression < END_PROGRESSION) v.armed = true;
        else if (v.armed) v.reachEnd?.(view.progression);
      }
      const wait = v.lastSent + SAVE_INTERVAL_MS - Date.now();
      if (wait <= 0) v.flush();
      else if (v.timer === undefined) v.timer = setTimeout(v.flush, wait);
    },
    [documentId, versionId, enabled],
  );

  const onRestored = useCallback(() => {
    const v = visit.current;
    v.restored = true;
    clearTimeout(v.restoreTimer);
  }, []);

  return { onViewport, onRestored };
}

function startFitsTimer(v: Visit): void {
  if (v.fitsTimer !== undefined || v.reachedEnd || v.closed || !visible()) return;
  v.fitsTimer = setTimeout(() => {
    v.fitsTimer = undefined;
    if (v.fits && visible()) v.reachEnd?.(1);
  }, FITS_READ_MS);
}
