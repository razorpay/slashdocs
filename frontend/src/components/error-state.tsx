import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { CloudOff, FileQuestion } from "lucide-react";
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
export function LoadError({ title, query }: { title: string; query: RetryQuery }) {
  return (
    <EmptyState
      icon={<CloudOff className="h-5 w-5" />}
      title={title}
      description="Check your connection, then try again."
      action={<RetryButton query={query} variant="outline" size="sm" />}
    />
  );
}

// LoadErrorLine is the small form of LoadError, for a hint, a menu or a row
// in a sheet.
export function LoadErrorLine({
  children,
  query,
  className,
}: {
  children: ReactNode;
  query: RetryQuery;
  className?: string;
}) {
  return (
    <div role="alert" className={cn("flex items-center gap-3 text-xs", className)}>
      <CloudOff className="h-4 w-4 shrink-0 text-[var(--color-fg-muted)]" />
      <span className="min-w-0 flex-1 text-pretty">{children}</span>
      <RetryButton query={query} variant="outline" size="sm" className="shrink-0" />
    </div>
  );
}
