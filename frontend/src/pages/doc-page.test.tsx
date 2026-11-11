import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DocProvider, type DocContextValue } from "./doc-context";
import { DocumentPage } from "./doc-page";
import type { DocWorkspace } from "./doc-workspace";

// The workspace shows what the page gives it: the version of the page, the
// newest seq of the document, and the banner. A test speaks for the frame
// through its props: it holds an update, and tells the seq that it shows.
let workspace: Parameters<typeof DocWorkspace>[0];
vi.mock("./doc-workspace", () => ({
  DocWorkspace: (props: Parameters<typeof DocWorkspace>[0]) => {
    workspace = props;
    return (
      <DocProvider
        value={
          {
            showCurrent: props.onLeavePreview,
            showUpdate,
          } as unknown as DocContextValue
        }
      >
        <p>
          on {props.version}, seq {props.latest}
        </p>
        {props.banner}
      </DocProvider>
    );
  },
}));
const asha = { type: "user" as const, id: "usr_a", name: "Asha" };
// The frame shows the change that waits when the reader asks.
const showUpdate = vi.fn();
const toastInfo = vi.hoisted(() => vi.fn());
vi.mock("sonner", () => ({ toast: { info: toastInfo } }));

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// installFetch answers the document with each status in turn, then with the
// last one.
function installFetch(documentStatuses: number[], ownRequests: unknown[] = []) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method || "GET" });
      if (url === "/v1/me") {
        return jsonResponse({ principal: { type: "user", id: "usr_reader" } });
      }
      if (url === "/v1/documents/doc_1") {
        const status = documentStatuses.shift() ?? 500;
        if (!documentStatuses.length) documentStatuses.push(status);
        return jsonResponse({ error: { code: "error", message: "no" } }, status);
      }
      if (url === "/v1/documents/doc_1/access-requests") {
        return jsonResponse({ items: ownRequests });
      }
      return jsonResponse({ items: [] });
    }),
  );
  const eventSource = vi.fn();
  vi.stubGlobal("EventSource", eventSource);
  return { calls, eventSource };
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/app/d/doc_1"]}>
        <Routes>
          <Route path="/app/d/:id" element={<DocumentPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  toastInfo.mockClear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("DocumentPage", () => {
  it("shows a request that waits as sent, and does not join the document", async () => {
    const { calls, eventSource } = installFetch(
      [403],
      [{ requester: { type: "user", id: "usr_reader" }, requested_at: "2026-11-01" }],
    );
    renderPage();
    expect(
      await screen.findByRole("button", { name: /Request sent/ }, { timeout: 3_000 }),
    ).toBeDisabled();
    expect(eventSource).not.toHaveBeenCalled();
    expect(calls.some((call) => call.url.includes("/presence"))).toBe(false);
  });

  it("offers a request when none waits", async () => {
    installFetch([403]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Request access/ })).toBeEnabled(),
    );
  });

  it("loads the document again on Retry", async () => {
    const { calls } = installFetch([500, 403]);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Retry" }));
    expect(
      await screen.findByText("You don't have access to this document"),
    ).toBeVisible();
    // The load, Retry, and the first check of the page that waits for access.
    await waitFor(() =>
      expect(calls.filter((call) => call.url === "/v1/documents/doc_1")).toHaveLength(
        3,
      ),
    );
  });

  it("checks access again on Check access, and says that it is still missing", async () => {
    const { calls } = installFetch(
      [403],
      [{ requester: { type: "user", id: "usr_reader" }, requested_at: "2026-11-01" }],
    );
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Check access" }));
    expect(await screen.findByText(/You still don't have access/)).toBeVisible();
    expect(calls.filter((call) => call.url === "/v1/documents/doc_1")).toHaveLength(3);
  });

  it("says that Check access failed, not that access is still missing", async () => {
    installFetch(
      [403, 403, 503],
      [{ requester: { type: "user", id: "usr_reader" }, requested_at: "2026-11-01" }],
    );
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Check access" }));
    expect(await screen.findByText(/Could not check access/)).toBeVisible();
    expect(screen.queryByText(/You still don't have access/)).toBeNull();
    expect(screen.getByRole("button", { name: "Check access" })).toBeEnabled();
  });

  it("asks for the document again while the reader waits for access", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls } = installFetch([403]);
    renderPage();
    await screen.findByText("You don't have access to this document");
    const asked = () => calls.filter((call) => call.url === "/v1/documents/doc_1");
    await waitFor(() => expect(asked()).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(5_000);
    await waitFor(() => expect(asked()).toHaveLength(3));
    // The page that waits does not blink to a load while it asks.
    expect(screen.getByText("You don't have access to this document")).toBeVisible();
  });
});

describe("a document that changes", () => {
  // The stream of the page, which a test sends events on.
  class Stream {
    static last: Stream;
    listeners = new Map<string, (message: MessageEvent) => void>();
    onopen?: () => void;
    constructor() {
      Stream.last = this;
    }
    addEventListener(kind: string, listener: (message: MessageEvent) => void) {
      this.listeners.set(kind, listener);
    }
    send(event: object) {
      this.listeners.get("document")?.(
        new MessageEvent("document", { data: JSON.stringify(event) }),
      );
    }
    close() {}
  }

  // The server has the document at a seq, in a version. The frame of the
  // page shows that seq.
  async function open() {
    // The reader owns the document, so they can edit it.
    const me = { type: "user", id: "usr_reader" };
    const server = {
      id: "doc_1",
      title: "Plan",
      current_version_id: "ver_1",
      seq: 1,
      owner: me,
    };
    const answers: Record<string, unknown> = {
      "/v1/documents/doc_1": server,
      "/v1/me": { principal: me },
    };
    vi.stubGlobal(
      "fetch",
      // A test can hold an answer: it gives a promise for it.
      vi.fn(async (input: RequestInfo | URL) =>
        jsonResponse((await answers[String(input)]) ?? { items: [] }),
      ),
    );
    vi.stubGlobal("EventSource", Stream);
    renderPage();
    await screen.findByText("on ver_1, seq 1");
    const shows = (seq: number, version = "ver_1") =>
      act(() => workspace.frameShows?.(seq, version));
    shows(1);
    const change = (seq: number, version = "ver_1") => {
      Object.assign(server, { seq, current_version_id: version });
      act(() => Stream.last.send({ data: { seq, version_id: version } }));
    };
    const asked = (url: string) =>
      vi.mocked(fetch).mock.calls.filter(([input]) => input === url).length;
    return { server, answers, change, shows, asked };
  }

  const banner = () => screen.queryByRole("status");

  it("learns the newest seq from the event, and shows no banner while the frame follows", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { change, shows } = await open();

    change(2);
    expect(await screen.findByText("on ver_1, seq 2")).toBeVisible();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    shows(2);
    await act(() => vi.advanceTimersByTimeAsync(2000));

    expect(banner()).toBeNull();
  });

  it("moves to a new version of the document, and stays a page that follows", async () => {
    const { change } = await open();

    change(2, "ver_2");

    expect(await screen.findByText("on ver_2, seq 2")).toBeVisible();
    expect(workspace.live).toBe(true);
    expect(workspace.showsLatest).toBe(true);
    expect(banner()).toBeNull();
  });

  it("gives the frame the last event, and the approver the seq that the frame shows", async () => {
    const { shows } = await open();
    expect(workspace.shownSeq).toBe(1);

    const data = { seq: 2, version_id: "ver_1", prev_seq: 1, replacements: [], sum: 9 };
    act(() => Stream.last.send({ data }));
    await screen.findByText("on ver_1, seq 2");
    expect(workspace.event).toMatchObject({ seq: 2, prev_seq: 1 });

    shows(2);
    expect(workspace.shownSeq).toBe(2);
  });

  it("refreshes the lists when the version changes, not on each operation", async () => {
    const { change, asked } = await open();
    const versions = "/v1/documents/doc_1/versions";
    const before = asked(versions);

    change(2);
    change(3);
    expect(asked(versions)).toBe(before);

    change(4, "ver_2");
    await waitFor(() => expect(asked(versions)).toBe(before + 1));
  });

  it("learns a seq that the frame shows before the stream tells of it", async () => {
    const { server, shows } = await open();

    // The operation of this reader made seq 3, and started a version.
    Object.assign(server, { seq: 3, current_version_id: "ver_2" });
    shows(3, "ver_2");
    expect(await screen.findByText("on ver_2, seq 3")).toBeVisible();

    // A late event for an earlier seq changes nothing.
    act(() => Stream.last.send({ data: { seq: 2, version_id: "ver_1" } }));
    await act(() => new Promise((done) => setTimeout(done, 20)));
    expect(screen.getByText("on ver_2, seq 3")).toBeVisible();
    expect(banner()).toBeNull();
  });

  it("offers the latest when the frame stays behind the newest seq", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { change, shows } = await open();

    change(2);
    await screen.findByText("on ver_1, seq 2");
    await act(() => vi.advanceTimersByTimeAsync(1400));
    expect(banner()).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(banner()).toHaveTextContent("This document changed.");
    expect(workspace.live).toBe(true);

    // The frame shows the latest where the reader is, and tells its seq.
    // The banner goes then.
    await userEvent.click(screen.getByRole("button", { name: "Show the latest" }));
    expect(showUpdate).toHaveBeenCalledOnce();
    shows(2);
    expect(banner()).toBeNull();
  });

  it("offers nothing while the frame loads again, and shows no seq of the document", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { change } = await open();
    change(2);
    await screen.findByText("on ver_1, seq 2");

    // The frame loads the document again: it tells no seq until it is ready.
    act(() => workspace.frameShows?.(undefined, "ver_1"));
    act(() => workspace.holdUpdate?.({ authors: [asha] }));
    await act(() => vi.advanceTimersByTimeAsync(3000));

    expect(workspace.shownSeq).toBeUndefined();
    expect(banner()).toBeNull();
  });

  it("offers nothing to a person in Edit mode, whose page keeps following", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { change } = await open();
    await act(() => workspace.onEditingChange?.(true));

    change(2);
    await screen.findByText("on ver_1, seq 2");
    act(() => workspace.holdUpdate?.({ authors: [asha] }));
    await act(() => vi.advanceTimersByTimeAsync(3000));

    expect(banner()).toBeNull();
    expect(workspace.live).toBe(true);
  });

  it("refreshes the history, the approvals and the document when the people are done", async () => {
    const { asked } = await open();
    const count = () =>
      ["/v1/documents/doc_1", "/v1/documents/doc_1/versions"].map(asked);
    const before = count();

    // The seal changes no seq and no version id.
    act(() =>
      Stream.last.send({ data: { seq: 1, version_id: "ver_1", sealed: true } }),
    );

    await waitFor(() => expect(count()).toEqual(before.map((n) => n + 1)));
  });

  it("shows at once the change that the frame holds for the reader", async () => {
    const { change } = await open();

    change(2);
    await screen.findByText("on ver_1, seq 2");
    act(() => workspace.holdUpdate?.({ authors: [asha] }));

    expect(banner()).toHaveTextContent("Asha updated this document.");
  });

  it("keeps the larger seq when an answer for the document names an earlier one", async () => {
    const { server, answers, change } = await open();
    // A refresh of the document is on its way, as after the first key on
    // an approved document.
    let answer!: (doc: unknown) => void;
    answers["/v1/documents/doc_1"] = new Promise((resolve) => (answer = resolve));
    act(() => Stream.last.send({}));

    // Operations come before its answer does.
    change(2);
    change(3, "ver_2");
    await screen.findByText("on ver_2, seq 3");
    answer({ ...server, seq: 1, current_version_id: "ver_1", title: "Plan B" });

    // The rest of the answer is in, and the seq and its version stay.
    await waitFor(() => expect(document.title).toContain("Plan B"));
    expect(screen.getByText("on ver_2, seq 3")).toBeVisible();
  });

  it("keeps Edit mode when the reader goes to a person on the live document", async () => {
    await open();
    await act(() => workspace.onEditingChange?.(true));
    expect(workspace.editing).toBe(true);

    // The jump shows the latest version, which is on screen.
    act(() => workspace.onLeavePreview?.());

    expect(workspace.editing).toBe(true);
    expect(screen.getByText("on ver_1, seq 1")).toBeVisible();
  });

  it("ends Edit mode when the reader goes to an earlier version", async () => {
    await open();
    await act(() => workspace.onEditingChange?.(true));

    // The History opens a version with the function that leaves a preview.
    const showVersion = workspace.onLeavePreview as (version: string) => void;
    act(() => showVersion("ver_0"));

    expect(await screen.findByText("on ver_0, seq 1")).toBeVisible();
    expect(workspace.editing).toBe(false);
  });

  it("tells the other people of a restore, and not the person who restored", async () => {
    await open();
    const restore = (updated_by: object) =>
      act(() =>
        Stream.last.send({
          updated_by,
          data: { seq: 2, version_id: "ver_2", restored: true },
        }),
      );

    restore({ type: "user", id: "usr_reader" });
    expect(toastInfo).not.toHaveBeenCalled();

    restore(asha);
    expect(toastInfo).toHaveBeenCalledExactlyOnceWith(
      "Asha restored an earlier state of this document.",
    );
  });

  it.each([
    ["the stream opens", () => Stream.last.onopen?.()],
    ["an event names no seq", () => Stream.last.send({})],
  ])("asks for the document again when %s", async (_name, event) => {
    const { asked } = await open();
    const before = asked("/v1/documents/doc_1");

    act(event);

    await waitFor(() => expect(asked("/v1/documents/doc_1")).toBeGreaterThan(before));
  });
});
