import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  AnimatePresence,
  motion,
  useIsPresent,
  useReducedMotion,
  type TargetAndTransition,
} from "framer-motion";
import { SheetHandle } from "@/components/ui/sheet";
import { keepToastsAbove } from "@/components/ui/toaster";
import { cn } from "@/lib/cn";
import { EDGE, placeBeside, type Rect } from "@/lib/place-beside";
import { anchorLabel } from "@/lib/comment-pins";
import { useLostWords } from "@/lib/comment-drafts";
import { principalLabel } from "@/lib/principals";
import { useIsMobile } from "@/lib/use-media-query";
import { crossFade, popIn, resolvedOut, sheetUp } from "@/lib/motion";
import { useDoc } from "./doc-context";
import { CommentComposer, CommentThread, DeletedThread } from "./doc-comments";
import { PersonAvatar } from "./doc-comment-parts";
import { CommentBody } from "./doc-comment-text";
import { useFrameMessage } from "./use-frame-message";

const WIDTH = 340;

// toApp turns a box in the render frame's viewport into one in the app's.
function toApp(frame: HTMLIFrameElement, r: Rect): Rect {
  const f = frame.getBoundingClientRect();
  const scale = frame.offsetWidth > 0 ? f.width / frame.offsetWidth : 1;
  return {
    left: f.left + r.left * scale,
    top: f.top + r.top * scale,
    width: r.width * scale,
    height: r.height * scale,
  };
}

function parseRect(value: unknown): Rect | null {
  const r = value as Record<string, unknown> | null;
  const num = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  return r && num(r.left) && num(r.top) && num(r.width) && num(r.height)
    ? { left: r.left, top: r.top, width: r.width, height: r.height }
    : null;
}

// Popover floats beside its anchor, or at the top right of the document when
// it has none, clear of a panel at the right. On a narrow screen it is a
// sheet at the bottom of the screen, which leaves the document above it, and
// tells onCover its height while it is open.
function Popover({
  anchor,
  beside,
  bounds,
  panel,
  label,
  onCover,
  onClose,
  children,
}: {
  anchor: Rect | null;
  // The boxes that the popover keeps off, as placeBeside takes them.
  beside?: Rect[];
  bounds: RefObject<HTMLElement | null>;
  // The pixels at the right of bounds that a panel covers.
  panel: number;
  label: string;
  onCover: (sheet: string, height: number) => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const mobile = useIsMobile();
  const [at, setAt] = useState<{ x: number; y: number }>();
  useLayoutEffect(() => {
    const box = bounds.current?.getBoundingClientRect();
    const el = ref.current;
    if (mobile || !box || !el) return;
    const size = { width: el.offsetWidth, height: el.offsetHeight };
    const right = box.right - panel;
    setAt(
      placeBeside(
        anchor ?? { left: right - EDGE, top: box.top, width: 0, height: 0 },
        size,
        { left: box.left, top: box.top, width: right - box.left, height: box.height },
        beside?.length ? beside : undefined,
      ),
    );
  }, [anchor, beside, bounds, panel, mobile, children]);
  // It takes the focus that a post or a pick in a list left behind, so Esc
  // and Tab reach it. Focus in the document stays there. When it closes, it
  // gives the focus back to the control that had it before it opened, or
  // else to the Comments button, unless the reader moved it on. The next
  // popover, as the thread of a posted comment, then takes it from there.
  const [opener] = useState(() => document.activeElement);
  const fromDocument = opener instanceof HTMLIFrameElement;
  const present = useIsPresent();
  useEffect(() => {
    const el = ref.current;
    if (el && !el.contains(document.activeElement) && !fromDocument)
      el.focus({ preventScroll: true });
  }, [fromDocument]);
  useEffect(() => {
    const focus = document.activeElement;
    if (present || !(focus === document.body || ref.current?.contains(focus))) return;
    const back =
      opener instanceof HTMLElement &&
      opener !== document.body &&
      !fromDocument &&
      opener.isConnected
        ? opener
        : document.querySelector<HTMLElement>('button[aria-label="Comments"]');
    back?.focus({ preventScroll: true });
  }, [present, opener, fromDocument]);
  const sheet = useId();
  useEffect(() => {
    const el = ref.current;
    if (!mobile || !el) return;
    const observer = new ResizeObserver(() =>
      onCover(sheet, present ? el.offsetHeight : 0),
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      onCover(sheet, 0);
    };
  }, [mobile, present, sheet, onCover]);
  useEffect(() => (present ? keepToastsAbove(ref.current) : undefined), [present]);
  const closeOnEscape = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    onClose();
  };
  const enter = mobile ? sheetUp : popIn;
  const reduced = useReducedMotion();
  // A popover whose thread the reader resolved leaves its own way; a sheet
  // goes down as it always does.
  const exits = {
    exit: (resolved: boolean) =>
      resolved && !mobile ? resolvedOut(reduced) : (enter.exit as TargetAndTransition),
  };
  // It grows from the side of its anchor.
  const origin =
    at && anchor
      ? `${anchor.left + anchor.width / 2 - at.x}px ${anchor.top + anchor.height / 2 - at.y}px`
      : "top right";
  return (
    <motion.div
      ref={ref}
      {...enter}
      variants={exits}
      exit="exit"
      // It waits, hidden, until it knows where it goes.
      animate={mobile || at ? enter.animate : enter.initial}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      onKeyDown={closeOnEscape}
      style={
        mobile
          ? undefined
          : {
              left: at?.x ?? -9999,
              top: at?.y ?? -9999,
              width: WIDTH,
              transformOrigin: origin,
            }
      }
      className={cn(
        "fixed z-40 flex flex-col overflow-hidden bg-[var(--color-surface)] shadow-xl ring-1 ring-[var(--color-border)] outline-none",
        mobile
          ? "inset-x-0 bottom-0 max-h-[70vh] rounded-t-2xl pb-[env(safe-area-inset-bottom)]"
          : "max-h-[min(60vh,480px)] rounded-xl",
      )}
    >
      {mobile && <SheetHandle />}
      <div className="min-h-0 overflow-y-auto overscroll-contain">{children}</div>
    </motion.div>
  );
}

