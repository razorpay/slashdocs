import { useTitle } from "@/lib/use-title";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, KeyRound, Send } from "lucide-react";
import { api, APIError, currentVersionID, docTitle, versionID } from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { useDocumentRole, useMe } from "@/lib/hooks";
import { samePrincipal } from "@/lib/principals";
import { useSignInPath } from "@/lib/auth-state";
import { textLinkFragment } from "../../bridge/text-link";
import { Skeleton, type RetryQuery } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/error-state";
import { AppBar } from "@/components/layout/app-shell";
import { Page } from "@/components/layout/page";
import { DocBar } from "./doc-bar";
import { DocWorkspace } from "./doc-workspace";
import type { FollowRequest } from "./doc-context";
import { PreviewBanner } from "./doc-preview-banner";
import { cursorsShownStore } from "@/lib/live-cursors";
import { useDocumentStream, type Viewer } from "./use-document-stream";

function AccessDeniedState({ documentID }: { documentID: string }) {
  // The server keeps the reader's request, so it stays sent after a reload.
  const ownRequest = useQuery({
    queryKey: queryKeys.documentAccessRequests(documentID),
    queryFn: () => api.documentAccessRequests(documentID),
    meta: { suppressGlobalError: true },
  });
  const requestAccess = useMutation({
    mutationFn: () => api.requestDocumentAccess(documentID),
    // The error shows under the button, not as a toast.
    onError: () => {},
  });
  const sent = requestAccess.isSuccess || !!ownRequest.data?.items.length;
  return (
    <ErrorState
      title="You don't have access to this document"
      description={
        sent
          ? "People who can share this document will see your request."
          : "Send the owner a request to grant you access."
      }
      icon={<KeyRound aria-hidden="true" className="h-5 w-5" />}
      action={
        <div className="flex flex-col items-center gap-2">
          <Button
            disabled={ownRequest.isPending || requestAccess.isPending || sent}
            onClick={() => requestAccess.mutate()}
          >
            <AnimatePresence initial={false} mode="wait">
              <motion.span
                key={sent ? "sent" : requestAccess.isPending ? "sending" : "request"}
                className="inline-flex items-center gap-2"
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ type: "spring", duration: 0.3, bounce: 0 }}
              >
                {sent ? <Check className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                {sent
                  ? "Request sent"
                  : requestAccess.isPending
                    ? "Sending…"
                    : "Request access"}
              </motion.span>
            </AnimatePresence>
          </Button>
          {requestAccess.isError ? (
            <p className="text-sm text-[var(--color-danger)]" role="alert">
              Could not send the request. Please try again.
            </p>
          ) : null}
        </div>
      }
    />
  );
}

function DocumentError({
  error,
  documentID,
  retry,
}: {
  error: Error;
  documentID: string;
  retry: RetryQuery;
}) {
  const apiError = error instanceof APIError ? error : undefined;
  if (apiError?.status === 403) return <AccessDeniedState documentID={documentID} />;
  if (apiError?.status === 404) {
    return (
      <ErrorState
        title="Document not found"
        description="This document may have been deleted, or the link may be incorrect."
      />
    );
  }
  if (apiError?.code === "group_membership_unavailable") {
    return (
      <ErrorState
        title="Group access is temporarily unavailable"
        description="Google Group membership could not be refreshed. Try again shortly; stale group access has not been used."
      />
    );
  }
  return (
    <ErrorState
      title="Could not load document"
      description="Something went wrong while loading this document. Please try again."
      retry={retry}
    />
  );
}

