import { useState } from "react";
import { Toaster, toast } from "sonner";
import { BrowserRouter, Link, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ChevronRight, ExternalLink, FolderIcon, Search } from "lucide-react";
import { ThemeProvider } from "@/lib/theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Center, EmptyState, Skeleton } from "@/components/ui/misc";
import { TopBar } from "@/components/layout/topbar";
import { CommentsToggle, DocBarFrame } from "@/components/layout/doc-bar-frame";
import { DocWorkspace } from "@/pages/doc-workspace";
import { api } from "@/api";
import { errorMessage } from "@/lib/errors";
import { queryKeys } from "@/lib/queryKeys";
import { Page } from "@/components/layout/page";
import { ENTRY_ROW, EntryName, EntryTable } from "@/components/browse/entry-table";
import { beat } from "@/lib/enter";
import { formatTimestamp } from "@/lib/format-date";
import { useTitle } from "@/lib/use-title";

// slashdocs local: the documents app for a folder of HTML files that
// `slashdocs local` serves. It reuses the app's pages and comments without
// the parts that need the server: accounts, sharing, and versions.

type Entry = {
  type: "folder" | "document";
  path: string;
  title: string;
  modified: string;
};

type Folder = Entry & { type: "folder"; dir: string; entries: Entry[] };
type Doc = Entry & { type: "document"; raw: string; version: string };

async function getEntry(pathname: string): Promise<Folder | Doc> {
  const res = await fetch(`/_/api/entry${pathname}`);
  if (!res.ok) throw new Error(res.status === 404 ? "Not found." : res.statusText);
  return res.json();
}

const href = (path: string) => `/${path.split("/").map(encodeURIComponent).join("/")}`;
const parent = (path: string) => path.split("/").slice(0, -1).join("/");
const base = (path: string) => path.split("/").pop() || "";

function EntryPage() {
  const { pathname } = useLocation();
  const entry = useQuery({
    queryKey: ["entry", pathname],
    queryFn: () => getEntry(pathname),
  });
  // After an error, such as a file deleted on disk, the old data is not shown.
  const data = entry.isError ? undefined : entry.data;
  if (data?.type === "document") {
    return <DocumentPage key={data.path} doc={data} />;
  }
  return (
    <>
      <TopBar home="/" />
      {entry.isLoading ? (
        <Page backdrop={false}>
          <Skeleton className="mx-auto mb-8 mt-16 h-14 max-w-2xl rounded-[18px]" />
          <Skeleton className="h-64 w-full" />
        </Page>
      ) : !data ? (
        <Center>{entry.error?.message}</Center>
      ) : data.path ? (
        <FolderPage folder={data} />
      ) : (
        <DocumentsPage folder={data} />
      )}
    </>
  );
}

// The home page: the documents page of the app, with a filter in place of
// the full-text search.
function DocumentsPage({ folder }: { folder: Folder }) {
  useTitle("Documents");
  const [q, setQ] = useState("");
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const entries = folder.entries.filter((e) =>
    words.every((w) => `${e.title} ${e.path}`.toLowerCase().includes(w)),
  );
  return (
    <Page backdrop="halo">
      <section className="pb-12 pt-8 text-center md:pb-16 md:pt-16">
        <p className="enter text-lg text-[var(--color-fg-muted)]">On this computer</p>
        <h1
          className="enter mt-2 text-[32px] font-normal leading-tight tracking-[-0.02em] md:text-[44px]"
          style={beat(1)}
        >
          What did your agents publish?
        </h1>
        <div className="enter mx-auto mt-8 max-w-2xl" style={beat(2)}>
          <div className="razorsense-ring z-20 w-full rounded-[18px]">
            <Search className="pointer-events-none absolute left-5 top-1/2 z-10 h-5 w-5 -translate-y-1/2 text-[var(--color-fg-muted)]" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              spellCheck={false}
              placeholder="Filter by title or file name…"
              aria-label="Filter documents"
              className="h-14 w-full rounded-[18px] bg-[var(--color-surface)] pl-14 pr-5 text-base shadow-[0_12px_40px_rgb(20_30_48/0.1)] outline-none placeholder:text-[var(--color-fg-muted)] dark:shadow-[0_14px_36px_rgb(0_0_0/0.42)]"
            />
          </div>
        </div>
      </section>
      <h2 className="enter mb-4 text-base font-semibold" style={beat(3)}>
        {q ? "Results" : "Documents"}
      </h2>
      {folder.entries.length === 0 ? (
        <EmptyState
          title="No documents yet"
          description={
            <>
              Put <code className="font-mono text-xs">.html</code> files in{" "}
              <code className="font-mono text-xs">{folder.dir}</code>, then refresh this
              page.
            </>
          }
        />
      ) : entries.length === 0 ? (
        <EmptyState
          title="No matches"
          description={`No title or file name has "${q}".`}
        />
      ) : (
        <Entries entries={entries} />
      )}
    </Page>
  );
}

