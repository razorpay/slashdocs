import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Pencil } from "lucide-react";
import { APIError } from "@/api";
import {
  booksApi,
  latestPosition,
  minutesLeft,
  type BookState,
  type ChapterState,
  type Manifest,
  type ManifestLink,
} from "@/lib/books";
import { queryKeys } from "@/lib/queryKeys";
import { useTitle } from "@/lib/use-title";
import { Button } from "@/components/ui/button";
import { Center, Skeleton } from "@/components/ui/misc";
import { Page } from "@/components/layout/page";

type RowState = ChapterState | "planned";

const STATE_LABEL: Record<RowState, string> = {
  not_started: "Not started",
  reading: "Reading",
  read: "Read",
  done: "Done",
  planned: "Planned",
};

const STATE_DOT: Record<RowState, string> = {
  not_started: "border border-[var(--color-fg-muted)]",
  reading: "bg-[var(--color-accent)]",
  read: "bg-[var(--color-fg-muted)]",
  done: "bg-[var(--color-success,var(--color-fg-muted))]",
  planned: "border border-dashed border-[var(--color-fg-muted)]",
};

function rowState(l: ManifestLink, s: BookState | undefined): RowState {
  if (l.properties?.kind === "planned") return "planned";
  const id = l.properties?.documentId;
  return (id && s?.chapters[id]?.state) || "not_started";
}

