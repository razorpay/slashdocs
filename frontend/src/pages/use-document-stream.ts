import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  api,
  type Anchor,
  type CursorSpot,
  type DocumentCursor,
  type DocumentKVEvent,
  type DocumentPresence,
  type Principal,
} from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { createCursorBatch } from "@/lib/live-cursors";
import { principalColor, principalLabel, samePrincipal } from "@/lib/principals";
import type { RemoteCursor } from "../../bridge/cursors";
import { randomId } from "@/lib/uuid";

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

const EVENT_KINDS = ["kv", "document", "comments", "presence", "cursor"] as const;

type DocumentEventHandlers = Partial<
  Record<(typeof EVENT_KINDS)[number], DocumentKVListener>
> & { open?: () => void };

// useDocumentEvents holds one connection to the document event stream and
// passes each event to the handler for its kind. A session marks the
// connection as a viewer, whom the server lists until the stream ends.
export function useDocumentEvents(
  docId: string,
  handlers: DocumentEventHandlers,
  session?: string,
) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [attempt, setAttempt] = useState(0);
  const lastRevision = useRef(0);

  useEffect(() => {
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
      reconnect = window.setTimeout(() => setAttempt((n) => n + 1), RECONNECT_DELAY);
    };
    return () => {
      source.close();
      window.clearTimeout(reconnect);
    };
  }, [docId, session, attempt]);
}

// useDocumentStream is the document page's view of the event stream. It
// passes KV changes to subscribers, refreshes comments and the document when
// they change, and reports and tracks who is viewing and where they point.
export function useDocumentStream({
  docId,
  version,
  principal,
  onRemoteDocumentChange,
}: {
  docId: string;
  version: string;
  principal?: Principal;
  onRemoteDocumentChange: () => void;
}) {
  const q = useQueryClient();
  const [session] = useState(() => randomId());
  const kvListeners = useRef(new Set<DocumentKVListener>());
  const [sessions, setSessions] = useState<ReadonlyMap<string, Viewer>>(new Map());
  const place = useRef<{ version: string; anchor?: Partial<Anchor> }>({ version });

  // The newest point of each remote cursor, so that a frame that loads later
  // can draw it. A cursor on another version than this one is hidden here.
  const cursors = useRef(new Map<string, { cursor: RemoteCursor; version: string }>());
  const cursorListeners = useRef(new Set<CursorListener>());
  const shownCursor = useCallback(
    (cursor: RemoteCursor, on: string) =>
      on === place.current.version ? cursor : hiddenCursor(cursor),
    [],
  );
  const emitCursor = useCallback((cursor: RemoteCursor) => {
    cursorListeners.current.forEach((listener) => listener(cursor));
  }, []);

  useDocumentEvents(
    docId,
    {
      open: () => setSessions(new Map()),
      kv: (event) => kvListeners.current.forEach((listener) => listener(event)),
      comments: () => q.invalidateQueries({ queryKey: queryKeys.comments(docId) }),
      document: (event) => {
        if (!samePrincipal(event.updated_by, principal)) onRemoteDocumentChange();
        q.invalidateQueries({ queryKey: queryKeys.document(docId) });
        q.invalidateQueries({ queryKey: queryKeys.versions(docId) });
      },
      presence: (event) => {
        const presence = event.data as DocumentPresence | undefined;
        const viewer = event.updated_by;
        if (!presence?.session || presence.session === session || !viewer) return;
        const key = `${viewer.type}:${viewer.id}:${presence.session}`;
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
        if (samePrincipal(viewer, principal)) return;
        const cursor = {
          session: data.session,
          name: principalLabel(viewer),
          color: principalColor(viewer),
          points: data.points,
        };
        cursors.current.set(data.session, {
          cursor: { ...cursor, points: [last] },
          version: data.version,
        });
        emitCursor(shownCursor(cursor, data.version));
      },
    },
    session,
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
  // REPORT_INTERVAL while scrolling, and as a heartbeat otherwise.
  const lastReport = useRef(0);
  const pendingReport = useRef<number | undefined>(undefined);
  const report = useCallback(() => {
    window.clearTimeout(pendingReport.current);
    pendingReport.current = undefined;
    lastReport.current = Date.now();
    api.postDocumentPresence(docId, { session, ...place.current }).catch(() => {});
  }, [docId, session]);
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
          version: place.current.version,
          points,
        }),
      ),
    [docId, session],
  );
  useEffect(() => () => cursorBatch.stop(), [cursorBatch]);
  const moveCursor = useCallback(
    (spot: CursorSpot | null) => cursorBatch.add(spot),
    [cursorBatch],
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
  // document.
  const cursorVersion = useCallback((id: string) => {
    const entry = cursors.current.get(id);
    return entry && !entry.cursor.points[0].hidden ? entry.version : undefined;
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
    subscribeCursors,
    cursorVersion,
  };
}

// hiddenCursor replaces a cursor's points with one hidden point, at the time
// of its last point plus after.
function hiddenCursor(cursor: RemoteCursor, after = 0): RemoteCursor {
  const t = (cursor.points.at(-1)?.t ?? 0) + after;
  return { ...cursor, points: [{ t, path: "", x: 0, y: 0, hidden: true }] };
}
