import { createContext, useContext, type Dispatch, type SetStateAction } from "react";
import type {
  Anchor,
  AnchorPoint,
  Comment,
  CursorSpot,
  DocumentEvent,
  Principal,
} from "@/api";
import type { CommentDraft, DraftText } from "@/lib/comment-drafts";
import type { Region, ScriptChange } from "../../bridge/source-pieces";
import type { DocUpdate } from "./doc-update-banner";
import type { Loads } from "./live-load";
import type { CursorListener, DocumentKVListener } from "./use-document-stream";

// What a new comment anchors to, from the render bridge: a text selection, or
// a spot in an element (anchor.point). `anchor` is present only when the
// bridge supplies real offsets. body starts the draft with text.
export type PendingSelection = {
  quote: string;
  anchor?: Partial<Anchor>;
  body?: string;
};

export type CommentPosition = {
  top: number;
  bottom: number;
};

// Comments whose highlight or pin the bridge could not place in the version
// on screen. Text and pins report on their own.
export type UnanchoredKind = "text" | "pins";

// What the rendered document reports when asked for its text edits: every
// region and every script text that changed since it loaded, and the count
// of the reader's operations that made them.
export type TextEditResult = {
  regions: Region[];
  scripts: ScriptChange[];
  edits: number;
};

// What the rendered document reports after a patch: its text edits, and
// whether the patch applied. A patch is stale, and changes nothing, when the
// reader made an operation after the count that the patch was made for.
export type TextPatchResult = TextEditResult & {
  ok: boolean;
  stale: boolean;
  // The frame took the change out again, because it would change much of
  // what the reader sees.
  withdrawn?: boolean;
};

// Whether the server holds the text that the editor typed: it does or will
// soon, or the sends fail for some time and go again by themselves, or a
// change cannot save. The editor acts only on the last two.
export type SaveState = "idle" | "failed" | "refused";

// What the frame gives the page for the text that it holds. settle sends the
// edits on screen at once, and tells whether the reader can leave them: not
// when a change cannot save. showUpdate shows the change that waits behind
// the banner, in place when the frame can. anchorOf describes the text that
// the highlight of a comment holds now, as for a new comment, when the frame
// shows the highlight.
export type LiveText = {
  settle: () => Promise<boolean>;
  showUpdate: () => Promise<void>;
  anchorOf: (id: string) => Promise<HeldAnchor | undefined>;
};

// The anchor of the text that a highlight holds, on the document at seq. The
// server moves it over the changes after that seq.
export type HeldAnchor = { anchor: Anchor; seq?: number };

// What scrolls the rendered document to a place, in pixels of the page.
export type DocumentScroller = { to: (top: number) => void };

// notSaved tells whether the edits on screen did not save. The editor sees
// only this state of a save.
export const notSaved = (state: SaveState) => state !== "idle";

// A request to go to another viewer: once to their cursor, or continuously
// to their view. Each request is a new object, so the same viewer can be
// gone to again.
export type FollowRequest = { session: string; continuous: boolean };

