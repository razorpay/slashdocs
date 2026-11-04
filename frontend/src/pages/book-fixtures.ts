// Shared fixtures for the book reader tests.
import type { BookState, ChapterState, Manifest, ManifestLink } from "@/lib/books";

export const chapter = (n: number, part: number): ManifestLink => ({
  href: `/app/b/b1/c/doc_${n}`,
  type: "text/html",
  title: `Title ${n}`,
  properties: {
    documentId: `doc_${n}`,
    kind: "chapter",
    number: n,
    part,
    versionId: `ver_${n}`,
    wordCount: 2300,
  },
});

const planned = (n: number, part: number): ManifestLink => ({
  title: `Planned ${n}`,
  properties: { kind: "planned", number: n, part },
});

// Part One holds chapters 1 and 2; Part Two holds chapter 3 and a planned 4.
export function bookManifest(): Manifest {
  const [c1, c2, c3] = [chapter(1, 0), chapter(2, 0), chapter(3, 1)];
  return {
    metadata: {
      identifier: "b1",
      title: "My Book",
      numberOfChapters: 4,
      folderId: "fld_1",
      outlineVersionId: "bov_1",
      canEdit: false,
    },
    readingOrder: [c1, c2, c3],
    toc: [
      { title: "Part One", children: [c1, c2] },
      { title: "Part Two", children: [c3, planned(4, 1)] },
    ],
  };
}

export function bookState(
  chapters: Record<
    string,
    { state?: ChapterState; updated?: boolean; furthest?: number }
  > = {},
  over: Partial<BookState> = {},
): BookState {
  return {
    positions: [],
    chapters: Object.fromEntries(
      Object.entries(chapters).map(([id, c]) => [
        id,
        {
          state: c.state ?? "reading",
          updated: c.updated ?? false,
          seen_version_id: "",
          furthest_progression: c.furthest ?? 0,
        },
      ]),
    ),
    progress: { chapter: 1, of: 3, share: 0.1 },
    ...over,
  };
}

// jsdom has no matchMedia. matches decides whether useIsMobile is true.
export function stubMatchMedia(matches = false) {
  return () => ({
    matches,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}
