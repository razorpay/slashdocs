import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { SheetHandle } from "@/components/ui/sheet";
import { cn } from "@/lib/cn";
import { EDGE, placeBeside, type Rect } from "@/lib/place-beside";
import { anchorLabel } from "@/lib/comment-pins";
import { principalLabel } from "@/lib/principals";
import { useIsMobile } from "@/lib/use-media-query";
import { popIn, sheetUp } from "@/lib/motion";
import { useDoc } from "./doc-context";
import { CommentComposer, CommentThread } from "./doc-comments";
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
// it has none. On a narrow screen it is a sheet at the bottom of the screen,
// which leaves the document above it.
function Popover({
  anchor,
  beside,
  bounds,
  label,
  onClose,
  children,
}: {
  anchor: Rect | null;
  // The boxes that the popover keeps off, as placeBeside takes them.
  beside?: Rect[];
  bounds: RefObject<HTMLElement | null>;
  label: string;
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
    setAt(
      placeBeside(
        anchor ?? { left: box.right - EDGE, top: box.top, width: 0, height: 0 },
        size,
        box,
        beside?.length ? beside : undefined,
      ),
    );
  }, [anchor, beside, bounds, mobile, children]);
  // It takes the focus that a post or a pick in a list left behind, so Esc
  // and Tab reach it. Focus in the document stays there.
  useEffect(() => {
    const el = ref.current;
    const focus = document.activeElement;
    if (el && !el.contains(focus) && !(focus instanceof HTMLIFrameElement))
      el.focus({ preventScroll: true });
  }, []);
  const closeOnEscape = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    onClose();
  };
  const enter = mobile ? sheetUp : popIn;
  // It grows from the side of its anchor.
  const origin =
    at && anchor
      ? `${anchor.left + anchor.width / 2 - at.x}px ${anchor.top + anchor.height / 2 - at.y}px`
      : "top right";
  return (
    <motion.div
      ref={ref}
      {...enter}
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

// CommentPopovers shows the open thread, or the new comment, beside its
// highlight or pin, and the threads of a pin cluster. The bridge reports
// where the open one's anchor is on each frame that it moves.
export function CommentPopovers({
  frame,
  bounds,
  origin,
  ready,
  postToFrame,
}: {
  frame: RefObject<HTMLIFrameElement | null>;
  bounds: RefObject<HTMLElement | null>;
  origin: string | null;
  ready: boolean;
  postToFrame: (message: Record<string, unknown>) => void;
}) {
  const { activeComment, setActiveComment, comments, drafts, unanchoredComments } =
    useDoc();
  const [anchor, setAnchor] = useState<{
    id: string;
    rect: Rect | null;
    beside: Rect[];
  }>();
  const [cluster, setCluster] = useState<{ ids: string[]; rect: Rect }>();
  useEffect(() => {
    if (ready) postToFrame({ type: "slashdocs:watch", id: activeComment ?? null });
  }, [ready, activeComment, postToFrame]);
  useFrameMessage(frame, origin, ready, (data) => {
    const iframe = frame.current;
    if (!iframe) return;
    if (data.type === "slashdocs:anchor-rect" && typeof data.id === "string") {
      // The blocks that hold a highlight, then the text of its lines.
      const [rect, ...beside] = [data.rect, data.block, data.lines].map(parseRect);
      setAnchor({
        id: data.id,
        rect: rect && toApp(iframe, rect),
        beside: beside.flatMap((box) => (box ? [toApp(iframe, box)] : [])),
      });
    }
    if (data.type === "slashdocs:pin-cluster" && Array.isArray(data.ids)) {
      const rect = parseRect(data.rect);
      const ids = data.ids.filter((id): id is string => typeof id === "string");
      if (rect) setCluster({ ids: ids.slice(0, 500), rect: toApp(iframe, rect) });
    }
    if (data.type === "slashdocs:document-click") setCluster(undefined);
  });

  const close = () => setActiveComment(undefined);
  const draft = drafts.find((d) => d.id === activeComment);
  const thread = comments.find((c) => c.id === activeComment);
  const placedAnchor = anchor?.id === activeComment ? anchor : undefined;
  const rect = placedAnchor?.rect ?? null;
  // Until the bridge reports the anchor, a thread waits, so it does not
  // jump; one whose text or pin is gone floats at the top right.
  const placed = !!rect || (!!activeComment && unanchoredComments.has(activeComment));
  const clustered = cluster && comments.filter((c) => cluster.ids.includes(c.id));
  return (
    <AnimatePresence>
      {(draft || thread) && placed ? (
        <Popover
          key={activeComment}
          anchor={rect}
          beside={placedAnchor?.beside}
          bounds={bounds}
          label={draft ? "New comment" : "Comment thread"}
          onClose={close}
        >
          {draft ? (
            <CommentComposer draft={draft} />
          ) : (
            <CommentThread c={thread!} onClose={close} />
          )}
        </Popover>
      ) : null}
      {cluster && clustered?.length ? (
        <Popover
          key="cluster"
          anchor={cluster.rect}
          bounds={bounds}
          label="Comment threads"
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
