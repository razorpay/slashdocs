import { useEffect, useRef, type MouseEvent } from "react";
import { Link } from "react-router-dom";
import { BookOpen, Pin, PinOff } from "lucide-react";
import type { BookState, Manifest, ManifestLink } from "@/lib/books";
import { cn } from "@/lib/cn";
import { useIsMobile } from "@/lib/use-media-query";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { STATE_LABEL, rowState } from "./book-chapter-state";
import { StateDot } from "./book-state-dot";
import { useReaderKeys } from "./book-keys";

const RAIL_KEYS = ["t", "T"] as const;

// Shown while the rail is open: pinned, pointed at, or holding focus. The
// text stays in the accessibility tree either way, so every dot has a name.
const SHOWN =
  "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100 group-data-[expanded=true]:opacity-100";

type Group = { title?: string; links: ManifestLink[] };

// Front matter, then each part, then back matter, in reading order.
function groups(m: Manifest): Group[] {
  const kind = (k: string) => m.readingOrder.filter((l) => l.properties?.kind === k);
  return [
    { links: kind("front") },
    ...m.toc.map((t) => ({ title: t.title, links: t.children })),
    { links: kind("back") },
  ].filter((g) => g.links.length > 0);
}

function ChapterDot({
  link,
  state,
  current,
}: {
  link: ManifestLink;
  state: BookState | undefined;
  current: boolean;
}) {
  const id = link.properties?.documentId;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
        // The reader's chapter is ringed and slightly larger.
        current &&
          "ring-2 ring-[var(--color-accent)] ring-offset-1 ring-offset-[var(--color-chrome)]",
      )}
    >
      <StateDot
        state={rowState(link, state)}
        updated={!!id && !!state?.chapters[id]?.updated}
        className={current ? "h-3 w-3" : undefined}
      />
    </span>
  );
}

