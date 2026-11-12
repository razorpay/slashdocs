import { RefreshCw } from "lucide-react";
import type { Principal } from "@/api";
import { Button } from "@/components/ui/button";
import { principalNames, samePrincipal } from "@/lib/principals";
import { DocBanner } from "./doc-banner";
import { useDoc } from "./doc-context";

// A change that the page does not show yet: the people who made it.
export type DocUpdate = { authors: Principal[] };

// A reader of a document that changed a lot must not find other text under
// their eyes. The banner says who changed the document, and the page stays
// as it is until the reader asks for the latest. The banner pushes the
// document down by its height and covers none of it, so all the text that
// the reader saw stays in view.
export function UpdateBanner({
  update,
}: {
  // Who changed the document, when the page knows it.
  update?: DocUpdate;
}) {
  const { showUpdate, principal } = useDoc();
  const authors = update?.authors ?? [];
  return (
    <DocBanner
      icon={RefreshCw}
      actions={
        <Button size="sm" onClick={showUpdate}>
          Show the latest
        </Button>
      }
    >
      {!authors.length
        ? "This document changed."
        : authors.every((author) => samePrincipal(author, principal))
          ? "You updated this document."
          : `${principalNames(authors)} updated this document.`}
    </DocBanner>
  );
}
