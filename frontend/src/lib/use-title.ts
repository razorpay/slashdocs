import { useEffect } from "react";

const BASE = "slashdocs";

// Sets the browser tab title to "<title> · slashdocs" (or just "slashdocs" when no
// page title is given). While the page is loading, the tab keeps its title: the
// server renders a document's title into its page before the app loads the
// document. When the title changes or the page unmounts, the tab resets to
// "slashdocs" rather than to the previous title, which can belong to a page the
// reader has left.
export function useTitle(title?: string, { loading = false } = {}) {
  useEffect(() => {
    if (loading) {
      return;
    }
    document.title = title ? `${title} · ${BASE}` : BASE;
    return () => {
      document.title = BASE;
    };
  }, [title, loading]);
}