// A subfolder: the folder page of the app.
function FolderPage({ folder }: { folder: Folder }) {
  useTitle(folder.title);
  const ancestors = folder.path.split("/").slice(0, -1);
  return (
    <Page>
      <nav className="mb-4 flex min-w-0 items-center gap-1 overflow-x-auto whitespace-nowrap text-sm text-[var(--color-fg-muted)]">
        <Link to="/" className="shrink-0 hover:text-[var(--color-fg)]">
          Documents
        </Link>
        {ancestors.map((name, i) => (
          <span key={i} className="flex shrink-0 items-center gap-1">
            <ChevronRight className="h-3 w-3" />
            <Link
              to={href(ancestors.slice(0, i + 1).join("/"))}
              className="hover:text-[var(--color-fg)]"
            >
              {name}
            </Link>
          </span>
        ))}
        <ChevronRight className="h-3 w-3" />
        <span className="shrink-0 font-medium text-[var(--color-fg)]">
          {folder.title}
        </span>
      </nav>
      <div className="mb-8 flex min-w-0 items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
          <FolderIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h1 className="enter truncate text-xl font-semibold tracking-[-0.01em] md:text-2xl">
            {folder.title}
          </h1>
          <p className="truncate font-mono text-xs text-[var(--color-fg-muted)]">
            {folder.dir}
          </p>
        </div>
      </div>
      {folder.entries.length === 0 ? (
        <EmptyState title="This folder is empty" />
      ) : (
        <Entries entries={folder.entries} />
      )}
    </Page>
  );
}

function Entries({ entries }: { entries: Entry[] }) {
  return (
    <EntryTable columns={["Name", "Modified"]}>
      {entries.map((e) => (
        <tr key={e.path} className={`group border-t transition-colors ${ENTRY_ROW}`}>
          <td className="px-4 py-3">
            <EntryName to={href(e.path)} folder={e.type === "folder"} title={e.title} />
          </td>
          <td className="px-4 py-3 text-[var(--color-fg-muted)]">
            {formatTimestamp(e.modified)}
          </td>
        </tr>
      ))}
    </EntryTable>
  );
}

// The document page of the app: the document bar over the rendered document.
function DocumentPage({ doc }: { doc: Doc }) {
  useTitle(doc.title);
  const me = useQuery({ queryKey: queryKeys.me(), queryFn: api.me });
  const folder = parent(doc.path);
  return (
    <DocWorkspace
      // The local API names a document by its path.
      docId={encodeURIComponent(doc.path)}
      version={doc.version}
      principal={me.data?.principal}
      home="/"
      notifications={false}
      bar={({ commentsOpen, onToggleComments }) => (
        <DocBarFrame
          home="/"
          folder={folder ? { to: href(folder), title: base(folder) } : undefined}
          title={doc.title}
        >
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="shrink-0"
            tooltip="Open raw HTML"
          >
            <a
              href={doc.raw}
              target="_blank"
              rel="noreferrer"
              aria-label="Open raw HTML"
            >
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
          <CommentsToggle open={commentsOpen} onToggle={onToggleComments} />
        </DocBarFrame>
      )}
    />
  );
}

export function LocalApp() {
  const [qc] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // An agent can change a document or its comments at any time.
          queries: { refetchOnWindowFocus: true },
          mutations: { onError: (e) => toast.error(errorMessage(e)) },
        },
      }),
  );
  return (
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <TooltipProvider>
          <BrowserRouter>
            <main className="relative h-full overflow-auto">
              <EntryPage />
            </main>
            <Toaster position="bottom-right" theme="system" richColors />
          </BrowserRouter>
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
