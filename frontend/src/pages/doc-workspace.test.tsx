import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api, type Principal } from "@/api";
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
afterEach(cleanup);

const reader: Principal = { type: "user", id: "u1", name: "Reader" };

// The bar shows where the page is, whether a pin waits for its spot, and the
// open draft. It also comments on selected text, as the document does.
function Bar({ onToggleComments }: { onToggleComments: () => void }) {
  const { placingPin, drafts, activeComment, startDraft } = useDoc();
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

// The page keeps Edit mode. The bar says the mode, holds a field, and can make
// the edits on screen fail to save.
function ModeBar() {
  const { editing, setEditing, registerTextSettle } = useDoc();
  return (
    <>
      <p>{editing ? "Editing" : "Commenting"}</p>
      <input aria-label="Title" />
      <button onClick={() => void setEditing(false)}>Done</button>
      <button onClick={() => registerTextSettle(async () => false)}>Fail saves</button>
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

it("stays in Edit mode while the edits on screen do not save", async () => {
  render(<ModePage canEdit />);
  await userEvent.keyboard("e");
  await userEvent.click(screen.getByRole("button", { name: "Fail saves" }));
  for (const leave of ["c", "{Escape}"]) {
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard(leave);
  }
  await userEvent.click(screen.getByRole("button", { name: "Done" }));
  expect(screen.getByText("Editing")).toBeInTheDocument();
});
