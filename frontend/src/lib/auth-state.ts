import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "@/api";
import { clearCommentDrafts } from "./comment-drafts";
import { clearFieldDrafts } from "./field-drafts";
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

// Ends the browser session and forgets everything cached for the user.
export function useSignOut() {
  const qc = useQueryClient();
  const nav = useNavigate();
  return useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      // Unsent comments and text must not outlive the session on a shared
      // browser.
      clearCommentDrafts();
      clearFieldDrafts();
      clearTextDrafts();
      qc.clear();
      nav("/", { replace: true });
    },
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
