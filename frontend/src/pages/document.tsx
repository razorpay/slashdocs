import { useParams } from "react-router-dom";
import { DocumentPage as DocumentView } from "./doc-page";

// The document page is implemented across the doc-*.tsx modules. The route
// keeps the same element when only :id changes, so the key remounts the page
// and no selection, version, or draft state carries over to another document.
export function DocumentPage() {
  const { id = "" } = useParams();
  return <DocumentView key={id} />;
}
