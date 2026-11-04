import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import {
  Link,
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  FileText,
  Keyboard,
  List,
  Search,
  Type,
  Undo2,
  X,
} from "lucide-react";
import type { RestoreMethod } from "../../bridge/reading";
import type { Principal } from "@/api";
import {
  booksApi,
  chapterByNumber,
  chapterName,
  neighbours,
  partTitle,
  shouldOfferOtherDevice,
  latestPosition,
  type BookState,
  type ChapterHeading,
  type Manifest,
  type ManifestLink,
  type ReadingPosition,
} from "@/lib/books";
import { queryKeys } from "@/lib/queryKeys";
import { useMe } from "@/lib/hooks";
import { useTitle } from "@/lib/use-title";
import { useIsMobile } from "@/lib/use-media-query";
import { cn } from "@/lib/cn";
import {
  deviceIdStore,
  readerSettingsStore,
  useReaderSettings,
  type StoredReaderSettings,
} from "@/lib/reader-store";
import { Button } from "@/components/ui/button";
import { Center, Skeleton } from "@/components/ui/misc";
import { Popover } from "@/components/ui/popover";
import { Segmented } from "@/components/ui/segmented";
import { AccountMenu } from "@/components/layout/topbar";
import { CommentsToggle } from "@/components/layout/doc-bar-frame";
import {
  useDoc,
  type PositionTarget,
  type ReaderOptions,
  type ReaderViewport,
} from "./doc-context";
import { DocWorkspace, type DocBarControls } from "./doc-workspace";
import { useDocumentStream } from "./use-document-stream";
import { useReadingPosition } from "./use-reading-position";
import { BookError } from "./book-home";
import { BookRail } from "./book-rail";
import { BookSearch } from "./book-search";
import { BookUpdateChip } from "./book-update-chip";
import { useBookState, useChapterChanges, useManifest } from "./book-chapter-state";
import { useReaderKeys } from "./book-keys";

const END_PROGRESSION = 0.98;
const PAGE_KEYS = ["ArrowLeft", "ArrowRight", "/"] as const;
const RESTORE_FAILED =
  "Couldn't find your saved place in this version, so the chapter opens at the top.";

// Where a jump left from, so "Back to where you were" can return there.
type Back = { href: string; docId: string; target: PositionTarget };
// Router state a chapter link can carry: a place to restore on arrival, and
// where the jump came from.
type ArrivalState = { restore?: PositionTarget; back?: Back } | null;

const NOT_IN_BOOK = (
  <Center>
    <p className="text-sm text-[var(--color-fg-muted)]">
      That chapter is not available in this book.
    </p>
  </Center>
);

// /app/b/:bookId/:number resolves through the manifest to the canonical
// chapter URL (A11).
export function BookNumberRoute() {
  const { bookId = "", number = "" } = useParams();
  const q = useManifest(bookId);
  if (q.isLoading) return <Skeleton className="m-6 h-40" />;
  if (q.error) return <BookError error={q.error} />;
  const link = q.data && chapterByNumber(q.data, Number(number));
  if (!link?.href) return NOT_IN_BOOK;
  return <Navigate to={link.href} replace />;
}

// /app/b/:bookId/c/:docId, the chapter reader.
export function BookReaderRoute() {
  const { bookId = "", docId = "" } = useParams();
  const manifest = useManifest(bookId);
  if (manifest.isLoading) {
    return (
      <div className="flex h-full">
        <Skeleton className="h-full w-14 rounded-none" />
        <div className="flex-1 p-6">
          <Skeleton className="mb-3 h-7 w-72" />
          <Skeleton className="h-[60vh] w-full" />
        </div>
      </div>
    );
  }
  if (manifest.error || !manifest.data) return <BookError error={manifest.error} />;
  const link = manifest.data.readingOrder.find(
    (l) => l.properties?.documentId === docId && l.href,
  );
  if (!link) return NOT_IN_BOOK;
  return <BookReader bookId={bookId} manifest={manifest.data} link={link} />;
}

const toTarget = (p: ReadingPosition): PositionTarget => ({
  anchor: p.anchor?.quote ? p.anchor : undefined,
  section: p.section_id || undefined,
  progression: p.progression,
});