function RailRow({
  link,
  state,
  current,
  onNavigate,
}: {
  link: ManifestLink;
  state: BookState | undefined;
  current: boolean;
  onNavigate?: (href: string) => void;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (current) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [current]);
  const p = link.properties;
  const s = rowState(link, state);
  const updated = !!p?.documentId && !!state?.chapters[p.documentId]?.updated;
  const label = (
    <>
      <ChapterDot link={link} state={state} current={current} />
      <span className={cn("flex min-w-0 flex-1 items-baseline gap-2", SHOWN)}>
        {p?.number ? (
          <span className="w-6 shrink-0 text-right text-xs tabular-nums text-[var(--color-fg-muted)]">
            {p.number}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{link.title}</span>
        {/* The state as text too, never colour alone (R13). */}
        <span className="shrink-0 text-xs text-[var(--color-fg-muted)]">
          <span className="sr-only">, </span>
          {/* An empty ring is the quiet default; its label is only read out. */}
          <span className={s === "not_started" ? "sr-only" : undefined}>
            {STATE_LABEL[s]}
          </span>
          {updated ? (
            <span className="text-[var(--color-warning)]">
              <span aria-hidden="true"> · </span>
              <span className="sr-only">, </span>Updated
            </span>
          ) : null}
        </span>
      </span>
    </>
  );
  const base =
    "flex h-8 w-full items-center gap-3 rounded-sm px-[18px] text-sm outline-none";
  if (s === "planned" || !link.href) {
    return (
      <li>
        <div aria-disabled="true" className={cn(base, "text-[var(--color-fg-muted)]")}>
          {label}
        </div>
      </li>
    );
  }
  const href = link.href;
  const onClick = (e: MouseEvent) => {
    if (
      !onNavigate ||
      e.button !== 0 ||
      e.metaKey ||
      e.ctrlKey ||
      e.shiftKey ||
      e.altKey
    )
      return;
    e.preventDefault();
    onNavigate(href);
  };
  return (
    <li>
      <Link
        ref={ref}
        to={href}
        onClick={onClick}
        aria-current={current ? "page" : undefined}
        className={cn(
          base,
          "text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)] focus-visible:bg-[var(--color-surface-muted)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--color-accent)]",
          current &&
            "font-medium group-hover:bg-[var(--color-accent-muted)] group-data-[expanded=true]:bg-[var(--color-accent-muted)]",
        )}
      >
        {label}
      </Link>
    </li>
  );
}

function Contents({
  manifest,
  state,
  current,
  onNavigate,
}: {
  manifest: Manifest;
  state: BookState | undefined;
  current: string;
  onNavigate?: (href: string) => void;
}) {
  return (
    <div className="space-y-3 py-2">
      {groups(manifest).map((g, i) => (
        <div key={i} role="group" aria-label={g.title}>
          {g.title ? (
            <h2
              className={cn(
                "truncate px-[18px] pb-1 pt-1 text-[11px] font-medium uppercase tracking-wider text-[var(--color-fg-muted)]",
                SHOWN,
              )}
            >
              {g.title}
            </h2>
          ) : null}
          <ul>
            {g.links.map((l, j) => (
              <RailRow
                key={l.properties?.documentId ?? `planned-${j}`}
                link={l}
                state={state}
                current={l.properties?.documentId === current}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// The book's contents as a slim rail of chapter dots on the left (layout C).
// It opens to the full contents when pointed at or focused, and T pins it
// open. On phones it is a drawer instead, and `pinned` means the drawer is
// open.
export function BookRail({
  manifest,
  state,
  current,
  pinned,
  onPinnedChange,
  onNavigate,
  shortcuts = true,
}: {
  manifest: Manifest;
  state: BookState | undefined;
  // The document id of the chapter being read.
  current: string;
  pinned: boolean;
  onPinnedChange: (pinned: boolean) => void;
  // Called for a plain click on a chapter instead of following the link.
  onNavigate?: (href: string) => void;
  shortcuts?: boolean;
}) {
  const isMobile = useIsMobile();
  useReaderKeys(RAIL_KEYS, shortcuts, () => onPinnedChange(!pinned));
  const home = `/app/b/${encodeURIComponent(manifest.metadata.identifier)}`;
  const contents = (
    <Contents
      manifest={manifest}
      state={state}
      current={current}
      onNavigate={onNavigate}
    />
  );

  if (isMobile) {
    return (
      <Sheet open={pinned} onOpenChange={onPinnedChange}>
        <SheetContent side="left" className="max-w-xs p-0" aria-describedby={undefined}>
          <SheetHeader>
            <SheetTitle className="truncate">{manifest.metadata.title}</SheetTitle>
          </SheetHeader>
          <nav
            role="navigation"
            aria-label="Book contents"
            data-expanded="true"
            className="group flex-1 overflow-y-auto"
          >
            <Link
              to={home}
              className="mx-2 mt-2 flex h-9 items-center gap-2 rounded-sm px-[10px] text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)]"
            >
              <BookOpen aria-hidden="true" className="h-4 w-4" />
              Book home
            </Link>
            {contents}
          </nav>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <div
      className={cn(
        "relative hidden shrink-0 motion-safe:transition-[width] motion-safe:duration-200 md:block",
        pinned ? "w-[300px]" : "w-14",
      )}
    >
      <nav
        role="navigation"
        aria-label="Book contents"
        data-expanded={pinned ? "true" : "false"}
        className={cn(
          "group absolute inset-y-0 left-0 z-30 flex w-14 flex-col overflow-hidden border-r border-[var(--color-border)] bg-[var(--color-chrome)] motion-safe:transition-[width,box-shadow] motion-safe:duration-200",
          "hover:w-[300px] focus-within:w-[300px] data-[expanded=true]:w-[300px]",
          !pinned &&
            "hover:shadow-[var(--shadow-pop)] focus-within:shadow-[var(--shadow-pop)]",
        )}
      >
        <div className="flex h-14 w-[300px] shrink-0 items-center gap-1 border-b border-[var(--color-border)] pl-2 pr-2">
          <Link
            to={home}
            title="Book home"
            className="flex h-10 min-w-0 flex-1 items-center gap-3 rounded-sm px-[10px] text-sm font-semibold hover:bg-[var(--color-surface-muted)]"
          >
            <BookOpen aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span className={cn("truncate", SHOWN)}>{manifest.metadata.title}</span>
          </Link>
          <button
            type="button"
            aria-pressed={pinned}
            aria-label={pinned ? "Unpin contents" : "Pin contents open"}
            title={shortcuts ? `${pinned ? "Unpin" : "Pin"} contents (T)` : undefined}
            onClick={() => onPinnedChange(!pinned)}
            className={cn(
              "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]",
              SHOWN,
            )}
          >
            {pinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          </button>
        </div>
        <div className="w-[300px] flex-1 overflow-y-auto overflow-x-hidden [scrollbar-width:thin]">
          {contents}
        </div>
      </nav>
    </div>
  );
}
