import { textLinkAnchor } from "./text-link.ts";
import { renderedTextFromRange } from "./anchoring/rendered-text.ts";
import { snapshotForPrint } from "./document-export.ts";
import { dispatchPublicEvent, PUBLIC_NAMES } from "./public-names.ts";
import type { RenderedTextWithBrPositions } from "./anchoring/rendered-text.ts";
import { renderedTextOf } from "./anchoring/rendered-text.ts";
import { describeAnchor, resolveAnchor, snapToWords } from "./anchoring/index.ts";
import { TextRange } from "./anchoring/text-range.ts";
import type { CommentAnchor } from "./anchoring/types.ts";
import {
  clearHighlights,
  clearHighlightsFor,
  highlightRange,
  refreshSVGRects,
  reveal,
} from "./highlight.ts";
import { createCursorChat, createCursorLayer, trackPointer } from "./cursors.ts";
import { createPinLayer, parsePins, type PinRect } from "./pins.ts";
import {
  blockOf,
  caretRange,
  cover,
  isEditableTarget,
  markSurface,
  placeClear,
  reducedMotion,
  scrollBehavior,
  settled,
  slide,
} from "./dom.ts";
import { startTextEditing, type TextEditor } from "./text-editing.ts";
import { BRIDGE_UI, elementOf, REFUSED } from "./structure.ts";
import { probe, startScriptText, type ScriptText } from "./script-text.ts";
import { blockTexts, changedBlocks, type Block } from "./changed-blocks.ts";
import { CHORD_KEYS, CHORD_WINDOW_MS } from "../src/lib/esc-chord.ts";
import {
  reduceVimScroll,
  VIM_GLIDE_PX_PER_MS,
  VIM_LINE_PX,
  type VimScrollAction,
} from "../src/lib/vim-scroll.ts";

type KVItems = Record<string, unknown>;

interface KVPatch {
  set: KVItems;
  delete: string[];
}

interface KVHistoryEntry {
  forward: KVPatch;
  inverse: KVPatch;
}

interface KVPendingRequest {
  resolve(value: KVItems): void;
  reject(error: unknown): void;
}

interface GitHubPendingRequest {
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

type KVChangeHandler = (detail: unknown) => void;

interface KVHandlers {
  kvchange: KVChangeHandler[];
}

interface QueuedKVOperation {
  op: string;
  args?: never[];
  resolve?: (value: unknown) => void;
  reject?: (error: unknown) => void;
}

type KVFunction = (...args: never[]) => Promise<unknown>;
type GitHubFunction = (input: {
  owner: string;
  repo: string;
  path: string;
  ref: string;
}) => Promise<unknown>;
type GitHubConnectFunction = () => void;

interface SlashdocsPublicAPI {
  print?: () => void;
  download?: (input: { blob: Blob; filename: string }) => Promise<void>;
  kv?: Record<string, KVFunction>;
  github?: {
    getRawContent: GitHubFunction;
    connect: GitHubConnectFunction;
  };
  on?: (event: string, handler: KVChangeHandler) => (() => void) | undefined;
  off?: (event: string, handler: KVChangeHandler) => void;
  [key: string]: unknown;
}

declare global {
  interface Window {
    __SLASHDOCS_APP_ORIGIN__?: string;
    // Set by the wrapper before the document loads and kept current by the
    // bridge, so a document that reloads itself reads the live theme.
    __slashdocsTheme?: string;
    __slashdocsKVHandlers?: KVHandlers;
    __slashdocsKVQueue?: QueuedKVOperation[];
    __slashdocsGitHubQueue?: Array<{
      input: Parameters<GitHubFunction>[0];
      resolve(value: unknown): void;
      reject(error: unknown): void;
    }>;
    __slashdocsGitHubConnectQueued?: boolean;
    slashdocs?: SlashdocsPublicAPI;
    aidocs?: SlashdocsPublicAPI;
    CustomEvent: typeof CustomEvent;
  }
}

// A selection as character offsets into the body text. trailing marks a
// caret at the end of its text node, which the same offset at the start of
// the next node must not take.
interface SavedSelection {
  start: number;
  end: number;
  backward: boolean;
  trailing: boolean;
}

interface PaintItem {
  id?: string;
  anchor?: CommentAnchor;
  quote?: string;
  selected_text?: string;
  // The reader did not read the thread.
  unread?: boolean;
  // The reader resolved the thread, whose highlight fades.
  leaving?: boolean;
}

type Theme = "dark" | "light";

(function bridge(): void {
  const appOrigin = window.__SLASHDOCS_APP_ORIGIN__ || "*";
  const frame = document.getElementById("slashdocs-doc") as HTMLIFrameElement;
  const cursors = createCursorLayer(doc, () =>
    parent.postMessage({ type: "slashdocs:unfollowed" }, targetOrigin()),
  );
  const pins = createPinLayer({
    doc,
    post: (message) => parent.postMessage(message, targetOrigin()),
    laidOut: () => scheduleCommentPositions(),
  });
  // This reader's cursor color, which the app gives only to a reader who can
  // chat at their cursor.
  let chatColor: string | undefined;
  // The cursor chat of the current document, which the app opens when "/" is
  // pressed outside the document.
  let chat: { open: () => boolean } | null = null;
  // A focused pin sits in this window, over the document, so its keys reach
  // this window, not the document. Give them the document's shortcuts (Esc,
  // C, the Esc chords) but leave the button its own keys. The same goes for
  // the keys of this window's body, which has the focus when the app gives
  // it back to the frame.
  let documentKeys: ((ev: KeyboardEvent) => void) | null = null;
  // The app shows the Esc chord, and says while it waits for a letter. An Esc
  // here arms it at once, as the app does, so that a letter right after it
  // goes to the chord before the app's word comes. The app's word, or the
  // chord's time, ends it.
  let chordArmed = false;
  // The document has open threads, so the app takes the keys that go from
  // one to the next.
  let threadKeys = false;
  const THREAD_KEYS = [..."jknpJ"];
  let chordTimer: ReturnType<typeof setTimeout> | undefined;
  function armChord(armed: boolean): void {
    chordArmed = armed;
    clearTimeout(chordTimer);
    if (armed) chordTimer = setTimeout(() => (chordArmed = false), CHORD_WINDOW_MS);
  }
  document.addEventListener("keydown", (ev) => {
    const target = ev.target as Element | null;
    if (target !== document.body && !target?.closest?.(".sd-pins")) return;
    if (ev.key === "Enter" || ev.key === " " || ev.key === "Tab") return;
    documentKeys?.(ev);
  });
  let kvRequestID = 0;
  const kvPending: Record<string, KVPendingRequest> = {};
  let githubRequestID = 0;
  const githubPending: Record<string, GitHubPendingRequest> = {};
  const kvRequestTimeoutMS = 10000;
  const kvHistoryLimit = 100;
  let kvUndoStack: KVHistoryEntry[] = [];
  let kvRedoStack: KVHistoryEntry[] = [];
  let kvMutationQueue: Promise<unknown> = Promise.resolve();
  let kvHistoryGeneration = 0;

  function doc(): Document | null {
    try {
      return frame.contentDocument || frame.contentWindow!.document;
    } catch (e) {
      return null;
    }
  }

  function targetOrigin(): string {
    if (!appOrigin || appOrigin === "*") return "*";
    if (appOrigin === "self" || appOrigin === "'self'") return window.location.origin;
    try {
      return new URL(appOrigin, window.location.href).origin;
    } catch (e) {
      return "*";
    }
  }

  function isParentMessage(e: MessageEvent): boolean {
    if (e.source !== parent) return false;
    const origin = targetOrigin();
    return origin === "*" || e.origin === origin;
  }

  function innerWindow(): Window | null {
    try {
      return frame.contentWindow;
    } catch (e) {
      return null;
    }
  }

  function jsonValue(value: unknown): unknown {
    const text = JSON.stringify(value);
    if (text === undefined) throw new TypeError("KV value must be JSON serializable");
    return JSON.parse(text);
  }

  function emptyKVPatch(): KVPatch {
    return { set: {}, delete: [] };
  }

  function hasOwn(obj: object | null | undefined, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
  }

  function hasKVPatchChanges(patch: KVPatch | null | undefined): boolean {
    return (
      Object.keys((patch && patch.set) || {}).length > 0 ||
      !!(patch && patch.delete && patch.delete.length)
    );
  }

  function cloneKVPatch(patch: KVPatch | null | undefined): KVPatch {
    const set: KVItems = {};
    Object.keys((patch && patch.set) || {}).forEach((key) => {
      set[key] = jsonValue(patch!.set[key]);
    });
    return { set, delete: ((patch && patch.delete) || []).map(String) };
  }

  function pushKVStack(stack: KVHistoryEntry[], entry: KVHistoryEntry): void {
    stack.push(entry);
    while (stack.length > kvHistoryLimit) stack.shift();
  }

  function resetKVHistory(): void {
    kvHistoryGeneration++;
    kvUndoStack = [];
    kvRedoStack = [];
    kvMutationQueue = Promise.resolve();
  }

  function kvPatchFromSet(key: unknown, value: unknown): KVPatch {
    if (value === undefined) {
      throw new TypeError("slashdocs.kv.set requires a JSON value");
    }
    const patch = emptyKVPatch();
    const k = String(key);
    if (value === null) patch.delete.push(k);
    else patch.set[k] = jsonValue(value);
    return patch;
  }

  function kvPatchFromDelete(key: unknown): KVPatch {
    const patch = emptyKVPatch();
    patch.delete.push(String(key));
    return patch;
  }

  function kvPatchFromObject(object: unknown): KVPatch {
    if (!object || typeof object !== "object" || Array.isArray(object)) {
      throw new TypeError("slashdocs.kv.patch requires an object");
    }
    const patch = emptyKVPatch();
    Object.keys(object).forEach((key) => {
      const value = (object as KVItems)[key];
      if (value === null || value === undefined) {
        patch.delete.push(key);
      } else {
        patch.set[key] = jsonValue(value);
      }
    });
    return patch;
  }

  function kvRequestItems(): Promise<KVItems> {
    return kvRequest("all").then((res) =>
      res && res.items && typeof res.items === "object" ? (res.items as KVItems) : {},
    );
  }

  function kvInversePatch(forward: KVPatch, items: KVItems): KVPatch {
    const inverse = emptyKVPatch();
    const keys: Record<string, boolean> = {};
    Object.keys((forward && forward.set) || {}).forEach((key) => {
      keys[key] = true;
    });
    ((forward && forward.delete) || []).forEach((key) => {
      keys[key] = true;
    });
    Object.keys(keys).forEach((key) => {
      if (hasOwn(items, key)) inverse.set[key] = jsonValue(items[key]);
      else inverse.delete.push(key);
    });
    return inverse;
  }

  function sameKVValue(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) return true;
    if (a === null || b === null) return a === b;
    if (typeof a !== typeof b) return false;
    if (typeof a !== "object") return false;
    const aIsArray = Array.isArray(a);
    const bIsArray = Array.isArray(b);
    if (aIsArray || bIsArray) {
      if (!aIsArray || !bIsArray || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!sameKVValue(a[i], b[i])) return false;
      }
      return true;
    }
    const aKeys = Object.keys(a).sort();
    const bKeys = Object.keys(b as object).sort();
    if (aKeys.length !== bKeys.length) return false;
    for (let i = 0; i < aKeys.length; i++) {
      const key = aKeys[i];
      if (key !== bKeys[i] || !sameKVValue((a as KVItems)[key], (b as KVItems)[key]))
        return false;
    }
    return true;
  }

  function kvPatchMatchesItems(patch: KVPatch, items: KVItems): boolean {
    const set = (patch && patch.set) || {};
    for (const key of Object.keys(set)) {
      if (!hasOwn(items, key) || !sameKVValue(items[key], set[key])) return false;
    }
    for (const key of (patch && patch.delete) || []) {
      if (hasOwn(items, key)) return false;
    }
    return true;
  }

  function rejectStaleKVHistory(message: string): Promise<never> {
    resetKVHistory();
    return Promise.reject(new Error(message));
  }

  function rejectResetKVHistory(): Promise<never> {
    return Promise.reject(new Error("KV history was reset"));
  }

  function queueKVMutation(task: () => Promise<unknown>): Promise<unknown> {
    const run = kvMutationQueue.then(task, task);
    kvMutationQueue = run.catch(() => {});
    return run;
  }

  function kvApplyPatch(patch: KVPatch, operation: string): Promise<KVItems> {
    const outgoing = cloneKVPatch(patch);
    return kvRequest("patch", {
      set: outgoing.set,
      delete: outgoing.delete,
      source: "local",
      kvOperation: operation,
    });
  }

  function kvApplyLocalPatch(forward: KVPatch, operation: string): Promise<unknown> {
    const generation = kvHistoryGeneration;
    const patch = cloneKVPatch(forward);
    return queueKVMutation(() => {
      if (generation !== kvHistoryGeneration) return rejectResetKVHistory();
      if (!hasKVPatchChanges(patch)) return kvApplyPatch(patch, operation);
      return kvRequestItems().then((items) => {
        if (generation !== kvHistoryGeneration) return rejectResetKVHistory();
        const inverse = kvInversePatch(patch, items);
        return kvApplyPatch(patch, operation).then((result) => {
          if (generation === kvHistoryGeneration) {
            pushKVStack(kvUndoStack, { forward: patch, inverse });
            kvRedoStack = [];
          }
          return result;
        });
      });
    });
  }

