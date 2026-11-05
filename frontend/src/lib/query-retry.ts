import type { Query } from "@tanstack/react-query";
import { toast } from "sonner";
import { APIError } from "@/api";
import { errorMessage } from "@/lib/errors";

// A failed query retries up to three times, but not when a retry cannot help:
// the reader is signed out or has no access, or the resource does not exist.
export function retryQuery(failureCount: number, error: Error) {
  if (error instanceof APIError && [401, 403, 404].includes(error.status)) {
    return false;
  }
  return failureCount < 3;
}

// A failed query toasts only when it already shows data, so that a failed
// refresh does not go unseen. A query with no data shows its own error state
// with Retry, and a toast would say the same thing twice.
export function toastQueryError(
  error: Error,
  query: Pick<Query, "meta"> & { state: { data: unknown } },
) {
  if (query.state.data === undefined || query.meta?.suppressGlobalError) return;
  if (error instanceof APIError && error.status === 401) return;
  toast.error(errorMessage(error));
}
