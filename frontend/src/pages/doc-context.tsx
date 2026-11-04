import { createContext, useContext } from "react";
import type { ReaderSettings, RestoreMethod } from "../../bridge/reading";
import type { Anchor, Comment, CursorSpot, Principal } from "@/api";
import type { CommentFilter } from "@/lib/constants";
import type { CommentDraft } from "@/lib/comment-drafts";
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

// Where the reader is in the rendered document, reported as they scroll.
export type ReaderViewport = {
  anchor?: Partial<Anchor>;
  section: string;
  progression: number;
  // True when nothing in the chapter scrolls (it fits on screen), so
  // progression says nothing about how far the reader got.
  fits?: boolean;
};

// A saved reading position to scroll back to. The bridge tries the quote,
// then the section heading, then the scroll share.
export type PositionTarget = {
  anchor?: Partial<Anchor>;
  section?: string;
  progression?: number;
};

// Book mode. Without it the document page renders as it always has.
export type ReaderOptions = {
  onViewport?: (viewport: ReaderViewport) => void;
  settings?: ReaderSettings;
  // Heading ids marked as changed since the reader last saw the chapter.
  markHeadings?: string[];
  frameTitle?: string;
  onKey?: (key: string) => void;
  onRestored?: (method: RestoreMethod) => void;
};

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
  reader?: ReaderOptions;
  // RenderFrame registers how to restore a position; restorePosition calls it
  // and waits for the frame to be ready.
  registerPositionRestorer?: (
    restore: ((target: PositionTarget) => void) | null,
  ) => void;
  restorePosition?: (target: PositionTarget) => void;
};

const DocContext = createContext<DocContextValue | null>(null);

export const DocProvider = DocContext.Provider;

export function useDoc(): DocContextValue {
  const v = useContext(DocContext);
  if (!v) throw new Error("useDoc must be used within a DocProvider");
  return v;
}
