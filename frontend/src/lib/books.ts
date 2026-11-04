import type { Anchor, Document } from "@/api";
import { APIError, request } from "@/api";

// Types mirror the server JSON (api/internal/server/handlers_book*.go and
// handlers_reading.go) field for field. The manifest is Readium-shaped, so its
// keys are camelCase; everything else is snake_case.

export type ChapterKind = "front" | "chapter" | "planned" | "back";

export type ManifestLink = {
  href?: string;
  type?: string;
  title: string;
  rel?: string;
  properties?: {
    documentId?: string;
    kind: ChapterKind;
    number?: number;
    // The index of the chapter's part in this reader's toc, or -1 for front
    // and back matter. Never an index into Outline.parts.
    part: number;
    versionId?: string;
    wordCount?: number;
  };
};

export type Manifest = {
  "@context"?: string;
  metadata: {
    identifier: string;
    title: string;
    subtitle?: string;
    // The chapters this reader can open, plus placeholders. Progress copy
    // uses BookState.progress.of.
    numberOfChapters: number;
    // Sent only to readers who can view the folder.
    folderId?: string;
    outlineVersionId: string;
    canEdit: boolean;
  };
  links?: ManifestLink[];
  readingOrder: ManifestLink[];
  toc: { title: string; children: ManifestLink[] }[];
};

export type ChapterState = "not_started" | "reading" | "read" | "done";

export type ReadingPosition = {
  device_id: string;
  document_id: string;
  version_id: string;
  section_id: string;
  anchor: Partial<Anchor>;
  progression: number;
  client_ts: string;
};

export type BookState = {
  // The newest positions, at most one per device and at most 20 devices.
  positions: ReadingPosition[];
  chapters: Record<
    string,
    {
      state: ChapterState;
      updated: boolean;
      seen_version_id: string;
      furthest_progression: number;
    }
  >;
  // chapter is the ordinal among chapters this reader can open.
  progress: { chapter: number; of: number; share: number };
};

export type ChapterChanges = {
  since_version_id: string;
  versions: {
    id: string;
    number: number;
    change_summary: string;
    created_at: string;
  }[];
  changed_sections: { id: string; title: string; removed: boolean }[];
};

// One heading of a rendered version, from GET /v1/documents/:id/headings.
export type ChapterHeading = { id: string; text: string; level: number; url: string };

export type OutlineEntry = { doc?: string; planned?: string };
export type Outline = {
  title: string;
  subtitle?: string;
  front: OutlineEntry[];
  parts: { title: string; chapters: OutlineEntry[] }[];
  back: OutlineEntry[];
};
export type BookDoc = { id: string; title: string };
export type OutlineResponse = {
  version_id: string;
  number: number;
  outline: Outline;
  not_in_outline: BookDoc[];
  removed: string[];
};

const b = (id: string) => `/v1/books/${encodeURIComponent(id)}`;
const ch = (id: string, doc: string) => `${b(id)}/chapters/${encodeURIComponent(doc)}`;
const post = (body?: unknown): RequestInit => ({
  method: "POST",
  body: JSON.stringify(body ?? {}),
});
// Reading writes may be the last request a closing page makes; keepalive
// lets them finish after the page is gone. Their bodies are far below the
// 64 KB keepalive limit.
const keepalive = (init: RequestInit): RequestInit => ({ ...init, keepalive: true });

