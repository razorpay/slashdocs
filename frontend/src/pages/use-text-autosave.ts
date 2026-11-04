import { useCallback, useEffect, useRef } from "react";
import { toast, type ExternalToast } from "sonner";
import { api, APIError } from "@/api";
import { errorMessage } from "@/lib/errors";
import {
  checkScriptChange,
  findLiterals,
  writeScriptChange,
  type Render,
} from "@/lib/script-literals";
import {
  applyRegions,
  parseSource,
  replacementsBetween,
  type Replacement,
  type SourceTree,
} from "@/lib/source-edits";
import { randomId } from "@/lib/uuid";
import type { Region, ScriptChange } from "../../bridge/source-pieces";
import type { SaveState, TextEditResult } from "./doc-context";

// A pause in typing this long saves the edits.
const AUTOSAVE_DELAY_MS = 1500;
// Typing without a pause still saves this often.
const AUTOSAVE_MAX_DELAY_MS = 10_000;
// A save that failed for a reason that can pass, such as the network, tries
// again after this long.
const AUTOSAVE_RETRY_MS = 5_000;

const FAILED_TOAST = "autosave-failed";
const PAUSED_TOAST = "autosave-paused";
const SCRIPT_TOAST = "script-text";

// The version that the frame loaded: its source, and the parse of it that
// the regions from the frame refer to.
type Base = { source: string; tree: SourceTree };

// The last version saved from the frame, and its source. Its source is what
// the frame shows at that save.
type Head = { id: string; source: string };

// One save: the regions that it holds, the local source that it makes, and
// the request. A request that failed for a reason that can pass goes again
// as it is, so that the server can tell that it is the same save. scripts
// names the script changes that this save is the first to hold, places
// counts the places that show them, and undo writes their old text back.
type Save = {
  regions: Region[];
  html: string;
  body: Parameters<typeof api.editSource>[1];
  scripts: string[];
  places: number;
  undo: Replacement[];
};

// The edits cannot be written into the source. The reason says why.
class Refused extends Error {}

