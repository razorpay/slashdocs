import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router-dom";
import { api } from "@/api";
import { clearCommentDrafts } from "./comment-drafts";

// Sign-out once only set this flag and kept the session cookie.
const LEGACY_SIGNED_OUT_KEY = "slashdocs.frontend_signed_out";

// The sign-in page, which returns the reader to this page after sign-in.
export function useSignInPath() {
  const { pathname, search } = useLocation();
  return `/login?next=${encodeURIComponent(pathname + search)}`;
}

// Ends the browser session and forgets everything cached for the user.
export function useSignOut() {
  const qc = useQueryClient();
  const nav = useNavigate();
  return useMutation({
    mutationFn: api.logout,
    onSuccess: () => {
      // Unsent comments must not outlive the session on a shared browser.
      clearCommentDrafts();
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
