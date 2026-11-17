import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api as staticApi } from "./api";
import { passing } from "./pages/live-load";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const DISCOVERY = "/.well-known/slashdocs.json";

type Discovery = "asks" | "can-decode" | "missing";

function discoveryResponse(mode: Discovery) {
  if (mode === "missing") return new Response("not found", { status: 404 });
  return Response.json({
    name: "slashdocs",
    request_encodings: ["gzip"],
    compress_requests: mode === "asks",
  });
}

// jsdom's FormData and File cannot be serialized by Node's Response, which
// real browsers do, so the upload cases use Node's own implementations.
async function useNodeFormData() {
  // Response.formData() builds instances of Node's classes, which jsdom shadows.
  const parsed = await new Response(new URLSearchParams("a=b")).formData();
  vi.stubGlobal("FormData", parsed.constructor);
}

// A File that Node's FormData can serialize.
async function nodeFile(content: string, name: string): Promise<File> {
  const fd = new (globalThis.FormData as typeof FormData)();
  fd.set("f", await new Response(content).blob(), name);
  return fd.get("f") as File;
}

// Loads a fresh copy of the module, because it caches the discovery answer.
async function setup(mode: Discovery) {
  const fetchMock = vi.fn<
    (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  >(async (input) =>
    String(input) === DISCOVERY
      ? discoveryResponse(mode)
      : new Response("{}", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.resetModules();
  const { api } = await import("./api");
  return { api, fetchMock };
}

function apiCalls(fetchMock: { mock: { calls: [RequestInfo | URL, RequestInit?][] } }) {
  return fetchMock.mock.calls.filter(([input]) => String(input) !== DISCOVERY);
}

async function gunzip(body: unknown): Promise<string> {
  const stream = new Response(body as BodyInit).body!.pipeThrough(
    new DecompressionStream("gzip"),
  );
  return new TextDecoder().decode(await new Response(stream).arrayBuffer());
}

const headersOf = (init?: RequestInit) =>
  (init?.headers ?? {}) as Record<string, string>;

describe("request bodies when the server asks for gzip", () => {
  it("gzips JSON bodies", async () => {
    const { api, fetchMock } = await setup("asks");
    const patch = {
      html: "<script>alert(1)</script>",
      sql: "' OR 1=1 --",
      emoji: "🙂",
    };
    await api.patchDocumentKV("doc_1", patch as never);

    const [[, init]] = apiCalls(fetchMock);
    expect(headersOf(init)["Content-Encoding"]).toBe("gzip");
    expect(headersOf(init)["Content-Type"]).toBe("application/json");
    const wire = await gunzip(init!.body);
    expect(JSON.parse(wire)).toEqual(patch);
    // Markup is escaped as Go's JSON encoder escapes it.
    expect(wire).not.toMatch(/[<>&]/);
    expect(wire).toContain("\\u003cscript\\u003e");
  });

  it("gzips live typing, which goes in a request that outlives the page", async () => {
    const { api, fetchMock } = await setup("asks");
    const op = {
      base_seq: 1,
      client_op_id: "op_1",
      replacements: [
        { start: 0, end: 0, old_html: "", new_html: "<script>alert(1)</script>" },
      ],
    };
    await api.sendOps("doc_1", op);

    const [[input, init]] = apiCalls(fetchMock);
    expect(String(input)).toBe("/v1/documents/doc_1/ops");
    expect(init).toMatchObject({ method: "POST", keepalive: true });
    expect(headersOf(init)["Content-Encoding"]).toBe("gzip");
    expect(headersOf(init)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(await gunzip(init!.body))).toEqual(op);
  });

  describe("when the page goes", () => {
    const op = {
      base_seq: 1,
      client_op_id: "op_1",
      replacements: [{ start: 0, end: 0, old_html: "", new_html: "<p>x</p>" }],
    };
    // The page shows again after each case, as a page that the browser kept does.
    afterEach(() => window.dispatchEvent(new Event("pageshow")));

    it("starts live typing in the same task, uncompressed, and compresses again when the page returns", async () => {
      const { api, fetchMock } = await setup("asks");

      window.dispatchEvent(new Event("pagehide"));
      const going = api.sendOps("doc_1", op);
      // No await has run yet: the request has left already.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await going;
      const [[, left]] = apiCalls(fetchMock);
      expect(left).toMatchObject({ method: "POST", keepalive: true });
      expect(left!.body).toBe(JSON.stringify(op));
      expect(headersOf(left)["Content-Encoding"]).toBeUndefined();

      window.dispatchEvent(new Event("pageshow"));
      await api.sendOps("doc_1", op);
      const [, [, back]] = apiCalls(fetchMock);
      expect(headersOf(back)["Content-Encoding"]).toBe("gzip");
    });

    it("sends at once, uncompressed, live typing that waits for the compressor", async () => {
      const { api, fetchMock } = await setup("asks");
      // Discovery is known: the next send waits only for the compressor.
      await api.patchDocumentKV("doc_1", { a: 1 } as never);
      const before = apiCalls(fetchMock).length;

      const going = api.sendOps("doc_1", op);
      await Promise.resolve();
      expect(apiCalls(fetchMock)).toHaveLength(before);
      window.dispatchEvent(new Event("pagehide"));
      expect(apiCalls(fetchMock)).toHaveLength(before + 1);
      await going;
      // The compressor finishing later does not send it twice.
      await new Promise((done) => setTimeout(done, 20));
      const sent = apiCalls(fetchMock).slice(before);
      expect(sent).toHaveLength(1);
      expect(sent[0][1]).toMatchObject({ keepalive: true });
      expect(sent[0][1]!.body).toBe(JSON.stringify(op));
      expect(headersOf(sent[0][1])["Content-Encoding"]).toBeUndefined();
    });

    it("sends at once, uncompressed, live typing that waits for discovery", async () => {
      const fetchMock = vi.fn<
        (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
      >((input) =>
        String(input) === DISCOVERY
          ? new Promise(() => {})
          : Promise.resolve(
              Response.json({ seq: 2, version_id: "v", others: [], sum: 1 }),
            ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { api } = await import("./api");

      const going = api.sendOps("doc_1", op);
      await Promise.resolve();
      expect(apiCalls(fetchMock)).toHaveLength(0);
      window.dispatchEvent(new Event("pagehide"));
      expect(apiCalls(fetchMock)).toHaveLength(1);
      await going;
      expect(headersOf(apiCalls(fetchMock)[0][1])["Content-Encoding"]).toBeUndefined();
    });
  });

  it("gzips multipart uploads and keeps the boundary in Content-Type", async () => {
    await useNodeFormData();
    const { api, fetchMock } = await setup("asks");
    const html = "<html><body>Hello <b>there</b></body></html>";
    await api.createDocument("Quarterly", await nodeFile(html, "q.html"));

    const [[, init]] = apiCalls(fetchMock);
    expect(headersOf(init)["Content-Encoding"]).toBe("gzip");
    const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(
      headersOf(init)["Content-Type"],
    )?.[1];
    expect(boundary).toBeTruthy();
    const text = await gunzip(init!.body);
    expect(text).toContain(`--${boundary}`);
    expect(text).toContain('name="title"');
    expect(text).toContain("Quarterly");
    expect(text).toContain('name="file"; filename="q.html"');
    expect(text).toContain(html);
  });

  it("sends bodies unchanged when CompressionStream is missing", async () => {
    await useNodeFormData();
    vi.stubGlobal("CompressionStream", undefined);
    const { api, fetchMock } = await setup("asks");
    await api.patchDocumentKV("doc_1", { a: 1 } as never);
    await api.createDocument("T", await nodeFile("<p>x</p>", "x.html"));

    const [[, json], [, upload]] = apiCalls(fetchMock);
    expect(json!.body).toBe(JSON.stringify({ a: 1 }));
    expect(headersOf(json)["Content-Encoding"]).toBeUndefined();
    expect(upload!.body).toBeInstanceOf(FormData);
    expect(headersOf(upload)).not.toHaveProperty("Content-Type");
    expect(headersOf(upload)["Content-Encoding"]).toBeUndefined();
  });

  it("does not ask discovery for requests without a body", async () => {
    const { api, fetchMock } = await setup("asks");
    await api.getConfig();
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "/v1/config",
    ]);
  });
});

describe("request bodies when the server does not ask for gzip", () => {
  for (const mode of ["can-decode", "missing"] as const) {
    it(`sends plain bodies (discovery: ${mode})`, async () => {
      await useNodeFormData();
      const { api, fetchMock } = await setup(mode);
      await api.patchDocumentKV("doc_1", { a: 1 } as never);
      await api.createDocument("T", await nodeFile("<p>x</p>", "x.html"));

      const [[, json], [, upload]] = apiCalls(fetchMock);
      expect(json!.body).toBe(JSON.stringify({ a: 1 }));
      expect(headersOf(json)["Content-Encoding"]).toBeUndefined();
      expect(upload!.body).toBeInstanceOf(FormData);
      expect(headersOf(upload)["Content-Encoding"]).toBeUndefined();
    });
  }

  it("sends plain bodies when discovery cannot be fetched", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async (input) => {
      if (String(input) === DISCOVERY) throw new Error("network down");
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api");
    await api.patchDocumentKV("doc_1", { a: 1 } as never);

    const [, init] = apiCalls(fetchMock)[0];
    expect(init!.body).toBe(JSON.stringify({ a: 1 }));
    expect(headersOf(init)["Content-Encoding"]).toBeUndefined();
  });
});

describe("discovery cache", () => {
  it("asks discovery once, then again after the cache expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { api, fetchMock } = await setup("asks");
      await api.patchDocumentKV("doc_1", { a: 1 } as never);
      await api.patchDocumentKV("doc_1", { a: 2 } as never);
      const probes = () =>
        fetchMock.mock.calls.filter(([i]) => String(i) === DISCOVERY).length;
      expect(probes()).toBe(1);
      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      await api.patchDocumentKV("doc_1", { a: 3 } as never);
      expect(probes()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  for (const [failure, answer] of [
    ["a network failure", () => Promise.reject(new Error("network down"))],
    ["a non-OK answer", async () => new Response("down", { status: 503 })],
  ] as const) {
    it(`sends plain after ${failure}, asks again after 30 seconds, and then compresses`, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        let calls = 0;
        const fetchMock = vi.fn<
          (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
        >(async (input) => {
          if (String(input) === DISCOVERY) {
            return ++calls === 1 ? answer() : discoveryResponse("asks");
          }
          return new Response("{}", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        });
        vi.stubGlobal("fetch", fetchMock);
        const { api } = await import("./api");
        await api.patchDocumentKV("doc_1", { a: 1 } as never);
        await api.patchDocumentKV("doc_1", { a: 2 } as never);
        expect(calls).toBe(1);
        vi.setSystemTime(Date.now() + 31 * 1000);
        await api.patchDocumentKV("doc_1", { a: 3 } as never);
        expect(calls).toBe(2);

        const encodings = apiCalls(fetchMock).map(
          ([, init]) => headersOf(init)["Content-Encoding"],
        );
        expect(encodings).toEqual([undefined, undefined, "gzip"]);
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it("sends plain when discovery does not answer in 3 seconds", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn<
        (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
      >((input, init) =>
        String(input) === DISCOVERY
          ? new Promise((_, fail) =>
              init!.signal!.addEventListener("abort", () => fail(init!.signal!.reason)),
            )
          : Promise.resolve(
              new Response("{}", {
                status: 200,
                headers: { "Content-Type": "application/json" },
              }),
            ),
      );
      vi.stubGlobal("fetch", fetchMock);
      const { api } = await import("./api");
      const sending = api.patchDocumentKV("doc_1", { a: 1 } as never);
      await vi.advanceTimersByTimeAsync(2999);
      expect(apiCalls(fetchMock)).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      await sending;
      const [[, init]] = apiCalls(fetchMock);
      expect(headersOf(init)["Content-Encoding"]).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends the body again plain, and stops compressing, when the server refuses gzip", async () => {
    let refused = 0;
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async (input, init) => {
      if (String(input) === DISCOVERY) return discoveryResponse("asks");
      if (headersOf(init)["Content-Encoding"] === "gzip") {
        refused++;
        return Response.json(
          {
            error: {
              code: "unsupported_encoding",
              message: "unsupported content encoding",
            },
          },
          { status: 415 },
        );
      }
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api");
    await api.patchDocumentKV("doc_1", { a: 1 } as never);
    await api.patchDocumentKV("doc_1", { a: 2 } as never);

    expect(refused).toBe(1);
    const calls = apiCalls(fetchMock);
    expect(calls.map(([, init]) => headersOf(init)["Content-Encoding"])).toEqual([
      "gzip",
      undefined,
      undefined,
    ]);
    expect(calls[1][1]!.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("does not resend or stop compressing after a 415 for a wrong Content-Type", async () => {
    const fetchMock = vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >(async (input) =>
      String(input) === DISCOVERY
        ? discoveryResponse("asks")
        : Response.json(
            {
              error: {
                code: "unsupported_media_type",
                message: "content-type must be application/json",
              },
            },
            { status: 415 },
          ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { api } = await import("./api");
    for (const a of [1, 2]) {
      await expect(api.patchDocumentKV("doc_1", { a } as never)).rejects.toMatchObject({
        status: 415,
        code: "unsupported_media_type",
      });
    }
    expect(
      apiCalls(fetchMock).map(([, init]) => headersOf(init)["Content-Encoding"]),
    ).toEqual(["gzip", "gzip"]);
  });

  it("keeps a successful answer that declines compression", async () => {
    const { api, fetchMock } = await setup("can-decode");
    await api.patchDocumentKV("doc_1", { a: 1 } as never);
    await api.patchDocumentKV("doc_1", { a: 2 } as never);
    expect(fetchMock.mock.calls.filter(([i]) => String(i) === DISCOVERY)).toHaveLength(
      1,
    );
  });
});

// The module imported above keeps the discovery answer, so it is fetched once
// here and the tests below see a server that does not ask for gzip, with no
// discovery request among the calls that they count.
beforeAll(async () => {
  vi.stubGlobal("fetch", async () => discoveryResponse("can-decode"));
  await staticApi.setNotificationPreferences(true);
  vi.unstubAllGlobals();
});

const answer = (body: BodyInit, headers: Record<string, string> = {}) =>
  vi.fn<typeof fetch>(async () => new Response(body, { headers }));

describe("sendOps", () => {
  const op = (text: string) => ({
    base_seq: 1,
    client_op_id: "op_1",
    replacements: [{ start: 0, end: 0, old_html: "", new_html: text }],
  });
  const sent = () =>
    answer(JSON.stringify({ seq: 2, version_id: "ver_1", others: [], sum: 1 }), {
      "Content-Type": "application/json",
    });

  it("goes in a request that outlives the page", async () => {
    const fetch = sent();
    vi.stubGlobal("fetch", fetch);

    await staticApi.sendOps("doc_1", op("x"));

    expect(fetch.mock.lastCall![1]).toMatchObject({ method: "POST", keepalive: true });
  });

  it("goes in a normal request when its body is larger than 64 KiB, which no browser lets outlive the page", async () => {
    const fetch = sent();
    vi.stubGlobal("fetch", fetch);

    // A character of three bytes: the limit is in bytes.
    await staticApi.sendOps("doc_1", op("€".repeat(22_000)));

    expect(fetch.mock.lastCall![1]).toMatchObject({ keepalive: false });
  });

  it("goes in a normal request when the requests on their way that outlive the page would be larger than 64 KiB with it", async () => {
    let land = () => {};
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(
        (...args) => new Promise((done) => (land = () => done(sent()(...args)))),
      )
      .mockImplementation(sent());
    vi.stubGlobal("fetch", fetch);

    // Each body is about 40 KiB.
    const first = staticApi.sendOps("doc_1", op("x".repeat(40_000)));
    await staticApi.sendOps("doc_1", op("y".repeat(40_000)));
    expect(fetch.mock.calls.map(([, init]) => init!.keepalive)).toEqual([true, false]);

    // The budget comes back when the first request ends.
    land();
    await first;
    await staticApi.sendOps("doc_1", op("z".repeat(40_000)));
    expect(fetch.mock.lastCall![1]).toMatchObject({ keepalive: true });
  });

  it("shares the 64 KiB with the change of a comment, which outlives the page too", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementation(sent());
    vi.stubGlobal("fetch", fetch);

    void staticApi.sendOps("doc_1", op("x".repeat(40_000)));
    await staticApi.patchComment("doc_1", "cmt_1", { body: "Fix it" });
    await staticApi.patchComment("doc_1", "cmt_1", { body: "y".repeat(40_000) });
    expect(fetch.mock.calls.map(([, init]) => init!.keepalive)).toEqual([
      true,
      true,
      false,
    ]);
  });
});

describe.each([
  [
    "sendOps",
    () =>
      staticApi.sendOps("doc_1", {
        base_seq: 1,
        client_op_id: "op_1",
        replacements: [],
      }),
  ],
  ["documentChanges", () => staticApi.documentChanges("doc_1", 1)],
])("%s", (_name, call) => {
  it("fails after 10 s with no answer, as a network that does not answer, so that it can go again", async () => {
    vi.useFakeTimers();
    // The timer of the browser, on the clock of the test.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const timeout = new AbortController();
      setTimeout(() => timeout.abort(new DOMException("", "TimeoutError")), ms);
      return timeout.signal;
    });
    // The network takes the request, and never answers.
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_, fail) =>
          init!.signal!.addEventListener("abort", () => fail(init!.signal!.reason)),
        ),
    );
    vi.stubGlobal("fetch", fetch);

    const failed = vi.fn();
    void call().catch(failed);
    await vi.advanceTimersByTimeAsync(9_000);
    expect(failed).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(failed).toHaveBeenCalledOnce();
    expect(passing(failed.mock.lastCall![0])).toBe(true);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});

describe("versionSource", () => {
  it("gives the source of the current version, with its byte order mark, and the seq of the document", async () => {
    const fetch = answer("\uFEFF<p>Hi</p>", { "X-Slashdocs-Seq": "41" });
    vi.stubGlobal("fetch", fetch);

    expect(await staticApi.versionSource("doc_1", "ver_2")).toEqual({
      source: "\uFEFF<p>Hi</p>",
      seq: 41,
    });
    expect(fetch.mock.lastCall![0]).toBe("/v1/documents/doc_1/versions/ver_2/html");
  });

  it("gives the source of the document at a seq that the version holds", async () => {
    const fetch = answer("<p>Hi</p>", { "X-Slashdocs-Seq": "7" });
    vi.stubGlobal("fetch", fetch);

    expect(await staticApi.versionSource("doc_1", "ver_2", 7)).toEqual({
      source: "<p>Hi</p>",
      seq: 7,
    });
    expect(fetch.mock.lastCall![0]).toBe(
      "/v1/documents/doc_1/versions/ver_2/html?seq=7",
    );
  });

  it.each([undefined, "", "soon", "-1", "1.5"])(
    "gives no seq when the server names %j",
    async (seq) => {
      const headers = seq === undefined ? undefined : { "X-Slashdocs-Seq": seq };
      vi.stubGlobal("fetch", answer("<p>Hi</p>", headers));
      expect((await staticApi.versionSource("doc_1", "ver_2")).seq).toBeUndefined();
    },
  );
});
