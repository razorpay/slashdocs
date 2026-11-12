import {
  focusManager,
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { toast } from "sonner";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type Principal } from "@/api";
import { replacementsBetween } from "@/lib/source-edits";
import { sumOf } from "@/lib/source-merge";
import { writeTextDraft } from "@/lib/text-drafts";
import { signInPath } from "@/lib/auth-state";
import { keepPendingComment, takePendingComment } from "@/lib/comment-drafts";
import { useDoc } from "./doc-context";
import { DocWorkspace } from "./doc-workspace";

// jsdom has no media queries.
beforeEach(() => {
  window.matchMedia = () =>
    ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList;
  vi.spyOn(api, "listComments").mockResolvedValue({ items: [] } as never);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const reader: Principal = { type: "user", id: "u1", name: "Reader" };

// The bar shows where the page is, whether a pin waits for its spot, and the
// open draft. It also comments on selected text, as the document does.
function Bar({ onToggleComments }: { onToggleComments: () => void }) {
  const { placingPin, drafts, activeComment, setActiveComment, startDraft } = useDoc();
  const { pathname, search } = useLocation();
  const open = drafts.find((d) => d.id === activeComment);
  return (
    <>
      <p>{pathname + search}</p>
      <p>{placingPin ? "Placing a pin" : "Reading"}</p>
      <p>{open ? `Draft on "${open.quote}" in ${open.version}` : "No draft"}</p>
      <button onClick={onToggleComments}>Comments</button>
      <button onClick={() => startDraft({ quote: "selected words" })}>
        Comment on text
      </button>
      <button onClick={() => setActiveComment(undefined)}>Close the draft</button>
    </>
  );
}

function renderWorkspace(
  entry: string,
  props: { principal?: Principal; signIn?: () => void },
) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <DocWorkspace
          docId="doc-1"
          version="v1"
          home="/app/documents"
          {...props}
          bar={({ onToggleComments }) => <Bar onToggleComments={onToggleComments} />}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

it("sends a reader who is signed out to sign in, with the pin to place after", async () => {
  renderWorkspace("/app/d/doc-1?version=v1", { signIn: vi.fn() });
  await userEvent.click(screen.getByRole("button", { name: "Comments" }));
  await userEvent.click(
    await screen.findByRole("button", { name: "Sign in to comment" }),
  );
  expect(
    screen.getByText(
      signInPath({ pathname: "/app/d/doc-1", search: "?version=v1" }, "pin"),
    ),
  ).toBeInTheDocument();
});

it("places the pin once the reader is back, and forgets the intent", async () => {
  renderWorkspace("/app/d/doc-1?version=v1&intent=pin", { principal: reader });
  expect(await screen.findByText("Placing a pin")).toBeInTheDocument();
  expect(screen.getByText("/app/d/doc-1?version=v1")).toBeInTheDocument();
});

it("keeps the intent until the reader is signed in", () => {
  renderWorkspace("/app/d/doc-1?intent=pin", { signIn: vi.fn() });
  expect(screen.getByText("Reading")).toBeInTheDocument();
  expect(screen.getByText("/app/d/doc-1?intent=pin")).toBeInTheDocument();
});

it("keeps the text that a reader who is signed out comments on while they sign in", async () => {
  localStorage.clear();
  renderWorkspace("/app/d/doc-1", { signIn: vi.fn() });
  await userEvent.click(screen.getByRole("button", { name: "Comment on text" }));
  expect(
    screen.getByText(signInPath({ pathname: "/app/d/doc-1", search: "" }, "comment")),
  ).toBeInTheDocument();
  expect(takePendingComment("doc-1")).toEqual({
    docId: "doc-1",
    version: "v1",
    selection: { quote: "selected words" },
  });
});

it("opens the draft on that text once the reader is back", async () => {
  localStorage.clear();
  keepPendingComment({
    docId: "doc-1",
    version: "v0",
    selection: { quote: "old words" },
  });
  renderWorkspace("/app/d/doc-1?intent=comment", { principal: reader });
  expect(await screen.findByText('Draft on "old words" in v0')).toBeInTheDocument();
  expect(screen.getByText("/app/d/doc-1")).toBeInTheDocument();
  expect(takePendingComment("doc-1")).toBeNull();
});

it("opens a draft on the same text again while its empty draft goes", () => {
  localStorage.clear();
  renderWorkspace("/app/d/doc-1", { principal: reader });
  vi.useFakeTimers();
  const comment = screen.getByRole("button", { name: "Comment on text" });
  act(() => comment.click());
  act(() => screen.getByRole("button", { name: "Close the draft" }).click());
  act(() => vi.advanceTimersByTime(490));
  // The empty draft goes before the page shows the next one.
  act(() => {
    comment.click();
    vi.advanceTimersByTime(20);
  });
  expect(screen.getByText('Draft on "selected words" in v1')).toBeInTheDocument();
});

// The page keeps Edit mode. The bar says the mode, holds a field, and can make
// the edits on screen fail to save.
function ModeBar() {
  const { editing, setEditing, registerLiveText } = useDoc();
  return (
    <>
      <p>{editing ? "Editing" : "Commenting"}</p>
      <input aria-label="Title" />
      <button onClick={() => void setEditing(false)}>Done</button>
      <button
        onClick={() =>
          registerLiveText({
            settle: async () => false,
            showUpdate: async () => {},
            anchorOf: async () => undefined,
          })
        }
      >
        Refuse saves
      </button>
      <button
        onClick={() =>
          // The sends fail, and go again by themselves: the reader can leave.
          registerLiveText({
            settle: async () => true,
            showUpdate: async () => {},
            anchorOf: async () => undefined,
          })
        }
      >
        Fail sends
      </button>
    </>
  );
}

function ModePage({ canEdit }: { canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  return (
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <DocWorkspace
          docId="doc-1"
          version="v1"
          home="/app/documents"
          principal={reader}
          canEdit={canEdit}
          editing={canEdit && editing}
          onEditingChange={setEditing}
          bar={() => <ModeBar />}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

it("opens in Comment mode, E starts Edit mode, and C, Done or one Esc leaves it", async () => {
  render(<ModePage canEdit />);
  expect(screen.getByText("Commenting")).toBeInTheDocument();
  for (const leave of ["c", "{Escape}", "done"]) {
    await userEvent.keyboard("e");
    expect(screen.getByText("Editing")).toBeInTheDocument();
    if (leave === "done")
      await userEvent.click(screen.getByRole("button", { name: "Done" }));
    else await userEvent.keyboard(leave);
    expect(await screen.findByText("Commenting")).toBeInTheDocument();
  }
});

it("takes E and C only without modifiers, outside fields, from a reader who can edit", async () => {
  const { unmount } = render(<ModePage canEdit />);
  await userEvent.keyboard("{Control>}e{/Control}");
  await userEvent.type(screen.getByRole("textbox", { name: "Title" }), "e");
  expect(screen.getByText("Commenting")).toBeInTheDocument();
  unmount();
  render(<ModePage canEdit={false} />);
  await userEvent.keyboard("e");
  expect(screen.getByText("Commenting")).toBeInTheDocument();
});

it("stays in Edit mode while a change on screen cannot save", async () => {
  render(<ModePage canEdit />);
  await userEvent.keyboard("e");
  await userEvent.click(screen.getByRole("button", { name: "Refuse saves" }));
  for (const leave of ["c", "{Escape}"]) {
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard(leave);
  }
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByText("Editing")).toBeInTheDocument();
});

// The frame of the workspace, and the count of render tokens that it asked for.
function renderFrame(live: boolean, latest?: number) {
  let load = 0;
  const token = vi
    .spyOn(api, "renderToken")
    .mockImplementation(async (_doc, version) => ({
      token: "t",
      url: `/render/doc-1/${version}?load=${++load}`,
      seq: 5,
    }));
  const workspace = (version: string) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/app/d/doc-1"]}>
        <DocWorkspace
          docId="doc-1"
          version={version}
          home="/app/documents"
          principal={reader}
          live={live}
          latest={latest}
          bar={() => <Latest />}
        />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const client = new QueryClient();
  const view = render(workspace("v1"));
  const src = async () =>
    (await screen.findByTitle("Rendered document")).getAttribute("src");
  const toggleFullScreen = async () => {
    await userEvent.keyboard("{Escape}");
    await userEvent.keyboard("f");
  };
  return {
    token,
    src,
    toggleFullScreen,
    show: (version: string) => view.rerender(workspace(version)),
  };
}

function Latest() {
  const { showCurrent, showUpdate } = useDoc();
  return (
    <>
      <button onClick={showCurrent}>Show the latest</button>
      <button onClick={showUpdate}>Show the update</button>
    </>
  );
}

// The document in the frame: it is ready, it answers each take with no edits
// and its scroll, and it keeps the messages that the page sends to it. A
// take gives caret, the selection that a load keeps.
function frameDocument(top: number, caret: unknown = null) {
  const posted: { type: string; [key: string]: unknown }[] = [];
  const send = (data: object) => {
    const source = screen.getByTitle<HTMLIFrameElement>("Rendered document");
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: source.contentWindow,
        data,
      }),
    );
  };
  const ready = async () => {
    const frame = await screen.findByTitle<HTMLIFrameElement>("Rendered document");
    vi.spyOn(frame.contentWindow!, "postMessage").mockImplementation(((
      message: (typeof posted)[number],
    ) => {
      posted.push(message);
      if (message.type !== "slashdocs:text-collect") return;
      const { requestId } = message;
      const taken = { requestId, regions: [], scripts: [], edits: 0, top, caret };
      queueMicrotask(() =>
        act(() => send({ type: "slashdocs:text-changes", ...taken })),
      );
    }) as never);
    act(() => send({ type: "slashdocs:ready" }));
  };
  return { posted, ready };
}

it("keeps the place and the caret of the reader when the latest needs a load of the frame", async () => {
  const SOURCE = "<p>One.</p>";
  const NEXT = `${SOURCE}<script>go()</script>`;
  vi.spyOn(api, "versionSource").mockResolvedValue({ source: SOURCE, seq: 5 });
  vi.spyOn(api, "getDocument").mockResolvedValue({ id: "doc-1" } as never);
  vi.spyOn(api, "documentChanges").mockResolvedValue({
    seq: 6,
    version_id: "v1",
    ops: [replacementsBetween(SOURCE, NEXT)],
    typed: false,
    authors: [],
    sum: sumOf(NEXT),
  });
  const { token, src } = renderFrame(true, 6);
  const caret = { start: 3, end: 3, at: 0, text: "One." };
  const frame = frameDocument(420, caret);
  await frame.ready();
  // The change waits for the reader: it needs a load of the frame.
  await vi.waitFor(() => expect(api.documentChanges).toHaveBeenCalled());
  expect(token).toHaveBeenCalledOnce();

  await userEvent.click(screen.getByRole("button", { name: "Show the update" }));

  await vi.waitFor(async () =>
    expect(await src()).toContain("/render/doc-1/v1?load=2"),
  );
  // The frame took no more keys before it went.
  expect(frame.posted).toContainEqual({ type: "slashdocs:text-editing", on: false });
  // The next frame starts where the reader was, with their caret.
  await frame.ready();
  await vi.waitFor(() =>
    expect(frame.posted).toContainEqual({
      type: "slashdocs:scroll-to",
      top: 420,
      caret,
    }),
  );
});

it("follows the document again from the loaded seq, with no other render token, when the document loads itself again", async () => {
  const SOURCE = "<p>One.</p>";
  const NEXT = "<p>One.</p><p>Two.</p>";
  vi.spyOn(api, "versionSource").mockResolvedValue({ source: SOURCE, seq: 5 });
  vi.spyOn(api, "documentChanges").mockResolvedValue({
    seq: 6,
    version_id: "v1",
    ops: [replacementsBetween(SOURCE, NEXT)],
    typed: true,
    authors: [],
    sum: sumOf(NEXT),
  });
  const { token } = renderFrame(true, 6);
  const frame = frameDocument(0);
  await frame.ready();
  const patches = () => frame.posted.filter((m) => m.type === "slashdocs:text-patch");
  await vi.waitFor(() => expect(patches()).toHaveLength(1));

  // A script of the document loads it again, as some do on a theme change:
  // the frame is ready a second time, and shows the source of seq 5 again.
  await frame.ready();

  // The text of the other person goes into it again.
  await vi.waitFor(() => expect(patches()).toHaveLength(2));
  expect(api.documentChanges).toHaveBeenLastCalledWith("doc-1", 5);
  // A new render token would load the frame again, and such a document
  // would then load itself again with no end.
  expect(token).toHaveBeenCalledOnce();
});

it.each([
  ["under the bar", ""],
  ["in full screen", "?fullscreen=1"],
])("puts the banner %s above the document, in the layout", async (_, search) => {
  vi.spyOn(api, "renderToken").mockResolvedValue({
    token: "t",
    url: "/render/1",
    seq: 5,
  });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[`/app/d/doc-1${search}`]}>
        <DocWorkspace
          docId="doc-1"
          version="v1"
          home="/app/documents"
          principal={reader}
          bar={() => null}
          banner={<p>This document changed.</p>}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  // The banner and the frame are next to each other in the layout: the
  // banner covers none of the document.
  expect(
    screen.getByText("This document changed.").nextElementSibling,
  ).toContainElement(await screen.findByTitle("Rendered document"));
});

