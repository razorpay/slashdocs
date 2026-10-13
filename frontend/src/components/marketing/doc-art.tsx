import { useRef } from "react";
import { useInView } from "framer-motion";
import { Bot, Check } from "lucide-react";
import { cn } from "@/lib/cn";

// Drawn miniatures of real Razorpay documents for the landing page. Each one
// keeps the idea of the document, not its pixels, and follows the page theme.

const PEOPLE = [
  ["M", "#1364f1"],
  ["A", "#c75300"],
  ["L", "#00753b"],
  ["K", "#8b3dd1"],
] as const;

const muted = "text-[var(--color-fg-muted)]";
const tint = (color: string, pct = 14) =>
  `color-mix(in srgb, ${color} ${pct}%, transparent)`;

// A tinted canvas that crops the document at its bottom edge.
function Stage({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      aria-hidden
      className={cn(
        "relative h-56 select-none overflow-hidden border-b border-[var(--color-border)] bg-[var(--color-surface-muted)] text-[var(--color-fg)] md:h-72",
        className,
      )}
    >
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_100%_0%,color-mix(in_srgb,var(--razorsense-wash-from)_24%,transparent),transparent_60%)]" />
      {children}
    </div>
  );
}

// A slashdocs document: the title and version bar, then the HTML.
function Paper({
  title,
  version,
  className,
  children,
}: {
  title: string;
  version: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "absolute inset-x-6 top-6 h-[130%] overflow-hidden rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-pop)] transition-transform duration-500 ease-[var(--ease-slash)] group-hover:-translate-y-1 md:inset-x-8 md:top-8 dark:border-transparent",
        className,
      )}
    >
      <div className="flex h-8 items-center gap-2 border-b border-[var(--color-border)] px-3 text-[11px]">
        <span className="truncate font-medium">{title}</span>
        <span className={cn("font-mono", muted)}>{version}</span>
      </div>
      {children}
    </div>
  );
}

function Avatar({
  person: [initial, color],
  className,
  style,
}: {
  person: readonly [string, string];
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <span
      className={cn(
        "grid h-5 w-5 shrink-0 place-items-center rounded-full text-[9px] font-semibold text-white",
        className,
      )}
      style={{ background: color, ...style }}
    >
      {initial}
    </span>
  );
}

function Lines({ widths }: { widths: string[] }) {
  return (
    <div className="grid gap-1.5">
      {widths.map((w, i) => (
        <span
          key={i}
          className="h-1.5 rounded-full bg-[var(--color-border)]"
          style={{ width: w }}
        />
      ))}
    </div>
  );
}

const KPIS = [
  ["Manual fixes", "14", "−38"],
  ["Merged PRs", "64", "+12"],
  ["Time at gate", "11m", "−3m"],
  ["Green first try", "92%", "+7pt"],
];
// Manual fixes per day, falling as the team fixes the flaky suites.
const BARS = [6, 9, 7, 12, 8, 5, 10, 7, 4, 6, 3, 5, 2, 3];

