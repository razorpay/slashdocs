import { afterEach, describe, expect, it, vi } from "vitest";
import serverManifest from "./__fixtures__/manifest.json";
import {
  booksApi,
  chapterByNumber,
  latestPosition,
  minutesLeft,
  neighbours,
  shouldOfferOtherDevice,
  type BookState,
  type Manifest,
  type ReadingPosition,
} from "./books";

function link(title: string, doc: string, number: number, part = 0) {
  return {
    href: `/app/b/b1/c/${doc}`,
    type: "text/html",
    title,
    properties: { documentId: doc, kind: "chapter" as const, number, part },
  };
}

function manifestFixture(): Manifest {
  const order = [
    link("A", "doc_a", 1),
    link("B", "doc_b", 2, 1),
    link("C", "doc_c", 3, 1),
  ];
  return {
    metadata: {
      identifier: "b1",
      title: "Book",
      numberOfChapters: 3,
      folderId: "f1",
      outlineVersionId: "o1",
      canEdit: false,
    },
    readingOrder: order,
    toc: [{ title: "", children: order }],
  };
}

function pos(device: string, p: number, ts: string, doc = "doc_a"): ReadingPosition {
  return {
    device_id: device,
    document_id: doc,
    version_id: "v1",
    section_id: "",
    anchor: {},
    progression: p,
    client_ts: ts,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("manifest navigation", () => {
  it("finds neighbours across parts", () => {
    const m = manifestFixture();
    expect(neighbours(m, "/app/b/b1/c/doc_b").prev?.title).toBe("A");
    expect(neighbours(m, "/app/b/b1/c/doc_a").prev).toBeUndefined();
    expect(neighbours(m, "/app/b/b1/c/doc_c").next).toBeUndefined();
    expect(neighbours(m, "/app/b/b1/c/doc_a").next?.title).toBe("B");
    expect(neighbours(m, "/app/b/b1/c/missing")).toEqual({});
  });

  it("looks a chapter up by number", () => {
    const m = manifestFixture();
    expect(chapterByNumber(m, 2)?.properties?.documentId).toBe("doc_b");
    expect(chapterByNumber(m, 9)).toBeUndefined();
  });
});

describe("reading positions", () => {
  it("offers another device only when meaningfully elsewhere", () => {
    const mine = pos("d1", 0.4, "2026-11-04T10:00:00Z");
    const near = pos("d1", 0.5, "2026-11-04T11:00:00Z");
    const far = pos("d1", 0.7, "2026-11-04T11:00:00Z");
    const other = pos("d2", 0.1, "2026-11-04T11:00:00Z", "doc_b");
    const older = pos("d2", 0.1, "2026-11-04T09:00:00Z", "doc_b");
    expect(shouldOfferOtherDevice(mine, near)).toBe(false);
    expect(shouldOfferOtherDevice(mine, far)).toBe(true);
    expect(shouldOfferOtherDevice(mine, other)).toBe(true);
    expect(shouldOfferOtherDevice(mine, older)).toBe(false);
    expect(shouldOfferOtherDevice(undefined, far)).toBe(true);
    expect(shouldOfferOtherDevice(mine, undefined)).toBe(false);
  });

  it("picks the newest position, optionally skipping one device", () => {
    const s = {
      positions: [
        pos("d1", 0.1, "2026-11-04T10:00:00Z"),
        pos("d2", 0.2, "2026-11-04T12:00:00Z"),
      ],
      chapters: {},
      progress: { chapter: 1, of: 3, share: 0 },
    } satisfies BookState;
    expect(latestPosition(s)?.device_id).toBe("d2");
    expect(latestPosition(s, "d2")?.device_id).toBe("d1");
    expect(latestPosition({ ...s, positions: [] })).toBeUndefined();
  });
});

describe("minutesLeft", () => {
  it("estimates minutes left at 230 words per minute", () => {
    expect(minutesLeft(2300, 0.5)).toBe(5);
    expect(minutesLeft(2300, 1)).toBe(0);
    expect(minutesLeft(10, 0)).toBe(1);
  });
});

describe("booksApi", () => {
  function stubFetch(body: unknown = {}) {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }
  function call(fetchMock: ReturnType<typeof stubFetch>) {
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    return {
      path,
      method: init.method ?? "GET",
      body: init.body && JSON.parse(String(init.body)),
    };
  }

  // The fixture is the Go handler's answer to a reader who holds grants on
  // the front matter and chapter 3 only: chapter 1 and its part are hidden,
  // chapter 2 is a placeholder.
  it("parses the manifest the server sends, byte for byte", async () => {
    stubFetch(serverManifest);
    const m = await booksApi.manifest("book_x");
    expect(m.metadata.identifier).toBe(serverManifest.metadata.identifier);
    expect(m.metadata.canEdit).toBe(false);
    // A reader who cannot view the folder is not told its id.
    expect(m.metadata.folderId).toBeUndefined();
    // Visible chapters plus placeholders.
    expect(m.metadata.numberOfChapters).toBe(2);
    const [front, chapter] = m.readingOrder;
    expect(front!.properties).toMatchObject({ kind: "front", part: -1 });
    expect(chapter!.href).toContain("/c/doc_");
    expect(chapter!.properties?.documentId).toMatch(/^doc_/);
    expect(chapter!.properties?.versionId).toMatch(/^ver_/);
    expect(chapter!.properties).toMatchObject({ kind: "chapter", number: 3 });
    // part indexes this reader's toc, which leaves out the hidden part.
    expect(m.toc[chapter!.properties!.part]!.title).toBe("Two");
    const planned = m.toc[0]!.children[0]!;
    expect(planned.href).toBeUndefined();
    expect(planned.properties).toMatchObject({ kind: "planned", number: 2 });
    // The client helpers work on the real server hrefs.
    expect(chapterByNumber(m, 3)?.href).toBe(chapter!.href);
    expect(chapterByNumber(m, 1)).toBeUndefined();
    expect(neighbours(m, chapter!.href!).prev?.href).toBe(front!.href);
  });

  it("sends the version being read with progress and seen", async () => {
    let f = stubFetch();
    await booksApi.progress("b1", "doc_a", "ver_1", 0.99, true);
    expect(call(f)).toEqual({
      path: "/v1/books/b1/chapters/doc_a/progress",
      method: "POST",
      body: { version_id: "ver_1", progression: 0.99, reached_end: true },
    });
    f = stubFetch();
    await booksApi.seen("b1", "doc_a", "ver_1");
    expect(call(f)).toEqual({
      path: "/v1/books/b1/chapters/doc_a/seen",
      method: "POST",
      body: { version_id: "ver_1" },
    });
    f = stubFetch();
    await booksApi.open("b1", "doc_a", "ver_1");
    expect(call(f).body).toEqual({ version_id: "ver_1" });
    f = stubFetch();
    await booksApi.done("b1", "doc_a", true);
    expect(call(f)).toMatchObject({ method: "PUT", body: { done: true } });
    f = stubFetch();
    await booksApi.seenAll("b1");
    expect(call(f)).toMatchObject({ path: "/v1/books/b1/seen", method: "POST" });
  });
});