it("keeps the frame of a page that follows the document when the document gets a new version", async () => {
  const { token, src, show } = renderFrame(true);
  expect(await src()).toContain("/render/doc-1/v1?load=1");

  show("v2");
  await new Promise((done) => setTimeout(done, 20));

  expect(token).toHaveBeenCalledOnce();
  expect(await src()).toContain("/render/doc-1/v1?load=1");
});

it("asks for a new render token when the reader asks for the latest", async () => {
  const { token, src, show } = renderFrame(true);
  await src();
  show("v2");

  await userEvent.click(screen.getByRole("button", { name: "Show the latest" }));

  await vi.waitFor(async () =>
    expect(await src()).toContain("/render/doc-1/v2?load=2"),
  );
  expect(token).toHaveBeenCalledTimes(2);
});

it("asks for no other render token while the frame is on screen", async () => {
  const { token, src } = renderFrame(true);
  const first = await src();

  // The reader comes back to the tab after a long time, and the network
  // comes back: a new token would load the frame under their text.
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60 * 60_000);
  focusManager.setFocused(false);
  focusManager.setFocused(true);
  onlineManager.setOnline(false);
  onlineManager.setOnline(true);
  await new Promise((done) => setTimeout(done, 20));

  expect(token).toHaveBeenCalledOnce();
  expect(await src()).toBe(first);
});

