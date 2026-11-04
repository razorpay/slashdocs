import { useTitle } from "@/lib/use-title";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
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
import { Center, Skeleton } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { DocBar } from "./doc-bar";
import { DocWorkspace } from "./doc-workspace";
import type { FollowRequest } from "./doc-context";
import { PreviewBanner } from "./doc-preview-banner";
import { cursorsShownStore } from "@/lib/live-cursors";
import { useDocumentStream, type Viewer } from "./use-document-stream";

function retryDocumentLoad(failureCount: number, error: Error) {
  if (error instanceof APIError && [401, 403, 404].includes(error.status)) {
    return false;
  }
  return failureCount < 3;
}

function DocumentErrorState({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <Center>
      <div className="max-w-md text-center">
        <h1 className="text-lg font-semibold text-[var(--color-fg)]">{title}</h1>
        <p className="mt-2 text-sm text-[var(--color-fg-muted)]">{description}</p>
        {children}
      </div>
    </Center>
  );
}

function AccessDeniedState({ documentID }: { documentID: string }) {
  const requestAccess = useMutation({
    mutationFn: () => api.requestDocumentAccess(documentID),
  });
  const sent = requestAccess.isSuccess;
  return (
    <DocumentErrorState
      title="You don't have access to this document"
      description={
        sent
          ? "People who can share this document will see your request."
          : "Send the owner a request to grant you access."
      }
    >
      <div className="mt-5 flex flex-col items-center gap-2">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[var(--color-surface-muted)] text-[var(--color-fg-muted)]">
          <KeyRound aria-hidden="true" className="h-5 w-5" />
        </div>
        <Button
          className="mt-1"
          disabled={requestAccess.isPending || sent}
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
    </DocumentErrorState>
  );
}

export function DocumentPage() {
  const { id = "" } = useParams();
  const [searchParams] = useSearchParams();
  const queryVersion = searchParams.get("version") || undefined;
  const doc = useQuery({
    queryKey: queryKeys.document(id),
    queryFn: () => api.getDocument(id),
    retry: retryDocumentLoad,
    meta: { suppressGlobalError: true },
  });
  const me = useMe();
  const versions = useQuery({
    queryKey: queryKeys.versions(id),
    queryFn: () => api.listVersions(id),
    enabled: !!id && !doc.error,
    meta: { suppressGlobalError: true },
  });
  // A version picked from the history, or the one on screen when someone else
  // changed the document: the reader stays on it until they ask for the
  // latest.
  const [selectedVersion, setSelectedVersion] = useState<string>();
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
  const browsed = selectedVersion || queryVersion;
  const current = browsed || pinnedVersion || latest;
  // An earlier version from the history is a preview: it does not change.
  const previewing = !!browsed && browsed !== latest;
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

  // The link keeps its fragment, such as a text link.
  const showLatest = useCallback(() => {
    setSelectedVersion(undefined);
    setPinnedVersion(undefined);
    const search = new URLSearchParams(location.search);
    if (!search.has("version")) return;
    search.delete("version");
    nav({ search: search.toString(), hash: location.hash }, { replace: true });
  }, [nav, location.search, location.hash]);
  // Going to the latest version follows it, so the reader's own edits keep
  // the page on it.
  const showVersion = useCallback(
    (version: string) =>
      version === latest ? showLatest() : setSelectedVersion(version),
    [latest, showLatest],
  );
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
      if (viewer.version) showVersion(viewer.version);
      const hash = textLinkFragment(viewer.anchor);
      if (hash) nav({ search: location.search, hash }, { replace: true });
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
    if (doc.error instanceof APIError) {
      if (doc.error.status === 401) {
        return <Navigate to={signInPath} replace />;
      }
      if (doc.error.status === 403) {
        return <AccessDeniedState documentID={id} />;
      }
      if (doc.error.status === 404) {
        return (
          <DocumentErrorState
            title="Document not found"
            description="This document may have been deleted, or the link may be incorrect."
          />
        );
      }
      if (doc.error.code === "group_membership_unavailable") {
        return (
          <DocumentErrorState
            title="Group access is temporarily unavailable"
            description="Google Group membership could not be refreshed. Try again shortly; stale group access has not been used."
          />
        );
      }
    }
    return (
      <DocumentErrorState
        title="Could not load document"
        description="Something went wrong while loading this document. Please try again."
      />
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
          versions={versionItems}
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
