import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Center, EmptyState, RetryButton, type RetryQuery } from "@/components/ui/misc";

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