function crumb(l: ManifestLink): string {
  const n = l.properties?.number;
  return n ? `${n} · ${l.title}` : l.title;
}

function BookReader({
  bookId,
  manifest,
  link,
}: {
  bookId: string;
  manifest: Manifest;
  link: ManifestLink;
}) {
  const docId = link.properties!.documentId!;
  const href = link.href!;
  const nav = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const fullscreen = searchParams.get("fullscreen") === "1";
  const qc = useQueryClient();
  const me = useMe();
  const isMobile = useIsMobile();
  const state = useBookState(bookId);
  const { shortcuts } = readerSettingsStore.useStore();
  const settings = useReaderSettings();
  const [pinned, setPinned] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  useTitle(`${link.title} · ${manifest.metadata.title}`);

  const invalidateBook = useCallback(
    () => qc.invalidateQueries({ queryKey: queryKeys.book(bookId) }),
    [qc, bookId],
  );

  // The version being read. It stays put when someone publishes a newer one
  // mid-chapter; the reader is told and can move on.
  const latest = link.properties?.versionId ?? "";
  const [held, setHeld] = useState<{ doc: string; version: string }>();
  const current = (held?.doc === docId && held.version) || latest;
  const stream = useDocumentStream({
    docId,
    version: current,
    principal: me.data?.principal,
    onRemoteDocumentChange: () => {
      setHeld((h) => (h?.doc === docId ? h : { doc: docId, version: current }));
      void invalidateBook();
    },
  });
  const seenLatest = useRef({ doc: docId, version: latest });
  useEffect(() => {
    const prev = seenLatest.current;
    seenLatest.current = { doc: docId, version: latest };
    if (prev.doc !== docId || !prev.version || prev.version === latest) return;
    if (current !== prev.version) return;
    toast.info("A new version of this chapter is available.", {
      action: { label: "View", onClick: () => setHeld(undefined) },
    });
  }, [docId, latest, current]);

  // Reading position, saved as the reader scrolls.
  const position = useReadingPosition({
    bookId,
    documentId: docId,
    versionId: current,
    enabled: state.isSuccess && !!current,
    onReachedEnd: invalidateBook,
  });
  const lastView = useRef<ReaderViewport | null>(null);
  const [section, setSection] = useState("");
  const [atEnd, setAtEnd] = useState(false);
  const { onViewport: saveViewport, onRestored: restoreDone } = position;
  const onViewport = useCallback(
    (v: ReaderViewport) => {
      saveViewport(v);
      lastView.current = v;
      setSection(v.section);
      setAtEnd(v.progression >= END_PROGRESSION);
    },
    [saveViewport],
  );

  // restorePosition lives in the document context, below this component.
  const restoreRef = useRef<((t: PositionTarget) => void) | null>(null);
  // Set while the frame restores a saved place, so a miss is reported.
  const restoringSaved = useRef(false);
  const restoreSaved = useCallback((t: PositionTarget) => {
    restoringSaved.current = true;
    restoreRef.current?.(t);
  }, []);
  const onRestored = useCallback(
    (method: RestoreMethod) => {
      restoreDone();
      if (method === "none" && restoringSaved.current) toast.info(RESTORE_FAILED);
      restoringSaved.current = false;
    },
    [restoreDone],
  );

  const [back, setBack] = useState<Back | null>(null);
  const here = useCallback(
    (): Back => ({
      href,
      docId,
      target: lastView.current
        ? {
            anchor: lastView.current.anchor,
            section: lastView.current.section || undefined,
            progression: lastView.current.progression,
          }
        : { progression: 0 },
    }),
    [href, docId],
  );
  const jumpWithin = useCallback(
    (t: PositionTarget) => {
      setBack(here());
      restoreRef.current?.(t);
    },
    [here],
  );
  const goChapter = useCallback(
    (to: string, jump: boolean) => {
      if (isMobile) setPinned(false);
      nav(to, { state: jump ? ({ back: here() } satisfies ArrivalState) : null });
    },
    [nav, here, isMobile],
  );

  // A chapter visit starts: open it, restore the saved place, and offer
  // another device's newer one.
  const [offer, setOffer] = useState<ReadingPosition | null>(null);
  const visited = useRef("");
  const opened = useRef("");
  useEffect(() => {
    if (!current || opened.current === docId) return;
    opened.current = docId;
    booksApi.open(bookId, docId, current).then(invalidateBook, () => {});
  }, [bookId, docId, current, invalidateBook]);
  useEffect(() => {
    setAtEnd(false);
    setSection("");
    lastView.current = null;
    setBack((location.state as ArrivalState)?.back ?? null);
    setOffer(null);
    // A new chapter only; same-chapter links keep the visit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);
  const stateSettled = state.isSuccess || state.isError;
  useEffect(() => {
    if (!stateSettled || visited.current === docId) return;
    visited.current = docId;
    const arrival = location.state as ArrivalState;
    if (arrival?.restore) {
      restoreSaved(arrival.restore);
      return;
    }
    const s = state.data;
    const device = deviceIdStore.read();
    const mine = s?.positions.find((p) => p.device_id === device);
    const other = s ? latestPosition(s, device) : undefined;
    if (other && shouldOfferOtherDevice(mine, other)) setOffer(other);
    // An explicit link wins over the saved place.
    if (location.hash) {
      restoreDone();
      return;
    }
    if (mine?.document_id === docId) restoreSaved(toTarget(mine));
    else restoreDone();
    // Runs once per chapter visit, when the state first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateSettled, docId]);

  // Focus and announce the chapter when it changes (R13).
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [announcement, setAnnouncement] = useState("");
  const firstChapter = useRef(docId);
  const name = chapterName(link);
  useEffect(() => {
    if (firstChapter.current === docId) return;
    firstChapter.current = "";
    titleRef.current?.focus();
    setAnnouncement(name);
  }, [docId, name]);

  const { prev, next } = neighbours(manifest, href);
  const onKey = useCallback(
    (key: string) => {
      if (key === "ArrowLeft" && prev?.href) goChapter(prev.href, false);
      else if (key === "ArrowRight" && next?.href) goChapter(next.href, false);
      else if (key === "t" || key === "T") setPinned((p) => !p);
      else if (key === "/") setSearchOpen(true);
    },
    [prev?.href, next?.href, goChapter],
  );
  useReaderKeys(PAGE_KEYS, shortcuts, onKey);
  // Keys pressed inside the chapter, forwarded by the frame.
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;
  const onKeyRef = useRef(onKey);
  onKeyRef.current = onKey;
  const onFrameKey = useCallback((key: string) => {
    if (shortcutsRef.current) onKeyRef.current(key);
  }, []);

  const updated = !!state.data?.chapters[docId]?.updated;
  const changes = useChapterChanges(bookId, docId, updated);
  const markHeadings = useMemo(
    () =>
      updated && changes.data
        ? changes.data.changed_sections.filter((s) => !s.removed).map((s) => s.id)
        : undefined,
    [updated, changes.data],
  );
  const reader = useMemo<ReaderOptions>(
    () => ({
      onViewport,
      settings,
      markHeadings,
      frameTitle: name,
      onKey: onFrameKey,
      onRestored,
    }),
    [onViewport, settings, markHeadings, name, onFrameKey, onRestored],
  );

  const headings = useQuery({
    queryKey: queryKeys.headings(docId, current),
    queryFn: () => booksApi.headings(docId, current),
    enabled: !!current,
    staleTime: Infinity,
    meta: { suppressGlobalError: true },
  });

  const goOffer = () => {
    if (!offer) return;
    setOffer(null);
    if (offer.document_id === docId) {
      setBack(here());
      restoreSaved(toTarget(offer));
      return;
    }
    const to = manifest.readingOrder.find(
      (l) => l.properties?.documentId === offer.document_id,
    )?.href;
    if (!to) return;
    nav(to, {
      state: { restore: toTarget(offer), back: here() } satisfies ArrivalState,
    });
  };
  const goBack = () => {
    if (!back) return;
    setBack(null);
    if (back.docId === docId) restoreSaved(back.target);
    else nav(back.href, { state: { restore: back.target } satisfies ArrivalState });
  };
  const openResult = (to: string, resultDoc: string) => {
    setSearchOpen(false);
    if (resultDoc === docId) {
      setBack(here());
      nav(to, { replace: true });
    } else {
      goChapter(to, true);
    }
  };

  return (
    <div className="flex h-full">
      <h1 ref={titleRef} tabIndex={-1} className="sr-only">
        {name}
      </h1>
      <div
        role="status"
        aria-live="polite"
        aria-label="Chapter announcement"
        className="sr-only"
      >
        {announcement}
      </div>
      {fullscreen ? null : (
        <BookRail
          manifest={manifest}
          state={state.data}
          current={docId}
          pinned={pinned}
          onPinnedChange={setPinned}
          onNavigate={(to) => goChapter(to, true)}
          shortcuts={shortcuts}
        />
      )}
      <div className="min-w-0 flex-1">
        <DocWorkspace
          key={docId}
          docId={docId}
          version={current}
          principal={me.data?.principal}
          home={`/app/b/${encodeURIComponent(bookId)}`}
          stream={stream}
          reader={reader}
          overlay={
            <ReaderOverlay
              restoreRef={restoreRef}
              offer={offer && <OfferNote offer={offer} manifest={manifest} />}
              onGoOffer={goOffer}
              onDismissOffer={() => setOffer(null)}
              back={!!back}
              onBack={goBack}
              onDismissBack={() => setBack(null)}
              end={
                atEnd ? (
                  <EndOfChapter
                    bookId={bookId}
                    docId={docId}
                    manifest={manifest}
                    link={link}
                    next={next}
                    state={state.data}
                  />
                ) : null
              }
            />
          }
          bar={(controls) => (
            <ReaderBar
              controls={controls}
              bookId={bookId}
              manifest={manifest}
              link={link}
              version={current}
              shortcuts={shortcuts}
              isMobile={isMobile}
              onContents={() => setPinned(true)}
              onSearch={() => setSearchOpen(true)}
              onJump={(id) => jumpWithin({ section: id })}
              headings={headings.data?.items}
              section={section}
              user={me.data?.user || me.data?.principal}
            />
          )}
        />
      </div>
      <BookSearch
        open={searchOpen}
        onOpenChange={setSearchOpen}
        bookId={bookId}
        manifest={manifest}
        currentDoc={docId}
        onOpen={openResult}
      />
    </div>
  );
}

// Gives the reader the frame's restorePosition, which only the document
// context below it has.
function CaptureRestore({
  into,
}: {
  into: RefObject<((t: PositionTarget) => void) | null>;
}) {
  const { restorePosition } = useDoc();
  useEffect(() => {
    into.current = restorePosition ?? null;
    return () => {
      into.current = null;
    };
  }, [into, restorePosition]);
  return null;
}

function Note({
  label,
  children,
  onDismiss,
}: {
  label: string;
  children: ReactNode;
  onDismiss: () => void;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className="pointer-events-auto flex max-w-full items-center gap-2 rounded-full bg-[var(--color-surface)] py-1 pl-4 pr-1 text-sm shadow-[var(--shadow-pop)] ring-1 ring-[var(--color-border)]"
    >
      {children}
      <button
        type="button"
        aria-label="Dismiss"
        onClick={onDismiss}
        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
      >
        <X aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// "Ch 3 · Retries": the other device's chapter and, once known, its section.
function OfferNote({
  offer,
  manifest,
}: {
  offer: ReadingPosition;
  manifest: Manifest;
}) {
  const at = manifest.readingOrder.find(
    (l) => l.properties?.documentId === offer.document_id,
  );
  const headings = useQuery({
    queryKey: queryKeys.headings(offer.document_id, offer.version_id),
    queryFn: () => booksApi.headings(offer.document_id, offer.version_id),
    enabled: !!offer.section_id && !!offer.version_id,
    staleTime: Infinity,
    meta: { suppressGlobalError: true },
  });
  const section = headings.data?.items.find((h) => h.id === offer.section_id)?.text;
  const n = at?.properties?.number;
  const chapter = n ? `Ch ${n}` : (at?.title ?? "another chapter");
  return (
    <span className="min-w-0 truncate">
      On another device you were at {chapter}
      {section ? ` · ${section}` : ""}
    </span>
  );
}

function ReaderOverlay({
  restoreRef,
  offer,
  onGoOffer,
  onDismissOffer,
  back,
  onBack,
  onDismissBack,
  end,
}: {
  restoreRef: RefObject<((t: PositionTarget) => void) | null>;
  offer: ReactNode;
  onGoOffer: () => void;
  onDismissOffer: () => void;
  back: boolean;
  onBack: () => void;
  onDismissBack: () => void;
  end: ReactNode;
}) {
  return (
    <>
      <CaptureRestore into={restoreRef} />
      {offer || back ? (
        <div className="pointer-events-none absolute inset-x-4 top-3 z-20 flex flex-col items-center gap-2">
          {offer ? (
            <Note label="Other device" onDismiss={onDismissOffer}>
              {offer}
              <span aria-hidden="true" className="text-[var(--color-fg-muted)]">
                —
              </span>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-2"
                onClick={onGoOffer}
              >
                Go there
              </Button>
            </Note>
          ) : null}
          {back ? (
            <Note label="Back" onDismiss={onDismissBack}>
              <Button
                size="sm"
                variant="ghost"
                className="-ml-2 h-7 px-2"
                onClick={onBack}
              >
                <Undo2 aria-hidden="true" className="h-3.5 w-3.5" />
                Back to where you were
              </Button>
            </Note>
          ) : null}
        </div>
      ) : null}
      {end}
    </>
  );
}

function EndOfChapter({
  bookId,
  docId,
  manifest,
  link,
  next,
  state,
}: {
  bookId: string;
  docId: string;
  manifest: Manifest;
  link: ManifestLink;
  next?: ManifestLink;
  state?: BookState;
}) {
  const qc = useQueryClient();
  const done = state?.chapters[docId]?.state === "done";
  const toggle = useMutation({
    mutationFn: (value: boolean) => booksApi.done(bookId, docId, value),
    onSettled: () => qc.invalidateQueries({ queryKey: queryKeys.book(bookId) }),
  });
  const pressed = toggle.isPending ? !!toggle.variables : done;
  const part = link.properties?.part;
  const nextPart = next?.properties?.part;
  const newPart =
    next?.properties?.kind === "chapter" && nextPart !== undefined && nextPart !== part
      ? partTitle(manifest, nextPart)
      : undefined;
  return (
    <section
      aria-label="End of chapter"
      className="pointer-events-auto absolute bottom-4 left-1/2 z-20 flex w-[min(40rem,calc(100%-2rem))] -translate-x-1/2 flex-wrap items-center gap-3 rounded-lg bg-[var(--color-surface)] p-3 shadow-[var(--shadow-pop)] ring-1 ring-[var(--color-border)]"
    >
      <Button
        variant={pressed ? "secondary" : "outline"}
        aria-pressed={pressed}
        onClick={() => toggle.mutate(!pressed)}
      >
        <Check
          aria-hidden="true"
          className={cn("h-4 w-4", pressed ? "opacity-100" : "opacity-40")}
        />
        Mark chapter done
      </Button>
      {next?.href ? (
        <Link
          to={next.href}
          className="group flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md px-3 py-2 hover:bg-[var(--color-surface-muted)]"
        >
          <span className="min-w-0">
            <span className="block text-xs text-[var(--color-fg-muted)]">
              {newPart ? `${newPart} starts` : "Next"}
            </span>
            <span className="block truncate font-medium text-[var(--color-fg)]">
              {crumb(next)}
            </span>
          </span>
          <ArrowRight
            aria-hidden="true"
            className="h-4 w-4 shrink-0 text-[var(--color-fg-muted)] transition-transform group-hover:translate-x-0.5"
          />
        </Link>
      ) : (
        <Link
          to={`/app/b/${encodeURIComponent(bookId)}`}
          className="flex-1 rounded-md px-3 py-2 text-sm text-[var(--color-fg-muted)] hover:bg-[var(--color-surface-muted)] hover:text-[var(--color-fg)]"
        >
          You reached the end of the book. Back to the book home
        </Link>
      )}
    </section>
  );
}

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

function ReaderBar({
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
          className="flex min-w-0 flex-1 items-center gap-1.5 text-sm"
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
            {crumb(link)}
          </span>
        </nav>
        <BookUpdateChip
          bookId={bookId}
          doc={docId}
          versionId={version}
          onOpenSection={onJump}
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
        {user ? <AccountMenu user={user} /> : null}
      </header>
      {headings?.length ? (
        <SectionTracker headings={headings} section={section} onJump={onJump} />
      ) : null}
    </div>
  );
}
