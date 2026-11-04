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
  // The frame posted it while a restore was still waiting for content.
  restoring?: boolean;
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
  // The last report dropped because the restore was not done yet.
  early?: Viewport;
  // Failed or throttled reached_end sends since the last success.
  endRetries: number;
  timer?: ReturnType<typeof setTimeout>;
  restoreTimer?: ReturnType<typeof setTimeout>;
  fitsTimer?: ReturnType<typeof setTimeout>;
  endTimer?: ReturnType<typeof setTimeout>;
  flush?: (final?: boolean) => void;
  reachEnd?: (progression: number) => void;
  accept?: (view: Viewport) => void;
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
  endRetries: 0,
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
// Restore gate: reports are ignored until the frame has restored the saved
// place (onRestored), or 3 s after the restore was requested
// (onRestoreRequested); before that they show the top of the page. Reports
// the frame tags as posted mid-restore are always ignored. A dropped report
// for a chapter that fits on screen is replayed once the gate opens: it has
// no scroll position to go stale, and it may be the only report the visit
// gets.
//
// Failed writes: 4xx refusals are dropped. Outages and network errors keep
// the position pending, retry once after 3 s, and otherwise go with the next
// report or page hide. 429 holds throttled saves for a minute; the save on
// page hide is sent anyway, since it is the last chance. A reached_end that
// fails or is throttled is retried on its own, with backoff, since a chapter
// that fits sends no more reports.
export function useReadingPosition(opts: {
  bookId: string;
  documentId: string;
  versionId: string;
  enabled: boolean;
  // Called once the server has heard the chapter was finished, so the page
  // can fetch the new chapter state.
  onReachedEnd?: () => void;
}): {
  onViewport: (v: Viewport) => void;
  // Call when a saved position is sent to the frame to restore; the gate
  // opens anyway 3 s later.
  onRestoreRequested: () => void;
  // Call when the frame has restored the saved position (reader.onRestored),
  // or when there is nothing to restore.
  onRestored: () => void;
} {
  const { bookId, documentId, versionId, enabled } = opts;
  const onReachedEnd = useRef(opts.onReachedEnd);
  onReachedEnd.current = opts.onReachedEnd;
  // Per-visit state; replaced when the chapter changes.
  const visit = useRef<Visit>(newVisit());
  // A restore requested or done while no visit was live (saving not enabled
  // yet), applied when this chapter's visit starts.
  const beforeVisit = useRef<{ documentId: string; done: boolean } | null>(null);

  useEffect(() => {
    if (!enabled) return;
    const v = newVisit();
    visit.current = v;

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

    // One timer; a chapter that fits gets no later report to resend with.
    const retryEnd = (progression: number) => {
      if (v.endTimer !== undefined || v.closed) return;
      const wait = Math.min(
        RATE_LIMIT_BACKOFF_MS,
        SAVE_INTERVAL_MS * 2 ** Math.min(v.endRetries, 5),
      );
      v.endRetries++;
      v.endTimer = setTimeout(
        () => {
          v.endTimer = undefined;
          reachEnd(progression);
        },
        Math.max(wait, v.backoffUntil - Date.now()),
      );
    };
    const reachEnd = (progression: number) => {
      if (v.reachedEnd || v.closed) return;
      if (Date.now() < v.backoffUntil) return retryEnd(progression);
      clearTimeout(v.endTimer);
      v.endTimer = undefined;
      v.reachedEnd = true;
      booksApi.progress(bookId, documentId, versionId, progression, true).then(
        () => {
          v.endRetries = 0;
          onReachedEnd.current?.();
        },
        (err: unknown) => {
          // Sent again on its own, or with the next report at the end.
          if (failed(err)) {
            v.reachedEnd = false;
            retryEnd(progression);
          }
        },
      );
    };

    const accept = (view: Viewport) => {
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
        else if (v.armed) reachEnd(view.progression);
      }
      const wait = v.lastSent + SAVE_INTERVAL_MS - Date.now();
      if (wait <= 0) flush();
      else if (v.timer === undefined) v.timer = setTimeout(flush, wait);
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
    v.accept = accept;
    const early = beforeVisit.current;
    beforeVisit.current = null;
    if (early?.documentId === documentId) {
      if (early.done) openGate(v);
      else v.restoreTimer = setTimeout(() => openGate(v), RESTORE_TIMEOUT_MS);
    }
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(v.restoreTimer);
      clearTimeout(v.fitsTimer);
      clearTimeout(v.endTimer);
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
      if (!enabled || !v.accept || view.restoring) return;
      if (!v.restored) {
        v.early = view;
        return;
      }
      v.accept(view);
    },
    [enabled],
  );

  const onRestoreRequested = useCallback(() => {
    const v = visit.current;
    if (!v.accept || v.closed) {
      if (beforeVisit.current?.documentId !== documentId)
        beforeVisit.current = { documentId, done: false };
      return;
    }
    if (v.restored || v.restoreTimer !== undefined) return;
    v.restoreTimer = setTimeout(() => openGate(v), RESTORE_TIMEOUT_MS);
  }, [documentId]);

  const onRestored = useCallback(() => {
    const v = visit.current;
    if (!v.accept || v.closed) {
      beforeVisit.current = { documentId, done: true };
      return;
    }
    clearTimeout(v.restoreTimer);
    openGate(v);
  }, [documentId]);

  return { onViewport, onRestoreRequested, onRestored };
}

// Opens the restore gate and replays a dropped report for a chapter that
// fits on screen (see the restore gate above).
function openGate(v: Visit): void {
  if (v.closed || v.restored) return;
  v.restored = true;
  v.restoreTimer = undefined;
  const early = v.early;
  v.early = undefined;
  if (early?.fits) v.accept?.(early);
}

function startFitsTimer(v: Visit): void {
  if (v.fitsTimer !== undefined || v.reachedEnd || v.closed || !visible()) return;
  v.fitsTimer = setTimeout(() => {
    v.fitsTimer = undefined;
    if (v.fits && visible()) v.reachEnd?.(1);
  }, FITS_READ_MS);
}
