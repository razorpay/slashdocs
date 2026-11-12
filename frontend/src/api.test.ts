import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { passing } from "./pages/live-load";

afterEach(() => vi.unstubAllGlobals());

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

    await api.sendOps("doc_1", op("x"));

    expect(fetch.mock.lastCall![1]).toMatchObject({ method: "POST", keepalive: true });
  });

  it("goes in a normal request when its body is larger than 64 KiB, which no browser lets outlive the page", async () => {
    const fetch = sent();
    vi.stubGlobal("fetch", fetch);

    // A character of three bytes: the limit is in bytes.
    await api.sendOps("doc_1", op("€".repeat(22_000)));

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
    const first = api.sendOps("doc_1", op("x".repeat(40_000)));
    await api.sendOps("doc_1", op("y".repeat(40_000)));
    expect(fetch.mock.calls.map(([, init]) => init!.keepalive)).toEqual([true, false]);

    // The budget comes back when the first request ends.
    land();
    await first;
    await api.sendOps("doc_1", op("z".repeat(40_000)));
    expect(fetch.mock.lastCall![1]).toMatchObject({ keepalive: true });
  });

  it("shares the 64 KiB with the change of a comment, which outlives the page too", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockImplementation(sent());
    vi.stubGlobal("fetch", fetch);

    void api.sendOps("doc_1", op("x".repeat(40_000)));
    await api.patchComment("doc_1", "cmt_1", { body: "Fix it" });
    await api.patchComment("doc_1", "cmt_1", { body: "y".repeat(40_000) });
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
    () => api.sendOps("doc_1", { base_seq: 1, client_op_id: "op_1", replacements: [] }),
  ],
  ["documentChanges", () => api.documentChanges("doc_1", 1)],
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

    expect(await api.versionSource("doc_1", "ver_2")).toEqual({
      source: "\uFEFF<p>Hi</p>",
      seq: 41,
    });
    expect(fetch.mock.lastCall![0]).toBe("/v1/documents/doc_1/versions/ver_2/html");
  });

  it("gives the source of the document at a seq that the version holds", async () => {
    const fetch = answer("<p>Hi</p>", { "X-Slashdocs-Seq": "7" });
    vi.stubGlobal("fetch", fetch);

    expect(await api.versionSource("doc_1", "ver_2", 7)).toEqual({
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
      expect((await api.versionSource("doc_1", "ver_2")).seq).toBeUndefined();
    },
  );
});
