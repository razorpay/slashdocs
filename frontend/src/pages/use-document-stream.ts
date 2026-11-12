import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  api,
  type Anchor,
  type CursorSpot,
  type DocumentCursor,
  type DocumentEvent,
  type DocumentKVEvent,
  type DocumentPresence,
  type Principal,
} from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import type { Replacement } from "@/lib/source-edits";
import { createCursorBatch } from "@/lib/live-cursors";
import { principalColor, principalLabel, samePrincipal } from "@/lib/principals";
import type { RemoteCursor } from "../../bridge/cursors";
import { randomId } from "@/lib/uuid";
import { useInvalidateApprovals } from "./use-invalidate-approvals";

// The version of the cursor of a viewer who follows the newest version.
// Such viewers are a version apart for a moment at each change, and their
// cursors must not hide then.
export const LIVE = "live";

// The server lists a viewer for 45 seconds after their last report.
const PRESENCE_TTL = 45_000;
const HEARTBEAT_INTERVAL = 20_000;
const REPORT_INTERVAL = 2_000;
const RECONNECT_DELAY = 10_000;

export type Viewer = {
  session: string;
  principal: Principal;
  version?: string;
  anchor?: Partial<Anchor>;
  seenAt: number;
};

export type DocumentKVListener = (event: DocumentKVEvent) => void;
export type CursorListener = (cursor: RemoteCursor) => void;

const EVENT_KINDS = [
  "kv",
  "document",
  "comments",
  "approvals",
  "presence",
  "cursor",
] as const;

type DocumentEventHandlers = Partial<
  Record<(typeof EVENT_KINDS)[number], DocumentKVListener>
> & { open?: () => void; closed?: () => void };

// useDocumentEvents holds one connection to the document event stream and
// passes each event to the handler for its kind. A session marks the
// connection as a viewer, whom the server lists until the stream ends.
export function useDocumentEvents(
  docId: string,
  handlers: DocumentEventHandlers,
  session?: string,
  enabled = true,
) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [attempt, setAttempt] = useState(0);
  const lastRevision = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const params = new URLSearchParams(session ? { session } : {});
    // The browser resumes dropped streams itself. Only a stream it gave up on
    // is opened again here, and it continues from the last event it saw.
    if (lastRevision.current)
      params.set("after_revision", String(lastRevision.current));
    const source = new EventSource(
      `/v1/documents/${encodeURIComponent(docId)}/kv/events?${params}`,
      { withCredentials: true },
    );
    source.onopen = () => handlersRef.current.open?.();
    // KV changes are unnamed messages; other kinds are named events.
    for (const kind of EVENT_KINDS) {
      source.addEventListener(kind === "kv" ? "message" : kind, (message) => {
        lastRevision.current = Math.max(
          lastRevision.current,
          Number(message.lastEventId) || 0,
        );
        let event: DocumentKVEvent;
        try {
          event = JSON.parse(message.data) as DocumentKVEvent;
        } catch {
          return;
        }
        handlersRef.current[kind]?.(event);
      });
    }
    let reconnect: number | undefined;
    source.onerror = () => {
      if (source.readyState !== EventSource.CLOSED) return;
      // The server refused the stream, as when access to the document went.
      handlersRef.current.closed?.();
      reconnect = window.setTimeout(() => setAttempt((n) => n + 1), RECONNECT_DELAY);
    };
    return () => {
      source.close();
      window.clearTimeout(reconnect);
    };
  }, [docId, session, attempt, enabled]);
}

