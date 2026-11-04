import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Center, EmptyState } from "@/components/ui/misc";

// A page that cannot show what the link asked for: a missing page, document
// or folder, or one that did not load. The default action goes back to the
// documents. With onRetry, a Retry action comes first, and it is busy until
// the retry ends.
export function ErrorState({
  title,
  description,
  icon = <FileQuestion className="h-5 w-5" />,
  onRetry,
  action = <ErrorActions onRetry={onRetry} />,
}: {
  title: string;
  description: ReactNode;
  icon?: ReactNode;
  onRetry?: () => Promise<unknown>;
  action?: ReactNode;
}) {
  return (
    <Center>
      <EmptyState icon={icon} title={title} description={description} action={action} />
    </Center>
  );
}

function ErrorActions({ onRetry }: { onRetry?: () => Promise<unknown> }) {
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    onRetry?.().finally(() => setRetrying(false));
  };
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {onRetry ? (
        <Button disabled={retrying} onClick={retry}>
          {retrying ? "Retrying…" : "Retry"}
        </Button>
      ) : null}
      <Button asChild variant={onRetry ? "outline" : "primary"}>
        <Link to="/app/documents">Go to documents</Link>
      </Button>
    </div>
  );
}
