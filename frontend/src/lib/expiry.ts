import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { queryKeys } from "@/lib/queryKeys";

// The periods that a person picks for the expiry of a document. The empty
// value keeps the document.
export const EXPIRY_PRESETS = [
  { value: "", label: "Keep" },
  { value: "1d", label: "1 day" },
  { value: "3d", label: "3 days" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "1 month" },
  { value: "90d", label: "3 months" },
] as const;

// Whether the server deletes expired documents. Without it the app shows
// no control to set an expiry. A mark of an expiry that a document has shows
// all the same.
export function useExpiryEnabled(): boolean {
  const config = useQuery({
    queryKey: queryKeys.config(),
    queryFn: api.getConfig,
    // The config of a server does not change while a page is open.
    staleTime: Infinity,
  });
  return config.data?.document_expiry_enabled === true;
}
