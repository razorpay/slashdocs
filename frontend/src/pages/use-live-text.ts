import { useCallback, useEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast, type ExternalToast } from "sonner";
import { api, APIError, type Principal } from "@/api";
import { disruption } from "@/lib/disruption";
import { principalLabel, principalNames, samePrincipal } from "@/lib/principals";
import { queryKeys } from "@/lib/queryKeys";
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
import { applyReplacements, merge3 } from "@/lib/source-merge";
import { patchBetween } from "@/lib/source-patch";
import {
  draftText,
  readTextDraft,
  removeTextDraft,
  writeTextDraft,
} from "@/lib/text-drafts";
import { randomId } from "@/lib/uuid";
import type { Patch, ScriptChange } from "../../bridge/source-pieces";
import type { SaveState, TextEditResult, TextPatchResult } from "./doc-context";
import type { DocUpdate } from "./doc-update-banner";

// A pause in typing this long saves the edits, and typing without a pause
// still saves after the longest delay.
const ALONE = { pause: 1500, most: 10_000 };
// With other people in the document the saves are fast, so that those
// people see the text as it comes.
const TOGETHER = { pause: 300, most: 700 };
// A save or a follow that failed for a reason that can pass, such as the
// network, tries again after this long.
const RETRY_MS = 5_000;
// A key that comes between a take and its patch makes the patch stale. The
// patch then goes again, at most this many times.
const PATCH_ATTEMPTS = 4;

const FAILED_TOAST = "autosave-failed";
const REFUSED_TOAST = "autosave-refused";
const COPIED_TOAST = "autosave-copied";
const EARLIER_TOAST = "autosave-earlier";
const APPROVALS_TOAST = "autosave-approvals";

// The edits do not fit the version that the server has.
const UNFIT =
  "This edit does not fit the latest version of the document, so it cannot save.";

// The messages of a save that did not go, by the status of the response.
const SERVER_REFUSALS: Record<number, string> = {
  403: "You can no longer edit this document, so your text cannot save.",
  404: "This document no longer exists, so your text cannot save.",
  413: "This change is too large to save.",
};

// The version that the frame loaded: its source, and the parse of it that
// the regions from the frame and the patches for the frame refer to.
type Base = { source: string; tree: SourceTree };

// The text from one load of the frame to the next. head is the version that
// this client follows. shown is the source that the frame showed for the
// head, with and without script text: what the frame shows more than that
// is not saved.
type Text = {
  base: Base;
  // from is the version that the server made the head on.
  head: { id: string; source: string; from?: string };
  shown: { source: string; regions: string };
  // What turns shown into the head, when the server gave it. The server
  // gives it exactly, also for a change too large for the diff here.
  ahead?: Replacement[];
};

// A script string that a save changes: the text that the page shows for it
// before the save and after it, and the count of places that show it. key
// names the script text that the reader typed in.
type ScriptSave = { key: string; from: string; to: string; places: number };

// One save: the text that it is for, the source that the frame showed, the
// source that it makes, and the request. A request that failed for a reason
// that can pass goes again as it is, so that the server can tell that it is
// the same save.
type Save = {
  text: Text;
  now: Text["shown"];
  target: string;
  body: Parameters<typeof api.editSource>[1];
  scripts: ScriptSave[];
};

// The edits cannot be written into the source.
class Refused extends Error {}

// The source of the loaded version did not load, so no edit can be written
// into it yet. It says nothing about the save, so it loads again.
class Unread extends Error {}