// useTextAutosave saves what an editor types in the rendered document. A
// pause in typing takes the edited regions from the frame, writes them into
// the source of the version that the frame loaded, and saves the difference
// from the last save as replacements by position. The server moves them onto
// a newer version when someone else saved first. It returns the function to
// call on each change in the frame.
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
  // Shows the latest version in place of what is on screen.
  reload: () => void;
  // Renders a source in a probe frame, to make sure that a script change
  // shows.
  probe: Render;
}) {
  const { loaded } = options;
  const latest = useRef(options);
  latest.current = options;
  const base = useRef<Base | undefined>(undefined);
  // Unset until the first save: then the loaded version is the head.
  const head = useRef<Head | undefined>(undefined);
  const unsent = useRef<Save | undefined>(undefined);
  // Set when the document changed elsewhere in a way that the edits on
  // screen cannot follow. Only a new load saves again.
  const paused = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const burstStart = useRef(0);
  const saving = useRef(false);
  const again = useRef(false);
  const unsaved = useRef(false);
  // The outcome of each script change, by its JSON, and the script changes
  // that a save holds.
  const checks = useRef(
    new Map<string, Promise<{ places: number } | { refused: string }>>(),
  );
  const savedScripts = useRef(new Set<string>());

  useEffect(() => {
    base.current = undefined;
    head.current = undefined;
    unsent.current = undefined;
    paused.current = false;
    unsaved.current = false;
    checks.current = new Map();
    savedScripts.current = new Set();
    toast.dismiss(PAUSED_TOAST);
  }, [loaded]);

  const loadBase = useCallback(async (): Promise<Base> => {
    const { docId, loaded } = latest.current;
    return (base.current ??= await readBase(docId, loaded.version));
  }, []);

  // Whether the reader can type in script text: when one string of the
  // loaded source holds it.
  const scriptEditable = useCallback(
    async (text: string): Promise<boolean> =>
      (await findLiterals((await loadBase()).source, text)).length === 1,
    [loadBase],
  );

  // check makes sure once that a script change shows on the page. A change
  // that does not show is not saved, and the reader is told why once.
  const check = useCallback((change: ScriptChange) => {
    const key = JSON.stringify(change);
    let checked = checks.current.get(key);
    if (!checked) {
      checked = checkScriptChange(base.current!, change, latest.current.probe).catch(
        () => ({ refused: "The new text could not be checked." }),
      );
      void checked.then((c) => {
        if ("refused" in c) toast.error(c.refused, { id: SCRIPT_TOAST });
      });
      checks.current.set(key, checked);
    }
    return checked;
  }, []);

  // The local source for what the frame shows: the loaded source with every
  // region, and with each script change that shows on the page.
  const build = useCallback(
    async ({ regions, scripts }: TextEditResult) => {
      const applied = applyRegions(base.current!.tree, regions);
      if ("refused" in applied) throw new Refused(applied.refused);
      let html = applied.html;
      const fresh: (ScriptChange & { key: string; places: number })[] = [];
      for (const change of scripts) {
        const checked = await check(change);
        if ("refused" in checked) continue;
        const written = await writeScriptChange(html, change.before, change.after);
        if (!written) continue;
        html = written;
        const key = JSON.stringify(change);
        if (!savedScripts.current.has(key))
          fresh.push({ ...change, key, places: checked.places });
      }
      return { html, fresh };
    },
    [check],
  );

  // The save for what the frame shows now, or nothing when it shows what the
  // head holds.
  const next = useCallback(async (): Promise<Save | undefined> => {
    const { loaded, take } = latest.current;
    const { source } = await loadBase();
    const result = await take();
    const { html, fresh } = await build(result);
    const from = head.current ?? { id: loaded.version, source };
    const replacements = replacementsBetween(from.source, html);
    if (!replacements.length) return undefined;
    let undone = html;
    for (const { before, after } of fresh)
      undone = (await writeScriptChange(undone, after, before)) ?? undone;
    return {
      regions: result.regions,
      html,
      body: { base_version_id: from.id, client_change_id: randomId(), replacements },
      scripts: fresh.map((c) => c.key),
      places: fresh.reduce((sum, c) => sum + c.places, 0),
      undo: fresh.length ? replacementsBetween(html, undone) : [],
    };
  }, [loadBase, build]);

  // Whether the frame still shows html, as when the reader typed nothing
  // more during a save.
  const shows = useCallback(
    async (html: string): Promise<boolean> => {
      try {
        return (await build(await latest.current.take())).html === html;
      } catch {
        return false;
      }
    },
    [build],
  );

  // Keeps the edits on screen and stops saving them, with a message that
  // stays until the reader acts on it.
  const pause = useCallback((message: string, actions: ExternalToast) => {
    paused.current = true;
    toast.error(message, { id: PAUSED_TOAST, duration: Infinity, ...actions });
  }, []);

  const save = useCallback(async (): Promise<void> => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    burstStart.current = 0;
    if (saving.current) {
      again.current = true;
      return;
    }
    if (paused.current) return;
    const { docId, setState, onSaved, reload } = latest.current;
    const showLatest = () => latest.current.reload();
    saving.current = true;
    let touched = unsaved.current;
    let outcome: "retry" | "refused" | "paused" | "reload" | undefined;
    try {
      const resent = unsent.current !== undefined;
      const change = (unsent.current ??= await next());
      if (!change) return;
      touched = true;
      setState("saving");
      const saved = await api.editSource(docId, change.body);
      unsent.current = undefined;
      onSaved(saved.id, !saved.rebased);
      if (change.places) {
        for (const key of change.scripts) savedScripts.current.add(key);
        // Undo saves the old text back after what the reader typed since,
        // and loads the frame again to show it.
        const undo = async () => {
          await save();
          try {
            const undone = await api.editSource(docId, {
              base_version_id: saved.id,
              client_change_id: randomId(),
              replacements: change.undo,
            });
            onSaved(undone.id, false);
            latest.current.reload();
          } catch (e) {
            toast.error(errorMessage(e, "The change could not be undone."), {
              id: SCRIPT_TOAST,
            });
          }
        };
        toast.success(
          change.places > 1 ? `Changed in ${change.places} places` : "Changed",
          { id: SCRIPT_TOAST, action: { label: "Undo", onClick: () => void undo() } },
        );
      }
      if (!saved.rebased) {
        head.current = { id: saved.id, source: change.html };
        // The frame changed while the save waited to go again.
        again.current ||= resent;
        // The other places that show the script text show it after a load.
        if (change.places && (await shows(change.html))) outcome = "reload";
      } else if (await shows(change.html)) {
        outcome = "reload";
      } else {
        outcome = "paused";
        pause(
          "The document changed elsewhere, so your latest words are on screen but not saved.",
          { action: { label: "Show the latest version", onClick: showLatest } },
        );
      }
    } catch (e) {
      if (e instanceof Refused) {
        outcome = "refused";
        toast.error(e.message, { id: FAILED_TOAST });
      } else if (e instanceof APIError && e.code === "edit_conflict") {
        outcome = "paused";
        const text = regionText(base.current!.tree, unsent.current!.regions);
        pause(
          "Someone else changed the same text. Your text stays on screen and is not saved.",
          {
            action: {
              label: "Copy my text",
              onClick: (event) => {
                // The message stays, to show their version after the copy.
                event.preventDefault();
                void navigator.clipboard.writeText(text).then(
                  () => toast.success("Your text is copied."),
                  () => toast.error("Could not copy your text."),
                );
              },
            },
            cancel: { label: "Show their version", onClick: showLatest },
          },
        );
      } else if (passing(e)) {
        outcome = "retry";
        toast.error("Your edits are not saved yet. Trying again…", {
          id: FAILED_TOAST,
        });
      } else {
        outcome = "reload";
        toast.error(
          e instanceof APIError && e.code === "edit_failed"
            ? "Your edit could not be saved. The document now shows the latest version."
            : errorMessage(e, "Your edits could not be saved."),
          { id: FAILED_TOAST },
        );
      }
      if (outcome !== "retry") unsent.current = undefined;
    } finally {
      saving.current = false;
      unsaved.current = outcome !== undefined && outcome !== "reload";
      if (outcome === "paused") setState("paused");
      else if (outcome === "retry" || outcome === "refused") setState("failed");
      else if (touched) setState("saved");
      if (outcome === "reload") reload();
      else if (outcome === "retry") later(timer, save, AUTOSAVE_RETRY_MS);
      else if (again.current) later(timer, save, 0);
      again.current = false;
    }
  }, [next, shows, pause]);

  // Each change waits for a pause in typing, but no longer than the longest
  // delay since the first change of the burst.
  const changed = useCallback(
    (count: number) => {
      if (count > 0) unsaved.current = true;
      if (paused.current) return;
      if (count > 0) latest.current.setState("unsaved");
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

  return { changed, scriptEditable };
}

async function readBase(docId: string, version: string): Promise<Base> {
  const source = await api.getVersionHTML(docId, version);
  return { source, tree: await parseSource(source) };
}

function later(
  timer: { current: number | undefined },
  run: () => Promise<void>,
  delay: number,
) {
  window.clearTimeout(timer.current);
  timer.current = window.setTimeout(() => void run(), Math.max(0, delay));
}

// passing reports an error that saving again can fix: the network, the
// frame that did not answer, or a server that is busy or failed.
function passing(e: unknown): boolean {
  return !(e instanceof APIError) || e.status >= 500 || [408, 429].includes(e.status);
}

// Elements that start a new line in the text to copy.
const BLOCKS = "address,blockquote,dd,div,dt,figcaption,h1,h2,h3,h4,h5,h6,li,p,pre,tr";
// Marks around each region in the text to copy. The private use characters
// do not occur in documents.
const START = "\uE000";
const END = "\uE001";

// regionText is the text of the regions as the reader sees it on screen, one
// region after another. The regions are written into the source between
// marks, and the marks find them in the text of the parsed result.
function regionText(tree: SourceTree, regions: Region[]): string {
  const marked = regions.map((r) => ({
    ...r,
    pieces: [{ text: START }, ...r.pieces, { text: END }],
  }));
  const applied = applyRegions(tree, marked);
  if ("refused" in applied) return "";
  const { body } = new DOMParser().parseFromString(applied.html, "text/html");
  body.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  body.querySelectorAll(BLOCKS).forEach((el) => el.append("\n"));
  return Array.from(
    (body.textContent ?? "").matchAll(/\uE000([^]*?)\uE001/g),
    ([, text]) => text.trim(),
  ).join("\n\n");
}