  function kvUndo(): Promise<unknown> {
    const generation = kvHistoryGeneration;
    return queueKVMutation(() => {
      if (generation !== kvHistoryGeneration) return rejectResetKVHistory();
      const entry = kvUndoStack.pop();
      if (!entry)
        return Promise.resolve({ changes: [], empty: true, operation: "undo" });
      return kvRequestItems().then((items) => {
        if (generation !== kvHistoryGeneration) return rejectResetKVHistory();
        if (!kvPatchMatchesItems(entry.forward, items)) {
          return rejectStaleKVHistory("KV undo history is stale");
        }
        return kvApplyPatch(entry.inverse, "undo").then(
          (result) => {
            if (generation === kvHistoryGeneration) pushKVStack(kvRedoStack, entry);
            return result;
          },
          (err) => {
            if (generation === kvHistoryGeneration) kvUndoStack.push(entry);
            throw err;
          },
        );
      });
    });
  }

  function kvRedo(): Promise<unknown> {
    const generation = kvHistoryGeneration;
    return queueKVMutation(() => {
      if (generation !== kvHistoryGeneration) return rejectResetKVHistory();
      const entry = kvRedoStack.pop();
      if (!entry)
        return Promise.resolve({ changes: [], empty: true, operation: "redo" });
      return kvRequestItems().then((items) => {
        if (generation !== kvHistoryGeneration) return rejectResetKVHistory();
        if (!kvPatchMatchesItems(entry.inverse, items)) {
          return rejectStaleKVHistory("KV redo history is stale");
        }
        return kvApplyPatch(entry.forward, "redo").then(
          (result) => {
            if (generation === kvHistoryGeneration) pushKVStack(kvUndoStack, entry);
            return result;
          },
          (err) => {
            if (generation === kvHistoryGeneration) kvRedoStack.push(entry);
            throw err;
          },
        );
      });
    });
  }