// useLiveText keeps the rendered document and the server together, for
// readers and editors. save sends what the editor typed as replacements by
// position, and the server merges them with the changes of other people.
// follow gets the changes from the head to the newest version. patch shows
// them in the frame in place, around the text that the editor types. It
// returns the functions to call on each change in the frame and on each
// draft that the frame sends.
export function useLiveText(options: {
  docId: string;
  // The version the frame loaded, and which load it is. A new load starts
  // over from that version.
  loaded: { version: string; load: number };
  // The newest version of the document, when the page knows it.
  latest?: string;
  // The frame is ready and follows the newest version. A preview does not.
  live: boolean;
  // Other people have the document open.
  others: boolean;
  take: () => Promise<TextEditResult>;
  // Changes the frame in place, for the count of edits of the last take.
  patch: (patches: Patch[], edits: number, flash: boolean) => Promise<TextPatchResult>;
  setState: (state: SaveState) => void;
  // The frame shows this version, so the page moves to it without a load.
  // The server made it on top of the version from.
  move: (versionID: string, from?: string) => void;
  // Loads a version, or else the latest one, in place of what is on screen.
  reload: (versionID?: string) => void;
  // Shows the banner for a change that waits for the reader, or removes it.
  holdUpdate: (update?: DocUpdate) => void;
  // Renders a source in a probe frame, to make sure that a script change
  // shows.
  probe: Render;
  // Changes the script text that the page shows in every place, as a load
  // of the saved source would.
  replaceText: (from: string, to: string) => void;
}) {
  const { loaded, latest, live } = options;
  const opts = useRef(options);
  opts.current = options;
  const q = useQueryClient();
  // Unset until the source of the loaded version loads.
  const text = useRef<Text | undefined>(undefined);
  const unsent = useRef<Save | undefined>(undefined);
  // The latest edits from the frame. They save when the frame goes before
  // it could save them, and stay in storage while they cannot save.
  const draft = useRef<TextEditResult | undefined>(undefined);
  // Set while storage holds the draft of this visit.
  const kept = useRef(false);
  // Set when the frame went away: saves use the draft, and say nothing.
  const gone = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const retry = useRef<number | undefined>(undefined);
  const burstStart = useRef(0);
  // Set while a save or a follow runs: one runs at a time. A save (again)
  // and a follow (asked) that were asked for meanwhile start when the run
  // ends, the save first.
  const busy = useRef(false);
  const again = useRef(false);
  const asked = useRef(false);
  // Called when the run on its way ends.
  const waiting = useRef<(() => void)[]>([]);
  // Set when the frame cannot show the head in place. It loads the head
  // once the text on screen is saved.
  const stale = useRef(false);
  const unsaved = useRef(false);
  const attempts = useRef(0);
  // Why the last save left out a change, if it did.
  const refusal = useRef<string | undefined>(undefined);
  // Shows again the message of edits that cannot save, with its choices.
  const problem = useRef<(() => void) | undefined>(undefined);
  // The outcome of each script change, by its JSON, and the text that the
  // page shows for each script text that the reader typed in.
  const checks = useRef(
    new Map<string, Promise<{ places: number } | { refused: string }>>(),
  );
  const written = useRef(new Map<string, Pick<ScriptSave, "to" | "places">>());
  // Set when the document has approvers, whose approvals an edit resets.
  const reviewed = useRef(false);
  reviewed.current = !!useQuery({
    queryKey: queryKeys.document(options.docId),
    queryFn: () => api.getDocument(options.docId),
  }).data?.approval_status;
  // The version whose approvers the editor was told about.
  const noted = useRef<string | undefined>(undefined);
  // save and follow start each other, so each one starts through this.
  const run = useRef({ save: async () => {}, follow: async () => {} });

  // keep puts the draft in storage, so that it outlives the page while it
  // cannot save. forget removes it when it saved or the reader dropped it.
  const keep = useCallback(() => {
    const { docId, loaded } = opts.current;
    if (!draft.current) return;
    kept.current = true;
    writeTextDraft(docId, { version: loaded.version, edits: draft.current });
  }, []);
  const forget = useCallback(() => {
    if (kept.current) removeTextDraft(opts.current.docId);
    kept.current = false;
  }, []);

  useEffect(() => {
    // A new load drops what the frame showed. When that was not saved, the
    // reader chose to see the saved version.
    if (unsaved.current) opts.current.setState("idle");
    text.current = undefined;
    unsent.current = undefined;
    draft.current = undefined;
    again.current = asked.current = stale.current = false;
    unsaved.current = false;
    refusal.current = undefined;
    problem.current = undefined;
    checks.current = new Map();
    written.current = new Map();
    forget();
    opts.current.holdUpdate(undefined);
    for (const id of [REFUSED_TOAST, FAILED_TOAST]) toast.dismiss(id);
  }, [loaded, forget]);

  // Text that did not save on an earlier visit. The reader copies it to add
  // it again, or discards it.
  const { docId } = options;
  useEffect(() => {
    const earlier = readTextDraft(docId);
    if (!earlier) return;
    toast.error("You have text in this document that was not saved.", {
      id: EARLIER_TOAST,
      duration: Infinity,
      action: copyAction(async () =>
        draftText(
          (await readBase(docId, earlier.version).catch(() => undefined))?.tree,
          earlier.edits,
        ),
      ),
      cancel: {
        label: "Discard my change",
        // Storage may hold the draft of this visit by now.
        onClick: () => {
          if (readTextDraft(docId)?.updatedAt === earlier.updatedAt)
            removeTextDraft(docId);
        },
      },
    });
    return () => void toast.dismiss(EARLIER_TOAST);
  }, [docId]);

  // The text of this load of the frame. It starts at the loaded version.
  const load = useCallback(async (): Promise<Text> => {
    const { docId, loaded } = opts.current;
    if (text.current) return text.current;
    const base = await readBase(docId, loaded.version).catch((cause) => {
      throw new Unread("", { cause });
    });
    // A new load of the frame came first.
    if (opts.current.loaded !== loaded) throw new Unread();
    const { source } = base;
    return (text.current ??= {
      base,
      head: { id: loaded.version, source },
      shown: { source, regions: source },
    });
  }, []);
  // Whether the frame still shows the load that an operation started on.
  const here = (at: Text) => !gone.current && text.current === at;
  // Whether the frame holds text that is not saved, or that a save waits for.
  const pending = () => unsaved.current || timer.current !== undefined;

  // The approvers whose approval counts on a version. Without them, the
  // messages say nothing about approvals.
  const approvedOn = useCallback(async (version: string): Promise<Principal[]> => {
    if (!reviewed.current) return [];
    try {
      const { items } = await api.listApprovals(opts.current.docId, version);
      return items.filter((i) => i.decision === "approved").map((i) => i.approver);
    } catch {
      return [];
    }
  }, []);

  // Before the first key on an approved version, the editor learns that a
  // change asks its approvers to approve again. They learn it once for each
  // version that has approvals.
  const focused = useCallback(async () => {
    const version = text.current?.head.id ?? opts.current.loaded.version;
    if (noted.current === version) return;
    noted.current = version;
    const approvers = await approvedOn(version);
    if (approvers.length)
      toast.info(`Your change asks ${principalNames(approvers)} to approve again.`, {
        id: APPROVALS_TOAST,
      });
  }, [approvedOn]);

  // Whether the reader can type in script text: when one string of the
  // loaded source holds it.
  const scriptEditable = useCallback(
    async (typed: string): Promise<boolean> =>
      (await findLiterals((await load()).base.source, typed)).length === 1,
    [load],
  );

  // check makes sure once that a script change shows on the page. Without
  // the frame, only a change that was checked before can save.
  const check = useCallback((change: ScriptChange) => {
    const key = JSON.stringify(change);
    let checked = checks.current.get(key);
    if (!checked && !gone.current) {
      checked = checkScriptChange(text.current!.base, change, opts.current.probe).catch(
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
      const applied = applyRegions(text.current!.base.tree, regions);
      if ("refused" in applied) throw new Refused(applied.refused);
      let html = applied.html;
      let refused: string | undefined;
      const changes: ScriptSave[] = [];
      for (const change of scripts) {
        const key = JSON.stringify(change.locator);
        const last = written.current.get(key);
        // Text typed back to its loaded text writes nothing into the source,
        // but its other places still show the last save.
        if (change.before.trim() === change.after.trim()) {
          if (last)
            changes.push({ key, from: last.to, to: change.after, places: last.places });
          continue;
        }
        const checked = await check(change);
        if (checked && "refused" in checked) refused ??= checked.refused;
        if (!checked || "refused" in checked) continue;
        const done = await writeScriptChange(html, change.before, change.after);
        if (!done) continue;
        html = done;
        const from = last?.to ?? change.before;
        changes.push({ key, from, to: change.after, places: checked.places });
      }
      return { html, regions: applied.html, scripts: changes, refused };
    },
    [check],
  );

  // The edits on screen: from the frame, or the last draft without it.
  const edits = useCallback(async () => {
    if (!gone.current) draft.current = await opts.current.take();
    return draft.current;
  }, []);

  // The save for what the frame shows now, or nothing when the head holds
  // it. Between a save that the server merged and its patch, the frame does
  // not show the head: the text typed since then merges into the head here,
  // as it does on the server.
  const next = useCallback(async (): Promise<Save | undefined> => {
    const at = await load();
    const result = await edits();
    if (!result) return undefined;
    const built = await build(result);
    refusal.current = built.refused;
    const { head, shown } = at;
    const now = { source: built.html, regions: built.regions };
    const target =
      shown.source === head.source
        ? now.source
        : merge3(shown.source, now.source, at.ahead ?? head.source);
    const replacements = replacementsBetween(head.source, target);
    if (!replacements.length) {
      at.shown = now;
      return undefined;
    }
    const scripts = built.scripts.filter((s) => s.from.trim() !== s.to.trim());
    // A save of script text only says what it changed in words.
    const summary =
      scripts.length && now.regions === shown.regions ? describe(scripts) : undefined;
    return {
      text: at,
      now,
      target,
      body: {
        base_version_id: head.id,
        client_change_id: randomId(),
        replacements,
        change_summary: summary,
      },
      scripts,
    };
  }, [load, edits, build]);

  // Copies the text that the reader typed, as it is now.
  const copyTyped = useMemo(
    () =>
      copyAction(async () => {
        const result = await edits();
        return result ? draftText(text.current?.base.tree, result) : "";
      }),
    [edits],
  );

  // tell gives the state of the edits on screen to the page. Edits that are
  // not saved stay in storage, and edits that cannot save show why, with the
  // choices, until the reader acts on them.
  const tell = useCallback(
    (state: SaveState) => {
      unsaved.current = state !== "saved" && state !== "idle";
      opts.current.setState(state);
      if (unsaved.current) keep();
      else forget();
      if (state !== "failed") toast.dismiss(FAILED_TOAST);
      problem.current = undefined;
      if (state !== "refused" || gone.current) return void toast.dismiss(REFUSED_TOAST);
      const message = refusal.current;
      problem.current = () =>
        toast.error(message, {
          id: REFUSED_TOAST,
          duration: Infinity,
          action: copyTyped,
          // The saved version shows the text before the change.
          cancel: {
            label: "Discard my change",
            onClick: () => opts.current.reload(text.current?.head.id),
          },
        });
      problem.current();
    },
    [keep, forget, copyTyped],
  );

  // release ends a run. The save that waits goes first, after wait when the
  // run failed, and then the follow.
  const release = useCallback((wait?: number) => {
    busy.current = false;
    for (const done of waiting.current.splice(0)) done();
    if (wait !== undefined || again.current) later(timer, run.current.save, wait ?? 0);
    else if (asked.current) void run.current.follow();
    again.current = false;
  }, []);

  // leave loads a version in the frame, in place of what is on screen. What
  // waits is about the frame that goes.
  const leave = useCallback((version?: string) => {
    again.current = asked.current = false;
    opts.current.reload(version);
  }, []);

  const save = useCallback(async (): Promise<void> => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    burstStart.current = 0;
    if (busy.current) {
      again.current = true;
      return;
    }
    const { docId, setState, move } = opts.current;
    busy.current = true;
    // The state after the save, and whether no text waits for a save.
    let state: SaveState | undefined;
    let done = false;
    try {
      const resent = unsent.current !== undefined;
      const change = (unsent.current ??= await next());
      if (!change) {
        // The edits went back to what is saved: there is no new version.
        if (refusal.current) state = "refused";
        else if (unsaved.current)
          state =
            text.current?.head.id === opts.current.loaded.version ? "idle" : "saved";
      } else {
        setState("saving");
        const approved = approvedOn(change.body.base_version_id);
        const saved = await api.editSource(docId, change.body);
        const at = change.text;
        const { now, target } = change;
        // The new version is the head. When it also holds changes of other
        // people, the answer names them, and the follow shows them. The text
        // typed after this save is then a change to that version. The save
        // goes again, and gets the same answer, until its source is known.
        const merged = saved.rebased
          ? ((saved.others && applyReplacements(target, saved.others)) ??
            (await api.getVersionHTML(docId, saved.id)))
          : target;
        unsent.current = undefined;
        attempts.current = 0;
        at.shown = now;
        at.head = { id: saved.id, source: merged, from: saved.base_version_id };
        at.ahead = target === now.source ? saved.others : undefined;
        if (here(at) && merged === now.source) move(saved.id, saved.base_version_id);
        // The frame changed while the save waited to go again.
        again.current ||= resent;
        state = refusal.current ? "refused" : "saved";
        if (!gone.current)
          void afterSave(change.scripts, approvalsChange(approved, saved.id));
      }
      // A newer version that waited for this save can go into the frame.
      done = asked.current = true;
    } catch (e) {
      if (e instanceof Refused) {
        state = "refused";
        refusal.current =
          "This edit does not fit the source of the document, so it cannot save.";
      } else if (e instanceof Unread || passing(e)) {
        state = "failed";
        attempts.current++;
        const why =
          e instanceof Unread
            ? "The saved version of this document did not load, so your edits are not saved yet."
            : "Your edits are not saved yet.";
        toast.error(`${why} Trying again (attempt ${attempts.current})…`, {
          id: FAILED_TOAST,
          action: copyTyped,
          cancel: { label: "Try now", onClick: () => void run.current.save() },
        });
      } else {
        // The server refused the save, and saving again cannot help. The
        // text stays on screen until the reader copies or discards it.
        const { code, status } = e as APIError;
        state = "refused";
        refusal.current =
          code === "edit_failed"
            ? UNFIT
            : (SERVER_REFUSALS[status] ??
              "The server did not take this change, so it cannot save.");
      }
      if (state !== "failed") unsent.current = undefined;
    } finally {
      if (state) tell(state);
      // The frame never loads while it holds text that is not saved.
      const at = text.current;
      if (done && stale.current && at && !gone.current && !again.current && !pending())
        leave(at.head.id);
      release(state === "failed" ? RETRY_MS : undefined);
    }
    // afterSave changes the other places of saved script text in place, as
    // a load of the saved source would. A save that resets approvals, or
    // gives them back, says so, as it is about more than the words.
    async function afterSave(scripts: ScriptSave[], approvals: Promise<string>) {
      for (const s of scripts) {
        opts.current.replaceText(s.from, s.to);
        written.current.set(s.key, { to: s.to, places: s.places });
      }
      const note = await approvals;
      if (note) toast.info(note, { id: APPROVALS_TOAST });
    }
    // approvalsChange says whose approvals a save reset or gave back.
    async function approvalsChange(before: Promise<Principal[]>, version: string) {
      const [was, now] = await Promise.all([before, approvedOn(version)]);
      const without = (a: Principal[], b: Principal[]) =>
        a.filter((p) => !b.some((q) => samePrincipal(p, q)));
      return [
        approvalsText(without(was, now), "reset"),
        approvalsText(without(now, was), "restored"),
      ]
        .filter(Boolean)
        .join(" ");
    }
  }, [next, tell, leave, release, copyTyped, approvedOn]);

  // The delays of a save: short with other people in the document.
  const pace = () => (opts.current.others ? TOGETHER : ALONE);

  // Each change waits for a pause in typing, but no longer than the longest
  // delay since the first change of the burst.
  const changed = useCallback(
    (count: number) => {
      if (count > 0) {
        unsaved.current = true;
        opts.current.setState("unsaved");
      }
      const { pause, most } = pace();
      const now = Date.now();
      burstStart.current ||= now;
      later(timer, save, Math.min(pause, burstStart.current + most - now));
    },
    [save],
  );

  // patch shows the head in the frame in place: the changes of other people
  // go around the text that the reader typed since the last save. The frame
  // answers with what it shows then, and only the exact target counts. When
  // the frame cannot show the head in place, it loads the head after the
  // text on screen saves.
  const patch = useCallback(
    async (at: Text, flash: boolean): Promise<void> => {
      const { base, head, shown } = at;
      // Set while the frame can hold a patch that it did not answer for.
      let sent: string | undefined;
      // The frame shows a source that is not the target. That source stands
      // for the target from now on, so that the patch never becomes an edit
      // of the reader. The text that the reader typed before the patch is
      // in the target, and saves from it.
      const spoil = (now: Text["shown"], target: string) => {
        if (target === head.source) at.shown = now;
        else
          unsent.current = {
            text: at,
            now,
            target,
            body: {
              base_version_id: head.id,
              client_change_id: randomId(),
              replacements: replacementsBetween(head.source, target),
            },
            scripts: [],
          };
        at.ahead = undefined;
      };
      try {
        for (let attempt = 0; attempt < PATCH_ATTEMPTS; attempt++) {
          const taken = (draft.current = await opts.current.take());
          let now = await build(taken);
          const target =
            now.html === shown.source
              ? head.source
              : merge3(shown.source, now.html, at.ahead ?? head.source);
          if (now.html !== target) {
            const wanted = patchBetween(base.tree, target);
            if ("reload" in wanted) break;
            // The frame already shows the patches of the text that it holds.
            const there = patchBetween(base.tree, now.html);
            const patches = wanted.patches.filter(
              (p) =>
                !("patches" in there && there.patches.some((q) => samePatch(p, q))),
            );
            sent = target;
            const result = await opts.current.patch(patches, taken.edits, flash);
            sent = undefined;
            if (!here(at)) return;
            // A key came between: the patch changed nothing. Typing that
            // does not stop gets the patch at its next pause.
            if (result.stale) {
              if (attempt + 1 === PATCH_ATTEMPTS)
                return later(retry, run.current.follow, pace().pause);
              continue;
            }
            if (!result.ok) break;
            draft.current = result;
            now = await build(result);
            if (now.html !== target) {
              spoil({ source: now.html, regions: now.regions }, target);
              break;
            }
          }
          at.shown = { source: head.source, regions: now.regions };
          at.ahead = undefined;
          opts.current.move(head.id, head.from);
          opts.current.holdUpdate(undefined);
          // The frame holds text that is not saved.
          if (target !== head.source) changed(1);
          return;
        }
      } catch {
        // The frame did not answer, or its text does not fit the source.
        if (!here(at)) return;
        if (sent !== undefined) {
          const now = await opts.current
            .take()
            .then(build)
            .catch(() => undefined);
          if (now) spoil({ source: now.html, regions: now.regions }, sent);
        }
      }
      stale.current = again.current = true;
    },
    [build, changed],
  );

  // follow brings the frame to the newest version. It first shows a head
  // that a save made, and then asks the server for the changes since the
  // head. A large change that is not live typing waits behind a banner
  // while the reader has no text of their own in the frame, and the head
  // stays, so that the next follow asks for the whole difference again.
  // Each other change goes into the frame in place.
  const follow = useCallback(async (): Promise<void> => {
    window.clearTimeout(retry.current);
    const { docId, loaded, latest, live, holdUpdate } = opts.current;
    if (gone.current || !live || stale.current) return;
    if (busy.current) {
      asked.current = true;
      return;
    }
    asked.current = false;
    const lags = (at = text.current) => !!at && at.shown.source !== at.head.source;
    if (!lags() && (!latest || latest === (text.current?.head.id ?? loaded.version)))
      return;
    busy.current = true;
    try {
      const at = await load();
      // A save that waits to go again is for this head. Its end comes back
      // here.
      if (unsent.current) return;
      if (lags(at)) await patch(at, false);
      if (!here(at) || lags(at) || !latest || latest === at.head.id) return;
      const { base, head, shown } = at;
      const changes = await api.documentChanges(docId, head.id);
      if (!here(at) || changes.version_id === head.id) return;
      const next = applyReplacements(head.source, changes.replacements);
      if (next === undefined) {
        // This client and the server do not agree about the head.
        if (!pending() && !again.current) return leave(latest);
        refusal.current = UNFIT;
        return tell("refused");
      }
      const waits =
        !changes.live &&
        !pending() &&
        !again.current &&
        disruption(base.tree.parse(head.source), next).disruptive;
      // The frame is read only now, because few changes wait.
      if (waits && (await build(await opts.current.take())).html === shown.source)
        return holdUpdate({ authors: changes.authors });
      at.head = { id: changes.version_id, source: next, from: head.id };
      at.ahead = changes.replacements;
      await patch(at, !changes.live);
    } catch (e) {
      if (denied(e)) void q.invalidateQueries({ queryKey: queryKeys.document(docId) });
      else later(retry, follow, RETRY_MS);
    } finally {
      release();
    }
  }, [q, load, build, patch, tell, leave, release]);
  run.current = { save, follow };

  // The page learned of a newer version, or the frame is ready for one.
  useEffect(() => void follow(), [follow, latest, live, loaded]);

  const drafted = useCallback(
    (result: TextEditResult) => {
      draft.current = result;
      if (kept.current) keep();
    },
    [keep],
  );

  // Save at once when the reader leaves the frame for the page around it, or
  // leaves the page, and warn before an unload loses unsaved edits. When the
  // frame goes, as on a move to another page, its last draft saves.
  useEffect(() => {
    gone.current = false;
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
      // The draft in storage outlives the message about it.
      if (kept.current) toast.dismiss(REFUSED_TOAST);
      const left = pending();
      window.clearTimeout(timer.current);
      timer.current = undefined;
      gone.current = true;
      if (left) void save();
    };
  }, [save]);

  // settle saves the edits on screen at once, after the run on its way, and
  // tells whether all of them are saved. A save that fails says why, as
  // any save does. Edits that cannot save say why again, with the choices.
  const settle = useCallback(async (): Promise<boolean> => {
    // A save can wait for a follow, and a follow can leave text to save.
    for (let round = 0; round < 3 && !attempts.current; round++) {
      while (busy.current)
        await new Promise<void>((done) => waiting.current.push(done));
      if (timer.current === undefined) break;
      await save();
    }
    if (unsaved.current) problem.current?.();
    return !unsaved.current;
  }, [save]);

  return { changed, drafted, scriptEditable, focused, settle };
}