// useDocumentStream is the document page's view of the event stream. It
// passes KV changes to subscribers, refreshes comments and approvals when
// they change, tells the page of each change to the document, and reports
// and tracks who is viewing and where they point.
export function useDocumentStream({
  docId,
  enabled,
  version,
  following,
  principal,
  onDocumentChange,
}: {
  docId: string;
  enabled: boolean;
  version: string;
  // The page follows the newest version: it is not a preview, and no change
  // waits for the reader.
  following: boolean;
  principal?: Principal;
  // Called on each change to the document, with what the event tells of
  // it, if it names a seq. It is also called when the stream opens, because
  // the changes before that sent no event here.
  onDocumentChange: (event?: DocumentEvent) => void;
}) {
  const q = useQueryClient();
  const invalidateApprovals = useInvalidateApprovals(docId);
  const [session] = useState(() => randomId());
  const kvListeners = useRef(new Set<DocumentKVListener>());
  const [sessions, setSessions] = useState<ReadonlyMap<string, Viewer>>(new Map());
  const place = useRef<{ version: string; anchor?: Partial<Anchor> }>({ version });

  // The newest point of each remote cursor, so that a frame that loads later
  // can draw it. A cursor on another version than this one is hidden here.
  const cursorOn = useRef(version);
  cursorOn.current = following ? LIVE : version;
  const cursors = useRef(new Map<string, { cursor: RemoteCursor; version: string }>());
  const cursorListeners = useRef(new Set<CursorListener>());
  // The sessions seen so far, to tell when someone arrives, and how to send
  // them this viewer's cursor then.
  const knownSessions = useRef(new Set<string>());
  const resendCursor = useRef<() => void>(() => {});
  const shownCursor = useCallback(
    (cursor: RemoteCursor, on: string) =>
      on === cursorOn.current ? cursor : hiddenCursor(cursor),
    [],
  );
  const emitCursor = useCallback((cursor: RemoteCursor) => {
    cursorListeners.current.forEach((listener) => listener(cursor));
  }, []);

  useDocumentEvents(
    docId,
    {
      open: () => {
        knownSessions.current.clear();
        setSessions(new Map());
        onDocumentChange();
      },
      // The page asks for the document again, and shows why it cannot.
      closed: () => onDocumentChange(),
      kv: (event) => kvListeners.current.forEach((listener) => listener(event)),
      comments: () => q.invalidateQueries({ queryKey: queryKeys.comments(docId) }),
      approvals: invalidateApprovals,
      document: (event) => onDocumentChange(documentEvent(event)),
      presence: (event) => {
        const presence = event.data as DocumentPresence | undefined;
        const viewer = event.updated_by;
        if (!presence?.session || presence.session === session || !viewer) return;
        const key = `${viewer.type}:${viewer.id}:${presence.session}`;
        // Someone new sees this viewer's cursor and view at once.
        if (!presence.left && !knownSessions.current.has(presence.session)) {
          knownSessions.current.add(presence.session);
          resendCursor.current();
        }
        if (presence.left) knownSessions.current.delete(presence.session);
        setSessions((current) => {
          const next = new Map(current);
          if (presence.left) next.delete(key);
          else
            next.set(key, {
              session: presence.session,
              principal: { ...viewer, picture_url: presence.picture_url },
              version: presence.version,
              anchor: presence.anchor,
              seenAt: Date.now(),
            });
          return next;
        });
      },
      cursor: (event) => {
        const data = event.data as DocumentCursor | undefined;
        const viewer = event.updated_by;
        const last = data?.points?.at(-1);
        if (!data || !last || data.session === session || !viewer) return;
        // This reader's other tab shows no cursor, only the block it edits.
        const own = samePrincipal(viewer, principal);
        const cursor = {
          session: data.session,
          name: principalLabel(viewer),
          color: principalColor(viewer),
          own,
          points: own
            ? data.points.map(({ t, e }) => ({ ...hiddenPoint(t), e }))
            : data.points,
        };
        cursors.current.set(data.session, {
          cursor: { ...cursor, points: cursor.points.slice(-1) },
          version: data.version,
        });
        emitCursor(shownCursor(cursor, data.version));
      },
    },
    session,
    enabled,
  );

  // A cursor goes away with its viewer.
  useEffect(() => {
    const live = new Set([...sessions.values()].map((viewer) => viewer.session));
    for (const [id, { cursor }] of cursors.current) {
      if (live.has(id)) continue;
      cursors.current.delete(id);
      emitCursor(hiddenCursor(cursor, 1));
    }
  }, [sessions, emitCursor]);

  // Viewers whose tab closed without a goodbye drop out after the TTL.
  useEffect(() => {
    const timer = window.setInterval(() => {
      setSessions((current) => {
        const oldest = Date.now() - PRESENCE_TTL;
        const live = [...current].filter(([, viewer]) => viewer.seenAt > oldest);
        return live.length === current.size ? current : new Map(live);
      });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, []);

  // Report this viewer's place: at once on a version change, at most every
  // REPORT_INTERVAL while scrolling, and as a heartbeat otherwise. Only a
  // signed-in viewer of an open document reports.
  const lastReport = useRef(0);
  const pendingReport = useRef<number | undefined>(undefined);
  const reporting = enabled && !!principal;
  const report = useCallback(() => {
    window.clearTimeout(pendingReport.current);
    pendingReport.current = undefined;
    lastReport.current = Date.now();
    if (!reporting) return;
    api.postDocumentPresence(docId, { session, ...place.current }).catch(() => {});
  }, [docId, session, reporting]);
  const scheduleReport = useCallback(() => {
    if (pendingReport.current !== undefined) return;
    const wait = Math.max(0, lastReport.current + REPORT_INTERVAL - Date.now());
    pendingReport.current = window.setTimeout(report, wait);
  }, [report]);
  const reportViewport = useCallback(
    (anchor?: Partial<Anchor>) => {
      place.current = { ...place.current, anchor };
      scheduleReport();
    },
    [scheduleReport],
  );
  useEffect(() => {
    place.current = { version };
    scheduleReport();
  }, [version, scheduleReport]);
  useEffect(() => {
    const timer = window.setInterval(report, HEARTBEAT_INTERVAL);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(pendingReport.current);
      pendingReport.current = undefined;
    };
  }, [report]);

  const cursorBatch = useMemo(
    () =>
      createCursorBatch((points) =>
        api.postDocumentCursor(docId, {
          session,
          version: cursorOn.current,
          points,
        }),
      ),
    [docId, session],
  );
  useEffect(() => () => cursorBatch.stop(), [cursorBatch]);
  useEffect(() => {
    resendCursor.current = cursorBatch.resend;
  }, [cursorBatch]);
  const moveCursor = useCallback(
    (spot: CursorSpot | null) => {
      if (reporting) cursorBatch.add(spot);
    },
    [cursorBatch, reporting],
  );

  // A new listener gets the newest point of every cursor at once.
  const subscribeCursors = useCallback(
    (listener: CursorListener) => {
      for (const { cursor, version } of cursors.current.values())
        listener(shownCursor(cursor, version));
      cursorListeners.current.add(listener);
      return () => {
        cursorListeners.current.delete(listener);
      };
    },
    [shownCursor],
  );

  // The version that a viewer's cursor is on, while the cursor is in the
  // document or the viewer still sends their view.
  const cursorVersion = useCallback((id: string) => {
    const entry = cursors.current.get(id);
    const point = entry?.cursor.points[0];
    return point && (!point.hidden || point.v) ? entry.version : undefined;
  }, []);

  const subscribeKV = useCallback((listener: DocumentKVListener) => {
    kvListeners.current.add(listener);
    return () => {
      kvListeners.current.delete(listener);
    };
  }, []);

  // One avatar per person, at their most recently active tab.
  const viewers = useMemo(() => {
    const byPrincipal = new Map<string, Viewer>();
    for (const viewer of sessions.values()) {
      if (samePrincipal(viewer.principal, principal)) continue;
      const key = `${viewer.principal.type}:${viewer.principal.id}`;
      if ((byPrincipal.get(key)?.seenAt ?? 0) <= viewer.seenAt) {
        byPrincipal.set(key, viewer);
      }
    }
    return [...byPrincipal.values()];
  }, [sessions, principal]);

  return {
    viewers,
    subscribeKV,
    reportViewport,
    moveCursor,
    holdCursor: cursorBatch.hold,
    subscribeCursors,
    cursorVersion,
  };
}

function hiddenPoint(t: number) {
  return { t, path: "", x: 0, y: 0, hidden: true };
}

// hiddenCursor replaces a cursor's points with one hidden point, at the time
// of its last point plus after.
function hiddenCursor(cursor: RemoteCursor, after = 0): RemoteCursor {
  return { ...cursor, points: [hiddenPoint((cursor.points.at(-1)?.t ?? 0) + after)] };
}

// documentEvent reads what a document event tells of the document, or
// nothing when it names no seq. Each event of an operation names its
// author, and whether they typed it. A small operation comes with its
// event. The event of a version that is done says so, and the event of a
// restore names the person who restored.
function documentEvent(event: DocumentKVEvent): DocumentEvent | undefined {
  const data = event.data as
    | (Partial<DocumentEvent> & { replacements?: Replacement[]; sum?: number })
    | undefined;
  if (typeof data?.seq !== "number" || !data.version_id) return undefined;
  const { seq, version_id, prev_seq, replacements, sum } = data;
  const typed = data.typed === true;
  const authors = event.updated_by ? [event.updated_by] : undefined;
  if (typeof prev_seq !== "number" || !replacements || typeof sum !== "number")
    return {
      seq,
      version_id,
      typed,
      authors,
      ...(data.sealed === true && { sealed: true }),
      ...(data.restored === true && { restored: true, updated_by: event.updated_by }),
    };
  const ops = [replacements];
  return {
    seq,
    version_id,
    typed,
    authors,
    prev_seq,
    changes: { seq, version_id, ops, typed, authors: authors ?? [], sum },
  };
}
