import { useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowLeft,
  ChevronRight,
  FileText,
  Keyboard,
  List,
  Search,
  Type,
} from "lucide-react";
import type { Principal } from "@/api";
import {
  chapterCrumb,
  type ChapterHeading,
  type Manifest,
  type ManifestLink,
} from "@/lib/books";
import { cn } from "@/lib/cn";
import { readerSettingsStore, type StoredReaderSettings } from "@/lib/reader-store";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
import { Segmented } from "@/components/ui/segmented";
import { AccountMenu } from "@/components/layout/topbar";
import { CommentsToggle } from "@/components/layout/doc-bar-frame";
import type { DocBarControls } from "./doc-workspace";
import { BookUpdateChip } from "./book-update-chip";

// The chapter reader's top bar: breadcrumb, update chip, search, reading
// settings and comments, with the section tracker under it.

const SIZE_OPTIONS = [
  { value: "s", label: "Small" },
  { value: "m", label: "Medium" },
  { value: "l", label: "Large" },
] as const;
const WIDTH_OPTIONS = [
  { value: "narrow", label: "Narrow" },
  { value: "comfortable", label: "Comfortable" },
  { value: "wide", label: "Wide" },
] as const;
const THEME_OPTIONS = [
  { value: "light", label: "Light" },
  { value: "paper", label: "Paper" },
  { value: "system", label: "System" },
] as const;

function setSetting(patch: Partial<StoredReaderSettings>) {
  readerSettingsStore.write({ ...readerSettingsStore.read(), ...patch });
}

// Aa: text size, line width, theme and single-key shortcuts (R11, A14).
// Settings are kept per device and apply to every book.
function ReadingSettings({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  const [open, setOpen] = useState(false);
  const s = readerSettingsStore.useStore();
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      label="Reading settings"
      trigger={
        <Button
          variant="ghost"
          size="icon"
          aria-label="Reading settings"
          className="shrink-0"
        >
          <Type className="h-4 w-4" />
        </Button>
      }
    >
      <div className="space-y-4">
        {(
          [
            ["Text size", "size", SIZE_OPTIONS],
            ["Line width", "width", WIDTH_OPTIONS],
            ["Theme", "theme", THEME_OPTIONS],
          ] as const
        ).map(([label, key, options]) => (
          <div key={key}>
            <p className="mb-1.5 text-xs font-medium text-[var(--color-fg-muted)]">
              {label}
            </p>
            <Segmented
              label={label}
              value={s[key]}
              options={[...options]}
              onChange={(value) => setSetting({ [key]: value })}
            />
          </div>
        ))}
        <label className="flex items-center justify-between gap-3">
          <span>
            <span className="block font-medium">Single-key shortcuts</span>
            <span className="block text-xs text-[var(--color-fg-muted)]">
              ← → for chapters, T for contents, / to search
            </span>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={s.shortcuts}
            aria-label="Single-key shortcuts"
            onClick={() => setSetting({ shortcuts: !s.shortcuts })}
            className={cn(
              "relative h-6 w-10 shrink-0 rounded-full transition-colors",
              s.shortcuts
                ? "bg-[var(--color-accent)]"
                : "bg-[var(--color-border-strong)]",
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-[left]",
                s.shortcuts ? "left-[18px]" : "left-0.5",
              )}
            />
          </button>
        </label>
        <div className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-fg-muted)]">
          <span>Saved on this device for every book.</span>
          <button
            type="button"
            className="inline-flex items-center gap-1 hover:text-[var(--color-fg)]"
            onClick={() => {
              setOpen(false);
              onShowShortcuts();
            }}
          >
            <Keyboard aria-hidden="true" className="h-3.5 w-3.5" />
            Shortcuts
          </button>
        </div>
      </div>
    </Popover>
  );
}

