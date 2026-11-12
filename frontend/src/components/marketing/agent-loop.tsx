import { useEffect, useRef, useState } from "react";
import { useInView } from "framer-motion";
import { CheckCircle2 } from "lucide-react";
import { Logo } from "@/components/layout/logo";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/cn";
import { usePrefersReducedMotion } from "@/lib/use-media-query";
import {
  BEAT_COUNT,
  COMMENT,
  DOC_ID,
  HOST,
  QUOTE,
  REPLY,
  TITLE,
  TYPE_MS,
  beatMs,
  isTyped,
  sceneAt,
  type Doc,
  type Line,
} from "./agent-loop-script";

const STEPS = ["The agent publishes", "People comment", "The agent revises"];

// [position %, length %, delay ms, tilt deg] of each streak in the wind.
const STREAKS = [
  [6, 55, 0, -1.5],
  [13, 35, 90, 1],
  [24, 30, 40, 2],
  [33, 25, 160, -2],
  [47, 50, 20, -1],
  [58, 30, 130, 0.5],
  [68, 60, 60, -0.5],
  [77, 35, 190, -1.5],
  [87, 55, 110, -2],
  [95, 65, 30, -1],
] as const;

const rise = "animate-[rise_300ms_ease-out]";

// The agent's terminal and the people's browser play the real loop: publish,
// comment, revise. At each handoff both windows buzz and a gust of wind
// carries the work across. It plays only while it is in view. With reduced
// motion it shows the last beat and stays still.
export function AgentLoop() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref, { amount: 0.4 });
  const still = usePrefersReducedMotion();
  const beat = useBeat(inView && !still, still ? BEAT_COUNT - 1 : 0);
  const { lines, doc, step, send } = sceneAt(beat);
  return (
    <div ref={ref}>
      <div className="grid md:grid-cols-[1fr_clamp(4rem,10vw,9rem)_1fr]">
        <Window label="Your agent" bar="zsh" buzz={!!send} dark>
          <Terminal lines={lines} animate={!still} />
        </Window>
        <div className="relative h-20 md:h-auto">
          {send && <Wind key={beat} reverse={send === "terminal"} />}
        </div>
        <Window
          label="Your team"
          bar={
            <Address path={doc === "none" ? "/app/documents" : `/app/d/${DOC_ID}`} />
          }
          buzz={!!send}
        >
          <Browser doc={doc} animate={!still} />
        </Window>
      </div>
      <ol className="mt-6 flex flex-wrap gap-x-8 gap-y-3 text-sm">
        {STEPS.map((label, i) => (
          <li
            key={label}
            className={cn(
              "flex items-center gap-2.5 transition-colors duration-300",
              i === step ? "text-[var(--color-fg)]" : "text-[var(--color-fg-muted)]",
            )}
          >
            <span
              className={cn(
                "h-0.5 w-5 rounded-full transition-colors duration-300",
                i === step
                  ? "bg-[var(--color-accent)]"
                  : "bg-[var(--color-border-strong)]",
              )}
            />
            {label}
          </li>
        ))}
      </ol>
    </div>
  );
}

// Steps through the beats in a loop while `play` is true.
function useBeat(play: boolean, start: number) {
  const [beat, setBeat] = useState(start);
  useEffect(() => {
    if (!play) return;
    const t = setTimeout(() => setBeat((b) => (b + 1) % BEAT_COUNT), beatMs(beat));
    return () => clearTimeout(t);
  }, [play, beat]);
  return beat;
}

// Reveals `text` one character at a time when `on` is true.
function useTyped(text: string, on: boolean, ms = TYPE_MS) {
  const [count, setCount] = useState(on ? 0 : text.length);
  useEffect(() => {
    if (count >= text.length) return;
    const t = setTimeout(() => setCount(count + 1), ms);
    return () => clearTimeout(t);
  }, [count, text, ms]);
  return text.slice(0, count);
}

