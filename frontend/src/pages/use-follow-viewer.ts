import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { cursorsShownStore } from "@/lib/live-cursors";
import { textLinkFragment } from "../../bridge/text-link";
import type { FollowRequest } from "./doc-context";
import type { Viewer } from "./use-document-stream";

// useFollowViewer shows the version another viewer reads: once at their
// cursor, or else at the passage they look at, or, to follow them, at their
// view as it moves. A viewer who did not send their view yet is followed from
// the passage, and from their view when it comes.
export function useFollowViewer(
  {
    viewers,
    cursorVersion,
  }: {
    viewers: Viewer[];
    // The version of a viewer's newest cursor or view, if one came.
    cursorVersion: (session: string) => string | undefined;
  },
  showVersion: (version?: string, hash?: string) => void,
) {
  const nav = useNavigate();
  const location = useLocation();
  const cursorsShown = cursorsShownStore.useStore();
  const [followedCursor, setFollowedCursor] = useState<FollowRequest>();
  const followViewer = useCallback(
    (viewer: Viewer, continuous = false) => {
      const version = cursorsShown && cursorVersion(viewer.session);
      setFollowedCursor(
        version || continuous ? { session: viewer.session, continuous } : undefined,
      );
      if (version) {
        showVersion(version);
        return;
      }
      const hash = textLinkFragment(viewer.anchor) || undefined;
      if (viewer.version) showVersion(viewer.version, hash);
      else if (hash) nav({ search: location.search, hash }, { replace: true });
    },
    [cursorsShown, cursorVersion, showVersion, nav, location.search],
  );
  const unfollow = useCallback(() => setFollowedCursor(undefined), []);
  const followedSession = followedCursor?.continuous
    ? followedCursor.session
    : undefined;
  // Following stops when the viewer leaves, when cursors are hidden, and on
  // Esc outside the document. Inside it, the bridge stops on the reader's own
  // scroll, click or typing.
  const followedGone =
    !!followedSession &&
    (!cursorsShown || !viewers.some((v) => v.session === followedSession));
  useEffect(() => {
    if (followedGone) setFollowedCursor(undefined);
  }, [followedGone]);
  useEffect(() => {
    if (!followedSession) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setFollowedCursor(undefined);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [followedSession]);
  return { followedCursor, followedSession, followViewer, unfollow };
}