// Segments for the chapter's top-level sections, with the reader's one
// highlighted. A deeper heading counts as part of the section above it.
function SectionTracker({
  headings,
  section,
  onJump,
}: {
  headings: ChapterHeading[];
  section: string;
  onJump: (id: string) => void;
}) {
  const top = Math.min(...headings.map((h) => h.level));
  const segments = headings.filter((h) => h.level === top);
  const at = headings.findIndex((h) => h.id === section);
  let currentId = "";
  for (let i = at; i >= 0; i--) {
    if (headings[i].level === top) {
      currentId = headings[i].id;
      break;
    }
  }
  const currentIndex = segments.findIndex((s) => s.id === currentId);
  if (segments.length < 2) return null;
  return (
    <div className="flex h-8 items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-chrome)] px-4">
      <span className="w-40 shrink-0 truncate text-xs text-[var(--color-fg-muted)] sm:w-56">
        {currentIndex >= 0 ? segments[currentIndex].text : "Start of chapter"}
      </span>
      <div role="group" aria-label="Sections" className="flex min-w-0 flex-1 gap-1">
        {segments.map((s, i) => (
          <button
            key={s.id}
            type="button"
            aria-label={s.text}
            title={s.text}
            aria-current={i === currentIndex ? "location" : undefined}
            onClick={() => onJump(s.id)}
            className="group flex h-6 min-w-0 flex-1 items-center"
          >
            <span
              className={cn(
                "block h-1 w-full rounded-full transition-colors group-hover:h-1.5",
                i === currentIndex
                  ? "bg-[var(--color-accent)]"
                  : i < currentIndex
                    ? "bg-[color-mix(in_srgb,var(--color-accent)_35%,transparent)]"
                    : "bg-[var(--color-border)]",
              )}
            />
          </button>
        ))}
      </div>
    </div>
  );
}

export function ReaderBar({
  controls,
  bookId,
  manifest,
  link,
  version,
  shortcuts,
  isMobile,
  onContents,
  onSearch,
  onJump,
  onChipDismissed,
  headings,
  section,
  user,
}: {
  controls: DocBarControls;
  bookId: string;
  manifest: Manifest;
  link: ManifestLink;
  version: string;
  shortcuts: boolean;
  isMobile: boolean;
  onContents: () => void;
  onSearch: () => void;
  onJump: (id: string) => void;
  onChipDismissed: () => void;
  headings?: ChapterHeading[];
  section: string;
  user?: Principal;
}) {
  const home = `/app/b/${encodeURIComponent(bookId)}`;
  const docId = link.properties!.documentId!;
  return (
    <div>
      <header className="flex h-14 items-center gap-1 border-b border-[var(--color-border)] bg-[var(--color-chrome)] px-2 sm:gap-2 sm:px-3">
        {isMobile ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Contents"
            className="shrink-0"
            onClick={onContents}
          >
            <List className="h-4 w-4" />
          </Button>
        ) : (
          <Button asChild variant="ghost" size="icon" className="shrink-0">
            <Link to={home} title="Back to the book" aria-label="Back to the book">
              <ArrowLeft className="h-4 w-4" />
            </Link>
          </Button>
        )}
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-16 flex-1 items-center gap-1.5 text-sm"
        >
          <Link
            to={home}
            className="hidden max-w-48 shrink truncate text-[var(--color-fg-muted)] hover:text-[var(--color-fg)] sm:block"
          >
            {manifest.metadata.title}
          </Link>
          <ChevronRight
            aria-hidden="true"
            className="hidden h-3.5 w-3.5 shrink-0 text-[var(--color-fg-muted)] sm:block"
          />
          <span aria-current="page" className="truncate font-semibold">
            {chapterCrumb(link)}
          </span>
        </nav>
        <BookUpdateChip
          bookId={bookId}
          doc={docId}
          versionId={version}
          onOpenSection={onJump}
          onDismissed={onChipDismissed}
        />
        <Button
          variant="ghost"
          size="icon"
          aria-label="Search this book"
          aria-keyshortcuts={shortcuts ? "/" : undefined}
          tooltip={shortcuts ? "Search (/)" : "Search"}
          className="shrink-0"
          onClick={onSearch}
        >
          <Search className="h-4 w-4" />
        </Button>
        <ReadingSettings onShowShortcuts={controls.onShowShortcuts} />
        <Button
          asChild
          variant="ghost"
          size="icon"
          className="hidden shrink-0 sm:inline-flex"
        >
          <Link
            to={`/app/d/${encodeURIComponent(docId)}?version=${encodeURIComponent(version)}`}
            title="Open as a document, with versions and sharing"
            aria-label="Open as a document"
          >
            <FileText className="h-4 w-4" />
          </Link>
        </Button>
        <CommentsToggle
          open={controls.commentsOpen}
          onToggle={controls.onToggleComments}
        />
        {user ? (
          <span className="hidden sm:contents">
            <AccountMenu user={user} />
          </span>
        ) : null}
      </header>
      {headings?.length ? (
        <SectionTracker headings={headings} section={section} onJump={onJump} />
      ) : null}
    </div>
  );
}