export const booksApi = {
  manifest: (id: string) => request<Manifest>(b(id)),
  state: (id: string) => request<BookState>(`${b(id)}/state`),
  savePosition: (id: string, p: ReadingPosition) =>
    request<void>(
      `${b(id)}/position`,
      keepalive({ method: "PUT", body: JSON.stringify(p) }),
    ),
  open: (id: string, doc: string, versionId: string) =>
    request<void>(`${ch(id, doc)}/open`, post({ version_id: versionId })),
  // versionId is the version being read; reaching its end marks it seen (A7).
  progress: (
    id: string,
    doc: string,
    versionId: string,
    progression: number,
    reachedEnd: boolean,
  ) =>
    request<void>(
      `${ch(id, doc)}/progress`,
      keepalive(post({ version_id: versionId, progression, reached_end: reachedEnd })),
    ),
  done: (id: string, doc: string, done: boolean) =>
    request<void>(`${ch(id, doc)}/done`, {
      method: "PUT",
      body: JSON.stringify({ done }),
    }),
  seen: (id: string, doc: string, versionId: string) =>
    request<void>(`${ch(id, doc)}/seen`, post({ version_id: versionId })),
  seenAll: (id: string) => request<void>(`${b(id)}/seen`, post()),
  changes: (id: string, doc: string) =>
    request<ChapterChanges>(`${ch(id, doc)}/changes`),
  // Full-text search of the chapters this reader can open (A16). documentId
  // narrows it to one chapter.
  search: (id: string, q: string, documentId?: string) => {
    const params = new URLSearchParams({
      q,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    if (documentId) params.set("document_id", documentId);
    return request<{ items: Document[] }>(`${b(id)}/search?${params}`);
  },
  headings: (doc: string, versionId: string) =>
    request<{ items: ChapterHeading[] }>(
      `/v1/documents/${encodeURIComponent(doc)}/headings?version=${encodeURIComponent(versionId)}`,
    ),
  folderBook: (folderId: string) =>
    request<{ book_id: string }>(`/v1/folders/${encodeURIComponent(folderId)}/book`),
  createBook: (folderId: string) =>
    request<{
      book_id: string;
      outline_version_id: string;
      placed: string[];
      not_in_outline: BookDoc[];
    }>(`/v1/folders/${encodeURIComponent(folderId)}/book`, post()),
  outline: (id: string) => request<OutlineResponse>(`${b(id)}/outline`),
  pushOutline: (id: string, base: string, outline: Outline, note: string) =>
    request<{ version_id: string; number: number }>(`${b(id)}/outline`, {
      method: "PUT",
      body: JSON.stringify({ base_version_id: base, outline, note }),
    }),
};

// What to do with a reading write that failed. 429 rate_limited waits for
// the limiter; 5xx (including 503 group_membership_unavailable) and network
// errors are worth retrying; any other 4xx will never be accepted.
export function readingWriteFailure(err: unknown): "rate_limited" | "retry" | "drop" {
  if (!(err instanceof APIError)) return "retry";
  if (err.status === 429) return "rate_limited";
  if (err.status >= 500 || err.status === 408) return "retry";
  return "drop";
}

export function chapterByNumber(m: Manifest, n: number): ManifestLink | undefined {
  return m.readingOrder.find(
    (l) => l.properties?.kind === "chapter" && l.properties.number === n,
  );
}

// The title of the part a chapter belongs to. Parts with no visible chapter
// are left out of the toc, so the part number cannot index it.
export function partTitle(m: Manifest, part: number): string | undefined {
  return m.toc.find((t) => t.children.some((l) => l.properties?.part === part))?.title;
}

// "Chapter 3, Retries" for the frame title and the announcement; front and
// back matter have no number.
export function chapterName(l: ManifestLink): string {
  const n = l.properties?.number;
  return n ? `Chapter ${n}, ${l.title}` : l.title;
}

// The links either side of href in reading order.
export function neighbours(
  m: Manifest,
  href: string,
): { prev?: ManifestLink; next?: ManifestLink } {
  const i = m.readingOrder.findIndex((l) => l.href === href);
  if (i < 0) return {};
  return { prev: m.readingOrder[i - 1], next: m.readingOrder[i + 1] };
}

const time = (p: ReadingPosition) => Date.parse(p.client_ts) || 0;

// The most recently saved position, skipping one device when given.
export function latestPosition(
  s: BookState,
  excludeDevice?: string,
): ReadingPosition | undefined {
  let best: ReadingPosition | undefined;
  for (const p of s.positions) {
    if (p.device_id === excludeDevice) continue;
    if (!best || time(p) > time(best)) best = p;
  }
  return best;
}

const MEANINGFUL_JUMP = 0.15;

// Offer to continue from another device only when it is newer and somewhere
// meaningfully different: another chapter, or well past this one.
export function shouldOfferOtherDevice(
  mine: ReadingPosition | undefined,
  other: ReadingPosition | undefined,
): boolean {
  if (!other) return false;
  if (!mine) return true;
  if (time(other) <= time(mine)) return false;
  return (
    other.document_id !== mine.document_id ||
    Math.abs(other.progression - mine.progression) > MEANINGFUL_JUMP
  );
}

export const WORDS_PER_MINUTE = 230;

// Minutes left in a chapter of `words` words, given how far through it the
// reader is. The only implementation: the server sends word counts, not times.
export function minutesLeft(words: number, progression: number): number {
  if (progression >= 1) return 0;
  return Math.max(1, Math.ceil((words * (1 - progression)) / WORDS_PER_MINUTE));
}
