import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  type Anchor,
  type Comment,
  type CursorPoint,
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
import { withThread } from "./comment-events";

// The version of the cursor of a viewer who follows the newest version.
// Such viewers are a version apart for a moment at each change, and their
// cursors must not hide then.
export const LIVE = "live";

// The server lists a viewer for 45 seconds after their last report. While
// the live connection is open, the server reports again for them.
const PRESENCE_TTL = 45_000;
const REPORT_INTERVAL = 2_000;
// A live connection that drops connects again after about this long, and
// twice as long after each failure that follows, up to RECONNECT_MAX.
const RECONNECT_MIN = 1_000;
const RECONNECT_MAX = 30_000;
// The server closes a connection that it refuses with 4000 plus the HTTP
// status: 4401 when the viewer must sign in, 4403 when they cannot read the
// document, or no longer can.
const REFUSED = 4000;

export type Viewer = {
  session: string;
  principal: Principal;
  version?: string;
  anchor?: Partial<Anchor>;
  seenAt: number;
};

export type DocumentKVListener = (event: DocumentKVEvent) => void;
export type CursorListener = (cursor: RemoteCursor) => void;

type DocumentEventHandlers = Partial<
  Record<NonNullable<DocumentKVEvent["kind"]>, DocumentKVListener>
> & { open?: () => void; closed?: () => void };

// A report of this viewer to the others: their place in the document, their
// pointer, or that they go.
export type LiveReport =
  | { type: "presence"; version: string; anchor?: Partial<Anchor> }
  | { type: "cursor"; version: string; points: CursorPoint[] }
  | { type: "left" };

// useDocumentEvents holds one live connection to a document, and passes
// each event to the handler for its kind. A session marks the connection as
// a viewer, whom the server lists until the connection ends. A connection
// that drops connects again, at a random time in a wait that grows, and
// continues after the last event that it took. A connection that the server
// refuses calls closed, and stops. It returns the function that sends a
// report while the connection is open.
export function useDocumentEvents(
  docId: string,
  handlers: DocumentEventHandlers,
  session?: string,
  enabled = true,
) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const socket = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let lastRevision = 0;
    let failures = 0;
    let reconnect: number | undefined;
    const connect = () => {
      const params = new URLSearchParams(session ? { session } : {});
      if (lastRevision) params.set("after_revision", String(lastRevision));
      const url = new URL(
        `/v1/documents/${encodeURIComponent(docId)}/live?${params}`,
        window.location.href,
      );
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      socket.current = ws;
      ws.onopen = () => {
        failures = 0;
        handlersRef.current.open?.();
      };
      ws.onmessage = ({ data }: MessageEvent<string>) => {
        let message: { id?: number; event?: DocumentKVEvent };
        try {
          message = JSON.parse(data);
        } catch {
          return;
        }
        const { id, event } = message;
        if (!event) return;
        lastRevision = Math.max(lastRevision, id ?? 0);
        handlersRef.current[event.kind || "kv"]?.(event);
      };
      ws.onclose = ({ code }) => {
        socket.current = null;
        if (code >= REFUSED && code < REFUSED + 1000)
          return handlersRef.current.closed?.();
        const wait = Math.min(RECONNECT_MAX, RECONNECT_MIN * 2 ** failures++);
        reconnect = window.setTimeout(connect, wait * (0.5 + Math.random() / 2));
      };
    };
    connect();
    return () => {
      window.clearTimeout(reconnect);
      const ws = socket.current;
      socket.current = null;
      if (!ws) return;
      ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "left" }));
      ws.close();
    };
  }, [docId, session, enabled]);

  return useCallback((report: LiveReport) => {
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify(report));
  }, []);
}

// useDocumentStream is the document page's view of the event stream. It
// passes KV changes to subscribers, puts each changed comment thread into
// the comments, refreshes approvals when they change, tells the page of each
// change to the document, and reports and tracks who is viewing and where
// they point.
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
  // it, if it names a seq. The server also tells where the document is when
  // the connection opens, because the changes before that sent no event
  // here. It is called with no event when the event cannot tell the change,
  // as for a new title, and when the server refuses the connection.
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

  const send = useDocumentEvents(
    docId,
    {
      // The server lists the viewers again, and this viewer is one of them.
      open: () => {
        knownSessions.current.clear();
        setSessions(new Map());
        report();
      },
      // The page asks for the document again, and shows why it cannot.
      closed: () => onDocumentChange(),
      kv: (event) => kvListeners.current.forEach((listener) => listener(event)),
      // A comments event has the thread that changed. The comments load
      // again only when the event cannot change them: they did not load
      // yet, a load is under way, or the event has no thread.
      comments: (event) => {
        const key = queryKeys.comments(docId);
        const data = q.getQueryData<{ items: Comment[] }>(key);
        const items =
          data && !q.isFetching({ queryKey: key })
            ? withThread(data.items, event, principal)
            : undefined;
        if (items) q.setQueryData(key, { ...data, items });
        else q.invalidateQueries({ queryKey: key });
      },
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

  // Report this viewer's place: at once when the connection opens or the
  // version changes, and at most every REPORT_INTERVAL while scrolling. Only
  // a signed-in viewer of an open document reports.
  const lastReport = useRef(0);
  const pendingReport = useRef<number | undefined>(undefined);
  const reporting = enabled && !!principal;
  const report = useCallback(() => {
    window.clearTimeout(pendingReport.current);
    pendingReport.current = undefined;
    lastReport.current = Date.now();
    if (reporting) send({ type: "presence", ...place.current });
  }, [send, reporting]);
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
  useEffect(
    () => () => {
      window.clearTimeout(pendingReport.current);
      pendingReport.current = undefined;
    },
    [report],
  );

  const cursorBatch = useMemo(
    () =>
      createCursorBatch(async (points) =>
        send({ type: "cursor", version: cursorOn.current, points }),
      ),
    [send],
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
// event. The event of a sealed version says so, and the event of a
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
