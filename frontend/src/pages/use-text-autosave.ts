import { useCallback, useEffect, useRef } from "react";
import { toast } from "sonner";
import { api, APIError } from "@/api";
import { errorMessage } from "@/lib/errors";
import { buildEdits, type TextChange, type UnmatchedChange } from "@/lib/text-edits";
import type { SaveState, TextEditResult } from "./doc-context";

// A pause in typing this long saves the edits.
const AUTOSAVE_DELAY_MS = 1500;
// Typing without a pause still saves this often.
const AUTOSAVE_MAX_DELAY_MS = 10_000;
// A save that failed for a reason that can pass, such as the network, tries
// again after this long.
const AUTOSAVE_RETRY_MS = 5_000;

// The version the next edits apply to, and its source once read. onScreen is
// false after edits were saved on top of someone else's: then no version
// holds exactly what the frame shows.
type Head = { id: string; source?: string; onScreen: boolean };

// useTextAutosave saves what an editor types in the rendered document. A
// pause in typing takes the burst of changes from the frame and sends it as
// find-and-replace edits, the same ones an agent sends. The server applies
// them to the latest version, so edits by someone else to other text land
// too. A change that cannot be placed, or that someone else changed first,
// is not saved: the reader is told, and the frame shows the latest version.
// It returns the function to call on each change in the frame.
export function useTextAutosave(options: {
  docId: string;
  // The version the frame loaded, and which load it is. A new load starts
  // over from that version.
  loaded: { version: string; load: number };
  take: () => Promise<TextEditResult>;
  setState: (state: SaveState) => void;
  // A version saved from the frame. It is clean when it holds exactly what
  // is on screen; otherwise it also holds someone else's edits.
  onSaved: (versionID: string, clean: boolean) => void;
  // Shows the latest version in place of what could not be saved.
  reload: () => void;
}) {
  const { loaded } = options;
  const latest = useRef(options);
  latest.current = options;
  const head = useRef<Head>({ id: loaded.version, onScreen: true });
  const timer = useRef<number | undefined>(undefined);
  const burstStart = useRef(0);
  const saving = useRef(false);
  const again = useRef(false);
  const unsaved = useRef(false);
  // Changes taken from the frame whose save failed, to send again.
  const retry = useRef<TextChange[]>([]);

  useEffect(() => {
    head.current = { id: loaded.version, onScreen: true };
    retry.current = [];
    unsaved.current = false;
  }, [loaded]);

  const save = useCallback(async (): Promise<void> => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    burstStart.current = 0;
    if (saving.current) {
      again.current = true;
      return;
    }
    const { docId, take, setState, onSaved, reload } = latest.current;
    saving.current = true;
    let touched = unsaved.current;
    let failed: "retry" | "reload" | null = null;
    try {
      const taken = await take();
      const changes = [...retry.current, ...taken.changes];
      retry.current = [];
      if (taken.unsupported) {
        toast.error(
          "Only words can change here. To add paragraphs or change the layout, upload the document again.",
        );
        failed = "reload";
      }
      if (!changes.length) return;
      touched = true;
      setState("saving");
      try {
        const base = head.current;
        base.source ??= await api.getVersionHTML(docId, base.id);
        const built = buildEdits(base.source, changes);
        if (built.edits.length) {
          const saved = await api.editDocument(docId, { edits: built.edits });
          const onBase = saved.base_version_id === base.id;
          head.current = {
            id: saved.id,
            source: onBase ? built.source : undefined,
            onScreen: base.onScreen && onBase,
          };
          onSaved(saved.id, head.current.onScreen);
        }
        if (built.unmatched.length) {
          toast.error(unmatchedMessage(built.unmatched[0]));
          failed = "reload";
        }
      } catch (e) {
        if (lasting(e)) failed = "reload";
        else {
          retry.current = changes;
          failed ??= "retry";
        }
        toast.error(saveErrorMessage(e), { id: "autosave-failed" });
      }
    } catch (e) {
      // The frame did not answer, so it still holds the changes.
      toast.error(errorMessage(e, "Could not read your edits."), {
        id: "autosave-failed",
      });
      failed = "retry";
    } finally {
      saving.current = false;
      unsaved.current = failed === "retry";
      if (failed === "retry") setState("failed");
      else if (touched) setState("saved");
      if (failed === "reload") reload();
      else if (failed === "retry") later(timer, save, AUTOSAVE_RETRY_MS);
      else if (again.current) later(timer, save, 0);
      again.current = false;
    }
  }, []);

  // Each change waits for a pause in typing, but no longer than the longest
  // delay since the first change of the burst.
  const changed = useCallback(
    (count: number) => {
      if (count > 0) {
        unsaved.current = true;
        latest.current.setState("unsaved");
      }
      const now = Date.now();
      burstStart.current ||= now;
      later(
        timer,
        save,
        Math.min(AUTOSAVE_DELAY_MS, burstStart.current + AUTOSAVE_MAX_DELAY_MS - now),
      );
    },
    [save],
  );

  // Save at once when the reader leaves the frame for the page around it, or
  // leaves the page, and warn before an unload loses unsaved edits.
  useEffect(() => {
    const flush = () => {
      if (timer.current !== undefined) void save();
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const warn = (e: BeforeUnloadEvent) => {
      if (unsaved.current || saving.current) e.preventDefault();
    };
    document.addEventListener("pointerdown", flush, true);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("beforeunload", warn);
    return () => {
      document.removeEventListener("pointerdown", flush, true);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("beforeunload", warn);
      window.clearTimeout(timer.current);
    };
  }, [save]);

  return changed;
}

function later(
  timer: { current: number | undefined },
  run: () => Promise<void>,
  delay: number,
) {
  window.clearTimeout(timer.current);
  timer.current = window.setTimeout(() => void run(), Math.max(0, delay));
}

// lasting reports an error that saving again will not fix.
function lasting(e: unknown): boolean {
  return (
    e instanceof APIError &&
    e.status >= 400 &&
    e.status < 500 &&
    ![408, 409, 429].includes(e.status)
  );
}

function saveErrorMessage(e: unknown): string {
  if (e instanceof APIError && e.code === "edit_failed") {
    return "Someone else changed the same text first, so your change was not saved. The document now shows their version.";
  }
  if (lasting(e)) return errorMessage(e, "Your edits could not be saved.");
  return "Your edits are not saved yet. Trying again…";
}

function unmatchedMessage(change: UnmatchedChange): string {
  const text = change.before.trim().slice(0, 60);
  return change.reason === "ambiguous"
    ? `“${text}” appears more than once in the document, so that change was not saved. Change a longer passage around it.`
    : `“${text}” is not in the document source as written (a script may make it), so that change was not saved.`;
}