// copyAction puts text that the reader typed on the clipboard. The message
// stays after a copy, so that the reader can still choose.
function copyAction(text: () => Promise<string>): ExternalToast["action"] {
  return {
    label: "Copy my text",
    onClick: (event) => {
      event.preventDefault();
      void copy(text);
    },
  };
}

async function copy(text: () => Promise<string>) {
  try {
    await navigator.clipboard.writeText(await text());
    toast.success("Your text is copied.", { id: COPIED_TOAST });
  } catch {
    toast.error("Could not copy your text.", { id: COPIED_TOAST });
  }
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
// frame that did not answer, a server that is busy or failed, or a race
// with other saves that the server lost.
function passing(e: unknown): boolean {
  return (
    !(e instanceof APIError) ||
    e.status >= 500 ||
    [408, 429].includes(e.status) ||
    e.code === "version_conflict"
  );
}

// denied reports that the reader cannot read the document: it is gone, or
// their access to it is.
function denied(e: unknown): boolean {
  const error = e instanceof Unread ? e.cause : e;
  return error instanceof APIError && [403, 404].includes(error.status);
}

const samePatch = (a: Patch, b: Patch) =>
  a.in === b.in && a.after === b.after && a.before === b.before && a.html === b.html;

// describe says in words what a save changed in script text.
function describe(scripts: ScriptSave[]): string {
  return scripts
    .map(
      ({ from, to, places }) =>
        `Changed “${from.trim()}” to “${to.trim()}” in ${places} ${places === 1 ? "place" : "places"}`,
    )
    .join(", ");
}

// approvalsText says that the approvals of people are reset or restored.
function approvalsText(people: Principal[], change: "reset" | "restored") {
  if (!people.length) return "";
  return people.length === 1
    ? `The approval of ${principalLabel(people[0])} is ${change}.`
    : `${people.length} approvals are ${change}.`;
}
