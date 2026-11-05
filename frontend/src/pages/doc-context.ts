import { createContext, useContext, type Dispatch, type SetStateAction } from "react";
import type { Anchor, AnchorPoint, Comment, CursorSpot, Principal } from "@/api";
import type { CommentDraft, DraftText } from "@/lib/comment-drafts";
import type { Region, ScriptChange } from "../../bridge/source-pieces";
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
// region and every script text that changed since it loaded.
export type TextEditResult = { regions: Region[]; scripts: ScriptChange[] };

export type TextControls = { focused: boolean; leave(): void };

// What a save of the editor changed, in the words of the history, and the
// way to take it back, if it offers one.
export type SaveNote = { said: string; undo?: () => void };

// Where the editor's typing is: none yet, waiting for a pause, being saved,
// saved, failed and waiting to try again, paused because the document
// changed elsewhere, or refused because a change cannot save.
export type SaveState =
  "idle" | "unsaved" | "saving" | "saved" | "failed" | "paused" | "refused";

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
  registerDocumentScroller: (scroller: ((top: number) => void) | null) => void;
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
  subscribeCursors: (listener: CursorListener) => () => void;
  // The viewer the reader asked to go to, if any.
  followedCursor?: FollowRequest;
  // The reader stopped following in the document, by moving the view or with
  // the stop button.
  onUnfollowCursor?: () => void;
  // An editor edits the words of the rendered document in place, and the
  // edits save as they pause.
  editable: boolean;
  saveState: SaveState;
  setSaveState: (state: SaveState) => void;
  // The note of the last save, for a while after it. The bar shows it, so
  // that no message covers the words that the editor types.
  saveNote?: SaveNote;
  setSaveNote: (note: SaveNote | undefined) => void;
  // The text of the frame: whether it has the caret, and how to leave the
  // text. The frame sets them.
  text?: TextControls;
  setText: (text: TextControls | undefined) => void;
  // The frame shows the text and takes edits. Until then, and when it did
  // not load, the bar does not say that the reader can edit.
  frameReady: boolean;
  setFrameReady: (ready: boolean) => void;
  // Keeps the reader on the version on screen when the document changes
  // under them, as when edits land on top of someone else's, or on a given
  // version that holds what is on screen.
  stayOnVersion: (version?: string) => void;
  // Shows the latest version again.
  showLatest: () => void;
};

const DocContext = createContext<DocContextValue | null>(null);

export const DocProvider = DocContext.Provider;

export function useDoc(): DocContextValue {
  const v = useContext(DocContext);
  if (!v) throw new Error("useDoc must be used within a DocProvider");
  return v;
}
