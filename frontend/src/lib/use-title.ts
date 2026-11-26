import { useEffect } from "react";
import { productName } from "@/lib/brand";

// Sets the browser tab title to "<title> · <product>" (or just the product name
// when no page title is given). The product is "slashdocs" unless the deployment
// sets a brand name. While the page is loading, the tab keeps its title: the
// server renders a document's title into its page before the app loads the
// document. When the title changes or the page unmounts, the tab resets to the
// product name rather than to the previous title, which can belong to a page the
// reader has left.
export function useTitle(title?: string, { loading = false } = {}) {
  useEffect(() => {
    if (loading) {
      return;
    }
    const base = productName();
    document.title = title ? `${title} · ${base}` : base;
    return () => {
      document.title = base;
    };
  }, [title, loading]);
}