it("loads the document again, with a new render token, when the frame mounts again", async () => {
  const { token, src, toggleFullScreen } = renderFrame(true);
  expect(await src()).toContain("/render/doc-1/v1?load=1");

  // Full screen puts the frame in another place of the page.
  await toggleFullScreen();

  await vi.waitFor(async () =>
    expect(await src()).toContain("/render/doc-1/v1?load=2"),
  );
  expect(token).toHaveBeenCalledTimes(2);
});

it("offers the text of an earlier visit one time, also when the frame mounts again", async () => {
  const error = vi.spyOn(toast, "error");
  // Script text of an earlier visit, which only a frame that shows it sends.
  writeTextDraft(reader.id, "doc-1", "load_0", { version: "v0", copy: "Keep it." });
  const { src, toggleFullScreen } = renderFrame(true);
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());

  await toggleFullScreen();
  await vi.waitFor(async () =>
    expect(await src()).toContain("/render/doc-1/v1?load=2"),
  );

  expect(error).toHaveBeenCalledExactlyOnceWith(
    "You have text in this document that was not saved.",
    expect.anything(),
  );
  toast.dismiss();
  localStorage.clear();
});

it("loads each version that a preview shows", async () => {
  const { src, show } = renderFrame(false);
  expect(await src()).toContain("/render/doc-1/v1?load=1");

  show("v2");

  await vi.waitFor(async () =>
    expect(await src()).toContain("/render/doc-1/v2?load=2"),
  );
});