// Where an anchor is: its box, and the boxes that a popover keeps off.
type Place = { rect: Rect | null; beside: Rect[] };

// CommentPopovers shows the open thread, or the new comment, beside its
// highlight or pin, and the threads of a pin cluster. The bridge reports
// where the open one's anchor is on each frame that it moves.
export function CommentPopovers({
  frame,
  bounds,
  panel = 0,
  origin,
  ready,
  postToFrame,
}: {
  frame: RefObject<HTMLIFrameElement | null>;
  bounds: RefObject<HTMLElement | null>;
  // The pixels at the right of bounds that a panel covers.
  panel?: number;
  origin: string | null;
  ready: boolean;
  postToFrame: (message: Record<string, unknown>) => void;
}) {
  const {
    docId,
    activeComment,
    setActiveComment,
    leaving,
    comments,
    commentsLoading,
    commentsError,
    drafts,
    unanchoredComments,
  } = useDoc();
  // `last` is the last place that the anchor had, for a thread whose mark
  // goes because someone deleted it.
  const [anchor, setAnchor] = useState<Place & { id: string; last?: Place }>();
  // The thread that the reader posted from its composer just now.
  const posted = useRef<string>(undefined);
  const [cluster, setCluster] = useState<{ ids: string[]; rect: Rect }>();
  // The height of each open sheet. The bridge keeps the open thread's anchor
  // above the tallest, which covers the bottom of the frame.
  const sheets = useRef(new Map<string, number>());
  const cover = useCallback(
    (sheet: string, height: number) => {
      const iframe = frame.current;
      if (height) sheets.current.set(sheet, height);
      else sheets.current.delete(sheet);
      if (!iframe) return;
      const f = iframe.getBoundingClientRect();
      const scale = iframe.offsetHeight > 0 ? f.height / iframe.offsetHeight : 1;
      const top = window.innerHeight - Math.max(0, ...sheets.current.values());
      postToFrame({
        type: "slashdocs:cover",
        bottom: Math.max(0, f.bottom - top) / scale,
      });
    },
    [frame, postToFrame],
  );
  // A new version of the document comes without it.
  useEffect(() => {
    if (ready) cover("", 0);
  }, [ready, cover]);
  useEffect(() => {
    if (ready) postToFrame({ type: "slashdocs:watch", id: activeComment ?? null });
  }, [ready, activeComment, postToFrame]);
  useFrameMessage(frame, origin, ready, (data) => {
    const iframe = frame.current;
    if (!iframe) return;
    if (data.type === "slashdocs:anchor-rect" && typeof data.id === "string") {
      // The blocks that hold a highlight, then the text of its lines.
      const [rect, ...beside] = [data.rect, data.block, data.lines].map(parseRect);
      const id = data.id;
      const place = {
        rect: rect && toApp(iframe, rect),
        beside: beside.flatMap((box) => (box ? [toApp(iframe, box)] : [])),
      };
      setAnchor((now) => ({
        id,
        ...place,
        last: place.rect ? place : now?.id === id ? now.last : undefined,
      }));
    }
    if (data.type === "slashdocs:pin-cluster" && Array.isArray(data.ids)) {
      const rect = parseRect(data.rect);
      const ids = data.ids.filter((id): id is string => typeof id === "string");
      if (rect) setCluster({ ids: ids.slice(0, 500), rect: toApp(iframe, rect) });
    }
    if (data.type === "slashdocs:document-click") setCluster(undefined);
  });

  const close = () => {
    posted.current = undefined;
    setActiveComment(undefined);
  };
  const draft = drafts.find((d) => d.id === activeComment);
  const thread = comments.find((c) => c.id === activeComment);
  // A thread that someone deleted keeps the words that the reader did not send.
  const lost = useLostWords(docId, activeComment);
  const deleted =
    !draft && !thread && !commentsLoading && !commentsError && lost.length > 0;
  // A popover that goes to another thread stays where it is until the bridge
  // reports the new anchor, and does not close meanwhile.
  const shown = useRef(false);
  const placedAnchor =
    anchor?.id === activeComment || shown.current ? anchor : undefined;
  // A deleted thread stays where it was.
  const place = deleted ? placedAnchor?.last : placedAnchor;
  const rect = place?.rect ?? null;
  // Until the bridge reports the anchor, a thread waits, so it does not
  // jump; one whose text or pin is gone floats at the top right.
  const placed = !!rect || (!!activeComment && unanchoredComments.has(activeComment));
  const clustered = cluster && comments.filter((c) => cluster.ids.includes(c.id));
  const open = ((draft || thread) && placed) || deleted;
  useEffect(() => {
    shown.current = !!open;
  });
  const reduced = useReducedMotion();
  return (
    <AnimatePresence custom={!!leaving}>
      {open ? (
        // One popover for every thread: it moves to the next one, and its
        // content cross-fades.
        <Popover
          key="thread"
          anchor={rect}
          beside={place?.beside}
          bounds={bounds}
          panel={panel}
          label={draft ? "New comment" : "Comment thread"}
          onCover={cover}
          onClose={close}
        >
          <AnimatePresence initial={false} mode="popLayout">
            <motion.div key={activeComment} {...crossFade(reduced)}>
              {draft ? (
                <CommentComposer
                  draft={draft}
                  onPosted={(id) => (posted.current = id)}
                />
              ) : thread ? (
                <CommentThread
                  c={thread}
                  onClose={close}
                  focusReply={posted.current === thread.id}
                />
              ) : (
                <DeletedThread id={activeComment!} texts={lost} onClose={close} />
              )}
            </motion.div>
          </AnimatePresence>
        </Popover>
      ) : null}
      {cluster && clustered?.length ? (
        <Popover
          key="cluster"
          anchor={cluster.rect}
          bounds={bounds}
          panel={panel}
          label="Comment threads"
          onCover={cover}
          onClose={() => setCluster(undefined)}
        >
          <ul className="p-1.5">
            {clustered.map((c) => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => {
                    setCluster(undefined);
                    setActiveComment(c.id);
                  }}
                  className="flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left hover:bg-[var(--color-surface-muted)] focus-visible:-outline-offset-2"
                >
                  <PersonAvatar who={c.author} />
                  <span className="min-w-0">
                    <span className="block truncate text-xs font-semibold">
                      {principalLabel(c.author)}
                      {anchorLabel(c) ? (
                        <span className="font-normal text-[var(--color-fg-muted)]">
                          {" "}
                          on {anchorLabel(c)}
                        </span>
                      ) : null}
                    </span>
                    <CommentBody text={c.body} mentions={c.mentions} preview />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </Popover>
      ) : null}
    </AnimatePresence>
  );
}