function Window({
  label,
  bar,
  buzz,
  dark,
  children,
}: {
  label: string;
  bar: React.ReactNode;
  buzz: boolean;
  dark?: boolean;
  children: React.ReactNode;
}) {
  return (
    <figure className="min-w-0">
      <figcaption className="mb-3 text-sm font-medium text-[var(--color-fg-muted)]">
        {label}
      </figcaption>
      <div
        className={cn(
          "flex h-[300px] flex-col overflow-hidden rounded-md shadow-[var(--shadow-elevated)] md:h-[400px]",
          dark ? "bg-[#0b0b10] text-zinc-300" : "bg-[var(--color-surface)]",
          buzz && "buzz",
        )}
      >
        <div
          className={cn(
            "flex h-9 shrink-0 items-center gap-3 border-b px-3 text-[11px]",
            dark
              ? "border-white/10 text-zinc-500"
              : "border-[var(--color-border)] text-[var(--color-fg-muted)]",
          )}
        >
          <div className="flex gap-1.5">
            {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
              <span
                key={c}
                className="h-2.5 w-2.5 rounded-full"
                style={{ background: c }}
              />
            ))}
          </div>
          <div className="min-w-0 flex-1 truncate text-center">{bar}</div>
          <div className="w-12" />
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </figure>
  );
}

// Thin streaks that rush across the gap, from the sender to the receiver.
function Wind({ reverse }: { reverse: boolean }) {
  return (
    <div aria-hidden className="wind" data-reverse={reverse || undefined}>
      {STREAKS.map(([at, length, delay, tilt]) => (
        <i
          key={at}
          style={
            {
              "--at": `${at}%`,
              "--length": `${length}%`,
              "--tilt": `${tilt}deg`,
              animationDelay: `${delay}ms`,
            } as React.CSSProperties
          }
        />
      ))}
    </div>
  );
}

/* ── Terminal ───────────────────────────────────────────── */

const MARK: Record<Line["kind"], string> = {
  prompt: "›",
  note: "●",
  cmd: "$",
  out: "",
};

function Terminal({ lines, animate }: { lines: Line[]; animate: boolean }) {
  // Lines stack from the bottom, and the oldest scroll out under a fade.
  return (
    <div className="flex h-full flex-col justify-end gap-1.5 p-4 font-mono text-[11.5px] leading-relaxed [mask-image:linear-gradient(transparent,black_40px)] [overflow-wrap:anywhere]">
      {lines.map((line, i) => (
        <TerminalLine key={i} line={line} animate={animate} />
      ))}
    </div>
  );
}

function TerminalLine({ line, animate }: { line: Line; animate: boolean }) {
  const text = useTyped(line.text, animate && isTyped(line));
  return (
    <div className={cn(rise, isTyped(line) ? "text-zinc-100" : "text-zinc-400")}>
      {MARK[line.kind] && (
        <span className="mr-2 text-[#818cff]">{MARK[line.kind]}</span>
      )}
      {text}
      {text.length < line.text.length && <Caret className="w-[0.55em] bg-zinc-300" />}
    </div>
  );
}

function Caret({ className }: { className: string }) {
  return (
    <span className={cn("ml-px inline-block h-[1.1em] translate-y-[2px]", className)} />
  );
}

/* ── Browser ────────────────────────────────────────────── */

function Address({ path }: { path: string }) {
  return (
    <span className="rounded-md bg-[var(--color-surface-muted)] px-3 py-1 font-mono text-[10px]">
      {HOST}
      <span className="opacity-60">{path}</span>
    </span>
  );
}

function Browser({ doc, animate }: { doc: Doc; animate: boolean }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col text-[11px] text-[var(--color-fg)]">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <Logo className="h-2.5 w-auto" />
        {doc !== "none" && (
          <>
            <span className="truncate font-medium">{TITLE}</span>
            <span className="font-mono text-[10px] text-[var(--color-fg-muted)]">
              v{doc === "v2" ? 2 : 1}
            </span>
          </>
        )}
      </div>
      {doc === "none" ? (
        <div className="p-4">
          <div className="text-[15px] font-semibold tracking-tight">Documents</div>
          <div className="mt-4 rounded-sm border border-dashed border-[var(--color-border)] p-6 text-center text-[var(--color-fg-muted)]">
            No documents yet.
          </div>
        </div>
      ) : (
        <Document doc={doc} animate={animate} />
      )}
    </div>
  );
}

