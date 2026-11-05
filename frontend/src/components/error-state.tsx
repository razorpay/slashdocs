import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CloudOff, FileQuestion } from "lucide-react";
import { APIError } from "@/api";
import { Button } from "@/components/ui/button";
import { Center, EmptyState, RetryButton, type RetryQuery } from "@/components/ui/misc";
import { cn } from "@/lib/cn";

// A page that cannot show what the link asked for: a missing page, document
// or folder, or one that did not load. The default action goes back to the
// documents. With a query to retry, a Retry action comes first.
export function ErrorState({
  title,
  description,
  icon = <FileQuestion className="h-5 w-5" />,
  retry,
  action = <ErrorActions retry={retry} />,
}: {
  title: string;
  description: ReactNode;
  icon?: ReactNode;
  retry?: RetryQuery;
  action?: ReactNode;
}) {
  return (
    <Center>
      <EmptyState icon={icon} title={title} description={description} action={action} />
    </Center>
  );
}

// PageError says why the document or folder of a page did not load. Only a
// 403 says that the reader has no access, with the page's own denied state,
// and only a 404 says that it is gone. Any other failure offers Retry.
export function PageError({
  error,
  what,
  denied,
  retry,
}: {
  error: unknown;
  what: "document" | "folder";
  denied: ReactNode;
  retry: RetryQuery;
}) {
  const apiError = error instanceof APIError ? error : undefined;
  if (apiError?.status === 403) return denied;
  if (apiError?.status === 404)
    return (
      <ErrorState
        title={what === "document" ? "Document not found" : "Folder not found"}
        description={`This ${what} may have been deleted, or the link may be incorrect.`}
      />
    );
  if (apiError?.code === "group_membership_unavailable")
    return (
      <ErrorState
        title="Group access is temporarily unavailable"
        description="Google Group membership could not be refreshed. Try again shortly; stale group access has not been used."
        retry={retry}
      />
    );
  return (
    <ErrorState
      title={`Could not load ${what}`}
      description="Check your connection, then try again."
      icon={<CloudOff className="h-5 w-5" />}
      retry={retry}
    />
  );
}

function ErrorActions({ retry }: { retry?: RetryQuery }) {
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {retry ? <RetryButton query={retry} /> : null}
      <Button asChild variant={retry ? "outline" : "primary"}>
        <Link to="/app/documents">Go to documents</Link>
      </Button>
    </div>
  );
}

// LoadError takes the place of a part of a page that did not load, such as a
// list. It never looks like an empty list.
export function LoadError({
  title,
  query,
  error,
}: {
  title: string;
  query: RetryQuery;
  error?: unknown;
}) {
  return (
    <EmptyState
      icon={<CloudOff className="h-5 w-5" />}
      title={title}
      description={loadErrorText(error)}
      action={<RetryButton query={query} variant="outline" size="sm" />}
    />
  );
}

// loadErrorText says why a read failed, when its status tells. A 403 or a 404
// tells only of that read: a part of a page that did not load does not mean
// that the page itself is denied or gone.
function loadErrorText(error?: unknown) {
  const status = error instanceof APIError ? error.status : 0;
  if (status === 403) return "You do not have access to this part.";
  if (status === 404) return "It was not found. It may have moved.";
  return "Check your connection, then try again.";
}

// LoadErrorLine is the small form of LoadError, for a hint, a menu or a row
// in a sheet. A boxed line sits on a page, above the parts that did load.
export function LoadErrorLine({
  children,
  query,
  boxed = false,
  className,
}: {
  children: ReactNode;
  query: RetryQuery;
  boxed?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex items-center gap-3 text-xs",
        boxed &&
          "mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] py-2 pl-4 pr-2 text-sm dark:border-transparent",
        className,
      )}
    >
      <CloudOff className="h-4 w-4 shrink-0 text-[var(--color-fg-muted)]" />
      <span className="min-w-0 flex-1 text-pretty">{children}</span>
      <RetryButton query={query} variant="outline" size="sm" className="shrink-0" />
    </div>
  );
}