  function kvRequest(operation: string, payload?: KVItems): Promise<KVItems> {
    const requestId = "kv_" + ++kvRequestID + "_" + Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        delete kvPending[requestId];
        reject(new Error("KV request timed out"));
      }, kvRequestTimeoutMS);
      kvPending[requestId] = {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      };
      parent.postMessage(
        Object.assign(
          { type: "slashdocs:kv-request", requestId, operation },
          payload || {},
        ),
        targetOrigin(),
      );
    });
  }

  function githubRawContent(input: Parameters<GitHubFunction>[0]): Promise<unknown> {
    if (!input || typeof input !== "object") {
      return Promise.reject(
        new TypeError("slashdocs.github.getRawContent requires an input object"),
      );
    }
    const payload = {
      owner: String(input.owner || ""),
      repo: String(input.repo || ""),
      path: String(input.path || ""),
      ref: String(input.ref || ""),
    };
    if (!payload.owner || !payload.repo || !payload.path || !payload.ref) {
      return Promise.reject(new TypeError("owner, repo, path, and ref are required"));
    }
    const requestId = "github_" + ++githubRequestID + "_" + Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        delete githubPending[requestId];
        reject(new Error("GitHub request timed out"));
      }, 30000);
      githubPending[requestId] = {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      };
      parent.postMessage(
        { type: "slashdocs:github-request", requestId, operation: "raw", ...payload },
        targetOrigin(),
      );
    });
  }

  function githubConnect(): void {
    parent.postMessage({ type: "slashdocs:github-connect" }, targetOrigin());
  }

  function emitKVChange(detail: unknown): void {
    const w = innerWindow();
    if (!w) return;
    try {
      const ev = new w.CustomEvent("kvchange", { detail });
      w.dispatchEvent(ev);
    } catch (e) {}
    const handlers =
      (w.__slashdocsKVHandlers && w.__slashdocsKVHandlers.kvchange) || [];
    handlers.slice().forEach((handler) => {
      try {
        handler(detail);
      } catch (e) {
        setTimeout(() => {
          throw e;
        }, 0);
      }
    });
  }

  let printPreparing = false;
  let textEditor: TextEditor | null = null;
  // The app's Edit mode: the reader types in the document.
  let textEditing = false;
  let scriptText: ScriptText | null = null;
  // Highlights split the text nodes that the editor changes, so they come
  // off each block that the editor changes, and go back when the app takes
  // the changes. The others stay. Paints and repairs wait meanwhile, and the
  // comment rail keeps its positions.
  let highlightsHeld = false;

  const DRAFT_MS = 100;
  let draftTimer: ReturnType<typeof setTimeout> | undefined;

  // textChanges gives the edits on screen and the scroll of the document.
  // A take starts the next save: the highlights of the changed blocks come
  // back.
  function textChanges(take: boolean) {
    const { regions } = (take ? textEditor?.take() : textEditor?.peek()) ?? {
      regions: [],
    };
    if (take) releaseHighlights();
    return {
      regions,
      scripts: scriptText?.take() ?? [],
      top: Math.round(doc()?.defaultView?.scrollY ?? 0),
    };
  }

  // Text editing makes the document editable in place. The frame's srcdoc
  // is the source as the server tagged it, before any script ran. Leaving
  // Edit mode only pauses the editor, so that the next save still holds
  // every change since the frame loaded. Text that is selected as Edit mode
  // starts gets the caret.
  function setTextEditing(on: boolean): void {
    const d = doc();
    textEditing = on;
    // The selection actions change with editing.
    selectionAction?.remove();
    // Script text gives back the contenteditable values that the source map
    // gave it, so it pauses first.
    scriptText?.setEditable(on);
    textEditor?.setEditable(on);
    if (!on) return releaseHighlights();
    if (!d?.body) return;
    if (!textEditor) startEditor(d);
    const selection = d.getSelection();
    const range = selectedRange(selection);
    if (!range) return;
    d.body.focus({ preventScroll: true });
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function startEditor(d: Document): void {
    markSurface(d);
    const post = (message: object) => parent.postMessage(message, targetOrigin());
    // Each change also sends a draft soon after it, which the app saves when
    // the frame goes before a save.
    const onDirty = (count: number) => {
      post({ type: "slashdocs:text-dirty", count });
      clearTimeout(draftTimer);
      draftTimer = setTimeout(
        () => post({ type: "slashdocs:text-draft", ...textChanges(false) }),
        DRAFT_MS,
      );
    };
    textEditor = startTextEditing(d, frame.srcdoc, {
      beforeTouch: holdHighlights,
      onDirty,
      // A hint at the script text already says why it does not change.
      onRefused: (reason) =>
        (reason === REFUSED.script && scriptText?.pulse()) ||
        post({ type: "slashdocs:text-refused", reason }),
    });
    if (textEditor)
      scriptText = startScriptText(d, {
        source: textEditor.map,
        post,
        onChange: () => onDirty(1),
      });
  }

  function holdHighlights(block: Element): void {
    const d = doc();
    if (!d || !d.body) return;
    highlightsHeld = true;
    if (!block.querySelector("mark.slashdocs-mark")) return;
    suspendMutationObserver();
    const caret = saveSelection(d, d.body, true);
    clearHighlights(block);
    if (caret) restoreSelection(d, d.body, caret);
    resumeMutationObserver();
  }

  function releaseHighlights(): void {
    const d = doc();
    if (!highlightsHeld || !d || !d.body) return;
    highlightsHeld = false;
    // Some marks are gone, so the same comments must be anchored again.
    // Wrapping text in marks moves the caret, so it goes back after.
    lastPaintKey = null;
    const caret = saveSelection(d, d.body, true);
    if (lastPaint) paint(lastPaint.items, lastPaint.active);
    if (caret) restoreSelection(d, d.body, caret);
  }
  const exportPending = new Map<string, { resolve: () => void; reject: () => void }>();
  let exportID = 0;
  function requestPrint(): void {
    parent.postMessage({ type: "slashdocs:print-request" }, targetOrigin());
  }
  function requestDownload(input: { blob: Blob; filename: string }): Promise<void> {
    return new Promise((resolve, reject) => {
      const requestId = `export-${++exportID}`;
      const timer = setTimeout(() => {
        exportPending.delete(requestId);
        reject(new Error("Download request timed out."));
      }, 5000);
      exportPending.set(requestId, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: () => {
          clearTimeout(timer);
          reject(
            new Error(
              "Download needs a click, a valid filename, and a file no larger than 20 MB. Please try again.",
            ),
          );
        },
      });
      parent.postMessage(
        {
          type: "slashdocs:download-request",
          requestId,
          blob: input.blob,
          filename: input.filename,
        },
        targetOrigin(),
      );
    });
  }

  function installSlashdocsAPI(): void {
    const w = innerWindow();
    if (!w) return;
    const existing: SlashdocsPublicAPI =
      w.slashdocs && typeof w.slashdocs === "object" ? w.slashdocs : {};
    const handlers =
      w.__slashdocsKVHandlers && w.__slashdocsKVHandlers.kvchange
        ? w.__slashdocsKVHandlers
        : { kvchange: [] };
    w.__slashdocsKVHandlers = handlers;

    function off(event: string, handler: KVChangeHandler): void {
      if (event !== "kvchange") return;
      handlers.kvchange = handlers.kvchange.filter((h) => h !== handler);
    }
    function on(event: string, handler: KVChangeHandler): (() => void) | undefined {
      if (event !== "kvchange" || typeof handler !== "function") return;
      handlers.kvchange.push(handler);
      return function unsubscribe() {
        off(event, handler);
      };
    }
    const kv: Record<string, KVFunction> = {
      get(key: unknown) {
        return kvRequest("get", { key: String(key) }).then((res) => res.value);
      },
      all() {
        return kvRequest("all").then((res) => res.items || {});
      },
      set(key: unknown, value: unknown) {
        return kvApplyLocalPatch(kvPatchFromSet(key, value), "set");
      },
      delete(key: unknown) {
        return kvApplyLocalPatch(kvPatchFromDelete(key), "delete");
      },
      patch(object: unknown) {
        return kvApplyLocalPatch(kvPatchFromObject(object), "patch");
      },
      undo() {
        return kvUndo();
      },
      redo() {
        return kvRedo();
      },
    };
    existing.print = requestPrint;
    existing.download = requestDownload;
    w.print = requestPrint;
    existing.kv = kv;
    existing.github = {
      getRawContent: githubRawContent,
      connect: githubConnect,
    };
    existing.on = on;
    existing.off = off;
    try {
      for (const name of PUBLIC_NAMES) w[name] = existing;
    } catch (e) {}

    const githubQueued = w.__slashdocsGitHubQueue || [];
    w.__slashdocsGitHubQueue = [];
    githubQueued.forEach((entry) => {
      githubRawContent(entry.input).then(entry.resolve, entry.reject);
    });
    if (w.__slashdocsGitHubConnectQueued) {
      w.__slashdocsGitHubConnectQueued = false;
      githubConnect();
    }

    const queued = w.__slashdocsKVQueue || [];
    w.__slashdocsKVQueue = [];
    queued.forEach((entry) => {
      const fn = kv[entry && entry.op];
      if (!fn) {
        entry.reject && entry.reject(new Error("unknown slashdocs KV operation"));
        return;
      }
      Promise.resolve()
        .then(() => fn.apply(kv, entry.args || []))
        .then(entry.resolve, entry.reject);
    });
  }

  function hydrateKV(): void {
    kvRequest("hydrate", { source: "initial", operation: "hydrate" })
      .then((res) => {
        emitKVChange(
          Object.assign(
            { source: "initial", operation: "hydrate", changes: [] },
            res || {},
          ),
        );
      })
      .catch(() => {});
  }

  function injectStyles(): void {
    const d = doc();
    if (!d || d.getElementById("slashdocs-highlight-style")) return;
    const s = d.createElement("style");
    s.id = "slashdocs-highlight-style";
    // The bridge's controls are not text of the document, so a selection,
    // as of Cmd+A, does not mark them. A field keeps its own selection. The
    // app names an unsent comment "draft:…". Its highlight has a dashed
    // underline, apart from the comments that are sent.
    s.textContent =
      `:root :is(${BRIDGE_UI}),:root :is(${BRIDGE_UI}) :not(input){-webkit-user-select:none!important;user-select:none!important}` +
      ".slashdocs-mark{background:#fef3c7!important;color:#111827!important;-webkit-text-fill-color:#111827!important;box-decoration-break:clone;-webkit-box-decoration-break:clone;border-radius:2px 2px 0 0;box-shadow:inset 0 -2px 0 #fbbf24;cursor:pointer;transition:background-color .15s,box-shadow .15s}.slashdocs-mark-active{background:#fde68a!important;box-shadow:inset 0 -2px 0 #f59e0b}.slashdocs-mark[data-unread]{box-shadow:inset 2px 0 0 #2563eb,inset 0 -2px 0 #fbbf24}.slashdocs-mark-active[data-unread]{box-shadow:inset 2px 0 0 #2563eb,inset 0 -2px 0 #f59e0b}.slashdocs-svg-mark-text{fill:#111827!important;-webkit-text-fill-color:#111827!important;cursor:pointer}.slashdocs-svg-mark-rect{fill:#fef3c7;stroke:#fbbf24;stroke-width:1;rx:3;ry:3;pointer-events:auto;opacity:.8}.slashdocs-svg-mark-rect.slashdocs-mark-active{fill:#fde68a;stroke:#f59e0b;stroke-width:2;opacity:.9}.slashdocs-svg-mark-rect[data-unread]{stroke:#2563eb}.slashdocs-mark[data-leaving]{background:transparent!important;box-shadow:none;transition-duration:.2s}.slashdocs-svg-mark-rect[data-leaving]{opacity:0;transition:opacity .2s}@media screen{.slashdocs-mark[data-cid^='draft:']{background:#fffbeb!important;box-shadow:none;text-decoration:underline dashed #f59e0b 1.5px!important;text-underline-offset:3px!important}.slashdocs-mark-active[data-cid^='draft:']{background:#fde68a!important}.slashdocs-svg-mark-rect[data-cid^='draft:']{stroke-dasharray:3 2}}@media print{.slashdocs-mark{background:transparent!important;box-shadow:none!important;-webkit-text-fill-color:inherit!important;color:inherit!important}.slashdocs-svg-mark-rect{display:none!important}.slashdocs-svg-mark-text{fill:inherit!important;-webkit-text-fill-color:inherit!important}}";
    (d.head || d.documentElement).appendChild(s);
  }

  // The last paint payload, kept so document mutations can re-anchor without
  // a round-trip to the parent (documents that render content with JS after
  // load would otherwise never get their highlights).
  let lastPaint: { items: PaintItem[]; active: string | null } | null = null;
  let mutationObserver: MutationObserver | null = null;
  let observedRoot: Node | null = null;
  let mutationRepaintTimer: number | null = null;
  let mutationRepaintDeadline = 0;
  const mutationObserverOptions: MutationObserverInit = {
    childList: true,
    characterData: true,
    subtree: true,
  };
  // Identity of the last fully painted item list, and its results, so a
  // repaint that only changes the active comment can skip re-anchoring.
  let lastPaintKey: string | null = null;
  let lastPaintResults: { id: string; anchored: boolean }[] | null = null;
  let commentPositionFrame = 0;
  // The active comment whose mark was last revealed (scrolled into view).
  // Reveal fires only when activation changes to a different comment:
  // repaints also arrive for reasons unrelated to activation (a comment
  // created, replied to, resolved or deleted all refetch the list, as does a
  // window refocus), and revealing on those yanked the reader away from
  // where they were to the active mark. Cleared when activation clears, so
  // re-activating the same comment reveals it again — mirroring the
  // edge-triggered card scroll on the sidebar side.
  let revealedActive: string | null = null;
  // Selection restored after a repaint, kept briefly so the resulting
  // selectionchange does not re-emit slashdocs:selection (which would re-open
  // the comment composer the user may have dismissed).
  let restoredSelection: Range | null = null;
  let restoredSelectionExpiry = 0;

  function paintKeyOf(list: PaintItem[]): string {
    return JSON.stringify(
      list.map((x) => [x && x.id, x && x.anchor, x && x.quote, x && x.selected_text]),
    );
  }

  // Snapshot the user's live selection as character offsets into
  // body.textContent (unchanged by highlight wrapping) so a repaint can put
  // it back. Without this, unwrapping and re-wrapping the text nodes under
  // the selection makes the browser drop the native selection highlight
  // while the user is still selecting. With caret set, a collapsed selection
  // (the editor's caret) is kept too.
  function saveSelection(
    d: Document,
    body: HTMLElement,
    caret = false,
  ): SavedSelection | null {
    const sel = d.getSelection();
    if (!sel || (sel.isCollapsed && !caret) || sel.rangeCount < 1) return null;
    try {
      const range = sel.getRangeAt(0);
      if (!body.contains(range.commonAncestorContainer)) return null;
      const textRange = TextRange.fromRange(range).relativeTo(body);
      const probe = d.createRange();
      probe.setStart(sel.anchorNode!, sel.anchorOffset);
      probe.collapse(true);
      const backward = probe.comparePoint(sel.focusNode!, sel.focusOffset) === -1;
      const trailing =
        sel.isCollapsed &&
        sel.focusNode!.nodeType === Node.TEXT_NODE &&
        sel.focusOffset > 0 &&
        sel.focusOffset === (sel.focusNode as Text).data.length;
      return {
        start: textRange.start.offset,
        end: textRange.end.offset,
        backward,
        trailing,
      };
    } catch {
      return null;
    }
  }

  function restoreSelection(
    d: Document,
    body: HTMLElement,
    saved: SavedSelection,
  ): void {
    try {
      const range = TextRange.fromOffsets(body, saved.start, saved.end).toRange();
      // Offset resolution is forward-biased: an end offset on a node
      // boundary resolves to (nextNode, 0), which visually stretches the
      // restored selection across the block boundary. Pull it back to the
      // end of the preceding text node, as for a caret that was at the end of
      // its text.
      if (
        range.endOffset === 0 &&
        (range.endContainer !== range.startContainer || saved.trailing)
      ) {
        const tw = d.createTreeWalker(body, NodeFilter.SHOW_TEXT);
        tw.currentNode = range.endContainer;
        const prev = tw.previousNode() as Text | null;
        if (prev) range.setEnd(prev, prev.data.length);
      }
      const sel = d.getSelection();
      if (!sel) return;
      const focused = body.matches(":focus");
      if (saved.backward) {
        sel.setBaseAndExtent(
          range.endContainer,
          range.endOffset,
          range.startContainer,
          range.startOffset,
        );
      } else {
        sel.setBaseAndExtent(
          range.startContainer,
          range.startOffset,
          range.endContainer,
          range.endOffset,
        );
      }
      // A selection in editable text focuses it, but text that Esc left
      // stays left, so the keys after Esc stay shortcuts.
      if (!focused) body.blur();
      restoredSelection = range;
      restoredSelectionExpiry = Date.now() + 1000;
    } catch {
      // The selected text no longer exists after a document mutation.
    }
  }

  // Repaint with the same comments but a different active id: move the
  // active class instead of re-anchoring, leaving the DOM structure (and
  // any live selection) untouched.
  function applyActiveOnly(d: Document, active: string | null, scroll: boolean): void {
    let scrollTarget: Element | null = null;
    d.querySelectorAll(
      "mark.slashdocs-mark,.slashdocs-svg-mark-rect,.slashdocs-svg-mark-text",
    ).forEach((el) => {
      const isActive = !!active && (el as HTMLElement).dataset.cid === active;
      el.classList.toggle("slashdocs-mark-active", isActive);
      if (isActive && !scrollTarget) scrollTarget = el;
    });
    if (scroll && scrollTarget) reveal(scrollTarget as Element);
  }

  // markThreads puts a bar at the start of the highlight of each thread that
  // the reader did not read, on its first mark only, and fades the
  // highlight of each thread that the reader resolved.
  function markThreads(d: Document): void {
    const ids = (key: "unread" | "leaving") =>
      new Set(lastPaint?.items.flatMap((x) => (x?.[key] && x.id ? [x.id] : [])));
    const [unread, leaving] = [ids("unread"), ids("leaving")];
    const seen = new Set<string>();
    d.querySelectorAll<HTMLElement | SVGElement>(
      "mark.slashdocs-mark,.slashdocs-svg-mark-rect",
    ).forEach((el) => {
      const id = el.dataset.cid ?? "";
      el.toggleAttribute("data-unread", unread.has(id) && !seen.has(id));
      el.toggleAttribute("data-leaving", leaving.has(id));
      seen.add(id);
    });
  }

  // Whitespace-insensitive text key: mark text omits synthesized <br> spaces
  // and reformatting must not read as a content change.
  function strippedText(s: string): string {
    return s.replace(/\s+/g, "");
  }

  // Painted quote (whitespace-stripped) per comment id, used to detect
  // whether a highlight survived a document mutation intact.
  const paintedQuotes = new Map<string, string>();

  // Report a short passage in the middle of the viewport, so other viewers
  // can follow this reader. Debounced: one scroll fires many events.
  const VIEWPORT_QUOTE_LENGTH = 64;
  let viewportTimer: ReturnType<typeof setTimeout> | undefined;
  function scheduleViewport(): void {
    clearTimeout(viewportTimer);
    viewportTimer = setTimeout(postViewport, 300);
  }

  function postViewport(): void {
    const d = doc();
    const view = d?.defaultView;
    if (!d?.body || !view) return;
    parent.postMessage(
      { type: "slashdocs:viewport", anchor: viewportAnchor(d, view) },
      targetOrigin(),
    );
  }

  // Probe points from the middle of the viewport outward for text. Text
  // navigation centers the anchor, so a follower sees what this reader sees.
  // Caret hit-testing costs the same on any document size, unlike a tree walk.
  function viewportAnchor(d: Document, view: Window): CommentAnchor | null {
    for (const y of [0.5, 0.4, 0.6, 0.3, 0.7]) {
      for (const x of [0.5, 0.25, 0.75]) {
        const range = caretRange(d, view.innerWidth * x, view.innerHeight * y);
        const node = range?.startContainer;
        const text = node?.nodeType === Node.TEXT_NODE ? node.nodeValue || "" : "";
        if (!range || !node || !text.trim()) continue;
        const start = text.lastIndexOf(" ", range.startOffset) + 1;
        range.setStart(node, start);
        range.setEnd(node, Math.min(text.length, start + VIEWPORT_QUOTE_LENGTH));
        const anchor = describeAnchor(d.body, range);
        if (anchor) return anchor;
      }
    }
    return null;
  }

  function postCommentPositions(): void {
    const d = doc();
    if (!d || !lastPaint) return;
    const view = d.defaultView;
    const scrollTop = view?.scrollY || d.documentElement.scrollTop || 0;
    const scrollHeight = Math.max(
      d.documentElement.scrollHeight,
      d.body?.scrollHeight || 0,
    );
    const positions: Array<{ id: string; top: number; bottom: number }> = [];
    const seen = new Set<string>();
    for (const item of lastPaint.items) {
      const id = item && item.id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const escaped = CSS.escape(id);
      const marks = Array.from(
        d.querySelectorAll(
          `mark.slashdocs-mark[data-cid="${escaped}"],.slashdocs-svg-mark-text[data-cid="${escaped}"],.slashdocs-svg-mark-rect[data-cid="${escaped}"]`,
        ),
      );
      let top = Number.POSITIVE_INFINITY;
      let bottom = Number.NEGATIVE_INFINITY;
      for (const mark of marks) {
        const rect = mark.getBoundingClientRect();
        if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) continue;
        top = Math.min(top, rect.top);
        bottom = Math.max(bottom, rect.bottom);
      }
      if (Number.isFinite(top) && Number.isFinite(bottom)) {
        positions.push({ id, top: top + scrollTop, bottom: bottom + scrollTop });
      }
    }
    for (const { id, top } of pins.tops()) positions.push({ id, top, bottom: top });
    parent.postMessage(
      {
        type: "slashdocs:comment-positions",
        positions,
        scrollHeight,
      },
      targetOrigin(),
    );
  }

  function scheduleCommentPositions(): void {
    const view = doc()?.defaultView;
    if (!view || commentPositionFrame) return;
    commentPositionFrame = view.requestAnimationFrame(() => {
      commentPositionFrame = 0;
      const current = doc();
      if (!current || highlightsHeld) return;
      refreshSVGRects(current);
      postCommentPositions();
    });
  }

  function highlightIntact(d: Document, id: string): boolean {
    const expected = paintedQuotes.get(id);
    if (!expected) return false;
    const cid = CSS.escape(id);
    let text = "";
    d.querySelectorAll('mark.slashdocs-mark[data-cid="' + cid + '"]').forEach((m) => {
      text += m.textContent || "";
    });
    d.querySelectorAll('.slashdocs-svg-mark-text[data-cid="' + cid + '"]').forEach(
      (el) => {
        text += el.textContent || "";
      },
    );
    if (!text) return false;
    // Containment, not equality: SVG artifacts cover whole elements, which
    // are supersets of the quote.
    return strippedText(text).indexOf(expected) >= 0;
  }
  // True while a selection gesture (mouse drag or touch) is in progress.
  // Repairs must wait: replacing text nodes or programmatically setting the
  // selection mid-drag makes the browser stop rendering the native
  // selection highlight until the user stops moving.
  let selectionGestureActive = false;

  // Debounce mutation-triggered scans (trailing 250ms, forced within 1s) so
  // a burst of DOM writes is handled once, and a document that mutates
  // continuously is scanned at a bounded rate.
  function scheduleMutationScan(): void {
    if (!lastPaint || !lastPaint.items.length) return;
    const now = Date.now();
    if (!mutationRepaintDeadline) mutationRepaintDeadline = now + 1000;
    clearTimeout(mutationRepaintTimer ?? undefined);
    mutationRepaintTimer = setTimeout(
      () => {
        mutationRepaintTimer = null;
        mutationRepaintDeadline = 0;
        if (selectionGestureActive) {
          // Try again after the gesture settles; the reschedule keeps the
          // 250ms cadence without doing any DOM work mid-drag.
          scheduleMutationScan();
          return;
        }
        repairAfterMutations();
      },
      Math.max(0, Math.min(now + 250, mutationRepaintDeadline) - now),
    );
  }

  // Repair only what a mutation actually affected. Highlights are DOM nodes
  // and move with the document, so an anchored comment whose marks are still
  // present with their text intact needs no work at all — an unrelated DOM
  // change (opening a dropdown, an animation tick) touches nothing. Only
  // comments whose highlighted text was removed or edited, and comments
  // still waiting for their text to appear, are re-anchored.
  function repairAfterMutations(): void {
    const d = doc();
    const body = d && d.body;
    if (
      !d ||
      !body ||
      highlightsHeld ||
      !lastPaint ||
      !lastPaint.items.length ||
      !lastPaintResults
    ) {
      return;
    }
    refreshSVGRects(d);
    const resultByID = new Map(lastPaintResults.map((r) => [r.id, r]));
    const dirty: PaintItem[] = [];
    for (const x of lastPaint.items) {
      if (!x || !x.id) continue;
      const res = resultByID.get(x.id);
      if (!res) continue;
      // Unanchored comments retry (their text may just have been rendered);
      // anchored comments only repaint when their highlight was damaged.
      if (!res.anchored || !highlightIntact(d, x.id)) dirty.push(x);
    }
    if (!dirty.length) return;

    suspendMutationObserver();
    const savedSelection = saveSelection(d, body);
    let mutatedDOM = false;
    try {
      injectStyles();
      let rendered: RenderedTextWithBrPositions | undefined;
      const getRenderedText = () => (rendered ??= renderedTextOf(body));
      for (const x of dirty) {
        let painted: boolean;
        try {
          if (clearHighlightsFor(d, x.id!) > 0) mutatedDOM = true;
          const anchor: CommentAnchor = Object.assign({}, x.anchor);
          if (!anchor.quote) anchor.quote = x.quote || x.selected_text || "";
          paintedQuotes.set(x.id!, strippedText(anchor.quote));
          const r = resolveAnchor(body, anchor, getRenderedText);
          painted =
            !!r && highlightRange(r, x.id === lastPaint.active, x.id, false) > 0;
          if (painted) mutatedDOM = true;
        } catch {
          painted = false;
        }
        const res = resultByID.get(x.id!);
        if (res) res.anchored = painted;
      }
      // Only put the selection back when this repair actually touched the
      // DOM; a fruitless retry must not churn the user's selection.
      if (savedSelection && mutatedDOM) restoreSelection(d, body, savedSelection);
      markThreads(d);
    } catch {
      // Never let one exotic document abort the repair loop.
    } finally {
      resumeMutationObserver();
    }
    parent.postMessage(
      { type: "slashdocs:paint-result", results: lastPaintResults },
      targetOrigin(),
    );
    scheduleCommentPositions();
  }

  // Our own painting mutates the document (splitText, mark wrapping, svg
  // rects, normalize); suspend observation around it so only the document's
  // own changes trigger re-anchoring. Pending external records are drained
  // first — disconnect() would silently discard them.
  function suspendMutationObserver(): void {
    if (!mutationObserver) return;
    if (mutationObserver.takeRecords().length) scheduleMutationScan();
    mutationObserver.disconnect();
  }

  function resumeMutationObserver(): void {
    if (mutationObserver && observedRoot) {
      mutationObserver.observe(observedRoot, mutationObserverOptions);
    }
  }

  function observeMutations(d: Document): void {
    if (mutationObserver) mutationObserver.disconnect();
    mutationObserver = new MutationObserver(() => {
      prepareHeadings(d);
      scheduleTextNavigation();
      scheduleMutationScan();
      scheduleCommentPositions();
    });
    // Observe the root element rather than body so a script replacing
    // document.body entirely is still seen.
    observedRoot = d.documentElement;
    mutationObserver.observe(observedRoot, mutationObserverOptions);
  }

  function paint(
    items: PaintItem[] | null | undefined,
    active: string | null | undefined,
  ): void {
    const d = doc();
    const list = items || [];
    const activeID = typeof active === "string" ? active : null;
    lastPaint = { items: list, active: activeID };
    // Held highlights take this paint when they go back.
    if (highlightsHeld) return;
    const key = paintKeyOf(list);
    const body = d && d.body;

    // Repaint with the same comments (sidebar clicks changing the active
    // id): move the active class without touching DOM structure. Any damage
    // from document mutations is healed by repairAfterMutations.
    const reveal = activeID !== null && activeID !== revealedActive;
    if (d && body && lastPaintResults && key === lastPaintKey) {
      revealedActive = activeID;
      applyActiveOnly(d, activeID, reveal);
      markThreads(d);
      parent.postMessage(
        { type: "slashdocs:paint-result", results: lastPaintResults },
        targetOrigin(),
      );
      scheduleCommentPositions();
      return;
    }

    const results: { id: string; anchored: boolean }[] = [];
    if (d && body) {
      revealedActive = activeID;
      suspendMutationObserver();
      const savedSelection = saveSelection(d, body);
      try {
        clearHighlights(d);
        paintedQuotes.clear();
        injectStyles();
        // One rendered-text snapshot serves every comment in this paint: marks
        // add no text, so wrapping earlier comments never invalidates it.
        let rendered: RenderedTextWithBrPositions | undefined;
        const getRenderedText = () => (rendered ??= renderedTextOf(body));
        list.forEach((x) => {
          let painted: boolean;
          // A single off-contract item must not abort the whole paint: catch
          // per comment and report it unanchored instead.
          try {
            const anchor: CommentAnchor = Object.assign({}, x && x.anchor);
            if (!anchor.quote) anchor.quote = (x && (x.quote || x.selected_text)) || "";
            if (x && x.id) paintedQuotes.set(x.id, strippedText(anchor.quote || ""));
            // Resolve immediately before painting each comment: wrapping a
            // previous comment's marks moves text nodes, which corrupts other
            // already-resolved live Ranges (overlapping comments would paint
            // wrong extents), while character offsets into textContent stay
            // valid across wraps and splits.
            const r = resolveAnchor(body, anchor, getRenderedText);
            painted = !!r && highlightRange(r, x.id === activeID, x.id, reveal) > 0;
          } catch {
            painted = false;
          }
          if (x && x.id) results.push({ id: x.id, anchored: painted });
        });
        if (savedSelection) restoreSelection(d, body, savedSelection);
      } catch {
        // Even a document with exotic DOM state (throwing accessors, broken
        // replaceWith) must not prevent the paint-result post below.
      } finally {
        resumeMutationObserver();
      }
      lastPaintKey = key;
      lastPaintResults = results;
      markThreads(d);
    }
    // Post even when the inner document is unavailable so the parent never
    // keeps stale "highlight not found" state.
    parent.postMessage({ type: "slashdocs:paint-result", results }, targetOrigin());
    scheduleCommentPositions();
  }

  // The thread whose popover the app shows, and the last rect sent for it.
  let watched: string | null = null;
  let watchFrame = 0;
  let watchedRect = "";

  // watchAnchor reports where a thread's pin or highlight is, each frame
  // that it moves, so the app keeps its popover beside it. A rect of null
  // means that this version has neither.
  function watchAnchor(id: string | null): void {
    watched = id;
    watchedRect = "";
    cancelAnimationFrame(watchFrame);
    if (id) watchFrame = requestAnimationFrame(postWatched);
  }

  function postWatched(): void {
    const id = watched;
    if (!id) return;
    const rect = pins.rect(id) ?? marksRect(id);
    // The blocks that hold a highlight, and the text of its lines. The rest
    // of those lines is part of what the comment is on, so the app keeps the
    // popover off them: in the margin of the blocks, or else beside the text.
    const block = marksRect(id, (mark) => blockOf(mark)?.getBoundingClientRect());
    const lines = marksRect(id, linesOf);
    const key = JSON.stringify([rect, block, lines]);
    if (key !== watchedRect) {
      watchedRect = key;
      parent.postMessage(
        { type: "slashdocs:anchor-rect", id, rect, block, lines },
        targetOrigin(),
      );
    }
    watchFrame = requestAnimationFrame(postWatched);
  }

  // linesOf gives the box of the text on the lines of a mark, in its block.
  function linesOf(mark: Element): DOMRect {
    const own = mark.getBoundingClientRect();
    const block = blockOf(mark);
    if (!block) return own;
    const range = mark.ownerDocument.createRange();
    range.selectNodeContents(block);
    let [left, right] = [own.left, own.right];
    for (const line of range.getClientRects()) {
      if (!line.width || line.bottom <= own.top || line.top >= own.bottom) continue;
      left = Math.min(left, line.left);
      right = Math.max(right, line.right);
    }
    return new DOMRect(left, own.top, right - left, own.height);
  }

  // marksRect gives the box around a text comment's highlight, or around the
  // box that `boxOf` gives for each of its marks. It is null when the
  // comment has no highlight.
  function marksRect(
    id: string,
    boxOf: (mark: Element) => DOMRect | undefined = (mark) =>
      mark.getBoundingClientRect(),
  ): PinRect | null {
    const d = doc();
    if (!d) return null;
    const cid = CSS.escape(id);
    let box: DOMRect | null = null;
    for (const mark of d.querySelectorAll(
      `mark.slashdocs-mark[data-cid="${cid}"],.slashdocs-svg-mark-rect[data-cid="${cid}"]`,
    )) {
      const r = boxOf(mark);
      if (!r || (!r.width && !r.height)) continue;
      box = box
        ? new DOMRect(
            Math.min(box.left, r.left),
            Math.min(box.top, r.top),
            Math.max(box.right, r.right) - Math.min(box.left, r.left),
            Math.max(box.bottom, r.bottom) - Math.min(box.top, r.top),
          )
        : r;
    }
    if (!box) return null;
    return { left: box.left, top: box.top, width: box.width, height: box.height };
  }

  // pulse shows where a thread is that the reader went to, once its pin or
  // highlight stops moving, as when the scroll to it ends: its pin sends out
  // a ring, or its highlight's tint doubles. It gives up after two seconds.
  let pulseFrame = 0;
  function pulse(id: string): void {
    cancelAnimationFrame(pulseFrame);
    let last = "";
    let still = 0;
    let frames = 0;
    const step = () => {
      const rect = pins.rect(id) ?? marksRect(id);
      const key = JSON.stringify(rect);
      still = rect && key === last ? still + 1 : 0;
      last = key;
      if (still < 4) {
        if (++frames < 120) pulseFrame = requestAnimationFrame(step);
        return;
      }
      const d = doc();
      if (!d || pins.pulse(id)) return;
      const cid = CSS.escape(id);
      const marks = d.querySelectorAll(
        `mark.slashdocs-mark[data-cid="${cid}"],.slashdocs-svg-mark-rect[data-cid="${cid}"]`,
      );
      flashRects(
        d,
        Array.from(marks).flatMap((m) => Array.from(m.getClientRects())),
        PULSE,
      );
    };
    pulseFrame = requestAnimationFrame(step);
  }

  // A click on a highlight opens its thread. For an editor, the click also
  // puts the caret in the text, as in Google Docs: the thread opens beside
  // the words and leaves the focus in them.
  function activate(e: MouseEvent): void {
    const m = (e.target &&
      (e.target as Element).closest &&
      (e.target as Element).closest(
        "mark.slashdocs-mark,.slashdocs-svg-mark-text,.slashdocs-svg-mark-rect",
      )) as HTMLElement | null;
    if (!m || !m.dataset.cid) return;
    parent.postMessage(
      { type: "slashdocs:activate", id: m.dataset.cid },
      targetOrigin(),
    );
  }

  function cssString(s: unknown): string {
    return String(s || "")
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
  }

  function fragmentTarget(d: Document, hash: string): Element | null {
    if (!hash || hash === "#") return null;
    let id;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch (e) {
      id = hash.slice(1);
    }
    return d.getElementById(id) || d.querySelector('[name="' + cssString(id) + '"]');
  }

  function openURL(url: string): void {
    try {
      const w = window.open(url, "_blank", "noopener,noreferrer");
      if (w) w.opener = null;
      if (!w) {
        const a = document.createElement("a");
        a.href = url;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
    } catch (e) {}
  }

  function handleLinkClick(e: MouseEvent): void {
    const d = doc();
    if (!d || !e.target || !(e.target as Element).closest) return;
    const a = (e.target as Element).closest("a[href]") as HTMLAnchorElement | null;
    if (!a) return;
    // A click on a link while editing places the caret. Cmd or Ctrl and
    // click follows the link, as in other editors.
    if (textEditor && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      return;
    }
    const href = a.getAttribute("href") || "";
    if (!href || /^javascript:/i.test(href)) {
      e.preventDefault();
      return;
    }
    if (href[0] === "#") {
      const t = fragmentTarget(d, href);
      if (t) {
        e.preventDefault();
        t.scrollIntoView({ block: "start", behavior: scrollBehavior(d) });
        try {
          d.defaultView!.history.replaceState(null, "", href);
        } catch (err) {}
        parent.postMessage(
          { type: "slashdocs:heading", id: t.id || href.slice(1) },
          targetOrigin(),
        );
      }
      return;
    }
    let u;
    try {
      u = new URL(
        href,
        d.location && d.location.href ? d.location.href : location.href,
      );
    } catch (err) {
      return;
    }
    if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:") {
      e.preventDefault();
      openURL(u.href);
    }
  }

  function prepareLinks(): void {
    const d = doc();
    if (!d) return;
    d.querySelectorAll<HTMLAnchorElement>("a[href]").forEach((a) => {
      const href = a.getAttribute("href") || "";
      if (href && !/^#|javascript:/i.test(href)) {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
      }
    });
  }

  let curTheme: Theme | null = null;
  // The app's pointer, "coarse" for a finger. A frame does not always match
  // the app's (pointer: coarse), as in touch emulation.
  let hostPointer = "";
  // The theme last announced to the current document. A document that reloads
  // itself on a theme change (a common way to re-render a diagram) would
  // reload forever if every load were announced. So the load right after an
  // announcement counts as that reload and is skipped. Every other load is
  // announced, because documents that only listen for the event need it.
  let announcedTheme: Theme | null = null;
  let reloadExpected = false;
  function initialTheme(): Theme | null {
    try {
      const t = new URLSearchParams(location.search).get("slashdocs_theme");
      return t === "dark" || t === "light" ? t : null;
    } catch (e) {
      return null;
    }
  }

  function applyTheme(t: unknown): void {
    if (t !== "dark" && t !== "light") return;
    curTheme = t;
    // The prelude in the document reads this before its own scripts run, and
    // a document that reloads itself reads it again on the way back.
    window.__slashdocsTheme = t;
    const d = doc();
    if (!d || !d.documentElement) return;
    for (const name of PUBLIC_NAMES) {
      d.documentElement.setAttribute(`data-${name}-theme`, t);
    }
    markSurface(d);
    d.documentElement.setAttribute("data-slashdocs-pointer", hostPointer);
    if (d !== setupDoc || announcedTheme === t) return;
    announcedTheme = t;
    reloadExpected = true;
    try {
      dispatchPublicEvent(d.defaultView!, "theme", { detail: { theme: t } });
    } catch (e) {}
  }

  // Return the selection's range, merging multiple ranges (a Firefox quirk:
  // https://bugzilla.mozilla.org/show_bug.cgi?id=1773065) into their union.
  function selectedRange(s: Selection | null): Range | null {
    if (!s || s.isCollapsed || s.rangeCount < 1) return null;
    let range = s.getRangeAt(0);
    for (let i = 1; i < s.rangeCount; i++) {
      const other = s.getRangeAt(i);
      const merged = range.cloneRange();
      if (other.compareBoundaryPoints(Range.START_TO_START, range) < 0) {
        merged.setStart(other.startContainer, other.startOffset);
      }
      if (other.compareBoundaryPoints(Range.END_TO_END, range) > 0) {
        merged.setEnd(other.endContainer, other.endOffset);
      }
      range = merged;
    }
    return range.collapsed ? null : range;
  }

  // snapSelection widens a drag to whole words when the pointer lets go, so
  // the selection shows the quote that a comment on it takes. A selection
  // made with keys stays as the keys put it.
  function snapSelection(d: Document): void {
    const s = d.getSelection();
    const range = selectedRange(s);
    if (!s || !range) return;
    const words = snapToWords(range);
    if (s.anchorNode === range.endContainer && s.anchorOffset === range.endOffset) {
      s.setBaseAndExtent(
        words.endContainer,
        words.endOffset,
        words.startContainer,
        words.startOffset,
      );
    } else {
      s.setBaseAndExtent(
        words.startContainer,
        words.startOffset,
        words.endContainer,
        words.endOffset,
      );
    }
  }

  function labelIcon(button: HTMLButtonElement, label: string): void {
    button.dataset.slashdocsTooltip = label;
    const align = () => {
      const rect = button.getBoundingClientRect();
      const width = button.ownerDocument.defaultView!.innerWidth;
      button.style.setProperty(
        "--slashdocs-tip-enter-y",
        rect.top < 48 ? "-3px" : "3px",
      );
      button.style.setProperty(
        "--slashdocs-tip-top",
        rect.top < 48 ? "calc(100% + 6px)" : "auto",
      );
      button.style.setProperty(
        "--slashdocs-tip-bottom",
        rect.top < 48 ? "auto" : "calc(100% + 6px)",
      );
      button.style.setProperty(
        "--slashdocs-tip-left",
        rect.left < 120 ? "0%" : rect.right > width - 120 ? "100%" : "50%",
      );
      button.style.setProperty(
        "--slashdocs-tip-shift",
        rect.left < 120 ? "0%" : rect.right > width - 120 ? "-100%" : "-50%",
      );
    };
    button.addEventListener("pointerenter", align);
    button.addEventListener("focus", align);
    const d = button.ownerDocument;
    if (!d.getElementById("slashdocs-icon-tooltip-style")) {
      const style = d.createElement("style");
      style.id = "slashdocs-icon-tooltip-style";
      // A hidden tip has no box, so that it never widens the page, as near
      // its right edge on a phone. It fades in from its starting style.
      style.textContent = `
        [data-slashdocs-tooltip]::after{all:initial!important;content:attr(data-slashdocs-tooltip)!important;position:absolute!important;z-index:2147483647!important;top:var(--slashdocs-tip-top,auto)!important;bottom:var(--slashdocs-tip-bottom,calc(100% + 6px))!important;left:var(--slashdocs-tip-left,50%)!important;transform:translate(var(--slashdocs-tip-shift,-50%),var(--slashdocs-tip-enter-y,3px))!important;width:max-content!important;max-width:min(220px,calc(100vw - 16px))!important;box-sizing:border-box!important;padding:6px 10px!important;border-radius:6px!important;background:#18181b!important;color:#fff!important;font:500 12px/1.4 system-ui,sans-serif!important;white-space:normal!important;text-wrap:balance!important;text-align:center!important;box-shadow:0 2px 8px #0003!important;pointer-events:none!important;display:none!important;opacity:0!important;transition:opacity .1s ease-out,transform .14s ease-out,display .1s allow-discrete!important}
        [data-slashdocs-tooltip]:hover::after,[data-slashdocs-tooltip]:focus-visible::after{display:block!important;opacity:1!important;transform:translate(var(--slashdocs-tip-shift,-50%),0)!important;transition:opacity .14s ease-out .5s,transform .14s ease-out .5s,display .14s allow-discrete .5s!important}
        @starting-style{[data-slashdocs-tooltip]:hover::after,[data-slashdocs-tooltip]:focus-visible::after{opacity:0!important;transform:translate(var(--slashdocs-tip-shift,-50%),var(--slashdocs-tip-enter-y,3px))!important}}
        [data-slashdocs-tooltip]:focus-visible::after{transition-delay:0s!important}
        [data-slashdocs-tooltip][data-slashdocs-copied]::after{content:"Copied"!important;display:block!important;opacity:1!important;transform:translate(var(--slashdocs-tip-shift,-50%),0)!important;transition-delay:0s!important}
        @media(prefers-reduced-motion:reduce){[data-slashdocs-tooltip]::after{transition-duration:0s!important;transform:translateX(var(--slashdocs-tip-shift,-50%))!important}}
        @media print{[data-slashdocs-tooltip]::after{display:none!important}}`;
      d.head.appendChild(style);
    }
  }

  const SELECTION_ACTION_GAP = 6;
  const MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
  const COMMENT_CHORD = MAC ? "⌘⌥M" : "Ctrl+Alt+M";
  // The formatting actions for an editor: the input that each one runs, its
  // name and keys, the elements around a selection that has it, and its icon.
  const FORMATS = [
    {
      type: "formatBold",
      name: "Bold",
      keys: MAC ? "⌘B" : "Ctrl+B",
      on: "strong,b",
      icon: "M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8",
    },
    {
      type: "formatItalic",
      name: "Italic",
      keys: MAC ? "⌘I" : "Ctrl+I",
      on: "em,i",
      icon: "M19 4h-9M14 20H5M15 4 9 20",
    },
    {
      type: "insertLink",
      name: "Link",
      keys: MAC ? "⌘K" : "Ctrl+K",
      on: "a[href]",
      icon: "M9 17H7A5 5 0 0 1 7 7h2M15 7h2a5 5 0 1 1 0 10h-2M8 12h8",
    },
    {
      type: "insertUnorderedList",
      name: "Bulleted list",
      keys: MAC ? "⌘⇧8" : "Ctrl+Shift+8",
      on: "ul>li",
      icon: "M3 12h.01M3 18h.01M3 6h.01M8 12h13M8 18h13M8 6h13",
    },
    {
      type: "insertOrderedList",
      name: "Numbered list",
      keys: MAC ? "⌘⇧7" : "Ctrl+Shift+7",
      on: "ol>li",
      icon: "M10 12h11M10 18h11M10 6h11M4 10h2M4 6h1v4M6 18H4c0-1 2-2 2-3s-1-1.5-2-1",
    },
  ];
  let selectionAction: HTMLDivElement | null = null;
  let actionRange: Range | null = null;
  let selectionDismissed = false;

  function dismissSelectionAction(): void {
    selectionAction?.remove();
    selectionAction = null;
    selectionDismissed = true;
  }

  function commitSelection(range: Range): void {
    const d = doc();
    if (!d?.body) return;
    const anchor = describeAnchor(d.body, snapToWords(range));
    if (!anchor) return;
    dismissSelectionAction();
    // The highlight of the new draft takes the place of the selection, so
    // the draft stays in view after its popover closes, and a click opens it.
    d.getSelection()?.removeAllRanges();
    parent.postMessage({ type: "slashdocs:selection", anchor }, targetOrigin());
  }

  function selection(): void {
    const d = doc();
    if (!d || !d.body) return;
    const range = selectedRange(d.getSelection());
    // Text selected in the document editor is still document text to
    // comment on; text in the document's own inputs is not.
    const inEditor = !!textEditor && d.activeElement === d.body;
    if (!range || (isEditableTarget(d, d.activeElement) && !inEditor)) {
      dismissSelectionAction();
      actionRange = null;
      return;
    }
    if (selectionGestureActive) return;
    // A selection this bridge just restored after a repaint is not a new
    // user gesture: re-emitting it would re-open the comment composer.
    if (restoredSelection && Date.now() < restoredSelectionExpiry) {
      try {
        if (
          range.compareBoundaryPoints(Range.START_TO_START, restoredSelection) === 0 &&
          range.compareBoundaryPoints(Range.END_TO_END, restoredSelection) === 0
        ) {
          return;
        }
      } catch {
        // The restored range's nodes were removed since; treat as new.
      }
    }
    restoredSelection = null;
    let unchanged = false;
    try {
      unchanged =
        !!actionRange &&
        range.compareBoundaryPoints(Range.START_TO_START, actionRange) === 0 &&
        range.compareBoundaryPoints(Range.END_TO_END, actionRange) === 0;
    } catch {
      /* The document replaced the previously selected nodes. */
    }
    if (!unchanged) selectionDismissed = false;
    actionRange = range.cloneRange();
    if (selectionDismissed) return;
    if (!selectionAction?.isConnected) {
      selectionAction = d.createElement("div");
      selectionAction.className = "slashdocs-selection-action";
      selectionAction.setAttribute("role", "group");
      selectionAction.setAttribute("aria-label", "Selected text actions");
      selectionAction.addEventListener("mousedown", (e) => e.preventDefault());
      selectionAction.addEventListener("click", (e) => e.stopPropagation());
      const addAction = (label: string, path: string, click: () => void) => {
        const button = d.createElement("button");
        button.type = "button";
        button.setAttribute("aria-label", label);
        const svg = d.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 24 24");
        svg.setAttribute("aria-hidden", "true");
        const shape = d.createElementNS("http://www.w3.org/2000/svg", "path");
        shape.setAttribute("d", path);
        svg.appendChild(shape);
        button.appendChild(svg);
        button.addEventListener("click", click);
        selectionAction!.appendChild(button);
        return button;
      };
      if (textEditor)
        for (const format of FORMATS) {
          const button = addAction(format.name, format.icon, () => {
            textEditor?.run(format.type);
            selection();
          });
          button.dataset.slashdocsFormat = format.on;
          labelIcon(button, `${format.name} ${format.keys}`);
        }
      const comment = addAction(
        "Comment on selected text",
        "M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9H13a8.48 8.48 0 0 1 8 8v.5Z",
        () => {
          if (actionRange) commitSelection(actionRange);
        },
      );
      // The main action says its name and its key, as a menu item does. When
      // they do not fit in one row, it is an icon with a tooltip.
      const name = d.createElement("span");
      name.textContent = "Comment";
      comment.append(name, d.createElement("kbd"));
      comment.classList.add("slashdocs-comment");
      labelIcon(comment, "Comment");
      // A hash, as at headings, so that it differs from the Link action.
      const copy = addAction(
        "Copy link to selected text",
        "M4 9h16M4 15h16M10 3 8 21M16 3l-2 18",
        () => {
          if (!actionRange) return;
          const anchor = describeAnchor(d.body, snapToWords(actionRange));
          parent.postMessage({ type: "slashdocs:copy-text", anchor }, targetOrigin());
        },
      );
      labelIcon(copy, "Copy link to text");
      if (!d.getElementById("slashdocs-selection-style")) {
        const style = d.createElement("style");
        style.id = "slashdocs-selection-style";
        style.textContent = `
          .slashdocs-selection-action{all:initial!important;position:fixed!important;z-index:2147483647!important;display:flex!important;width:max-content!important;max-width:calc(100vw - 16px)!important;padding:2px!important;border-radius:10px!important;background:#fff!important;color:#52525b!important;box-shadow:0 0 0 1px #0001,0 4px 16px #0002!important;animation:slashdocs-selection-in .15s ease-out!important}
          @keyframes slashdocs-selection-in{from{opacity:0;transform:scale(.97)}}
          .slashdocs-selection-action button{all:initial!important;position:relative!important;box-sizing:border-box!important;display:flex!important;align-items:center!important;justify-content:center!important;gap:6px!important;min-width:40px!important;height:40px!important;padding:0 11px!important;border-radius:8px!important;color:inherit!important;cursor:pointer!important;transition:background-color .15s,transform .15s!important}
          .slashdocs-selection-action span{all:initial!important;color:inherit!important;font:500 13px/1 system-ui,sans-serif!important}
          .slashdocs-selection-action kbd{all:initial!important;padding:2px 5px!important;border-radius:4px!important;background:#f4f4f5!important;color:#71717a!important;font:500 11px/1.2 system-ui,sans-serif!important}
          .slashdocs-selection-action button:hover{background:#f4f4f5!important;color:#18181b!important}
          .slashdocs-selection-action button:active{transform:scale(.96)!important}
          .slashdocs-selection-action button[hidden],.slashdocs-selection-action[data-compact] .slashdocs-comment>:not(svg),.slashdocs-selection-action:not([data-compact]) .slashdocs-comment::after{display:none!important}
          .slashdocs-selection-action button[aria-pressed=true]{background:#eef2ff!important;color:#4338ca!important}
          .slashdocs-selection-action [data-slashdocs-format]:not([hidden])+button:not([data-slashdocs-format])::before{all:initial!important;content:""!important;position:absolute!important;left:-1px!important;top:10px!important;bottom:10px!important;width:1px!important;background:currentColor!important;opacity:.2!important}
          .slashdocs-selection-action button:focus-visible{outline:2px solid #6366f1!important;outline-offset:-2px!important}
          .slashdocs-selection-action svg{all:initial!important;color:inherit!important;width:17px!important;height:17px!important;fill:none!important;stroke:currentColor!important;stroke-width:1.8!important;stroke-linecap:round!important;stroke-linejoin:round!important;pointer-events:none!important}
          .slashdocs-selection-action path{fill:none!important;stroke:inherit!important;stroke-width:inherit!important}
          .slashdocs-selection-action[data-docked]{left:0!important;right:0!important;width:auto!important;max-width:none!important;justify-content:center!important;padding:2px 2px max(2px,env(safe-area-inset-bottom))!important;border-radius:0!important}
          .slashdocs-selection-action[data-docked=bottom]{bottom:0!important}
          .slashdocs-selection-action[data-docked=top]{top:0!important}
          html:has(>.slashdocs-selection-action[data-docked=bottom]){padding-bottom:48px!important}
          [data-slashdocs-surface=dark] .slashdocs-selection-action{background:#27272a!important;color:#d4d4d8!important;box-shadow:0 0 0 1px #fff2,0 4px 16px #0004!important}
          [data-slashdocs-surface=dark] .slashdocs-selection-action button:hover{background:#3f3f46!important;color:#fff!important}
          [data-slashdocs-surface=dark] .slashdocs-selection-action kbd{background:#3f3f46!important;color:#a1a1aa!important}
          [data-slashdocs-surface=dark] .slashdocs-selection-action button[aria-pressed=true]{background:#312e81!important;color:#e0e7ff!important}
          [data-slashdocs-pointer=coarse] .slashdocs-selection-action kbd{display:none!important}
          @media(pointer:coarse){.slashdocs-selection-action kbd{display:none!important}}
          @media(prefers-reduced-motion:reduce){.slashdocs-selection-action,.slashdocs-selection-action button{animation:none!important;transition:none!important}}
          @media print{.slashdocs-selection-action,.slashdocs-text-flash{display:none!important}}`;
        d.head.appendChild(style);
      }
      // Outside the body, as the link field is, so that a selection of all
      // the text, as of Cmd+A in the editor, does not hold the actions.
      d.documentElement.appendChild(selectionAction);
    }
    // In text that the reader edits, C types, so the chip shows the chord.
    const typing = isEditableTarget(d, d.activeElement);
    const key = typing ? COMMENT_CHORD : "C";
    const comment = selectionAction.querySelector<HTMLElement>(".slashdocs-comment")!;
    comment.querySelector("kbd")!.textContent = key;
    comment.dataset.slashdocsTooltip = `Comment ${key}`;
    // The formatting actions show for editable text, and are pressed when
    // the whole selection has their format.
    const ends = [range.startContainer, range.endContainer];
    const formattable = inEditor && ends.every((n) => isEditableTarget(d, n));
    selectionAction
      .querySelectorAll<HTMLButtonElement>("[data-slashdocs-format]")
      .forEach((button) => {
        button.hidden = !formattable;
        const on = ends.every((n) =>
          elementOf(n)?.closest(button.dataset.slashdocsFormat!),
        );
        button.setAttribute("aria-pressed", String(on));
      });
    // The buttons shrink to fit in one row. Comment keeps its name and key
    // while they fit in it. Its tooltip shows only when they do not.
    selectionAction.removeAttribute("data-compact");
    selectionAction.removeAttribute("data-docked");
    selectionAction.toggleAttribute(
      "data-compact",
      comment.scrollWidth > comment.clientWidth,
    );
    // The actions sit next to the selection, as in other editors: centered
    // above it, else below it. They cover the text around the selection
    // while they show, but never the selection. With a finger, the system's
    // own menu takes that place, so the actions sit where they cover no text:
    // also after its last line, or beside its block. When no place is clear,
    // as in a narrow column of text, they dock at an edge of the viewport as
    // a bar, and the document gets room to scroll out from under a bar at
    // the bottom.
    const rect = range.getBoundingClientRect();
    const lines = Array.from(range.getClientRects()).filter((r) => r.width);
    const [first, last] = [lines[0] ?? rect, lines.at(-1) ?? rect];
    const block = blockOf(range.startContainer)?.getBoundingClientRect() ?? rect;
    const { offsetWidth: width, offsetHeight: height } = selectionAction;
    const gap = SELECTION_ACTION_GAP;
    const center = rect.left + (rect.width - width) / 2;
    const beside = (line: DOMRect) => line.top + (line.height - height) / 2;
    const touch = hostPointer === "coarse";
    const places = [
      [center, first.top - gap - height],
      [center, last.bottom + gap],
      ...(touch
        ? [
            [last.right + gap, beside(last)],
            [block.right + gap, beside(first)],
            [block.left - gap - width, beside(first)],
          ]
        : []),
    ];
    const edge = placeClear(d, selectionAction, lines, places, {
      dock: touch,
      overText: !touch,
    });
    if (!edge) return;
    selectionAction.style.removeProperty("left");
    selectionAction.style.removeProperty("top");
    selectionAction.setAttribute("data-docked", edge);
  }

  function handleKVUndoRedoShortcut(d: Document, ev: KeyboardEvent): void {
    if (ev.defaultPrevented || isEditableTarget(d, ev.target)) return;
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
    const key = String(ev.key || "").toLowerCase();
    const wantsRedo = key === "y" || (key === "z" && ev.shiftKey);
    const wantsUndo = key === "z" && !ev.shiftKey;
    if (wantsRedo) {
      if (!kvRedoStack.length) return;
      ev.preventDefault();
      ev.stopPropagation();
      kvRedo().catch(() => {});
      return;
    }
    if (!wantsUndo || !kvUndoStack.length) return;
    ev.preventDefault();
    ev.stopPropagation();
    kvUndo().catch(() => {});
  }

  curTheme = initialTheme();
  let setupDoc: Document | null = null;

  let pendingHeading = "";
  let headingFlash: Animation | undefined;
  function prepareHeadings(d: Document): void {
    const used = new Set(Array.from(d.querySelectorAll("[id]")).map((el) => el.id));
    if (!d.getElementById("slashdocs-heading-link-style")) {
      const style = d.createElement("style");
      style.id = "slashdocs-heading-link-style";
      // The link button is out of flow, in the gutter before the heading's
      // first line. Headings keep the height that the author gave them, so
      // readers, editors and previews lay out the document in the same way.
      // With no gutter, it follows the heading's last word.
      style.textContent = `.slashdocs-heading-link{position:absolute!important;box-sizing:border-box!important;width:1.2em!important;margin:0!important;margin-inline-start:-1.2em!important;padding:0!important;border:0!important;border-radius:4px;background:transparent!important;color:inherit;font:inherit;text-align:center;cursor:pointer}.slashdocs-heading-link.slashdocs-heading-link-end{margin-inline-start:.25em!important}.slashdocs-heading-link::before{content:"#";opacity:0;transition:opacity .15s ease-out}:is(h1,h2,h3,h4,h5,h6):hover>.slashdocs-heading-link::before,.slashdocs-heading-link:focus-visible::before{opacity:.5}.slashdocs-heading-link:hover::before{opacity:.85}.slashdocs-heading-link:focus-visible{outline:2px solid currentColor}:is(h1,h2,h3,h4,h5,h6)>.slashdocs-heading-link[data-slashdocs-copied]::before{content:"✓";opacity:1}@media print{.slashdocs-heading-link{display:none!important}}`;
      d.head.appendChild(style);
    }
    Array.from(d.querySelectorAll("h1,h2,h3,h4,h5,h6")).forEach((heading) => {
      if (!heading.id) {
        const base =
          (heading.textContent || "section")
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "section";
        let id = base;
        for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`;
        heading.id = id;
        used.add(id);
      }
      let button = heading.querySelector<HTMLButtonElement>(
        ":scope > .slashdocs-heading-link",
      );
      if (!button) {
        button = d.createElement("button");
        button.type = "button";
        button.className = "slashdocs-heading-link";
        // The editor's caret and typing stay in the heading's text.
        button.contentEditable = "false";
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.setAttribute(
          "aria-label",
          `Copy link to ${heading.textContent?.trim() || "heading"}`,
        );
        labelIcon(button, "Copy link to heading");
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          parent.postMessage(
            { type: "slashdocs:copy-heading", id: heading.id },
            targetOrigin(),
          );
        });
      }
      // The button sits in the gutter when the heading has room on its left.
      // Else it follows the heading's text, so that it stays in the frame.
      const fits =
        heading.getBoundingClientRect().left >=
        parseFloat(d.defaultView!.getComputedStyle(heading).fontSize) * 1.2;
      if (button !== (fits ? heading.firstChild : heading.lastChild)) {
        if (fits) heading.prepend(button);
        else heading.append(button);
      }
      button.classList.toggle("slashdocs-heading-link-end", !fits);
      // A button after a last word at the page's edge would make the page
      // wider. It moves back over that word, where only hover and focus show it.
      button.style.translate = "";
      const over = button.getBoundingClientRect().right - d.documentElement.clientWidth;
      if (!fits && over > 0) button.style.translate = `${-Math.ceil(over)}px`;
    });
    if (pendingHeading) navigateHeading(pendingHeading);
  }

  // The time that the link control of a heading says Copied.
  const COPIED_MS = 1500;

  // showCopied tells, on the link control of heading id, that its link is
  // copied, in place of a toast that would cover the heading.
  let copied: HTMLElement | undefined;
  let copiedTimer: number | undefined;
  function showCopied(id: string): void {
    clearTimeout(copiedTimer);
    if (copied) delete copied.dataset.slashdocsCopied;
    copied =
      doc()
        ?.getElementById(id)
        ?.querySelector<HTMLElement>(":scope > .slashdocs-heading-link") ?? undefined;
    if (!copied) return;
    copied.dataset.slashdocsCopied = "";
    copiedTimer = window.setTimeout(() => showCopied(""), COPIED_MS);
  }

  function navigateHeading(id: string): void {
    pendingText = null;
    textVisibilityObserver?.disconnect();
    clearTimeout(textNoticeTimer);
    pendingHeading = id;
    const d = doc();
    if (!d || !id) return;
    const target = d.getElementById(id);
    if (!target) return;
    for (let el = target.parentElement; el; el = el.parentElement) {
      if (el.tagName === "DETAILS") (el as HTMLDetailsElement).open = true;
    }
    if (!(target as HTMLElement).getClientRects().length) return;
    pendingHeading = "";
    target.scrollIntoView({ block: "start", behavior: "instant" });
    headingFlash?.cancel();
    const highlight = { backgroundColor: "rgba(129, 140, 248, 0.25)" };
    const resting = {
      backgroundColor: d.defaultView!.getComputedStyle(target).backgroundColor,
    };
    const reduced = reducedMotion(d);
    // A single arrival cue, with no layout changes or persistent author styles.
    headingFlash = target.animate(
      [highlight, { ...highlight, offset: 0.25 }, resting],
      { duration: 1400, easing: reduced ? "steps(1, end)" : "ease-out" },
    );
  }
  let textVisibilityObserver: MutationObserver | undefined;
  function scheduleTextNavigation(): void {
    if (pendingText && !textRetryTimer) {
      textRetryTimer = setTimeout(() => {
        textRetryTimer = undefined;
        tryNavigateText();
      }, 200);
    }
  }

  let pendingText: CommentAnchor | null = null;
  let textRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let textNoticeTimer: ReturnType<typeof setTimeout> | undefined;

  function navigateText(value: unknown): void {
    pendingHeading = "";
    pendingText = textLinkAnchor(value);
    textVisibilityObserver?.disconnect();
    clearTimeout(textNoticeTimer);
    doc()
      ?.querySelectorAll(".slashdocs-text-flash")
      .forEach((el) => el.remove());
    if (!pendingText) return;
    tryNavigateText();
    if (pendingText) {
      // Attribute-only tab/panel reveals do not trigger the comment text observer.
      textVisibilityObserver = new MutationObserver(scheduleTextNavigation);
      const root = doc()?.documentElement;
      if (root)
        textVisibilityObserver.observe(root, {
          subtree: true,
          attributes: true,
          attributeFilter: ["hidden", "class", "style", "open"],
        });
      textNoticeTimer = setTimeout(() => {
        if (pendingText)
          parent.postMessage({ type: "slashdocs:text-unavailable" }, targetOrigin());
      }, 2000);
    }
  }

  function tryNavigateText(): void {
    const d = doc();
    if (!pendingText || !d?.body) return;
    // Deep links must target the quoted text, never an approximate replacement.
    const rendered = renderedTextOf(d.body);
    if (!rendered.text.includes(pendingText.quote!)) return;
    const range = resolveAnchor(d.body, pendingText, () => rendered);
    if (!range || renderedTextFromRange(range) !== pendingText.quote) return;
    const start =
      range.startContainer.nodeType === 1
        ? (range.startContainer as Element)
        : range.startContainer.parentElement;
    for (let el = start; el; el = el.parentElement) {
      if (el.tagName === "DETAILS") (el as HTMLDetailsElement).open = true;
    }
    if (!Array.from(range.getClientRects()).some((r) => r.width && r.height)) return;
    pendingText = null;
    textVisibilityObserver?.disconnect();
    clearTimeout(textNoticeTimer);
    // Center the first line of the text, not its block: a long paragraph
    // would otherwise put the text far from where a followed reader sees it.
    start?.scrollIntoView({ block: "center", behavior: "instant" });
    const line = Array.from(range.getClientRects()).find((r) => r.width && r.height)!;
    d.defaultView!.scrollBy({
      top: line.top + line.height / 2 - d.defaultView!.innerHeight / 2,
      behavior: "instant",
    });
    flashRects(d, Array.from(range.getClientRects()), TEXT_FLASH);
  }

  // A flash blinks twice on text that a link goes to, and fades once on text
  // that changed. Reduced motion holds it, then takes it away.
  // A flash paints a sky tint unless it gives its own paint. With reduced
  // motion, it holds its keyframes, or else shows its still paint as long.
  type Flash = {
    keyframes: Keyframe[];
    duration: number;
    paint?: string;
    still?: { paint: string; duration: number };
  };
  const TEXT_FLASH: Flash = {
    keyframes: [
      { opacity: 0.2 },
      { opacity: 1, offset: 0.12 },
      { opacity: 0.25, offset: 0.25 },
      { opacity: 1, offset: 0.38 },
      { opacity: 1, offset: 0.72 },
      { opacity: 0 },
    ],
    duration: 2200,
  };
  const CHANGED_FLASH: Flash = {
    keyframes: [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }],
    duration: 1200,
  };

  // The paint of a flash that gives none.
  const SKY =
    "background:rgba(56,189,248,.32)!important;box-shadow:0 0 0 1px rgba(14,165,233,.65)!important";
  // A thread that the reader went to: the tint of its highlight doubles and
  // comes back, once. Reduced motion outlines it for 1.5 s.
  const PULSE: Flash = {
    keyframes: [{ opacity: 0 }, { opacity: 1, offset: 0.4 }, { opacity: 0 }],
    duration: 600,
    paint:
      "background:rgba(251,191,36,.55)!important;mix-blend-mode:multiply!important",
    still: { paint: "box-shadow:0 0 0 2px #f59e0b!important", duration: 1500 },
  };

  // flashRects puts a flash over each rectangle. Overlays that take no
  // pointer events do not split text nodes or disturb comments. They sit on
  // the page, not the window, so that they stay on their text through any
  // scroll: the load, a scroll restore, an open pin, or the reader's own.
  function flashRects(d: Document, rects: DOMRect[], flash: Flash): void {
    const reduced = reducedMotion(d);
    const { paint = SKY, duration } = (reduced && flash.still) || flash;
    const { scrollX, scrollY } = d.defaultView!;
    rects.slice(0, 200).forEach((r) => {
      if (!r.width || !r.height) return;
      const overlay = d.createElement("span");
      overlay.className = "slashdocs-text-flash";
      overlay.setAttribute("aria-hidden", "true");
      // Keep opacity animatable: an important `all` reset overrides animation values.
      overlay.style.cssText = `all:initial;position:absolute!important;pointer-events:none!important;z-index:2147483646!important;left:${r.left + scrollX}px!important;top:${r.top + scrollY}px!important;width:${r.width}px!important;height:${r.height}px!important;${paint};border-radius:3px!important`;
      d.documentElement.appendChild(overlay);
      const animation = overlay.animate(
        reduced
          ? [{ opacity: 1 }, { opacity: 1, offset: 0.85 }, { opacity: 0 }]
          : flash.keyframes,
        { duration, easing: reduced ? "steps(1, end)" : "ease-in-out" },
      );
      animation.onfinish = () => overlay.remove();
    });
  }

  // The text of the blocks that a reader saw last in this tab, per document,
  // which the next load of the document compares with its own. It is kept
  // after each load, and again when the document's window goes, while its
  // blocks are still there: this frame goes after the document does.
  const SEEN_BLOCKS = `slashdocs:blocks:${location.pathname.split("/")[2]}`;
  function keepSeen(blocks: Block[]): void {
    // A window that goes before its blocks show keeps the list of the last.
    if (!blocks.length) return;
    try {
      sessionStorage.setItem(SEEN_BLOCKS, JSON.stringify(blocks.map((b) => b.text)));
    } catch {}
  }

  // showChanges flashes the blocks whose text the reader did not see last.
  function showChanges(): void {
    const d = doc();
    if (!d?.body) return;
    let seen: unknown;
    try {
      seen = JSON.parse(sessionStorage.getItem(SEEN_BLOCKS) ?? "null");
    } catch {}
    const blocks = blockTexts(d);
    keepSeen(blocks);
    if (!Array.isArray(seen)) return;
    const changed = changedBlocks(
      seen.map(String),
      blocks.map((b) => b.text),
    );
    flashRects(
      d,
      changed.flatMap((i) => blocks[i].nodes.flatMap(rectsOf)),
      CHANGED_FLASH,
    );
  }

  // The margin that a document keeps at its left when it moves for a panel.
  const ROOM_MARGIN = 16;
  // The pixels at the right of the window that a panel of the app covers.
  let panel = 0;

  // makeRoomForPanel moves the document left, so that the panel covers none
  // of its content, when its left margin has room. Else it tells the app,
  // which makes room beside the panel.
  function makeRoomForPanel(): void {
    const d = doc();
    if (!d?.body) return;
    const shift = roomFor(d, panel);
    slide(d, shift ?? 0);
    if (shift === null)
      parent.postMessage({ type: "slashdocs:room", crowded: true }, targetOrigin());
  }

  // roomFor tells how far left document d moves so that a panel over the
  // right `covered` pixels of the window covers none of its content: 0 when the
  // panel covers margin only, or null when the left margin is too narrow.
  // The content is the boxes of the body's blocks, as a centered column, in
  // the page.
  function roomFor(d: Document, covered: number): number | null {
    const view = d.defaultView!;
    let left = Infinity;
    let right = -Infinity;
    for (const el of d.body.children) {
      if (/^(absolute|fixed)$/.test(view.getComputedStyle(el).position)) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      left = Math.min(left, r.left + view.scrollX);
      right = Math.max(right, r.right + view.scrollX);
    }
    const shift = Math.max(0, Math.ceil(right - (view.innerWidth - covered)));
    return !shift || (left <= right && shift <= left - ROOM_MARGIN) ? shift : null;
  }

  function rectsOf(node: Node): DOMRect[] {
    const range = node.ownerDocument!.createRange();
    range.selectNodeContents(node);
    return Array.from(range.getClientRects());
  }

  function setupFrame(): void {
    const d = doc();
    if (!d || !d.documentElement || !d.body || setupDoc === d) return;
    setupDoc = d;
    pendingText = null;
    textVisibilityObserver?.disconnect();
    clearTimeout(textRetryTimer);
    textRetryTimer = undefined;
    clearTimeout(textNoticeTimer);
    // A freshly loaded document has no highlights; the parent repaints after
    // the ready signal below. Dropping the previous document's payload — and
    // any repaint already scheduled for it — keeps its comments from being
    // anchored into the new document mid-load.
    lastPaint = null;
    lastPaintKey = null;
    lastPaintResults = null;
    highlightsHeld = false;
    commentPositionFrame = 0;
    revealedActive = null;
    restoredSelection = null;
    paintedQuotes.clear();
    clearTimeout(mutationRepaintTimer ?? undefined);
    mutationRepaintTimer = null;
    mutationRepaintDeadline = 0;
    observeMutations(d);
    // Before the click listeners below: a click that places a pin goes no
    // further.
    pins.start(d);
    resetKVHistory();
    injectStyles();
    installSlashdocsAPI();
    dismissSelectionAction();
    actionRange = null;
    selectionDismissed = false;
    // The actions at the selection go on scroll. Docked ones stay, so that
    // the reader can scroll text out from under them.
    d.defaultView?.addEventListener(
      "scroll",
      () => {
        if (!selectionAction?.hasAttribute("data-docked")) dismissSelectionAction();
      },
      { passive: true },
    );
    prepareHeadings(d);
    prepareLinks();
    // The prelude already stamped the current theme on a reload, so only
    // other loads get it announced.
    announcedTheme = reloadExpected ? curTheme : null;
    reloadExpected = false;
    applyTheme(curTheme);
    // Track the selection gesture so mutation repairs never run mid-drag
    // (they would make the browser stop rendering the native selection).
    d.addEventListener("mousedown", () => {
      selectionGestureActive = true;
    });
    d.addEventListener("mouseup", () => {
      selectionGestureActive = false;
    });
    d.addEventListener("mouseup", () =>
      setTimeout(() => {
        snapSelection(d);
        selection();
      }, 0),
    );
    d.addEventListener("keyup", () => setTimeout(selection, 0));
    // Touch devices: while a finger is down the user is still adjusting the
    // selection (long-press then drag the handles), so we must NOT emit yet
    // — doing so pops the comments sheet and steals the drag. We only emit
    // once the finger lifts (touchend), i.e. the gesture has settled.
    var touching = false;
    var touchEmitTimer: number | null = null;
    d.addEventListener(
      "touchstart",
      function () {
        touching = true;
        selectionGestureActive = true;
        // A new touch (e.g. grabbing a selection handle to drag) cancels a
        // pending emit from the previous touchend.
        if (touchEmitTimer) {
          clearTimeout(touchEmitTimer);
          touchEmitTimer = null;
        }
      },
      { passive: true },
    );
    d.addEventListener("touchend", function () {
      touching = false;
      selectionGestureActive = false;
      // Wait after the finger lifts before emitting. If the user grabs a
      // selection handle to keep dragging, touchstart cancels this timer, so
      // the sheet only appears once they've truly finished selecting.
      if (touchEmitTimer) clearTimeout(touchEmitTimer);
      touchEmitTimer = setTimeout(function () {
        touchEmitTimer = null;
        selection();
      }, 450);
    });
    d.addEventListener("touchcancel", function () {
      touching = false;
      selectionGestureActive = false;
    });
    // selectionchange handles mouse drag-selection on desktop; on touch it
    // fires continuously mid-drag, so skip it while a finger is down.
    var selTimer: number | null = null;
    d.addEventListener("selectionchange", function () {
      if (touching) return;
      if (selTimer) clearTimeout(selTimer);
      selTimer = setTimeout(selection, 350);
    });
    const chordKeys: string[] = CHORD_KEYS.map((item) => item.key);
    let vimGArmed = false;
    let vimGTimer = 0;
    let glide = 0;
    const stopGlide = () => {
      d.defaultView?.cancelAnimationFrame(glide);
      glide = 0;
    };
    d.addEventListener("keyup", stopGlide);
    d.defaultView?.addEventListener("blur", stopGlide);
    const runVimScroll = (action: VimScrollAction, repeat = false) => {
      const view = d.defaultView;
      if (!view) return;
      const behavior = scrollBehavior(d);
      if (action === "line-down" || action === "line-up") {
        const direction = action === "line-down" ? 1 : -1;
        if (!repeat || behavior === "instant") {
          stopGlide();
          view.scrollBy({ top: direction * VIM_LINE_PX, behavior });
          return;
        }
        // Each key repeat would restart a smooth scroll from rest, which is
        // slower than taps. A held key moves the page every frame instead.
        if (glide) return;
        let last = view.performance.now();
        const step = (now: number) => {
          view.scrollBy(0, direction * VIM_GLIDE_PX_PER_MS * (now - last));
          last = now;
          glide = view.requestAnimationFrame(step);
        };
        glide = view.requestAnimationFrame(step);
      } else if (action === "half-page-down")
        view.scrollBy({ top: Math.max(160, view.innerHeight * 0.5), behavior });
      else if (action === "half-page-up")
        view.scrollBy({
          top: -Math.max(160, view.innerHeight * 0.5),
          behavior,
        });
      else if (action === "top") view.scrollTo({ top: 0, behavior });
      else
        view.scrollTo({
          top: d.documentElement.scrollHeight,
          behavior,
        });
    };
    const onKey = (ev: KeyboardEvent) => {
      // An Esc that closes the actions at the selection is theirs alone.
      if (ev.key === "Escape") {
        const shown = !!selectionAction?.isConnected;
        dismissSelectionAction();
        if (shown) return;
      }
      const modified = ev.metaKey || ev.ctrlKey || ev.altKey;
      if (ev.key === "Escape" && pins.isPlacing()) {
        ev.preventDefault();
        pins.setPlacing(false);
        return;
      }
      // Where C types, as in the document editor, Ctrl or Cmd with Alt and
      // M comments on the selection, as in Google Docs.
      if ((ev.metaKey || ev.ctrlKey) && ev.altKey && ev.code === "KeyM") {
        const range = selectedRange(d.getSelection());
        if (range) {
          ev.preventDefault();
          commitSelection(range);
          return;
        }
      }
      // In Edit mode every key types while the text has the caret, as in
      // Google Docs. Esc leaves the text, and in the app it closes the open
      // thread, or else leaves Edit mode. It arms no chord.
      if (ev.key === "Escape" && textEditing && isEditableTarget(d, ev.target)) {
        (d.activeElement as HTMLElement | null)?.blur();
        parent.postMessage(
          { type: "slashdocs:keydown", key: "Escape" },
          targetOrigin(),
        );
        return;
      }
      if (ev.defaultPrevented || isEditableTarget(d, ev.target)) {
        vimGArmed = false;
        clearTimeout(vimGTimer);
        handleKVUndoRedoShortcut(d, ev);
        return;
      }

      const key = ev.key.toLowerCase();
      if (ev.key === "Escape") {
        // An Esc closes the open thread in the app, or leaves Edit mode, and
        // arms no chord.
        armChord(!chordArmed && !watched && !textEditing);
        parent.postMessage(
          { type: "slashdocs:keydown", key: "Escape" },
          targetOrigin(),
        );
      } else if (chordArmed && !modified && chordKeys.includes(key)) {
        // While the app shows the Esc chord, the chord takes the key: it
        // types nothing, and C opens the comments instead of placing a pin.
        armChord(false);
        ev.preventDefault();
        parent.postMessage({ type: "slashdocs:keydown", key }, targetOrigin());
      }
      if (ev.key === "?" && !modified) {
        parent.postMessage({ type: "slashdocs:keydown", key: "?" }, targetOrigin());
      }
      // While the document has open threads, J and K go from thread to
      // thread in the app, with N and P, and Shift+J to the next unread one.
      if (threadKeys && !modified && THREAD_KEYS.includes(ev.key)) {
        ev.preventDefault();
        if (!ev.repeat)
          parent.postMessage(
            { type: "slashdocs:keydown", key: ev.key },
            targetOrigin(),
          );
        return;
      }

      const vim = reduceVimScroll(
        {
          key: ev.key,
          ctrlKey: ev.ctrlKey,
          metaKey: ev.metaKey,
          altKey: ev.altKey,
        },
        vimGArmed,
      );
      vimGArmed = vim.gArmed;
      clearTimeout(vimGTimer);
      if (vimGArmed) {
        vimGTimer = setTimeout(() => {
          vimGArmed = false;
        }, 600);
      }
      if (vim.action) {
        ev.preventDefault();
        runVimScroll(vim.action, ev.repeat);
      }
      handleKVUndoRedoShortcut(d, ev);
    };
    // C comments on the selected text, as in Figma, and with nothing
    // selected it places a comment pin. In Edit mode it goes back to Comment
    // mode, with a comment on the selected text, and E, which the app takes,
    // starts Edit mode. They run after the document's own handlers, on its
    // window, so a document that takes them keeps them.
    const onModeKey = (ev: KeyboardEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (ev.defaultPrevented || isEditableTarget(d, ev.target)) return;
      if (ev.key === (textEditing ? "c" : "e"))
        parent.postMessage({ type: "slashdocs:keydown", key: ev.key }, targetOrigin());
      if (ev.key !== "c") return;
      ev.preventDefault();
      const range = selectedRange(d.getSelection());
      if (range) commitSelection(range);
      else if (!textEditing) pins.setPlacing(!pins.isPlacing());
    };
    d.addEventListener("keydown", onKey);
    d.defaultView?.addEventListener("keydown", onModeKey);
    documentKeys = (ev) => {
      onKey(ev);
      onModeKey(ev);
    };
    // Forward trackpad pinch-to-zoom (wheel + ctrlKey) to parent so the
    // app can scale only the document iframe instead of browser-zooming. A
    // document that zooms itself takes the wheel first, and keeps it.
    d.defaultView?.addEventListener(
      "wheel",
      function (ev) {
        if (!ev.ctrlKey || ev.defaultPrevented) return;
        ev.preventDefault();
        parent.postMessage(
          {
            type: "slashdocs:zoom",
            deltaY: ev.deltaY,
            clientX: ev.clientX,
            clientY: ev.clientY,
          },
          targetOrigin(),
        );
      },
      { passive: false },
    );
    // The app tells an editor what a change does to approvals when the text
    // takes the caret. The focus settles first, as it moves from the body
    // into script text.
    const reportFocus = () =>
      setTimeout(() =>
        parent.postMessage(
          {
            type: "slashdocs:text-focus",
            on: !!textEditor && isEditableTarget(d, d.activeElement),
          },
          targetOrigin(),
        ),
      );
    d.addEventListener("focusin", reportFocus);
    d.addEventListener("focusout", reportFocus);
    d.addEventListener("click", activate);
    d.addEventListener("click", handleLinkClick);
    d.addEventListener(
      "click",
      () => parent.postMessage({ type: "slashdocs:document-click" }, targetOrigin()),
      true,
    );
    d.defaultView?.addEventListener("resize", scheduleCommentPositions);
    d.defaultView?.addEventListener("pagehide", () => keepSeen(blockTexts(d)));
    // Capture scrolls of nested containers too, not only the window.
    d.addEventListener("scroll", scheduleViewport, { capture: true, passive: true });
    d.addEventListener("scroll", cursors.refresh, { capture: true, passive: true });
    // Typing here moves the blocks that others edit.
    d.addEventListener("input", cursors.refresh);
    d.defaultView?.addEventListener("resize", cursors.refresh);
    d.defaultView?.addEventListener("resize", cursors.refollow);
    cursors.watchInput(d);
    const pointer = trackPointer(d, (spot) =>
      parent.postMessage({ type: "slashdocs:pointer", spot }, targetOrigin()),
    );
    chat = pointer ? createCursorChat(d, pointer, () => chatColor) : null;
    // A document that reloads by itself while being edited stays editable.
    textEditor = null;
    scriptText = null;
    if (textEditing) setTextEditing(true);
    // The address says which document is ready, so that the app does not
    // take a late ready of the document before it as this one's.
    parent.postMessage(
      { type: "slashdocs:ready", href: location.href },
      targetOrigin(),
    );
    scheduleViewport();
    hydrateKV();
    // A document that reloads by itself keeps clear of the panel.
    if (panel) makeRoomForPanel();
  }

  frame.addEventListener("load", setupFrame);
  try {
    const d = doc();
    if (d && d.readyState !== "loading") setTimeout(setupFrame, 0);
  } catch (e) {}

  window.addEventListener("message", (e) => {
    if (!e.data) return;
    if (!isParentMessage(e)) return;
    if (
      e.data.type === "slashdocs:print-snapshot" &&
      typeof e.data.requestId === "string"
    ) {
      const d = doc();
      if (!d || printPreparing) return;
      printPreparing = true;
      void snapshotForPrint(d)
        .then((html) => {
          parent.postMessage(
            {
              type: "slashdocs:print-snapshot-result",
              requestId: e.data.requestId,
              html,
              title: d.title,
            },
            targetOrigin(),
          );
        })
        .catch(() => {
          parent.postMessage(
            { type: "slashdocs:print-snapshot-result", requestId: e.data.requestId },
            targetOrigin(),
          );
        });
      return;
    }
    if (e.data.type === "slashdocs:print-finished") {
      printPreparing = false;
      const view = innerWindow();
      if (view) {
        view.dispatchEvent(new Event("afterprint"));
        dispatchPublicEvent(view, "afterprint");
      }
      return;
    }
    if (e.data.type === "slashdocs:export-response") {
      const pending = exportPending.get(e.data.requestId);
      exportPending.delete(e.data.requestId);
      if (e.data.ok === true) pending?.resolve();
      else pending?.reject();
      return;
    }
    if (e.data.type === "slashdocs:text-editing") {
      setTextEditing(e.data.on === true);
      return;
    }
    if (
      e.data.type === "slashdocs:text-collect" &&
      typeof e.data.requestId === "string"
    ) {
      parent.postMessage(
        {
          type: "slashdocs:text-changes",
          requestId: e.data.requestId,
          ...textChanges(true),
        },
        targetOrigin(),
      );
      return;
    }
    // A saved script string shows its new text in every place, and the
    // places that changed flash.
    if (
      e.data.type === "slashdocs:script-replace" &&
      typeof e.data.from === "string" &&
      typeof e.data.to === "string"
    ) {
      const d = doc();
      const texts = scriptText?.replace(e.data.from, e.data.to) ?? [];
      if (d) flashRects(d, texts.flatMap(rectsOf), CHANGED_FLASH);
      return;
    }
    if (
      e.data.type === "slashdocs:script-text-result" &&
      typeof e.data.requestId === "string"
    ) {
      scriptText?.answer(
        e.data.requestId,
        e.data.editable === true,
        e.data.failed === true,
      );
      return;
    }
    // The app renders a changed source in a hidden frame here, beside the
    // document, to make sure that a script change shows before it saves.
    if (
      e.data.type === "slashdocs:probe" &&
      typeof e.data.requestId === "string" &&
      typeof e.data.html === "string" &&
      Array.isArray(e.data.strings)
    ) {
      const { requestId, html, locator, strings } = e.data;
      void probe(frame, html, locator, strings.map(String))
        .catch(() => ({
          text: null,
          counts: strings.map(() => 0),
          texts: 0,
          errors: 0,
        }))
        .then((result) =>
          parent.postMessage(
            { type: "slashdocs:probe-result", requestId, ...result },
            targetOrigin(),
          ),
        );
      return;
    }
    if (e.data.type === "slashdocs:paint") paint(e.data.comments, e.data.active);
    else if (e.data.type === "slashdocs:theme") {
      hostPointer = String(e.data.pointer ?? "");
      applyTheme(e.data.theme);
    } else if (e.data.type === "slashdocs:kv-response") {
      const requestId = String(e.data.requestId || "");
      const pending = kvPending[requestId];
      if (!pending) return;
      delete kvPending[requestId];
      if (e.data.ok) pending.resolve(e.data.result || {});
      else
        pending.reject(
          new Error((e.data.error && e.data.error.message) || "KV request failed"),
        );
    } else if (e.data.type === "slashdocs:github-response") {
      const requestId = String(e.data.requestId || "");
      const pending = githubPending[requestId];
      if (!pending) return;
      delete githubPending[requestId];
      if (e.data.ok) pending.resolve(e.data.result || {});
      else
        pending.reject(
          new Error((e.data.error && e.data.error.message) || "GitHub request failed"),
        );
    } else if (
      e.data.type === "slashdocs:room" &&
      typeof e.data.cover === "number" &&
      Number.isFinite(e.data.cover)
    ) {
      panel = e.data.cover;
      makeRoomForPanel();
    } else if (e.data.type === "slashdocs:show-changes") {
      showChanges();
    } else if (e.data.type === "slashdocs:navigate-text") {
      navigateText(e.data.anchor);
    } else if (e.data.type === "slashdocs:navigate-heading") {
      navigateHeading(String(e.data.id || ""));
    } else if (e.data.type === "slashdocs:request-comment-positions") {
      scheduleCommentPositions();
    } else if (
      e.data.type === "slashdocs:scroll-to" &&
      typeof e.data.top === "number" &&
      Number.isFinite(e.data.top)
    ) {
      doc()?.defaultView?.scrollTo({
        top: Math.max(0, e.data.top),
        behavior: "instant",
      });
    } else if (e.data.type === "slashdocs:vim-key") {
      const d = doc();
      const KeyboardEventCtor = d?.defaultView?.KeyboardEvent;
      if (!d || !KeyboardEventCtor) return;
      d.dispatchEvent(
        new KeyboardEventCtor(e.data.up === true ? "keyup" : "keydown", {
          key: String(e.data.key || ""),
          ctrlKey: e.data.ctrlKey === true,
          metaKey: e.data.metaKey === true,
          altKey: e.data.altKey === true,
          repeat: e.data.repeat === true,
        }),
      );
    } else if (e.data.type === "slashdocs:kv-event") {
      emitKVChange(e.data.detail || {});
    } else if (e.data.type === "slashdocs:cursor") {
      cursors.receive(e.data.cursor);
    } else if (e.data.type === "slashdocs:clear-cursors") {
      cursors.clear();
    } else if (e.data.type === "slashdocs:follow-cursor") {
      cursors.follow(String(e.data.session || ""), e.data.continuous === true);
    } else if (e.data.type === "slashdocs:unfollow-cursor") {
      cursors.unfollow();
    } else if (e.data.type === "slashdocs:open-cursor-chat") {
      chat?.open();
    } else if (e.data.type === "slashdocs:chord") {
      armChord(e.data.armed === true);
    } else if (e.data.type === "slashdocs:cursor-chat") {
      chatColor =
        typeof e.data.color === "string" && /^#[0-9a-f]{3,8}$/i.test(e.data.color)
          ? e.data.color
          : undefined;
    } else if (e.data.type === "slashdocs:pins") {
      pins.setPins(
        parsePins(e.data.pins),
        typeof e.data.active === "string" ? e.data.active : undefined,
      );
    } else if (e.data.type === "slashdocs:pin-placing") {
      pins.setPlacing(
        e.data.on === true,
        typeof e.data.move === "string" ? e.data.move : undefined,
      );
    } else if (e.data.type === "slashdocs:pins-release") {
      pins.releaseOutside();
    } else if (e.data.type === "slashdocs:heading-copied") {
      if (typeof e.data.id === "string") showCopied(e.data.id);
    } else if (e.data.type === "slashdocs:pulse" && typeof e.data.id === "string") {
      pulse(e.data.id);
    } else if (e.data.type === "slashdocs:thread-keys") {
      threadKeys = e.data.on === true;
    } else if (e.data.type === "slashdocs:watch") {
      watchAnchor(typeof e.data.id === "string" ? e.data.id : null);
    } else if (e.data.type === "slashdocs:cover") {
      // A comment sheet covers the bottom of the document. Once the document
      // stops scrolling to the open thread, its pin or highlight comes up
      // above the sheet.
      const d = doc();
      const bottom = typeof e.data.bottom === "number" ? e.data.bottom : 0;
      if (!d?.defaultView) return;
      cover(d, bottom);
      if (bottom)
        settled(d.defaultView, () => {
          const cid = watched && CSS.escape(watched);
          const mark = cid && d.querySelector(`mark.slashdocs-mark[data-cid="${cid}"]`);
          if (!pins.reveal(watched ?? undefined) && mark) reveal(mark);
        });
    }
  });
})();