export type DocContextValue = {
  docId: string;
  version: string;
  comments: Comment[];
  commentsLoading: boolean;
  commentsError: boolean;
  // The server can notify about comments. `slashdocs local` cannot.
  notifications: boolean;
  principal?: Principal;
  // Set for a signed-out reader, who must sign in to comment or edit.
  signIn?: () => void;
  drafts: CommentDraft[];
  startDraft: (selection: PendingSelection) => void;
  saveDraft: (id: string, text: DraftText) => void;
  // moveDraft moves an unsent point comment to a new spot.
  moveDraft: (id: string, anchor: Partial<Anchor> & { point: AnchorPoint }) => void;
  discardDraft: (id: string) => void;
  // The thread or draft whose popover is open.
  activeComment?: string;
  setActiveComment: Dispatch<SetStateAction<string | undefined>>;
  // Opens a thread that the reader went to, as from a link, the list or N.
  jumpToComment: (id: string) => void;
  // The last jump, a new object each time, so the same thread pulses again.
  jump?: { id: string };
  // Resolves a thread: its check draws, it leaves, and a toast offers Undo.
  resolveThread: (id: string) => void;
  // The thread that the reader resolved, on its way out.
  leaving?: string;
  // The popover showed the open thread long enough for the reader to read it.
  readThread: (id: string) => void;
  // Ids of comments and drafts that the bridge could not place in the version
  // on screen; replaced wholesale on every repaint.
  unanchoredComments: ReadonlySet<string>;
  setUnanchoredComments: (kind: UnanchoredKind, ids: ReadonlySet<string>) => void;
  // Ids of point comments whose element is not in the version on screen,
  // which the bridge shows at their spot in the page.
  movedPins: ReadonlySet<string>;
  setMovedPins: (ids: ReadonlySet<string>) => void;
  commentPositions: ReadonlyMap<string, CommentPosition>;
  setCommentPositions: (positions: ReadonlyMap<string, CommentPosition>) => void;
  // The scroll height of the document, in which commentPositions lie.
  documentHeight: number;
  setDocumentHeight: (height: number) => void;
  registerDocumentPrinter: (print: (() => void) | null) => void;
  printDocument: () => void;
  registerDocumentScroller: (scroller: DocumentScroller | null) => void;
  scrollDocumentTo: (top: number) => void;
  handleDocCommentClick: (id: string) => void;
  handleRenderedDocumentClick: () => void;
  // The reader is placing a comment pin: the next click in the document
  // drops it. It is the id of a thread whose pin the reader moves, or true
  // for a new pin.
  placingPin: boolean | string;
  setPlacingPin: (on: boolean | string) => void;
  subscribeDocumentKV: (listener: DocumentKVListener) => () => void;
  reportViewport: (anchor?: Partial<Anchor>) => void;
  moveCursor: (spot: CursorSpot | null) => void;
  // Holds the points of the cursor while the text that the reader typed is
  // not on the server (see useLiveText).
  holdCursor: (held: boolean) => void;
  subscribeCursors: (listener: CursorListener) => () => void;
  // The viewer the reader asked to go to, if any.
  followedCursor?: FollowRequest;
  // The reader stopped following in the document, by moving the view or with
  // the stop button.
  onUnfollowCursor?: () => void;
  // The reader may edit the words of the version on screen.
  canEdit: boolean;
  // Edit mode: the editor types in the rendered document, and the edits go
  // to the server as they type. Otherwise they comment on it, as every
  // reader does.
  editing: boolean;
  // Starts Edit mode, or leaves it after the edits on screen went to the
  // server. It stays when a change cannot save. It tells whether the mode
  // is the one that was asked for.
  setEditing: (on: boolean) => Promise<boolean>;
  registerLiveText: (text: LiveText | null) => void;
  saveState: SaveState;
  setSaveState: (state: SaveState) => void;
  // Sends the edits on screen again at once, or says again why they cannot
  // save, with the choices.
  retrySave: () => void;
  // The frame shows the text and takes edits. Until then, and when it did
  // not load, the bar does not say that the reader can edit.
  frameReady: boolean;
  setFrameReady: (ready: boolean) => void;
  // The frame shows the document at this seq, which this version holds. It
  // shows no seq of the live document while it loads, and in a preview.
  frameShows: (seq: number | undefined, versionID: string) => void;
  // Leaves a preview, and loads the document in the frame again.
  showCurrent: () => void;
  // Each load of the frame has its own number. reloadFrame loads the
  // document in the frame again, in place of what is on screen.
  frameLoad: number;
  reloadFrame: () => void;
  // The page of the document is there. The frame can mount again while it
  // is, as full screen does.
  onPage: { readonly current: boolean };
  // The loads of the frame that the page answers for (see Loads).
  liveLoads: Loads;
  // The newest seq of the document, when the page knows it. The frame
  // follows it in place while live is set: a preview stays as it is.
  latest?: number;
  live: boolean;
  // The last event of the document, which can hold a small operation.
  event?: DocumentEvent;
  // The other people who typed in the document a short time ago (see
  // useTypists). The server takes no approval while they type.
  typists: Principal[];
  // The people who made the changes that are not typing after a seq, up to
  // another one, when the events named them (see useTypists).
  madeBy: (after: number, upto: number) => Principal[] | undefined;
  // The seq of the document that the frame shows, when it has live state.
  // An approver decides on what they see.
  shownSeq?: number;
  // Shows the banner for a change that waits for the reader, or removes it.
  holdUpdate: (update?: DocUpdate) => void;
  // Shows the change that waits, where the reader is in the document.
  showUpdate: () => void;
  // The anchor of the text that the highlight of a comment holds now (see
  // LiveText). The highlight follows the text that people type.
  anchorOf: (id: string) => Promise<HeldAnchor | undefined>;
};

const DocContext = createContext<DocContextValue | null>(null);

export const DocProvider = DocContext.Provider;

export function useDoc(): DocContextValue {
  const v = useContext(DocContext);
  if (!v) throw new Error("useDoc must be used within a DocProvider");
  return v;
}
