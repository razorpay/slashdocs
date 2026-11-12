import { createContext, useContext } from "react";
import type { Anchor, Comment, CursorSpot, Principal } from "@/api";
import type { CommentFilter } from "@/lib/constants";
import type { CommentDraft } from "@/lib/comment-drafts";
import type { TextChange } from "@/lib/text-edits";
import type { CursorListener, DocumentKVListener } from "./use-document-stream";

// A text selection captured from the render bridge that a new comment will
// anchor to. `anchor` is present only when the bridge supplies real offsets.
export type PendingSelection = {
  quote: string;
  anchor?: Partial<Anchor>;
  top?: number;
};

export type CommentPosition = {
  top: number;
  bottom: number;
};

export type CommentViewport = {
  scrollTop: number;
  scrollHeight: number;
};

// What the rendered document reports when asked for its text edits.
export type TextEditResult = { changes: TextChange[]; unsupported: boolean };

// Where the editor's typing is: none yet, waiting for a pause, being saved,
// saved, or failed and waiting to try again.
export type SaveState = "idle" | "unsaved" | "saving" | "saved" | "failed";

export type DocContextValue = {
  docId: string;
  version: string;
  comments: Comment[];
  commentFilter: CommentFilter;
  setCommentFilter: (filter: CommentFilter) => void;
  commentsLoading: boolean;
  commentsError: boolean;
  // The server can notify about comments. `slashdocs local` cannot.
  notifications: boolean;
  principal?: Principal;
  // Set for a signed-out reader, who must sign in to comment or edit.
  signIn?: () => void;
  drafts: CommentDraft[];
  startDraft: (selection: PendingSelection) => void;
  saveDraft: (id: string, text: Pick<CommentDraft, "body" | "mentions">) => void;
  discardDraft: (id: string) => void;
  activeComment?: string;
  setActiveComment: (id?: string) => void;
  // Ids of comments and drafts whose highlight the bridge could not anchor in the
  // currently rendered version; replaced wholesale on every repaint.
  unanchoredComments: ReadonlySet<string>;
  setUnanchoredComments: (ids: ReadonlySet<string>) => void;
  commentPositions: ReadonlyMap<string, CommentPosition>;
  setCommentPositions: (positions: ReadonlyMap<string, CommentPosition>) => void;
  commentViewport: CommentViewport;
  setCommentViewport: (viewport: CommentViewport) => void;
  registerDocumentPrinter: (print: (() => void) | null) => void;
  printDocument: () => void;
  registerDocumentScroller: (scroller: ((top: number) => void) | null) => void;
  scrollDocumentTo: (top: number) => void;
  registerCommentRailSync: (sync: ((top: number) => void) | null) => void;
  syncCommentRail: (top: number) => void;
  handleDocCommentClick: (id: string) => void;
  handleRenderedDocumentClick: () => void;
  subscribeDocumentKV: (listener: DocumentKVListener) => () => void;
  reportViewport: (anchor?: Partial<Anchor>) => void;
  moveCursor: (spot: CursorSpot | null) => void;
  subscribeCursors: (listener: CursorListener) => () => void;
  // The cursor of the viewer the reader asked to go to. Each request is a new
  // object, so the same viewer can be followed again.
  followedCursor?: { session: string };
  // An editor edits the words of the rendered document in place, and the
  // edits save as they pause.
  editable: boolean;
  saveState: SaveState;
  setSaveState: (state: SaveState) => void;
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
