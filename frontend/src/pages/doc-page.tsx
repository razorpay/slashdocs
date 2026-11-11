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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, KeyRound, Send } from "lucide-react";
import {
  api,
  APIError,
  currentVersionID,
  docTitle,
  versionID,
  type Document,
} from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { useDocumentRole, useMe, useMounted } from "@/lib/hooks";
import { useSignInPath } from "@/lib/auth-state";
import { Skeleton } from "@/components/ui/misc";
import { Button } from "@/components/ui/button";
import { ErrorState, PageError } from "@/components/error-state";
import { AppBar } from "@/components/layout/app-shell";
import { Page } from "@/components/layout/page";
import { DocBar } from "./doc-bar";
import { DocWorkspace } from "./doc-workspace";
import { PreviewBanner } from "./doc-preview-banner";
import { UpdateBanner, type DocUpdate } from "./doc-update-banner";
import { useDocumentStream } from "./use-document-stream";
import { useFollowViewer } from "./use-follow-viewer";
import { useRefreshLists } from "./use-refresh-lists";

// The frame follows a change in place in less time than this. A page that
// stays behind the latest version for longer offers it to the reader.
const BEHIND_MS = 1500;

// A reader without access waits on the page. The page asks for the document
// again while they wait, and on Check access, so it opens the document by
// itself when someone grants access. It asks outside the document query,
// whose state would show a load each time.
function AccessDeniedState({ documentID }: { documentID: string }) {
  const q = useQueryClient();
  const recheck = useQuery({
    queryKey: [...queryKeys.document(documentID), "access-check"],
    queryFn: async () => {
      const doc = await api.getDocument(documentID);
      q.setQueryData(queryKeys.document(documentID), doc);
      return doc;
    },
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    retry: false,
    meta: { suppressGlobalError: true },
  });
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
  // Only a 403 says that access is still missing. Any other failure says
  // nothing about access, so the reader can check again.
  const check = useMutation({
    mutationFn: async () => {
      const { error } = await recheck.refetch();
      if (error) throw error;
    },
    // The result shows in the description, not as a toast.
    onError: () => {},
  });
  const denied = check.error instanceof APIError && check.error.status === 403;
  const sent = requestAccess.isSuccess || !!ownRequest.data?.items.length;
  return (
    <ErrorState
      title="You don't have access to this document"
      description={
        denied
          ? "You still don't have access. This page opens the document when someone grants it."
          : check.isError
            ? "Could not check access. Check your connection, then try again."
            : sent
              ? "People who can share this document will see your request. This page opens the document when they grant access."
              : "Send the owner a request to grant you access."
      }
      icon={<KeyRound aria-hidden="true" className="h-5 w-5" />}
      action={
        <div className="flex flex-col items-center gap-2">
          <div className="flex flex-wrap justify-center gap-2">
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
            {sent ? (
              <Button
                variant="outline"
                disabled={check.isPending}
                onClick={() => check.mutate()}
              >
                {check.isPending ? "Checking…" : "Check access"}
              </Button>
            ) : null}
          </div>
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

export function DocumentPage() {
  const { id = "" } = useParams();
  const q = useQueryClient();
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
  // The version on screen when the document changed: the page stays on it
  // until the frame shows a newer one in place, or the reader asks for the
  // latest.
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
  const role = useDocumentRole(id, doc.data?.owner, me.data?.principal);
  const canEdit = role.canEdit && !previewing;
  // Each document opens in Comment mode, and so does each version that the
  // reader goes to. An editor turns on Edit mode to type in the document.
  const [editingIn, setEditingIn] = useState<string>();
  const editing = canEdit && editingIn === id;
  const setEditing = useCallback(
    (on: boolean) => setEditingIn(on ? id : undefined),
    [id],
  );

  // The version on screen is in the link, so a reload or a copied link keeps
  // a preview from the history. The link keeps its fragment, such as a text
  // link. Going to the latest version follows it, so the reader's own edits
  // keep the page on it. A page that the reader left changes no link, so a
  // late result, such as the Undo of a Restore, does not bring them back.
  const onPage = useMounted();
  const showVersion = useCallback(
    (version?: string, hash = location.hash) => {
      if (!onPage.current) return;
      setEditingIn(undefined);
      const search = new URLSearchParams(location.search);
      if (!version || version === latest) {
        setPinnedVersion(undefined);
        search.delete("version");
      } else search.set("version", version);
      nav({ search: search.toString(), hash }, { replace: true });
    },
    [onPage, nav, location.search, location.hash, latest],
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

  // A change that waits for the reader, as the frame scored it. The banner
  // for it also shows when the page stays behind for another reason, as
  // when the frame cannot follow.
  const [update, setUpdate] = useState<DocUpdate>();
  const behind = !previewing && !!current && !!latest && current !== latest;
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!behind) return setStuck(false);
    const timer = window.setTimeout(() => setStuck(true), BEHIND_MS);
    return () => window.clearTimeout(timer);
  }, [behind, current]);
  const offered = behind && (!!update || stuck);

  const refreshLists = useRefreshLists(id);
  const stream = useDocumentStream({
    docId: id,
    // A document that does not open has no viewers to report to or hear from.
    enabled: !!doc.data,
    version: current,
    following: !previewing && !offered,
    principal: me.data?.principal,
    // The page stays on the version on screen, and the frame moves it to
    // the new one when it shows that version (see RenderFrame). The event
    // names the new version, so the page learns of it without a request. An
    // event with no version, or a stream that opens, asks for the document.
    onDocumentChange: (version) => {
      stayOnVersion();
      const queryKey = queryKeys.document(id);
      if (!version) return void q.invalidateQueries({ queryKey });
      // The answer of a request that is on its way can name an earlier
      // version, so it must not come after this one.
      void q.cancelQueries({ queryKey });
      q.setQueryData<Document>(
        queryKey,
        (doc) => doc && { ...doc, current_version_id: version },
      );
      refreshLists();
    },
  });

  const { followedCursor, followedSession, followViewer, unfollow } = useFollowViewer(
    stream,
    showVersion,
  );

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
          <PageError
            error={doc.error}
            what="document"
            denied={<AccessDeniedState documentID={id} />}
            retry={doc}
          />
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
      canEdit={canEdit}
      editing={editing}
      onEditingChange={setEditing}
      stayOnVersion={stayOnVersion}
      showLatest={showLatest}
      showsLatest={current === latest}
      latest={latest}
      live={!previewing}
      others={stream.viewers.length > 0}
      holdUpdate={setUpdate}
      bar={(controls) => (
        <DocBar
          {...controls}
          title={docTitle(doc.data)}
          docId={id}
          owner={doc.data.owner}
          principal={me.data?.principal}
          accountUser={me.data?.user || me.data?.principal}
          parentFolder={doc.data.parent_folder}
          parentFolderId={doc.data.parent_folder_id}
          canMove={!!doc.data.can_move}
          current={current}
          latest={latest}
          previewing={previewing}
          canChangeContent={role.canEdit}
          accessUnknown={role.failed}
          labels={doc.data.labels || []}
          onSelectVersion={showVersion}
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
            canRestore={role.canEdit}
            floating={floating}
          />
        ) : offered ? (
          <UpdateBanner update={update} onShowLatest={showLatest} floating={floating} />
        ) : null
      }
    />
  );
}