export function ReportArt() {
  return (
    <Stage>
      <Paper title="Devstack E2E developer pain" version="v1">
        <div className="p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold">
              Manual interventions, last 7 days
            </span>
            <span
              className={cn("flex shrink-0 items-center gap-1.5 text-[10px]", muted)}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--color-success)] motion-safe:animate-pulse" />
              Updates at 08:00 and 20:00
            </span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            {KPIS.map(([label, value, delta]) => (
              <div
                key={label}
                className="rounded-sm border border-[var(--color-border)] p-2"
              >
                <div
                  className={cn("truncate text-[9px] uppercase tracking-wide", muted)}
                >
                  {label}
                </div>
                <div className="mt-0.5 text-base font-semibold tabular-nums">
                  {value}
                </div>
                <div className="text-[9px] text-[var(--color-success)]">
                  {delta} vs last week
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex h-16 items-end gap-1">
            {BARS.map((h, i) => (
              <span
                key={i}
                className={cn(
                  "flex-1 rounded-t-[3px]",
                  i === BARS.length - 1
                    ? "bg-[var(--color-accent)]"
                    : "bg-[var(--color-accent-muted)]",
                )}
                style={{ height: `${h * 8}%` }}
              />
            ))}
          </div>
        </div>
      </Paper>
    </Stage>
  );
}

export function DeckArt() {
  return (
    <Stage>
      <div className="absolute left-1/2 top-8 aspect-[16/10] w-[78%] -translate-x-1/2 md:top-12">
        {[2, 1].map((n) => (
          <div
            key={n}
            className="absolute inset-0 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] dark:border-transparent"
            style={{
              transform: `translate(${n * 12}px, ${n * -10}px) rotate(${n * 2.5}deg)`,
            }}
          />
        ))}
        <div className="absolute inset-0 rounded-md bg-[linear-gradient(150deg,#0e54cd,#1364f1_45%,#5a81f1)] p-4 text-white shadow-[var(--shadow-pop)] transition-transform duration-500 ease-[var(--ease-slash)] group-hover:-translate-y-1 md:p-5">
          <div className="text-[9px] uppercase tracking-[0.2em] opacity-70">
            Proposal · August
          </div>
          <div className="mt-2 max-w-[13ch] font-[family-name:var(--font-heading)] text-lg font-semibold leading-tight md:text-2xl">
            Quick commerce runs on fast money
          </div>
          <div className="absolute inset-x-4 bottom-3 flex gap-1 md:inset-x-5">
            {Array.from({ length: 8 }, (_, i) => (
              <span
                key={i}
                className={cn(
                  "h-0.5 flex-1 rounded-full",
                  i < 3 ? "bg-white" : "bg-white/30",
                )}
              />
            ))}
          </div>
        </div>
        <span className="absolute -bottom-3 right-4 flex items-center gap-1 rounded-full rounded-bl-none bg-[var(--color-surface)] py-1 pl-1 pr-2 text-[10px] shadow-[var(--shadow-pop)]">
          <Avatar person={PEOPLE[1]} className="h-4 w-4" /> Slide 3?
        </span>
      </div>
    </Stage>
  );
}

export function MagazineArt() {
  return (
    <Stage>
      <div className="absolute left-1/2 top-8 h-[130%] w-[64%] -translate-x-1/2 rotate-3 rounded-sm bg-[var(--color-surface)] shadow-[var(--shadow-card)]" />
      <div className="absolute left-1/2 top-6 h-[130%] w-[64%] -translate-x-1/2 overflow-hidden rounded-sm bg-[linear-gradient(165deg,#5d6b6c,#1f2e31_55%,#101819)] p-5 text-white shadow-[var(--shadow-pop)] transition-transform duration-500 ease-[var(--ease-slash)] group-hover:-translate-y-1 md:top-8">
        <span className="border border-white/40 px-2 py-0.5 font-mono text-[8px] uppercase tracking-[0.3em] text-white/70">
          Edition 01
        </span>
        <div className="mt-6 font-[Georgia,serif] text-3xl font-bold leading-[0.95] md:text-4xl">
          Bootcamp
          <div className="font-normal italic text-[#e8a88e]">Magazine</div>
        </div>
        <p className="mt-3 border-l-2 border-[#e8a88e] pl-2 text-[10px] leading-snug text-white/75">
          One month, 36 new engineers, and the projects they shipped.
        </p>
        <div className="mt-4 font-mono text-[8px] uppercase tracking-[0.2em] text-white/60">
          36 rookies · 12 teams · 1 demo day
        </div>
      </div>
    </Stage>
  );
}

const SKETCH = ["Payment", "Webhook queue", "Delivery worker", "Merchant"];
const HAND = { fontFamily: "'Chalkboard SE', 'Comic Sans MS', 'Segoe Print', cursive" };

export function SketchArt() {
  // SMIL runs on the main thread on every frame, also off screen, so the dot
  // moves only while the drawing is in view.
  const ref = useRef<SVGSVGElement>(null);
  const inView = useInView(ref);
  return (
    <Stage>
      <Paper title="PR #4812 explainer: retry failed webhooks" version="v1">
        <svg
          ref={ref}
          viewBox="0 0 640 230"
          className="h-auto w-full text-[var(--color-fg)]"
          style={HAND}
        >
          <defs>
            <pattern
              id="hatch"
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="6"
                stroke="currentColor"
                strokeWidth="1.5"
                opacity="0.16"
              />
            </pattern>
          </defs>
          <text x="24" y="38" fontSize="22" fill="currentColor">
            Retry failed webhook deliveries
          </text>
          {SKETCH.map((label, i) => {
            const x = 24 + i * 152;
            return (
              <g key={label}>
                <rect
                  x={x}
                  y="64"
                  width="116"
                  height="56"
                  rx="4"
                  fill="url(#hatch)"
                  stroke="currentColor"
                  strokeWidth="1.8"
                />
                <text
                  x={x + 58}
                  y="97"
                  fontSize="14"
                  textAnchor="middle"
                  fill="currentColor"
                >
                  {label}
                </text>
                {i < 3 && (
                  <path
                    d={`M${x + 122} 92 h28 m-7 -5 l7 5 l-7 5`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.8"
                  />
                )}
              </g>
            );
          })}
          <text x="540" y="146" fontSize="15" fill="var(--color-danger)">
            503 · busy
          </text>
          <text x="490" y="56" fontSize="15" fill="var(--color-success)">
            200 OK on try 2
          </text>
          <path
            d="M350 120 C 346 150, 340 172, 330 186 M440 186 C 430 170, 424 150, 420 126 m-5 6 l5 -6 l5 6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <rect
            x="300"
            y="186"
            width="190"
            height="34"
            rx="4"
            fill="#facc15"
            fillOpacity="0.25"
            stroke="currentColor"
            strokeWidth="1.8"
          />
          <text x="395" y="208" fontSize="13" textAnchor="middle" fill="currentColor">
            retry at 1s · 4s · 16s · 64s
          </text>
          {inView && (
            <circle r="5" fill="var(--color-accent)" className="motion-reduce:hidden">
              <animateMotion dur="4s" repeatCount="indefinite" path="M82 92 H540" />
            </circle>
          )}
        </svg>
      </Paper>
    </Stage>
  );
}

const SECTIONS = [
  ["3", "Flow", 3],
  ["4", "Risks", 2],
  ["5", "Rollout", 1],
] as const;

export function ReceiptsArt() {
  return (
    <Stage className="md:h-52">
      <Paper title="Spec: instant refunds to UPI" version="v2">
        <div className="grid gap-3 p-4">
          {SECTIONS.map(([n, title, read]) => (
            <div key={n}>
              <div className="text-xs font-semibold">
                <span className={muted}>{n}</span> {title}
              </div>
              <div className="mt-1.5 flex items-center gap-1">
                {PEOPLE.map((p, i) => (
                  <span
                    key={p[0]}
                    className={cn(
                      "flex items-center gap-0.5 rounded-full p-0.5 pr-1.5",
                      i < read ? "bg-[var(--color-accent-muted)]" : "opacity-50",
                    )}
                  >
                    <Avatar person={p} className="h-3.5 w-3.5 text-[7px]" />
                    {i < read && (
                      <Check className="h-2.5 w-2.5 text-[var(--color-accent)]" />
                    )}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Paper>
      <span className="absolute bottom-3 right-4 rounded-md bg-[#16191d] px-3 py-2 text-[11px] font-medium text-white shadow-[var(--shadow-pop)] dark:bg-[#2b2e33]">
        Thanks for reading, Maya 🎉
      </span>
    </Stage>
  );
}

const ENDPOINTS = [
  ["GET", "/v2/payouts", "var(--color-success)"],
  ["POST", "/v2/payouts", "var(--color-accent)"],
  ["POST", "/v2/payouts/{id}/cancel", "var(--color-accent)"],
  ["PATCH", "/v2/fund_accounts/{id}", "var(--color-warning)"],
  ["DELETE", "/v2/fund_accounts/{id}", "var(--color-danger)"],
] as const;

export function GitHubArt() {
  return (
    <Stage className="md:h-52">
      <Paper title="Payouts API reference" version="v1">
        <div className="p-4">
          <span className="inline-flex max-w-full items-center gap-1.5 truncate rounded-sm bg-[var(--color-surface-muted)] px-2 py-1 font-mono text-[10px]">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--color-success)]" />
            acme/payouts <span className={muted}>openapi.json @ main</span>
          </span>
          <div className="mt-3 grid gap-1.5">
            {ENDPOINTS.map(([method, path, color]) => (
              <div
                key={method + path}
                className="flex items-center gap-2 font-mono text-[10px]"
              >
                <span
                  className="w-12 rounded-[4px] py-0.5 text-center text-[9px] font-semibold"
                  style={{ color, background: tint(color) }}
                >
                  {method}
                </span>
                <span className="truncate">{path}</span>
              </div>
            ))}
          </div>
        </div>
      </Paper>
    </Stage>
  );
}

// The same diagram in both themes. The colors are fixed, because the art
// shows each theme whatever the page uses.
const THEMES = {
  light: {
    paper: "#ffffff",
    fg: "#050505",
    line: "#8a949b",
    node: "#f7f7f7",
    edge: "#c8cdd0",
  },
  dark: {
    paper: "#16181b",
    fg: "#ffffff",
    line: "#7894d9",
    node: "#1f2a44",
    edge: "#395eb7",
  },
};

function Diagram({ theme }: { theme: keyof typeof THEMES }) {
  const c = THEMES[theme];
  return (
    <svg
      viewBox="0 0 370 170"
      className="h-full w-full"
      style={{ background: c.paper }}
    >
      <text x="20" y="30" fontSize="13" fontWeight="600" fill={c.fg}>
        Settlement ledger
      </text>
      <path
        d="M100 75 C 130 75, 130 100, 150 100 M100 125 C 130 125, 130 100, 150 100 M230 100 C 250 100, 250 75, 270 75 M230 100 C 250 100, 250 125, 270 125"
        fill="none"
        stroke={c.line}
        strokeWidth="1.5"
      />
      {[
        [20, 60, "Payments"],
        [20, 110, "Refunds"],
        [150, 85, "Ledger"],
        [270, 60, "Balance"],
        [270, 110, "Recon"],
      ].map(([x, y, label]) => (
        <g key={label}>
          <rect
            x={x}
            y={y}
            width="80"
            height="30"
            rx="6"
            fill={c.node}
            stroke={c.edge}
          />
          <text
            x={Number(x) + 40}
            y={Number(y) + 19}
            fontSize="10"
            textAnchor="middle"
            fill={c.fg}
          >
            {label}
          </text>
        </g>
      ))}
    </svg>
  );
}

export function ThemeArt() {
  return (
    <Stage className="md:h-52">
      <div className="absolute inset-x-6 top-6 bottom-6 overflow-hidden rounded-md shadow-[var(--shadow-pop)] transition-transform duration-500 ease-[var(--ease-slash)] group-hover:-translate-y-1 md:inset-x-8">
        <Diagram theme="light" />
        <div className="absolute inset-0 [clip-path:polygon(70%_0,100%_0,100%_100%,62%_100%)]">
          <Diagram theme="dark" />
        </div>
      </div>
      <span className="absolute bottom-3 left-3 rounded-sm border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[10px] shadow-[var(--shadow-card)]">
        Esc t
      </span>
    </Stage>
  );
}

export function ScreenerArt() {
  return (
    <Stage>
      <Paper
        title="Ledger Lens · Day 0 idea"
        version="v2"
        className="right-[22%] md:right-[26%]"
      >
        <div className="grid gap-4 p-4">
          <div>
            <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--color-accent)]">
              One-line pitch
            </div>
            <p className="mt-1.5 text-xs leading-relaxed">
              Ledger Lens finds settlement mismatches{" "}
              <mark className="rounded-[2px] bg-[#facc15]/40 px-0.5 text-inherit">
                for finance analysts
              </mark>{" "}
              and explains each one.
            </p>
          </div>
          <div>
            <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-[var(--color-accent)]">
              Problem
            </div>
            <div className="mt-2">
              <Lines widths={["100%", "92%", "70%"]} />
            </div>
          </div>
        </div>
      </Paper>
      <div className="absolute right-4 top-24 w-[46%] rounded-md bg-[var(--color-surface)] p-3 shadow-[var(--shadow-pop)] md:right-6 md:top-32 md:w-[40%]">
        <div className="flex items-center gap-1.5 text-[10px] font-medium">
          <span className="grid h-5 w-5 place-items-center rounded-full bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
            <Bot className="h-3 w-3" />
          </span>
          day0-screener.bot
        </div>
        <p className="mt-2 text-[11px] leading-snug">
          Name the user and the result in one sentence.
        </p>
        <div className="mt-2 flex items-center gap-1 text-[10px] text-[var(--color-success)]">
          <Check className="h-3 w-3" /> Resolved in v2
        </div>
      </div>
    </Stage>
  );
}
