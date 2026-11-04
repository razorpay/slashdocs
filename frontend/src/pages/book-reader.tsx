import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { RestoreMethod } from "../../bridge/reading";
import {
  booksApi,
  chapterByNumber,
  chapterName,
  neighbours,
  shouldOfferOtherDevice,
  latestPosition,
  type Manifest,
  type ManifestLink,
  type ReadingPosition,
} from "@/lib/books";
import { queryKeys } from "@/lib/queryKeys";
import { useMe } from "@/lib/hooks";
import { useTitle } from "@/lib/use-title";
import { useIsMobile } from "@/lib/use-media-query";
import {
  deviceIdStore,
  readerSettingsStore,
  useReaderSettings,
} from "@/lib/reader-store";
import { Center, Skeleton } from "@/components/ui/misc";
import {
  type PositionTarget,
  type ReaderOptions,
  type ReaderViewport,
} from "./doc-context";
import { DocWorkspace } from "./doc-workspace";
import { useDocumentStream } from "./use-document-stream";
import { useReadingPosition } from "./use-reading-position";
import { BookError } from "./book-home";
import { BookRail } from "./book-rail";
import { BookSearch } from "./book-search";
import { ReaderBar } from "./book-reader-bar";
import { EndOfChapter, OfferNote, ReaderOverlay } from "./book-reader-notes";
import { useBookState, useChapterChanges, useManifest } from "./book-chapter-state";
import { useReaderKeys } from "./book-keys";
import { useHeldVersion } from "./book-held-version";

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

  // Switching to a newer version keeps the reader's place: the quote anchor
  // resolves fuzzily in the new version, once its frame is ready.
  const versionRestore = useRef<PositionTarget | null>(null);
  const lastView = useRef<ReaderViewport | null>(null);
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
  const latest = link.properties?.versionId ?? "";
  const current = useHeldVersion({
    docId,
    latest,
    reading: true,
    beforeView: () => {
      versionRestore.current = here().target;
      // The saved place wins over a heading the link named.
      if (location.hash) nav(href, { replace: true });
    },
  });
  const stream = useDocumentStream({
    docId,
    version: current,
    principal: me.data?.principal,
    onRemoteDocumentChange: () => void invalidateBook(),
  });

  // Reading position, saved as the reader scrolls.
  const position = useReadingPosition({
    bookId,
    documentId: docId,
    versionId: current,
    enabled: state.isSuccess && !!current,
    onReachedEnd: invalidateBook,
  });
  const [section, setSection] = useState("");
  const [atEnd, setAtEnd] = useState(false);
  const { onViewport: saveViewport, onRestored: restoreDone } = position;
  const onViewport = useCallback(
    (v: ReaderViewport) => {
      saveViewport(v);
      lastView.current = v;
      setSection(v.section);
      // A chapter that fits on screen is visible to its end.
      setAtEnd(!!v.fits || v.progression >= END_PROGRESSION);
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
  const jumpWithin = useCallback(
    (t: PositionTarget) => {
      setBack(here());
      restoreRef.current?.(t);
    },
    [here],
  );
  useEffect(() => {
    const target = versionRestore.current;
    if (!target) return;
    versionRestore.current = null;
    restoreSaved(target);
  }, [current, restoreSaved]);

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
    if (mine?.document_id === docId) {
      restoreSaved(toTarget(mine));
      return;
    }
    // No saved place here, but the reader got partway through before (say
    // on a device whose position has since moved to another chapter).
    const chapter = s?.chapters[docId];
    const furthest = chapter?.furthest_progression ?? 0;
    if (chapter?.state === "reading" && furthest > 0 && furthest < END_PROGRESSION) {
      restoreRef.current?.({ progression: furthest });
      return;
    }
    restoreDone();
    // Runs once per chapter visit, when the state first arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stateSettled, docId]);

  // Focus and announce the chapter when it changes (R13).
  const titleRef = useRef<HTMLHeadingElement>(null);
  const [announcement, setAnnouncement] = useState("");
  const firstChapter = useRef(docId);
  const name = chapterName(link);
  const nameRef = useRef(name);
  nameRef.current = name;
  useEffect(() => {
    if (firstChapter.current === docId) return;
    firstChapter.current = "";
    titleRef.current?.focus();
    setAnnouncement(nameRef.current);
  }, [docId]);

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
  // Marks stay for the rest of the visit once the update is seen, so the
  // dots do not vanish while the reader looks at the changes.
  const [marks, setMarks] = useState<{ doc: string; ids: string[] }>();
  useEffect(() => {
    if (!updated || !changes.data) return;
    const ids = changes.data.changed_sections
      .filter((s) => !s.removed)
      .map((s) => s.id);
    setMarks((m) =>
      m?.doc === docId && m.ids.join("\n") === ids.join("\n") ? m : { doc: docId, ids },
    );
  }, [updated, changes.data, docId]);
  const markHeadings = marks?.doc === docId ? marks.ids : undefined;
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
          // A new chapter or version is a new frame, so a restore waiting for
          // one never lands in another.
          key={`${docId}:${current}`}
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
