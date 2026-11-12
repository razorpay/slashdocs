import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, FolderIcon, PanelRightClose, PanelRightOpen } from "lucide-react";
import { Logo } from "./logo";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";

// The bar above a document: back, home, the folder, and the title. The meta
// follows the title, and the children are the actions on the right.
export function DocBarFrame({
  home,
  folder,
  title,
  meta,
  children,
}: {
  home: string;
  folder?: { to: string; title: string };
  title: string;
  meta?: ReactNode;
  children?: ReactNode;
}) {
  const back = folder ? "Back to folder" : "Back to documents";
  return (
    <header className="flex h-14 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-chrome)] px-2 sm:gap-2 sm:px-3">
      <Button asChild variant="ghost" size="icon" className="shrink-0">
        <Link to={folder?.to ?? home} title={back} aria-label={back}>
          <ArrowLeft className="h-4 w-4" />
        </Link>
      </Button>
      <Tooltip label="All documents">
        <Link
          to={home}
          aria-label="slashdocs home"
          title="All documents"
          className="hidden h-10 shrink-0 items-center rounded-sm px-2 hover:bg-[var(--color-surface-muted)] sm:flex"
        >
          <Logo className="h-4 w-auto" />
        </Link>
      </Tooltip>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {folder ? (
          <>
            <Link
              to={folder.to}
              title={folder.title}
              aria-label={`Folder: ${folder.title}`}
              className="hidden h-10 max-w-32 shrink items-center gap-1 text-sm text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] lg:flex"
            >
              <FolderIcon className="h-4 w-4 shrink-0" />
              <span className="truncate">{folder.title}</span>
            </Link>
            <span
              aria-hidden="true"
              className="hidden text-[var(--color-fg-muted)] lg:inline"
            >
              /
            </span>
          </>
        ) : null}
        <div title={title} className="truncate text-sm font-semibold">
          {title}
        </div>
        {meta}
      </div>
      {children}
    </header>
  );
}

export function CommentsToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={onToggle}
      aria-label={open ? "Hide comments" : "Show comments"}
      tooltip={open ? false : "Show comments (Esc C)"}
      aria-pressed={open}
      className="shrink-0"
    >
      {open ? (
        <PanelRightClose className="h-4 w-4" />
      ) : (
        <PanelRightOpen className="h-4 w-4" />
      )}
    </Button>
  );
}
