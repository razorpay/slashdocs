import { useQuery } from "@tanstack/react-query";
import { api, APIError } from "@/api";
import { queryKeys } from "@/lib/queryKeys";

// A signed-out reader stays signed out until sign-in reloads the page, so a
// 401 is an answer and a component that mounts later does not ask again.
export function useMe() {
  const q = useQuery({
    queryKey: queryKeys.me(),
    queryFn: api.me,
    retry: false,
    retryOnMount: false,
  });
  const unauth = q.error instanceof APIError && q.error.status === 401;
  return { ...q, unauth };
}
