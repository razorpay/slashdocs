import { useTitle } from "@/lib/use-title";
import { useCallback, useEffect, useState } from "react";
import {
  Navigate,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  replaceEqualDeep,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, KeyRound, Send } from "lucide-react";
import {
  api,
  APIError,
  currentVersionID,
  docTitle,
  versionID,
  type Document,
  type DocumentEvent,
} from "@/api";
import { principalLabel, samePrincipal } from "@/lib/principals";
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
import { useTypists } from "./use-typists";

// The frame follows a change in place in less time than this. A page that
// stays behind the document for longer offers its latest state to the
// reader.
const BEHIND_MS = 1500;

// newestSeq gives the document that the cache keeps when an answer comes.
// An answer that was on its way can name an earlier seq than the one that
// the page learned from an operation. The cache then keeps the larger seq
// and the version that holds it, and takes the rest of the answer.
function newestSeq(known: unknown, answer: unknown) {
  const [was, next] = [known as Document | undefined, answer as Document];
  const { seq, current_version_id } = was ?? {};
  return replaceEqualDeep(
    known,
    (seq ?? 0) > (next.seq ?? 0) ? { ...next, seq, current_version_id } : next,
  );
}

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
  // Each query of the document has its own request, and newestSeq is the
  // rule for the answers of all of them. The page sets the rule once, before
  // its first query: each document has its own page.
  useState(() =>
    q.setQueryDefaults(queryKeys.document(id), { structuralSharing: newestSeq }),
  );
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
  // The seq of the live document that the frame shows. The frame tells it
  // when it is ready, and tells none while it loads, and in a preview.
  const [shownSeq, setShownSeq] = useState<number>();
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
  // The page follows the live document, and its version is then the current
  // one of the document: a comment or an approval is made on it. An earlier
  // version from the history is a preview: it does not change.
  const current = queryVersion || latest;
  const previewing = !!queryVersion && queryVersion !== latest;
  const role = useDocumentRole(id, doc.data?.owner, me.data?.principal);
  const canEdit = role.canEdit && !previewing;
  // Each document opens in Comment mode, and so does each preview that the
  // reader goes to. An editor turns on Edit mode to type in the document.
  const [editingIn, setEditingIn] = useState<string>();
  const editing = canEdit && editingIn === id;
  const setEditing = useCallback(
    (on: boolean) => setEditingIn(on ? id : undefined),
    [id],
  );

  // A preview from the history is in the link, so a reload or a copied link
  // keeps it. The link keeps its fragment, such as a text link. A page that
  // the reader left changes no link, so a late result, such as the Undo of a
  // Restore, does not bring them back. Only a preview ends Edit mode: an
  // editor who goes to a person on the live document types on.
  const onPage = useMounted();
  const showVersion = useCallback(
    (version?: string, hash = location.hash) => {
      if (!onPage.current) return;
      const search = new URLSearchParams(location.search);
      if (!version || version === latest) search.delete("version");
      else {
        search.set("version", version);
        setEditingIn(undefined);
      }
      nav({ search: search.toString(), hash }, { replace: true });
    },
    [onPage, nav, location.search, location.hash, latest],
  );
  // A link to the latest version is a link to the document.
  useEffect(() => {
    if (queryVersion && queryVersion === latest) showVersion();
  }, [queryVersion, latest, showVersion]);

  // A change that waits for the reader, as the frame scored it. The banner
  // for it also shows when the page stays behind for another reason, as
  // when the frame cannot follow.
  const [update, setUpdate] = useState<DocUpdate>();
  const seq = doc.data?.seq;
  const behind =
    !previewing && shownSeq !== undefined && seq !== undefined && shownSeq < seq;
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!behind) return setStuck(false);
    const timer = window.setTimeout(() => setStuck(true), BEHIND_MS);
    return () => window.clearTimeout(timer);
  }, [behind, shownSeq]);
  // An editor gets no banner: they would type into text that is no longer
  // there. The frame takes each change for them (see useLiveText).
  const offered = behind && !editing && (!!update || stuck);

  // learn keeps the newest seq of the document and the version that holds
  // it. The lists of versions and approvals change with the version, not
  // with each operation.
  const refreshLists = useRefreshLists(id);
  const learn = useCallback(
    (seq: number, version: string) => {
      const queryKey = queryKeys.document(id);
      const known = q.getQueryData<Document>(queryKey);
      if (!known || (known.seq ?? 0) >= seq) return;
      q.setQueryData<Document>(queryKey, {
        ...known,
        seq,
        current_version_id: version,
      });
      if (version !== known.current_version_id) refreshLists();
    },
    [q, id, refreshLists],
  );
  // The frame can show a seq before the stream tells of it, as after the
  // operation of this reader, or while the stream is down.
  const frameShows = useCallback(
    (seq: number | undefined, version: string) => {
      setShownSeq(seq);
      if (seq !== undefined) learn(seq, version);
    },
    [learn],
  );
  // The last event of the document. The frame takes a small operation from
  // it with no request.
  const [event, setEvent] = useState<DocumentEvent>();
  const { typists, hear, madeBy } = useTypists(me.data?.principal, shownSeq);
  const stream = useDocumentStream({
    docId: id,
    // A document that does not open has no viewers to report to or hear from.
    enabled: !!doc.data,
    version: current,
    following: !previewing && !offered,
    principal: me.data?.principal,
    // The event names the new seq and its version, so the page learns of
    // them without a request, and the frame follows (see RenderFrame). An
    // event with no data, or a stream that opens, asks for the document.
    onDocumentChange: (event) => {
      if (!event) return void q.invalidateQueries({ queryKey: queryKeys.document(id) });
      hear(event);
      setEvent(event);
      learn(event.seq, event.version_id);
      // The people are done. That changes no seq and no version id, but the
      // entry of the history and the approvals that count, with the state
      // of the approval in the document.
      if (event.sealed) refreshLists();
      // The person who restored has their own toast, with Undo.
      const by = event.restored ? event.updated_by : undefined;
      if (by && !samePrincipal(by, me.data?.principal))
        toast.info(`${principalLabel(by)} restored an earlier state of this document.`);
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
      frameShows={frameShows}
      onLeavePreview={showVersion}
      showsLatest={!previewing}
      latest={seq}
      event={event}
      typists={typists}
      madeBy={madeBy}
      shownSeq={shownSeq}
      live={!previewing}
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
      banner={
        previewing ? (
          <PreviewBanner
            docId={id}
            version={versionItems.find((v) => v.id === current)}
            canRestore={role.canEdit}
          />
        ) : offered ? (
          <UpdateBanner update={update} />
        ) : null
      }
    />
  );
}
