import { RefreshCw } from "lucide-react";
import type { Principal } from "@/api";
import { Button } from "@/components/ui/button";
import { principalNames } from "@/lib/principals";
import { DocBanner } from "./doc-banner";

// A change that the page does not show yet: the people who made it.
export type DocUpdate = { authors: Principal[] };

// A reader of a document that changed a lot must not find other text under
// their eyes. The banner says who changed the document, and the page stays
// as it is until the reader asks for the latest.
export function UpdateBanner({
  update,
  onShowLatest,
  floating,
}: {
  // Who changed the document, when the page knows it.
  update?: DocUpdate;
  onShowLatest: () => void;
  // In full screen there is no doc bar, so the banner floats over the document.
  floating: boolean;
}) {
  return (
    <DocBanner
      icon={RefreshCw}
      floating={floating}
      actions={
        <Button size="sm" onClick={onShowLatest}>
          Show the latest
        </Button>
      }
    >
      {update?.authors.length
        ? `${principalNames(update.authors)} updated this document.`
        : "This document changed."}
    </DocBanner>
  );
}
