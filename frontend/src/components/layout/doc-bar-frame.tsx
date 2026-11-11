import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, MessageSquareText } from "lucide-react";
import { Logo } from "./logo";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/cn";

// The open threads of a document, and whether the reader did not read one.
export type ThreadCount = { open: number; unread: boolean };

// The bar above a document: back, home and the title on the left, and every
// action on the right. The title is the bar's to fill, so that it can be a
// field to rename in. The children are the groups of actions, 12px apart.
export function DocBarFrame({
  home,
  folder,
  title,
  children,
}: {
  home: string;
  folder?: { to: string; title: string };
  title: ReactNode;
  children?: ReactNode;
}) {
  const back = folder ? `Back to ${folder.title}` : "Back to documents";
  return (
    <header className="flex h-14 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-chrome)] px-2 sm:gap-2 sm:px-3">
      <Button asChild variant="chrome" size="icon-sm" className="shrink-0">
        <Link to={folder?.to ?? home} title={back} aria-label={back}>
          <ArrowLeft className="size-4" />
        </Link>
      </Button>
      <Tooltip label="All documents">
        <Link
          to={home}
          aria-label="slashdocs home"
          title="All documents"
          className="hidden h-10 shrink-0 items-center rounded-[6px] px-2 hover:bg-[var(--color-highlight)] sm:flex"
        >
          <Logo className="h-4 w-auto" />
        </Link>
      </Tooltip>
      <div className="flex min-w-0 flex-1 items-center">{title}</div>
      <div className="flex shrink-0 items-center gap-3">{children}</div>
    </header>
  );
}

// BarGroup holds the actions of one kind, 2px apart.
export function BarGroup({ children }: { children: ReactNode }) {
  return <div className="flex shrink-0 items-center gap-0.5">{children}</div>;
}

// CommentsToggle opens the comments list. It counts the open threads, in an
// accent pill while the reader did not read one of them.
export function CommentsToggle({
  open,
  onToggle,
  threads,
}: {
  open: boolean;
  onToggle: () => void;
  threads: ThreadCount;
}) {
  return (
    <Button
      variant="chrome"
      size="icon-sm"
      onClick={onToggle}
      aria-label="Comments"
      aria-description={
        threads.open
          ? `${threads.open} open${threads.unread ? ", some unread" : ""}`
          : undefined
      }
      // One tooltip in both states keeps the same button, which the list
      // gives the focus back to.
      tooltip="Comments (Esc C)"
      aria-expanded={open}
      className="relative shrink-0"
    >
      <MessageSquareText className="size-4" />
      {threads.open ? (
        <span
          data-state="open"
          className={cn(
            "pop absolute -right-1 -top-1 min-w-4 rounded-full px-1 text-[10px] font-medium leading-4 tabular-nums ring-2 ring-[var(--color-chrome)]",
            threads.unread
              ? "bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
              : "bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]",
          )}
        >
          {threads.open}
        </span>
      ) : null}
    </Button>
  );
}