it("stays in Edit mode on Done while a change cannot save", async () => {
  render(<ModePage canEdit />);
  await userEvent.keyboard("e");
  await screen.findByText("Editing");

  await userEvent.click(screen.getByRole("button", { name: "Refuse saves" }));
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByText("Editing")).toBeInTheDocument();
});

it("leaves Edit mode on Done when the edits only wait for the network", async () => {
  render(<ModePage canEdit />);
  await userEvent.keyboard("e");
  await userEvent.click(screen.getByRole("button", { name: "Fail sends" }));
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(await screen.findByText("Commenting")).toBeInTheDocument();
});

it("asks the server for nothing when Edit mode ends, and when the page goes", async () => {
  const fetched = vi
    .spyOn(globalThis, "fetch")
    .mockRejectedValue(new TypeError("Failed to fetch"));
  const view = render(<ModePage canEdit />);
  await userEvent.keyboard("e");
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  await screen.findByText("Commenting");

  await userEvent.keyboard("e");
  await screen.findByText("Editing");
  // The browser unloads the page, or the app leaves it.
  window.dispatchEvent(new Event("pagehide"));
  view.unmount();
  await new Promise((done) => setTimeout(done, 20));

  // The server alone ends a sitting: the page asks for no version.
  const asked = fetched.mock.calls.map(([url]) => String(url));
  expect(asked).not.toHaveLength(0);
  expect(asked.filter((url) => /checkpoint|ops/.test(url))).toEqual([]);
});
