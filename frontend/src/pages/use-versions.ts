import { useQuery } from "@tanstack/react-query";
import { api } from "@/api";
import { queryKeys } from "@/lib/queryKeys";

// useVersions reads the history of a document, oldest entry first. The
// document page reads it too, and they share one request.
export function useVersions(docId: string) {
  return useQuery({
    queryKey: queryKeys.versions(docId),
    queryFn: () => api.listVersions(docId),
    meta: { suppressGlobalError: true },
  });
}
