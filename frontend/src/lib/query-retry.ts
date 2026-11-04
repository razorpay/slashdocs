import { APIError } from "@/api";

// A failed query retries up to three times, but not when a retry cannot help:
// the reader is signed out or has no access, or the resource does not exist.
export function retryQuery(failureCount: number, error: Error) {
  if (error instanceof APIError && [401, 403, 404].includes(error.status)) {
    return false;
  }
  return failureCount < 3;
}
