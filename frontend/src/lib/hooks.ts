import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
// owner may do everything. Anyone else has the role their grants give. The
// grants are asked for only after the document loads with its owner, so a
// document that does not open asks for nothing more.
// When the grants do not load, the role is unknown, and `failed` is the query
// to retry: a reader then can do nothing yet, but is not told that they may
// only view.
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
    failed: access.isError && !access.data ? access : undefined,
  };
}

// useAccessRequests is the requests on every document on which the reader
// manages access, the newest first. The header and the document cards share
// it.
export function useAccessRequests() {
  return useQuery({
    queryKey: queryKeys.managedAccessRequests(),
    queryFn: api.managedAccessRequests,
    staleTime: 30_000,
    // The list is a hint. A failure shows a quiet mark in the header with
    // Retry, not a toast.
    meta: { suppressGlobalError: true },
  });
}

// useInbox is what waits on the reader. A read of a thread and a decision
// load it again, so that the item leaves, and so does a return to the tab.
export function useInbox() {
  return useQuery({
    queryKey: queryKeys.inbox(),
    queryFn: api.inbox,
    refetchOnWindowFocus: true,
    meta: { suppressGlobalError: true },
  });
}

// useDebounced is the value after it stays the same for `delay` ms.
export function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timeout);
  }, [value, delay]);
  return debounced;
}

// useLastDefined is the value, or while it is undefined the last value that
// was defined, so that a dialog keeps what it shows through its exit.
export function useLastDefined<T>(value: T | undefined): T | undefined {
  const [last, setLast] = useState(value);
  if (value !== undefined && value !== last) setLast(value);
  return value ?? last;
}

// useWarnBeforeUnload asks the browser to confirm a reload or a close while
// `when` holds, as when it would lose what the reader cannot get back.
export function useWarnBeforeUnload(when: boolean) {
  useEffect(() => {
    if (!when) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [when]);
}

// useMounted is true while the component is on screen. A late result checks
// it before it changes the view, so that it never moves a reader who left.
export function useMounted() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);
  return mounted;
}

const NETWORK_EVENTS = ["online", "offline"] as const;
function subscribeOnline(notify: () => void) {
  for (const type of NETWORK_EVENTS) window.addEventListener(type, notify);
  return () => {
    for (const type of NETWORK_EVENTS) window.removeEventListener(type, notify);
  };
}

// useOnline tells whether the browser has a network, as the browser says.
export function useOnline() {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine);
}