function Document({ doc, animate }: { doc: Doc; animate: boolean }) {
  const thread = doc === "open" || doc === "v2";
  return (
    <div
      className={cn(
        rise,
        "grid min-h-0 flex-1 grid-cols-[1fr_44%] sm:grid-cols-[1fr_180px]",
      )}
    >
      <article className="min-w-0 p-4 leading-relaxed sm:p-5">
        <div className="text-[15px] font-semibold tracking-tight">{TITLE}</div>
        <div className="mt-0.5 text-[10px] text-[var(--color-fg-muted)]">
          An explainer for new teammates
        </div>
        <p className="mt-3">
          Each GPS satellite broadcasts the time and its own position. Your receiver
          measures how long each signal took to arrive and turns that delay into a
          distance. With distances to <Phrase doc={doc} /> it fixes your position.
        </p>
        {doc === "v2" && (
          <p className={cn(rise, "mt-2.5")}>
            Three distances fix a point in space. The fourth solves for the error in the
            receiver clock.
          </p>
        )}
      </article>
      <aside className="flex min-w-0 flex-col gap-2 border-l border-[var(--color-border)] bg-[var(--color-surface-muted)]/40 p-2.5">
        <div className="font-semibold">
          Comments{" "}
          <span className="font-normal text-[var(--color-fg-muted)]">
            {thread ? 1 : 0}
          </span>
        </div>
        {doc === "composing" && <Composer animate={animate} />}
        {thread && <Thread resolved={doc === "v2"} />}
      </aside>
    </div>
  );
}

// The quoted words: a selection while someone comments, then the comment mark.
function Phrase({ doc }: { doc: Doc }) {
  const selected = doc === "selecting" || doc === "composing";
  const marked = doc === "open" || doc === "v2";
  return (
    <span
      className={cn(
        "whitespace-nowrap",
        selected && "select-sweep",
        marked &&
          "rounded-t-[2px] bg-[#fef3c7] text-zinc-900 shadow-[inset_0_-2px_0_#fbbf24]",
      )}
    >
      {QUOTE}
    </span>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div
      className={cn(
        rise,
        "flex flex-col gap-1.5 rounded-sm bg-[var(--color-surface)] p-2.5 ring-1 ring-[var(--color-border)]",
      )}
    >
      {children}
    </div>
  );
}

function Quote() {
  return (
    <blockquote className="border-l-2 border-[var(--color-border-strong)] pl-2 text-[var(--color-fg-muted)]">
      {QUOTE}
    </blockquote>
  );
}

function Composer({ animate }: { animate: boolean }) {
  // People type slower than agents.
  const text = useTyped(COMMENT, animate, TYPE_MS * 3);
  return (
    <Card>
      <Quote />
      <div className="min-h-8 rounded-md px-2 py-1.5 ring-1 ring-[var(--color-accent)]">
        {text}
        <Caret className="w-px bg-[var(--color-fg)]" />
      </div>
      <span className="self-end rounded-md bg-[var(--color-accent)] px-2.5 py-1 text-[10px] font-medium text-[var(--color-accent-fg)]">
        Comment
      </span>
    </Card>
  );
}

function Thread({ resolved }: { resolved: boolean }) {
  return (
    <Card>
      <div className="flex items-center justify-between font-semibold">
        priya
        {resolved ? (
          <Badge variant="success">
            <CheckCircle2 className="h-3 w-3" /> resolved
          </Badge>
        ) : (
          <Badge variant="accent">open</Badge>
        )}
      </div>
      <Quote />
      <p>{COMMENT}</p>
      {resolved && (
        <div className={cn(rise, "border-t border-[var(--color-border)] pt-1.5")}>
          <span className="font-semibold">agent</span> {REPLY}
        </div>
      )}
    </Card>
  );
}
