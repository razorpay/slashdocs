import { Page } from "@/components/layout/page";
import { ErrorState } from "@/components/error-state";
import { useTitle } from "@/lib/use-title";

export function NotFoundPage() {
  useTitle("Page not found");
  return (
    <Page lane="focus" backdrop={false}>
      <ErrorState
        title="Page not found"
        description="The link is not correct, or the page moved."
      />
    </Page>
  );
}
