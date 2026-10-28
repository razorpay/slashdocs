import { useEffect } from "react";

const BASE = "slashdocs";

// Sets the browser tab title to "<title> · slashdocs" (or just "slashdocs" when no
// page title is given), and resets it to "slashdocs" when the page unmounts. It
// does not restore the previous title: the server renders a document's title
// into its page, so that title can belong to a page the reader has left.
export function useTitle(title?: string) {
  useEffect(() => {
    document.title = title ? `${title} · ${BASE}` : BASE;
    return () => {
      document.title = BASE;
    };
  }, [title]);
}