export function DocumentPage() {
  const { id = "" } = useParams();
  const [searchParams] = useSearchParams();
  const queryVersion = searchParams.get("version") || undefined;
  const doc = useQuery({
    queryKey: queryKeys.document(id),
    queryFn: () => api.getDocument(id),
    meta: { suppressGlobalError: true },
  });
  const me = useMe();
  const versions = useQuery({
    queryKey: queryKeys.versions(id),
    queryFn: () => api.listVersions(id),
    enabled: !!id && !doc.error,
    meta: { suppressGlobalError: true },
  });
  // The version on screen when someone else changed the document: the reader
  // stays on it until they ask for the latest.
  const [pinnedVersion, setPinnedVersion] = useState<string>();
  const [shareOpen, setShareOpen] = useState(searchParams.get("share") === "1");
  const closeShare = useCallback(() => setShareOpen(false), []);
  const nav = useNavigate();
  const location = useLocation();
  const signInPath = useSignInPath();
  // A signed-out reader of a document shared with anyone signs in to comment
  // or edit.
  const goToSignIn = useCallback(() => nav(signInPath), [nav, signInPath]);
  const signIn = me.unauth ? goToSignIn : undefined;
  useTitle(doc.data ? docTitle(doc.data) : undefined, { loading: doc.isPending });

  const versionItems = versions.data?.items || [];
  const latest =
    currentVersionID(doc.data || {}) ||
    versionID(versionItems[versionItems.length - 1] || {});
  const current = queryVersion || pinnedVersion || latest;
  // An earlier version from the history is a preview: it does not change.
  const previewing = !!queryVersion && queryVersion !== latest;
  const { canEdit } = useDocumentRole(id, doc.data?.owner, me.data?.principal);
  // An assigned approver reviews the document. Typing in it would make them
  // an author, which removes them as an approver, so it stays read-only.
  const approvals = useQuery({
    queryKey: queryKeys.approvals(id),
    queryFn: () => api.listApprovals(id),
    enabled: canEdit && !!doc.data?.approval_status,
  });
  const approver = !!approvals.data?.items.some((item) =>
    samePrincipal(item.approver, me.data?.principal),
  );
  // Until the approvals load, the reader may be an approver.
  const approverKnown = !doc.data?.approval_status || approvals.isSuccess;
  const canChangeContent = canEdit && approverKnown && !approver;
  const editable = canChangeContent && !previewing;

  // The version on screen is in the link, so a reload or a copied link keeps
  // a preview from the history. The link keeps its fragment, such as a text
  // link. Going to the latest version follows it, so the reader's own edits
  // keep the page on it.
  const showVersion = useCallback(
    (version?: string, hash = location.hash) => {
      const search = new URLSearchParams(location.search);
      if (!version || version === latest) {
        setPinnedVersion(undefined);
        search.delete("version");
      } else search.set("version", version);
      nav({ search: search.toString(), hash }, { replace: true });
    },
    [nav, location.search, location.hash, latest],
  );
  const showLatest = useCallback(() => showVersion(), [showVersion]);
  // A link to the latest version is a link to the document.
  useEffect(() => {
    if (queryVersion && queryVersion === latest) showLatest();
  }, [queryVersion, latest, showLatest]);
  const currentRef = useRef(current);
  currentRef.current = current;
  const stayOnVersion = useCallback(
    (version?: string) =>
      setPinnedVersion((pinned) => version || pinned || currentRef.current),
    [],
  );

  const stream = useDocumentStream({
    docId: id,
    // A document that does not open has no viewers to report to or hear from.
    enabled: !!doc.data,
    version: current,
    principal: me.data?.principal,
    // Keep the reader on the version they read when someone else edits. An
    // editor stays on it after any change, even their own from an agent or
    // another tab, so the frame keeps what they type. Saves from this tab
    // move the editor on (see RenderFrame).
    onDocumentChange: (by) => {
      if (editable || !samePrincipal(by, me.data?.principal)) stayOnVersion();
    },
  });

  // Offer the edits made elsewhere while this reader stayed on the version
  // before them.
  const seenLatest = useRef(latest);
  useEffect(() => {
    const previous = seenLatest.current;
    seenLatest.current = latest;
    if (!previous || previous === latest || current !== previous) return;
    toast.info("This document changed elsewhere.", {
      id: "document-changed",
      action: { label: "Show changes", onClick: showLatest },
    });
  }, [latest, current, showLatest]);

  // Show the version another viewer reads: once at their cursor, or else at
  // the passage they look at, or, to follow them, at their view as it moves.
  const cursorsShown = cursorsShownStore.useStore();
  const [followedCursor, setFollowedCursor] = useState<FollowRequest>();
  const { cursorVersion } = stream;
  const followViewer = useCallback(
    (viewer: Viewer, continuous = false) => {
      const version = cursorsShown && cursorVersion(viewer.session);
      if (version) {
        showVersion(version);
        setFollowedCursor({ session: viewer.session, continuous });
        return;
      }
      setFollowedCursor(undefined);
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
    (!cursorsShown || !stream.viewers.some((v) => v.session === followedSession));
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

  if (doc.isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="mb-3 h-7 w-72" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  }
  if (doc.error) {
    if (doc.error instanceof APIError && doc.error.status === 401) {
      return <Navigate to={signInPath} replace />;
    }
    // A document that does not open shows the app bar, as a missing page does.
    return (
      <>
        <AppBar />
        <Page lane="focus" backdrop={false}>
          <DocumentError error={doc.error} documentID={id} retry={doc} />
        </Page>
      </>
    );
  }
  if (!doc.data) return null;

  return (
    <DocWorkspace
      docId={id}
      version={current}
      principal={me.data?.principal}
      home="/app/documents"
      notifications={!signIn}
      signIn={signIn}
      stream={stream}
      followedCursor={followedCursor}
      onUnfollowCursor={unfollow}
      onDocumentClick={closeShare}
      editable={editable}
      stayOnVersion={stayOnVersion}
      showLatest={showLatest}
      showsLatest={current === latest}
      bar={(controls) => (
        <DocBar
          {...controls}
          title={docTitle(doc.data)}
          docId={id}
          owner={doc.data.owner}
          principal={me.data?.principal}
          accountUser={me.data?.user || me.data?.principal}
          parentFolder={doc.data.parent_folder}
          current={current}
          latest={latest}
          previewing={previewing}
          canChangeContent={canChangeContent}
          labels={doc.data.labels || []}
          onSelectVersion={showVersion}
          onShowLatest={showLatest}
          viewers={stream.viewers}
          onFollowViewer={followViewer}
          followedSession={followedSession}
          onUnfollowViewer={unfollow}
          shareOpen={shareOpen}
          onShareOpenChange={setShareOpen}
          approvalStatus={doc.data.approval_status}
          approvalSummary={doc.data.approval_summary}
          approvalsOpen={searchParams.get("approvals") === "1"}
        />
      )}
      banner={(floating) =>
        previewing ? (
          <PreviewBanner
            docId={id}
            version={versionItems.find((v) => v.id === current)}
            canRestore={canChangeContent}
            floating={floating}
          />
        ) : null
      }
    />
  );
}
