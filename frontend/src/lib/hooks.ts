import { useQuery } from "@tanstack/react-query";
import { api, APIError, type Principal } from "@/api";
import { ROLE_RANK } from "@/lib/constants";
import { samePrincipal } from "@/lib/principals";
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

// useSelf is the reader as a principal with their name: the session's
// principal may carry only an id, and the profile has the name.
export function useSelf(principal?: Principal): Principal | undefined {
  const me = useMe();
  return (
    principal && {
      ...me.data?.user,
      ...principal,
      name: principal.name || me.data?.user?.name,
    }
  );
}

// useDocumentRole is what the signed-in reader may do with a document. The
// owner may do everything; anyone else has the role their grants give. The
// grants are asked for only after the document loads with its owner, so a
// document that does not open asks for nothing more.
export function useDocumentRole(
  docId: string,
  owner?: Principal,
  principal?: Principal,
) {
  const isOwner = samePrincipal(principal, owner);
  const access = useQuery({
    queryKey: queryKeys.documentAccess(docId),
    queryFn: () => api.documentAccess(docId),
    enabled: !!owner && !!principal && !isOwner,
    staleTime: 30_000,
  });
  const role = isOwner ? "owner" : access.data?.current_role;
  return {
    isOwner,
    role,
    canEdit: (ROLE_RANK[role || ""] || 0) >= ROLE_RANK.editor,
  };
}
