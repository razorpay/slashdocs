import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "@/api";
import { clearCommentDrafts } from "./comment-drafts";
import { clearFieldDrafts } from "./field-drafts";
import { useMe } from "./hooks";
import { clearOneTimeKeys, setKeyAccount } from "./one-time-keys";
import { clearTextDrafts } from "./text-drafts";

// Sign-out once only set this flag and kept the session cookie.
const LEGACY_SIGNED_OUT_KEY = "slashdocs.frontend_signed_out";

// The sign-in page, which returns the reader to a page after sign-in. An
// intent, such as "pin", asks that page to start it once the reader is back.
export function signInPath(
  { pathname, search }: { pathname: string; search: string },
  intent?: string,
) {
  const back = new URLSearchParams(search);
  if (intent) back.set("intent", intent);
  const query = back.toString();
  return `/login?next=${encodeURIComponent(query ? `${pathname}?${query}` : pathname)}`;
}

// The sign-in page, which returns the reader to this page after sign-in.
export function useSignInPath() {
  return signInPath(useLocation());
}

// The tabs of the app tell each other the account that they show: an id,
// or null after a sign-out.
const accounts =
  typeof BroadcastChannel === "undefined"
    ? undefined
    : new BroadcastChannel("slashdocs.account");

// useEndSession forgets everything of the session in this tab: unsent
// comments and text, keys that show once, and the cache. They must not
// outlive the session on a shared browser. Then the tab goes to the start.
function useEndSession() {
  const qc = useQueryClient();
  const nav = useNavigate();
  return () => {
    clearCommentDrafts();
    clearFieldDrafts();
    clearTextDrafts();
    clearOneTimeKeys();
    qc.clear();
    nav("/", { replace: true });
  };
}

// Ends the browser session, here and in every other tab.
export function useSignOut() {
  const endSession = useEndSession();
  return useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      accounts?.postMessage(null);
      endSession();
    },
  });
}

// useAccountSync keeps a tab on the account of the browser. The tab tells
// the others its account. When another tab tells of a sign-out or another
// account, this tab ends its session, so that no key, draft or page of the
// account before shows to the next one.
export function useAccountSync() {
  const me = useMe();
  const endSession = useEndSession();
  const account = me.unauth ? null : me.data?.principal.id;
  useEffect(() => {
    if (account === undefined) return;
    setKeyAccount(account);
    accounts?.postMessage(account);
  }, [account]);
  useEffect(() => {
    if (account === undefined || !accounts) return;
    const onMessage = ({ data }: MessageEvent) => data !== account && endSession();
    accounts.addEventListener("message", onMessage);
    return () => accounts.removeEventListener("message", onMessage);
  });
}

// Ends the session of a user who signed out with the legacy flag, so the
// upgrade does not sign them back in.
export async function finishLegacySignOut() {
  try {
    if (localStorage.getItem(LEGACY_SIGNED_OUT_KEY) !== "true") return;
    await api.logout();
    localStorage.removeItem(LEGACY_SIGNED_OUT_KEY);
  } catch {
    // Storage is blocked or the server is down. The next start tries again.
  }
}
