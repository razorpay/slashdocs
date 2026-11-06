import { useId } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ChevronRight, FileText, Folder as FolderIcon, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { api, docID, docTitle, type FeaturedSection, type FolderEntry } from "@/api";
import { cn } from "@/lib/cn";
import { errorMessage } from "@/lib/errors";
import { createPersistentStore } from "@/lib/persistent-store";
import { principalLabel } from "@/lib/principals";
import { queryKeys } from "@/lib/queryKeys";

// collapsedStore holds the titles of the sections that the user collapsed.
const collapsedStore = createPersistentStore<string[]>(
  "slashdocs:featured-collapsed",
  [],
  (parsed) =>
    Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [],
);

// FeaturedItems shows the sections of documents and folders that the server
// features for every user, in the configured order.
export function FeaturedItems() {
  const featured = useQuery({
    queryKey: queryKeys.featured(),
    queryFn: api.listFeatured,
  });
  return (featured.data?.items || []).map((section) => (
    <FeaturedRow key={section.title} section={section} />
  ));
}

function FeaturedRow({ section }: { section: FeaturedSection }) {
  const headingID = useId();
  const contentID = useId();
  const collapsedTitles = collapsedStore.useStore();
  const collapsed = collapsedTitles.includes(section.title);
  const toggle = () =>
    collapsedStore.write(
      collapsed
        ? collapsedTitles.filter((t) => t !== section.title)
        : [...collapsedTitles, section.title],
    );
  return (
    <section aria-labelledby={headingID} className={collapsed ? "mb-3" : "mb-8"}>
      <h2 id={headingID} className="text-sm font-semibold">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-controls={contentID}
          onClick={toggle}
          className="-ml-1 flex cursor-pointer items-center gap-1 rounded-sm py-1 pl-1 pr-1.5 hover:bg-[var(--color-surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          <ChevronRight
            aria-hidden
            className={cn(
              "h-3.5 w-3.5 text-[var(--color-fg-muted)] transition-transform duration-200 ease-out",
              !collapsed && "rotate-90",
            )}
          />
          {section.title}
          {collapsed && (
            <span className="ml-1 text-xs font-normal tabular-nums text-[var(--color-fg-muted)]">
              {section.items.length}
            </span>
          )}
        </button>
      </h2>
      <div id={contentID} hidden={collapsed}>
        {section.description && (
          <p className="text-xs text-[var(--color-fg-muted)]">{section.description}</p>
        )}
        <div className="stagger-grid mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {section.items.map((item) => (
            <FeaturedCard
              key={item.folder?.id || docID(item.document!)}
              item={item}
              hideable={!section.permanent}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeaturedCard({ item, hideable }: { item: FolderEntry; hideable: boolean }) {
  const isFolder = item.type === "folder";
  const id = item.folder?.id || docID(item.document!);
  const title = item.folder?.title || docTitle(item.document!);
  const qc = useQueryClient();
  const hide = useMutation({
    mutationFn: () => api.hideFeatured(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: queryKeys.featured() }),
    onError: (e) => toast.error(errorMessage(e, "Could not hide")),
  });
  const Icon = isFolder ? FolderIcon : FileText;

  return (
    <div className="group relative flex items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] transition-[border-color,transform] duration-200 ease-out hover:-translate-y-0.5 hover:border-[var(--color-border-strong)] dark:border-transparent dark:hover:border-[var(--color-border)]">
      <Link
        to={isFolder ? `/app/folders/${id}` : `/app/d/${id}`}
        className={`flex min-w-0 flex-1 items-center gap-3 p-2 ${hideable ? "pr-12" : ""}`}
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-sm bg-[var(--color-accent-muted)] text-[var(--color-accent)]">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="block truncate text-xs text-[var(--color-fg-muted)]">
            {isFolder ? "Folder" : "Document"} ·{" "}
            {principalLabel(item.folder?.owner || item.document?.owner)}
          </span>
        </span>
      </Link>
      {hideable && (
        <Button
          variant="ghost"
          size="icon"
          aria-label="Hide"
          className="absolute right-1 h-10 w-10 cursor-pointer opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          disabled={hide.isPending}
          onClick={() => hide.mutate()}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      )}
    </div>
  );
}