function Dot({ state }: { state: RowState }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2 w-2 shrink-0 rounded-full ${STATE_DOT[state]}`}
    />
  );
}

function BookError({ error }: { error: unknown }) {
  let title = "Could not load this book";
  let description = "Something went wrong. Please try again.";
  if (error instanceof APIError) {
    if (error.status === 404 && error.code === "feature_disabled") {
      title = "Books are not enabled on this server.";
      description = "Ask an administrator to turn on book mode.";
    } else if (error.status === 401) {
      title = "Sign in to read this book";
      description = "Your session has ended. Sign in again to continue.";
    } else if (error.status === 403 || error.status === 404) {
      title = "Book not found";
      description =
        "This book may have been deleted, or you may not have access to it. Check the link.";
    }
  }
  return (
    <Center>
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">{title}</h1>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{description}</p>
      </div>
    </Center>
  );
}

function ChangeSummary({ bookId, docId }: { bookId: string; docId: string }) {
  const q = useQuery({
    queryKey: queryKeys.bookChanges(bookId, docId),
    queryFn: () => booksApi.changes(bookId, docId),
    meta: { suppressGlobalError: true },
  });
  const latest = q.data?.versions[q.data.versions.length - 1];
  return (
    <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
      {q.isLoading
        ? "Loading…"
        : q.isError
          ? "Could not load the changes."
          : latest?.change_summary || "No summary was written for this change."}
    </p>
  );
}

function UpdatedItem({ bookId, link }: { bookId: string; link: ManifestLink }) {
  const [open, setOpen] = useState(false);
  const docId = link.properties?.documentId ?? "";
  return (
    <details
      className="py-1.5"
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer text-sm text-[var(--color-fg)]">
        <span className="tabular-nums text-[var(--color-fg-muted)]">
          {link.properties?.number}
        </span>{" "}
        {link.title}
      </summary>
      {open && docId ? <ChangeSummary bookId={bookId} docId={docId} /> : null}
    </details>
  );
}

function UpdatedGroup({
  bookId,
  links,
  state,
}: {
  bookId: string;
  links: ManifestLink[];
  state: BookState;
}) {
  const qc = useQueryClient();
  const updated = links.filter(
    (l) => l.properties?.documentId && state.chapters[l.properties.documentId]?.updated,
  );
  const markAll = useMutation({
    mutationFn: () => booksApi.seenAll(bookId),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.bookState(bookId) }),
  });
  if (updated.length === 0) return null;
  return (
    <section
      aria-label="Updated chapters"
      className="mb-6 rounded-md border border-[var(--color-border)] px-4 py-3"
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-[var(--color-fg)]">
          {updated.length === 1
            ? "1 chapter you read has a new version"
            : `${updated.length} chapters you read have new versions`}
        </p>
        <Button
          variant="ghost"
          size="sm"
          disabled={markAll.isPending}
          onClick={() => markAll.mutate()}
        >
          Mark all seen
        </Button>
      </div>
      <div className="mt-1 divide-y divide-[var(--color-border)]">
        {updated.map((l) => (
          <UpdatedItem key={l.properties?.documentId} bookId={bookId} link={l} />
        ))}
      </div>
    </section>
  );
}

function ContinueCard({ manifest, state }: { manifest: Manifest; state: BookState }) {
  const pos = latestPosition(state);
  const chapters = manifest.readingOrder.filter(
    (l) => l.properties?.kind === "chapter",
  );
  const at = pos
    ? chapters.find((l) => l.properties?.documentId === pos.document_id)
    : undefined;
  const target = at ?? chapters[0];
  if (!target) return null;
  const p = target.properties;
  const left = at && p?.wordCount ? minutesLeft(p.wordCount, pos?.progression ?? 0) : 0;
  return (
    <section
      aria-label="Continue reading"
      className="mb-6 flex flex-wrap items-center justify-between gap-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="min-w-0">
        <p className="text-xs text-[var(--color-fg-muted)]">
          {at ? "Continue reading" : "Start reading"}
        </p>
        <p className="mt-1 truncate font-medium text-[var(--color-fg)]">
          <span className="tabular-nums text-[var(--color-fg-muted)]">{p?.number}</span>{" "}
          {target.title}
        </p>
        {at && left > 0 ? (
          <p className="mt-0.5 text-sm text-[var(--color-fg-muted)]">
            about {left} min left
          </p>
        ) : null}
      </div>
      <Button asChild>
        <Link to={target.href ?? "#"}>
          {at ? "Continue" : "Start reading"}
          <ArrowRight aria-hidden="true" className="h-4 w-4" />
        </Link>
      </Button>
    </section>
  );
}

function ChapterRow({ link, state }: { link: ManifestLink; state: RowState }) {
  const p = link.properties;
  const inner = (
    <>
      <span className="w-8 shrink-0 text-right tabular-nums text-[var(--color-fg-muted)]">
        {p?.number}
      </span>
      <span className="min-w-0 flex-1 truncate">{link.title}</span>
      <span className="flex shrink-0 items-center gap-1.5 text-xs text-[var(--color-fg-muted)]">
        <Dot state={state} />
        {STATE_LABEL[state]}
      </span>
    </>
  );
  const base = "flex items-center gap-3 px-3 py-2 text-sm";
  if (state === "planned" || !link.href) {
    return (
      <div aria-disabled="true" className={`${base} opacity-60`}>
        {inner}
      </div>
    );
  }
  return (
    <Link
      to={link.href}
      className={`${base} text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]`}
    >
      {inner}
    </Link>
  );
}

function PartSection({
  part,
  state,
}: {
  part: Manifest["toc"][number];
  state: BookState | undefined;
}) {
  const rows = part.children.filter((l) => l.properties?.number !== undefined);
  const real = rows.filter((l) => l.properties?.kind !== "planned");
  const read = real.filter((l) => {
    const s = rowState(l, state);
    return s === "read" || s === "done";
  }).length;
  return (
    <details open className="rounded-md border border-[var(--color-border)]">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2.5">
        <span className="font-medium text-[var(--color-fg)]">{part.title}</span>
        <span className="flex items-center gap-3 text-xs text-[var(--color-fg-muted)]">
          <span aria-hidden="true" className="flex gap-0.5">
            {rows.map((l, i) => (
              <Dot key={i} state={rowState(l, state)} />
            ))}
          </span>
          {read} of {real.length} read
        </span>
      </summary>
      <div className="border-t border-[var(--color-border)] py-1">
        {rows.map((l) => {
          const s = rowState(l, state);
          const updated =
            !!l.properties?.documentId &&
            !!state?.chapters[l.properties.documentId]?.updated;
          return (
            <div key={l.properties?.number} className="relative">
              <ChapterRow link={l} state={s} />
              {updated ? (
                <span className="pointer-events-none absolute right-28 top-1/2 -translate-y-1/2 rounded-full bg-[var(--color-surface-muted)] px-2 py-0.5 text-xs text-[var(--color-fg-muted)]">
                  Updated
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </details>
  );
}

export function BookHomePage() {
  const { bookId = "" } = useParams();
  const manifest = useQuery({
    queryKey: queryKeys.book(bookId),
    queryFn: () => booksApi.manifest(bookId),
    retry: false,
    meta: { suppressGlobalError: true },
  });
  const state = useQuery({
    queryKey: queryKeys.bookState(bookId),
    queryFn: () => booksApi.state(bookId),
    retry: false,
    meta: { suppressGlobalError: true },
  });
  useTitle(manifest.data?.metadata.title);

  if (manifest.isLoading) {
    return (
      <Page lane="focus" backdrop={false}>
        <Skeleton className="mb-3 h-24 w-full" />
        <Skeleton className="h-64 w-full" />
      </Page>
    );
  }
  if (manifest.error || !manifest.data) return <BookError error={manifest.error} />;

  const m = manifest.data;
  const s = state.data;
  const allLinks = m.toc.flatMap((p) => p.children);
  const read = allLinks.filter((l) => {
    const st = rowState(l, s);
    return st === "read" || st === "done";
  }).length;
  const share = s ? Math.round(s.progress.share * 100) : 0;

  return (
    <Page lane="focus" backdrop={false}>
      <header className="mb-6 flex items-start gap-4">
        <div
          aria-hidden="true"
          className="hidden h-28 w-20 shrink-0 items-end rounded-md bg-gradient-to-br from-[var(--color-accent)] to-[var(--color-accent-strong)] p-2 text-[10px] font-semibold leading-tight text-[var(--color-accent-fg)] sm:flex"
        >
          {m.metadata.title}
        </div>
        <div className="min-w-0 flex-1">
          <h1
            className="text-2xl font-semibold tracking-[-0.01em] text-[var(--color-fg)]"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            {m.metadata.title}
          </h1>
          {m.metadata.subtitle ? (
            <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
              {m.metadata.subtitle}
            </p>
          ) : null}
          <p className="mt-1 text-sm text-[var(--color-fg-muted)]">
            {m.metadata.numberOfChapters} chapters in {m.toc.length}{" "}
            {m.toc.length === 1 ? "part" : "parts"}
          </p>
          {s ? (
            <div className="mt-3">
              <div
                role="progressbar"
                aria-label="Book progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={share}
                className="h-1.5 overflow-hidden rounded-full bg-[var(--color-surface-muted)]"
              >
                <div
                  className="h-full bg-[var(--color-accent)]"
                  style={{ width: `${share}%` }}
                />
              </div>
              <p className="mt-1.5 text-xs text-[var(--color-fg-muted)]">
                Chapter {s.progress.chapter} of {s.progress.of} · {share}% of the book ·{" "}
                {read} chapters read
              </p>
            </div>
          ) : null}
        </div>
        {m.metadata.canEdit ? (
          <Button asChild variant="outline" size="sm">
            <Link to={`/app/b/${encodeURIComponent(bookId)}/outline`}>
              <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
              Edit outline
            </Link>
          </Button>
        ) : null}
      </header>

      {s ? <ContinueCard manifest={m} state={s} /> : null}
      {s ? <UpdatedGroup bookId={bookId} links={allLinks} state={s} /> : null}

      <div className="space-y-3">
        {m.toc.map((p, i) => (
          <PartSection key={i} part={p} state={s} />
        ))}
      </div>

      <p className="mt-6 text-xs text-[var(--color-fg-muted)]">
        Not started · Reading · Read · Done · Planned (not written yet) · Updated (a new
        version of a chapter you read)
      </p>
    </Page>
  );
}
