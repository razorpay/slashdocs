import { useCallback, useEffect, useMemo, useRef } from "react";
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
const REFUSED_TOAST = "autosave-refused";
const SCRIPT_TOAST = "script-text";
const COPIED_TOAST = "autosave-copied";

// The version that the frame loaded: its source, and the parse of it that
// the regions from the frame refer to.
type Base = { source: string; tree: SourceTree };

// The last version saved from the frame, its source, and its source without
// script text. Its source is what the frame shows at that save.
type Head = { id: string; source: string; regions: string };

// A script string that a save changes: the text that the page shows for it
// before the save and after it, and the count of places that show it. key
// names the script text that the reader typed in.
type ScriptSave = { key: string; from: string; to: string; places: number };

// One save: the local source that it makes, with and without script text,
// and the request. A request that failed for a reason that can pass goes
// again as it is, so that the server can tell that it is the same save.
type Save = {
  html: string;
  regions: string;
  body: Parameters<typeof api.editSource>[1];
  scripts: ScriptSave[];
};

// The edits cannot be written into the source.
class Refused extends Error {}

// useTextAutosave saves what an editor types in the rendered document. A
// pause in typing takes the edited regions from the frame, writes them into
// the source of the version that the frame loaded, and saves the difference
// from the last save as replacements by position. The server moves them onto
// a newer version when someone else saved first. It returns the functions to
// call on each change in the frame and on each draft that the frame sends.
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
  // Shows a version, or else the latest one, in place of what is on screen.
  reload: (versionID?: string) => void;
  // Renders a source in a probe frame, to make sure that a script change
  // shows.
  probe: Render;
  // Changes the script text that the page shows in every place, as a load
  // of the saved source would.
  replaceText: (from: string, to: string) => void;
}) {
  const { loaded } = options;
  const latest = useRef(options);
  latest.current = options;
  const base = useRef<Base | undefined>(undefined);
  // Unset until the first save: then the loaded version is the head.
  const head = useRef<Head | undefined>(undefined);
  const unsent = useRef<Save | undefined>(undefined);
  // The latest edits that the frame sent by itself. They save when the
  // frame goes before it could save them.
  const draft = useRef<TextEditResult | undefined>(undefined);
  // Set when the frame went away: saves use the draft, and say nothing.
  const gone = useRef(false);
  // Set when the document changed elsewhere in a way that the edits on
  // screen cannot follow. Only a new load saves again.
  const paused = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const burstStart = useRef(0);
  const saving = useRef(false);
  const again = useRef(false);
  const unsaved = useRef(false);
  const attempts = useRef(0);
  // Why the last save left out a script change, if it did.
  const refusal = useRef<string | undefined>(undefined);
  // The outcome of each script change, by its JSON, and the text that the
  // page shows for each script text that the reader typed in.
  const checks = useRef(
    new Map<string, Promise<{ places: number } | { refused: string }>>(),
  );
  const shown = useRef(new Map<string, string>());

  useEffect(() => {
    // A new load drops what the frame showed. When that was not saved, the
    // reader chose to see the saved version.
    if (unsaved.current || paused.current) latest.current.setState("idle");
    base.current = undefined;
    head.current = undefined;
    unsent.current = undefined;
    draft.current = undefined;
    paused.current = false;
    unsaved.current = false;
    refusal.current = undefined;
    checks.current = new Map();
    shown.current = new Map();
    for (const id of [PAUSED_TOAST, REFUSED_TOAST, FAILED_TOAST]) toast.dismiss(id);
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

  // check makes sure once that a script change shows on the page. Without
  // the frame, only a change that was checked before can save.
  const check = useCallback((change: ScriptChange) => {
    const key = JSON.stringify(change);
    let checked = checks.current.get(key);
    if (!checked && !gone.current) {
      checked = checkScriptChange(base.current!, change, latest.current.probe).catch(
        () => ({ refused: "The new text could not be checked." }),
      );
      checks.current.set(key, checked);
    }
    return checked;
  }, []);

  // The local source for what the frame shows: the loaded source with every
  // region, and with each script change that shows on the page. refused
  // tells why a script change is left out.
  const build = useCallback(
    async ({ regions, scripts }: TextEditResult) => {
      const applied = applyRegions(base.current!.tree, regions);
      if ("refused" in applied) throw new Refused(applied.refused);
      let html = applied.html;
      let refused: string | undefined;
      const changes: ScriptSave[] = [];
      for (const change of scripts) {
        const checked = await check(change);
        if (checked && "refused" in checked) refused ??= checked.refused;
        if (!checked || "refused" in checked) continue;
        const written = await writeScriptChange(html, change.before, change.after);
        if (!written) continue;
        html = written;
        const key = JSON.stringify(change.locator);
        const from = shown.current.get(key) ?? change.before;
        changes.push({ key, from, to: change.after, places: checked.places });
      }
      return { html, regions: applied.html, scripts: changes, refused };
    },
    [check],
  );

  // The edits on screen: from the frame, or the last draft without it.
  const edits = useCallback(
    async () => (gone.current ? draft.current : await latest.current.take()),
    [],
  );

  // The save for what the frame shows now, or nothing when it shows what the
  // head holds.
  const next = useCallback(async (): Promise<Save | undefined> => {
    const { source } = await loadBase();
    const result = await edits();
    if (!result) return undefined;
    const built = await build(result);
    refusal.current = built.refused;
    const from = head.current ?? {
      id: latest.current.loaded.version,
      source,
      regions: source,
    };
    const replacements = replacementsBetween(from.source, built.html);
    if (!replacements.length) return undefined;
    const scripts = built.scripts.filter((s) => s.from.trim() !== s.to.trim());
    // A save of script text only says what it changed in words.
    const summary =
      scripts.length && built.regions === from.regions ? describe(scripts) : undefined;
    return {
      html: built.html,
      regions: built.regions,
      body: {
        base_version_id: from.id,
        client_change_id: randomId(),
        replacements,
        change_summary: summary,
      },
      scripts,
    };
  }, [loadBase, edits, build]);

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

  // copy puts the text that the reader typed, as it is now, on the
  // clipboard.
  const copy = useCallback(async () => {
    try {
      const result = await edits();
      await navigator.clipboard.writeText(
        result ? draftText(base.current!, result) : "",
      );
      toast.success("Your text is copied.", { id: COPIED_TOAST });
    } catch {
      toast.error("Could not copy your text.", { id: COPIED_TOAST });
    }
  }, [edits]);
  // The message stays after a copy, so that the reader can still choose.
  const copyAction = useMemo<ExternalToast["action"]>(
    () => ({
      label: "Copy my text",
      onClick: (event) => {
        event.preventDefault();
        void copy();
      },
    }),
    [copy],
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
    // The state after the save, and a load after it, if any.
    let state: SaveState | undefined;
    let load: { version?: string } | undefined;
    try {
      const resent = unsent.current !== undefined;
      const change = (unsent.current ??= await next());
      if (!change) {
        if (refusal.current) state = "refused";
        else if (unsaved.current) state = "saved";
        return;
      }
      setState("saving");
      const saved = await api.editSource(docId, change.body);
      unsent.current = undefined;
      attempts.current = 0;
      onSaved(saved.id, !saved.rebased);
      if (!saved.rebased) {
        head.current = { id: saved.id, source: change.html, regions: change.regions };
        // The frame changed while the save waited to go again.
        again.current ||= resent;
        if (!gone.current) showScripts(change.scripts);
        state = refusal.current ? "refused" : "saved";
      } else if (await shows(change.html)) {
        state = "saved";
        load = { version: saved.id };
      } else {
        state = "paused";
        pause(
          "The document changed elsewhere, so your latest words are on screen but not saved.",
          { action: { label: "Show the latest version", onClick: showLatest } },
        );
      }
    } catch (e) {
      if (e instanceof Refused) {
        state = "refused";
        refusal.current =
          "This edit does not fit the source of the document, so it cannot save.";
      } else if (e instanceof APIError && e.code === "edit_conflict") {
        state = "paused";
        pause(
          "Someone else changed the same text. Your text stays on screen and is not saved.",
          {
            action: copyAction,
            cancel: { label: "Show their version", onClick: showLatest },
          },
        );
      } else if (passing(e)) {
        state = "failed";
        attempts.current++;
        toast.error(
          `Your edits are not saved yet. Trying again (attempt ${attempts.current})…`,
          { id: FAILED_TOAST, action: copyAction },
        );
      } else {
        state = "idle";
        load = {};
        toast.error(
          e instanceof APIError && e.code === "edit_failed"
            ? "Your edit could not be saved. The document now shows the latest version."
            : errorMessage(e, "Your edits could not be saved."),
          { id: FAILED_TOAST },
        );
      }
      if (state !== "failed") unsent.current = undefined;
    } finally {
      saving.current = false;
      if (state) {
        unsaved.current = state !== "saved" && !load;
        setState(state);
      }
      if (state !== "failed") toast.dismiss(FAILED_TOAST);
      if (state === "refused" && !gone.current)
        toast.error(refusal.current, {
          id: REFUSED_TOAST,
          duration: Infinity,
          action: copyAction,
          // The saved version shows the text before the change.
          cancel: {
            label: "Discard my change",
            onClick: () => latest.current.reload(head.current?.id),
          },
        });
      else toast.dismiss(REFUSED_TOAST);
      if (gone.current) load = undefined;
      if (load) reload(load.version);
      else if (state === "failed") later(timer, save, AUTOSAVE_RETRY_MS);
      else if (again.current) later(timer, save, 0);
      again.current = false;
    }
    // showScripts changes the other places of the saved script text in
    // place, and offers to undo the change. An undo puts the text back in
    // every place, which the next save then saves.
    function showScripts(scripts: ScriptSave[]) {
      if (!scripts.length) return;
      const set = (from: "from" | "to", to: "from" | "to") => {
        for (const s of scripts) {
          latest.current.replaceText(s[from], s[to]);
          shown.current.set(s.key, s[to]);
        }
      };
      set("from", "to");
      toast.success(describe(scripts), {
        id: SCRIPT_TOAST,
        action: { label: "Undo", onClick: () => set("to", "from") },
      });
    }
  }, [next, shows, pause, copyAction]);

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

  const drafted = useCallback((result: TextEditResult) => {
    draft.current = result;
  }, []);

  // Save at once when the reader leaves the frame for the page around it, or
  // leaves the page, and warn before an unload loses unsaved edits. When the
  // frame goes, as on a move to another page, its last draft saves.
  useEffect(() => {
    gone.current = false;
    const pending = () => unsaved.current || saving.current || !!timer.current;
    const flush = () => {
      if (timer.current !== undefined) void save();
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    const warn = (e: BeforeUnloadEvent) => {
      if (pending()) e.preventDefault();
    };
    document.addEventListener("pointerdown", flush, true);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("beforeunload", warn);
    return () => {
      document.removeEventListener("pointerdown", flush, true);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("beforeunload", warn);
      const left = pending();
      window.clearTimeout(timer.current);
      timer.current = undefined;
      if (!left) return;
      gone.current = true;
      void save();
    };
  }, [save]);

  return { changed, drafted, scriptEditable };
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

// describe says in words what a save changed in script text.
function describe(scripts: ScriptSave[]): string {
  return scripts
    .map(
      ({ from, to, places }) =>
        `Changed “${from.trim()}” to “${to.trim()}” in ${places} ${places === 1 ? "place" : "places"}`,
    )
    .join(", ");
}

// draftText is the text that the reader typed: the text of each region and
// each script text.
function draftText(base: Base, { regions, scripts }: TextEditResult): string {
  return [regionText(base.tree, regions), ...scripts.map((s) => s.after.trim())]
    .filter(Boolean)
    .join("\n\n");
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
