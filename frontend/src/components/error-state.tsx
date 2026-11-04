import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { FileQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Center, EmptyState } from "@/components/ui/misc";

// A page that cannot show what the link asked for: a missing page, document
// or folder, or one that did not load. The default action goes back to the
// documents.
export function ErrorState({
  title,
  description,
  icon = <FileQuestion className="h-5 w-5" />,
  action = (
    <Button asChild>
      <Link to="/app/documents">Go to documents</Link>
    </Button>
  ),
}: {
  title: string;
  description: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Center>
      <EmptyState icon={icon} title={title} description={description} action={action} />
    </Center>
  );
}
