import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  api,
  APIError,
  currentVersionID,
  type DocumentChanges,
  type DocumentEvent,
  type Principal,
} from "@/api";
import { queryKeys } from "@/lib/queryKeys";
import { findLiterals, type Render } from "@/lib/script-literals";
import { applyOps, sumOf } from "@/lib/source-merge";
import { patchBetween } from "@/lib/source-patch";
import { draftText, removeTextDraft, writeTextDraft } from "@/lib/text-drafts";
import type { Patch } from "../../bridge/source-pieces";
import type { SaveState, TextEditResult, TextPatchResult } from "./doc-context";
import type { DocUpdate } from "./doc-update-banner";
import {
  apart,
  applied,
  cancel,
  denied,
  draftOf,
  drop,
  enter,
  expire,
  failure,
  fromFrame,
  gone,
  hidden,
  lags,
  lose,
  Lost,
  newLoad,
  open,
  outdated,
  over,
  pending,
  release,
  removed,
  request,
  signedOut,
  stage,
  TIMERS,
  Unread,
  unsaved,
  type Load,
  type Loads,
  type Op,
  type Patched,
  type Screen,
  type Text,
  type Timer,
} from "./live-load";
import {
  describe,
  outsideAfter,
  screenOf,
  stringPatches,
  without,
} from "./live-screen";
import { useApprovalNotes } from "./use-approval-notes";
import { copyAction } from "./use-earlier-draft";

// A change in the frame goes to the server after this long, so that the
// events of one key are one operation. It is too short to see.
const BURST_MS = 50;
// A send or a follow that failed for a reason that can pass, such as the
// network, tries again after this long.
const RETRY_MS = 5_000;
// Sends that fail go again by themselves, so the bar says nothing at first.
// It says that the text is not saved when they fail for this long.
const FAILED_SIGN_MS = 10_000;
// A key that comes between a take and its patch makes the patch stale. The
// patch then goes again, at most this many times, and after that when the
// keys stopped for a moment.
const PATCH_ATTEMPTS = 4;
const STALE_MS = 300;
// While a change waits behind the banner, the frame is asked about it again
// after the reader scrolled, at most once in this time.
const ASK_MS = 1_000;

const REFUSED_TOAST = "live-text-refused";

// The edits do not fit the document that the server has, or its source.
const UNFIT = "This edit no longer fits the document, so it cannot save.";

// The messages of an operation that the server refused, by the status of
// the response, and for another status.
const SERVER_REFUSALS: Record<number, string> = {
  403: "You can no longer edit this document, so your text cannot save.",
  404: "This document no longer exists, so your text cannot save.",
  413: "This change is too large to save.",
};
const REFUSED = "The server did not take this change, so it cannot save.";

// useLiveText keeps the rendered document and the server together, for
// readers and editors. There is no save step: send gives what the editor
// typed to the server at once, as one operation of replacements by position,
// and the server merges it with the changes of other people. While one
// operation is on its way, the next changes wait and go as one. follow gets
// the changes after the head. patch shows them in the frame in place, around
// the text that the editor types. The states of a load are at the top of
// live-load.ts. The hook returns the functions to call on what the frame
// tells, and those that the page calls for the reader.
export function useLiveText(options: {
  docId: string;
  // The principal of the reader. Storage keeps their text as theirs, and
  // keeps nothing for a reader with no principal.
  owner?: string;
  // Takes the reader to sign in. It is there when the reader is signed out.
  signIn?: () => void;
  // What the frame loaded: the version, the seq of the document that it
  // shows, and the URL, which each load of the frame has its own. A new
  // load starts over from there. A server with no live documents gives no
  // seq: nothing is sent or followed then.
  loaded: { version: string; seq?: number; url?: string };
  // The newest seq of the document, when the page knows it.
  latest?: number;
  // The last event of the document. It can hold a small operation, which
  // then needs no request.
  event?: DocumentEvent;
  // The frame is ready and follows the live document. A preview does not.
  live: boolean;
  // Edit mode: the reader can type in the frame.
  editing: boolean;
  // The page of the document is there. It stays when the frame mounts
  // again, as full screen does, and this hook ends then.
  onPage: { readonly current: boolean };
  // The loads that the page answers for. They outlive this hook.
  loads: Loads;
  take: () => Promise<TextEditResult>;
  // Changes the frame in place, for the count of edits of the last take.
  // With ask, the frame holds a change that would change much of what the
  // reader sees, and changes nothing.
  patch: (
    patches: Patch[],
    edits: number,
    flash: boolean,
    ask: boolean,
  ) => Promise<TextPatchResult>;
  setState: (state: SaveState) => void;
  // Holds the cursor of the reader while the server does not hold all of
  // their text: a cursor names a place in that text, which other people do
  // not have yet. The server relays an operation before it answers it.
  holdCursor: (held: boolean) => void;
  // The frame shows the document at this seq, which this version holds. It
  // shows no seq that the page can follow while it loads, and in a preview.
  frameShows: (seq: number | undefined, versionID: string) => void;
  // Loads the document in the frame again, in place of what is on screen.
  reload: () => void;
  // Shows the banner for a change that waits for the reader, or removes it.
  holdUpdate: (update?: DocUpdate) => void;
  // The people who made the changes that are not typing after a seq, up to
  // another one, or none when the page knows of no change there (see
  // useTypists).
  madeBy: (after: number, upto: number) => Principal[] | undefined;
  // Renders a source in a probe frame: a script change must show there.
  probe: Render;
  // Changes the script text that the page shows in every place, as a load
  // of the saved source would.
  replaceText: (from: string, to: string) => void;
}) {
  const { docId, loaded, latest, live, editing, event, signIn } = options;
  const opts = useRef(options);
  opts.current = options;
  const q = useQueryClient();
  // The load of the frame. Each load of the frame makes a new one (see
  // below). The first one stands in until then: it is not on the page, and
  // holds no lock.
  const [first] = useState(newLoad);
  const load = useRef(first);
  const { beforeEdit, afterEdit } = useApprovalNotes(docId);

  // send and follow start work again after a time, through this. wait
  // starts it for one of the timers of a load, after due makes the change
  // that the end of the time makes. A page that went tries nothing again.
  const run = useRef<(s: Load) => Promise<void>>(async () => {});
  const wait = useCallback((s: Load, timer: Timer, delay: number, due?: () => void) => {
    cancel(s, timer);
    s.timers[timer] = window.setTimeout(() => {
      delete s.timers[timer];
      if (!opts.current.onPage.current) return;
      due?.();
      void run.current(s);
    }, delay);
  }, []);

  // forget takes the draft of a load out of storage.
  const forget = useCallback((s: Load) => {
    const { docId, owner } = opts.current;
    if (s.kept && owner) removeTextDraft(owner, docId, s.id);
    s.kept = false;
  }, []);
  // Whether the frame can hold text of the reader: they are in Edit mode,
  // or they typed in this load of the frame. What a frame shows while
  // changes wait behind the banner is never an edit.
  const writes = useCallback(
    (s: Load) => !s.text?.held && (opts.current.editing || !!s.draft?.edits),
    [],
  );
  // keep makes storage follow what the server may not hold of a load, so
  // that it outlives the page (see draftOf).
  const keep = useCallback(
    (s: Load) => {
      const { docId, owner } = opts.current;
      if (!owner) return;
      s.kept = true;
      const draft = draftOf(s, writes(s));
      if (draft) writeTextDraft(owner, docId, s.id, draft);
      else removeTextDraft(owner, docId, s.id);
    },
    [writes],
  );

  // Whether the frame does not show the newest state of the document that
  // the page knows.
  const behind = useCallback((s: Load) => {
    const { latest = 0, event } = opts.current;
    const newest = Math.max(latest, event?.seq ?? 0);
    return (
      s.sync === "lost" || lags(s.text) || newest > (s.text?.head.seq ?? s.seq ?? 0)
    );
  }, []);

  // read gives the text of a load of the frame. It starts at the loaded
  // seq, with the loaded source, which is read once.
  const read = useCallback(async (s: Load): Promise<Text> => {
    try {
      return (
        s.text ??
        (await (s.reading ??= open(s, opts.current.docId).finally(
          () => (s.reading = undefined),
        )))
      );
    } catch (cause) {
      throw new Unread("", { cause });
    }
  }, []);

  // recover gives the text of a load with a head that this client knows.
  // When this client lost the head, the live document is the new head, with
  // no operations that lead to it: the text that the frame holds then
  // merges into it from the two sources. It changes the head, so only the
  // work, which sends and follows from the head, calls it.
  const recover = useCallback(
    async (s: Load): Promise<Text> => {
      const at = await read(s);
      if (s.sync !== "lost") return at;
      const { docId } = opts.current;
      try {
        const version = currentVersionID(await api.getDocument(docId));
        const { source, seq } = await api.versionSource(docId, version);
        if (seq === undefined) throw new Unread();
        at.head = { seq, version, source };
        at.ahead = undefined;
        s.sync = "unsure";
        return at;
      } catch (cause) {
        throw new Unread("", { cause });
      }
    },
    [read],
  );

  // Whether the reader can type in script text: when one string of the
  // loaded source holds it.
  const scriptEditable = useCallback(
    async (typed: string): Promise<boolean> =>
      (await findLiterals((await read(load.current)).base.source, typed)).length === 1,
    [read],
  );

  // The screen for edits of the frame (see screenOf).
  const build = useCallback(
    (s: Load, taken: TextEditResult) => screenOf(s, taken, opts.current.probe),
    [],
  );

  // The edits on screen: of the frame, or the last draft when it went.
  const edits = useCallback(
    async (s: Load) => {
      if (!gone(s))
        s.draft = await fromFrame(s, opts.current.take()).catch((e) => {
          // The frame went before it gave them.
          if (!gone(s)) throw e;
          return s.draft;
        });
      if (s.kept) keep(s);
      return s.draft;
    },
    [keep],
  );

  // compose makes the operation that turns the head into the document with
  // the text of the frame, or nothing when the head holds that text. It
  // makes nothing for a frame that cannot hold text of the reader: what such
  // a frame shows other than the head is never an edit.
  const compose = useCallback(
    async (s: Load): Promise<Op | undefined> => {
      s.dirty = false;
      const at = await recover(s);
      if (s.unwritable) return undefined;
      const taken = await edits(s);
      if (!taken || !writes(s)) return undefined;
      const { scripts, refused, ...screen } = await build(s, taken);
      s.refusal = refused;
      const target = over(at, screen.source).source;
      const changed = scripts.filter((c) => c.from.trim() !== c.to.trim());
      // An operation on script text only says what it changed in words.
      const words = changed.length > 0 && screen.regions === at.shown.regions;
      const body = request(s, target, words ? describe(changed) : undefined);
      return body && stage(s, { screen, target, body, scripts });
    },
    [recover, edits, build, writes],
  );

  // show tells the page whether the server holds the text of its loads.
  // Sends that fail go again by themselves, so the page says that the text
  // is not saved only when they fail for FAILED_SIGN_MS. Text that cannot
  // save says why, with the choices, until the reader acts on it. A reader
  // who discards the text gets the document again, without it: nothing of
  // it goes to the server or stays in storage. Only the hook of a frame
  // that shows the text can load that frame again, so a hook leaves the
  // message of a load of another hook as it is.
  const show = useCallback(() => {
    const { loads, onPage, setState, holdCursor } = opts.current;
    if (!onPage.current) return;
    const all = [...loads.all];
    const refused = all.find((s) => s.refusal);
    if (!all.some((s) => s.failing)) {
      window.clearTimeout(loads.sign);
      loads.sign = undefined;
      loads.late = false;
    } else
      loads.sign ??= window.setTimeout(() => {
        loads.late = true;
        show();
      }, FAILED_SIGN_MS);
    setState(refused ? "refused" : loads.late ? "failed" : "idle");
    holdCursor(all.some(pending));
    if (!refused) return void toast.dismiss(REFUSED_TOAST);
    if (!gone(refused) && refused !== load.current) return;
    toast.error(refused.refusal, {
      id: REFUSED_TOAST,
      duration: Infinity,
      action: copyAction(async () => {
        const result = await edits(refused);
        return result ? draftText(refused.text?.base.tree, result) : "";
      }),
      cancel: {
        label: "Discard my change",
        onClick: () => {
          refused.dirty = false;
          refused.unsent = refused.refusal = undefined;
          forget(refused);
          if (gone(refused)) drop(loads, refused);
          else {
            refused.frame = "reloading";
            opts.current.reload();
          }
          show();
        },
      },
    });
  }, [edits, forget]);

  // report keeps the text of a load in storage while the server does not
  // hold it, and tells the page. Storage takes it when its send failed, and
  // follows it once it holds it. A load that ended leaves the page when the
  // server holds its text.
  const report = useCallback(
    (s: Load) => {
      if (s.refusal || s.failing || (s.kept && pending(s))) keep(s);
      else if (!pending(s)) forget(s);
      if (gone(s) && !unsaved(s)) drop(opts.current.loads, s);
      show();
    },
    [keep, forget, show],
  );

  // send gives the text that the frame holds to the server, as one
  // operation on the head, and ends in one of these ways:
  //   1. The head holds the text: nothing goes.
  //   2. The server took the operation. Its answer is the new head. When
  //      the answer also names operations of other people, the frame lags,
  //      and the follow shows them.
  //   3. The edits cannot be written into the source: the text cannot save.
  //   4. The send failed (see failure):
  //      passing  The same operation goes again after a time, also for a
  //               frame that went. A reader whose session ended signs in
  //               first: nothing goes again, and their text waits in
  //               storage, which the page after sign-in sends.
  //      lost     The text goes again, on the live document, unless the
  //               server took this operation: the document then has the
  //               text already. When the live document was the head
  //               already, the frame loads again after that, and text that
  //               the server refused cannot save.
  //      unfit, refused  The text cannot save.
  // Text that cannot save stays on screen until the reader copies or
  // discards it.
  const send = useCallback(
    async (s: Load): Promise<void> => {
      cancel(s, "burst");
      let op = s.unsent;
      try {
        op ??= await compose(s);
        const answering = op && api.sendOps(opts.current.docId, op.body);
        if (op) {
          const at = s.text!;
          const before = at.head.version;
          const answer = (await answering)!;
          // The server holds the text of the operation.
          s.unsent = undefined;
          at.shown = op.screen;
          const source = applyOps(op.target, answer.others);
          if (source === undefined || sumOf(source) !== answer.sum) throw new Lost();
          s.sync = "sure";
          at.head = { seq: answer.seq, version: answer.version_id, source };
          // The answer names the text of other people for a frame that
          // showed the head. Else the next merge is from the two sources.
          at.ahead = op.target === op.screen.source ? answer.others : undefined;
          if (gone(s)) {
            // The page learns the new seq from the server, and the frame
            // that came after this one follows it.
            void q.invalidateQueries({
              queryKey: queryKeys.document(opts.current.docId),
            });
          } else {
            if (!lags(at)) opts.current.frameShows(answer.seq, answer.version_id);
            // The other places of sent script text change in place, as a
            // load of the new source would.
            for (const { key, from, to } of op.scripts) {
              opts.current.replaceText(from, to);
              s.written.set(key, to);
            }
            void afterEdit(before, answer.version_id);
          }
        }
        // A newer state that waited for this send can go into the frame.
        s.wanted = true;
        s.failing = false;
      } catch (e) {
        const failed = failure(e);
        s.failing = failed === "passing";
        // Only an operation that can pass goes again.
        if (failed !== "passing") s.unsent = undefined;
        switch (failed) {
          case "passing": {
            s.dirty ||= !s.unsent;
            if (!signedOut(e)) {
              wait(s, "resend", RETRY_MS);
              break;
            }
            // The page asks who the reader is, learns that they are signed
            // out, and takes them to sign in (see below). A page that knows
            // it already takes them at once.
            const { loads, signIn } = opts.current;
            loads.signedOut = true;
            void q.invalidateQueries({ queryKey: queryKeys.me() });
            signIn?.();
            break;
          }
          case "lost": {
            // The server holds the text of an operation that it answered,
            // or that it applied before. That text counts as shown, so that
            // it merges into the live document one time, and it never fails
            // to save.
            const held = e instanceof Lost || applied(e);
            if (held) s.text!.shown = op!.screen;
            if (e instanceof Lost && s.sync === "unsure") {
              expire(s);
              s.sync = "lost";
            } else lose(s);
            if (s.sync === "lost") s.dirty = true;
            else if (!held) s.refusal = UNFIT;
            break;
          }
          case "unfit":
            s.refusal = UNFIT;
            break;
          case "refused":
            s.refusal = SERVER_REFUSALS[(e as APIError).status] ?? REFUSED;
        }
      }
      report(s);
    },
    [q, compose, report, afterEdit, wait],
  );

  // patch makes the frame show the head in place: the text of other people
  // goes around the text that the reader typed since the last send. It
  // tells how it ended (see Patched). With ask, the frame is asked first
  // whether the reader would see the change as a small one. Each attempt
  // has four steps:
  //   1. Take what the frame shows.
  //   2. Make the target: the head, with the text of the reader on top.
  //   3. Give the frame the patches that it does not show yet.
  //   4. Take what the frame shows now. Only a screen that is exactly the
  //      target counts as shown.
  const patch = useCallback(
    async (s: Load, flash: boolean, ask = false): Promise<Patched> => {
      const at = s.text!;
      const { base, head } = at;
      // The frame shows target, and regions is the source of its regions.
      // While changes wait, target is the head without them. Else the frame
      // holds text that the server does not when target is not the head.
      const shows = (target: string, regions: string): Patched => {
        at.shown = { source: head.source, regions };
        at.ahead = undefined;
        if (at.held !== undefined) at.held = target;
        else s.dirty ||= target !== head.source;
        return "shown";
      };
      // The frame shows screen, and not target, which the document must
      // have: target holds the text that the reader typed before the patch.
      // That text goes to the server as target, and screen counts as shown
      // after it. What the frame shows other than target is thus never sent
      // as an edit of the reader. A frame that cannot hold text of the
      // reader sends nothing.
      const differs = (screen: Screen, target: string): Patched => {
        at.ahead = undefined;
        const body = writes(s) && request(s, target);
        if (body) stage(s, { screen, target, body, scripts: [] });
        else at.shown = screen;
        return "failed";
      };
      try {
        for (let attempt = 0; attempt < PATCH_ATTEMPTS; attempt++) {
          const taken = (s.draft = await fromFrame(s, opts.current.take()));
          // The regions of an unwritable frame say nothing about what it
          // shows.
          const before = s.unwritable ? undefined : await build(s, taken);
          // A frame that cannot hold text of the reader has the head as its
          // target also when it shows another source, as after a load that
          // the page did not start.
          const typed = before && writes(s) ? before.source : undefined;
          const { source: target, marks } = over(
            at,
            typed ?? at.held ?? at.shown.source,
          );
          if (before?.source === target) return shows(target, before.regions);

          const wanted = patchBetween(
            base.tree,
            target,
            marks,
            before?.source ?? at.shown.source,
          );
          // A load of the frame is never a small change for the reader.
          if ("reload" in wanted) return ask ? "held" : "failed";
          // The frame already shows the patches of the text that it holds.
          const patches = without(wanted.patches, base, before?.source);
          const codes = without(wanted.codes, base, before?.source);
          // A script text can change all that the reader sees.
          if (ask && codes.length) return "held";
          const strings = await stringPatches(s, codes, taken, opts.current.probe);
          if (!strings) return "failed";
          patches.push(...strings);
          const result = await fromFrame(
            s,
            opts.current.patch(patches, taken.edits, flash, ask),
          ).catch(() => undefined);
          if (!result) {
            // The frame did not answer for the patch, and shows it or not.
            // The keys that came after the first take go with the text of
            // the reader when they are surely keys (see apart), and the
            // frame loads again.
            const again = (s.draft = await fromFrame(s, opts.current.take()));
            const screen = await build(s, again);
            return differs(
              screen,
              typed ? apart(typed, screen.source, target) : target,
            );
          }
          if (result.withdrawn) return "held";
          // A key came between the take and the patch.
          if (result.stale) continue;
          // The patch does not fit, as for a style that a script changed,
          // and the frame must load. A load is never a small change.
          if (!result.ok) return ask ? "held" : "failed";

          at.outside = outsideAfter(at.outside, base, patches);
          for (const tag of wanted.tags) at.made.add(tag);
          s.draft = result;
          if (!before) return shows(target, head.source);
          const after = await build(s, result);
          if (after.source === target) return shows(target, after.regions);
          // The regions cannot write what the frame shows now, as with a
          // new table. That only matters for text that the reader types.
          // Outside Edit mode, a frame with no text of the reader stays as
          // it is: it shows the head, or the head without the changes that
          // wait.
          if (opts.current.editing || (typed !== undefined && target !== head.source))
            return differs(after, target);
          s.unwritable = true;
          return shows(target, head.source);
        }
        return "busy";
      } catch {
        // The frame did not answer, or its text does not fit the source.
        return "failed";
      }
    },
    [build, writes],
  );

  // advance moves the head to the newest state of the document, with the
  // operations after it: those of the last event, when it is on the head,
  // or else those that the server gives. It gives the changes, or nothing
  // when the head did not move: it is the newest state, or this client
  // lost it.
  const advance = useCallback(
    async (s: Load, at: Text): Promise<DocumentChanges | undefined> => {
      // The live document can be the newest state.
      if (!behind(s)) return undefined;
      const { docId, event } = opts.current;
      const { head } = at;
      const changes =
        event?.changes && event.prev_seq === head.seq
          ? event.changes
          : await api.documentChanges(docId, head.seq);
      if (gone(s) || changes.seq <= head.seq) return undefined;
      const source = applyOps(head.source, changes.ops);
      if (source === undefined || sumOf(source) !== changes.sum) return void lose(s);
      s.sync = "sure";
      at.head = { seq: changes.seq, version: changes.version_id, source };
      at.ahead = changes.ops;
      return changes;
    },
    [behind],
  );

  // follow brings the frame to the newest state of the document: to a head
  // that the frame lags behind, as after a send, or else to the operations
  // after the head. It ends in one of these ways:
  //   1. There is nothing to follow: the frame is not open, it shows a
  //      preview, or the server has no live documents.
  //   2. The frame shows the newest state that the page knows.
  //   3. This client lost the head: the next follow starts from the live
  //      document.
  //   4. The frame shows the head now, or while changes wait behind the
  //      banner, the head without them: typing of other people goes on.
  //   5. The frame held the change. The frame stays as it is, in place of
  //      the head, and the banner shows. Only a change that can be more
  //      than typing can wait, and it never waits in Edit mode, in a tab
  //      that the reader does not see, while the frame holds text that is
  //      not saved, or when the reader asked for the latest.
  //   6. The reader types: the patch goes again a moment later.
  //   7. The frame cannot show the head in place: it loads the document
  //      again, after the text that it can hold is sent.
  //   8. The changes did not come: the follow goes again after a time. A
  //      reader who cannot read the document gets the page that says so,
  //      and a frame whose version is gone loads the current one.
  const follow = useCallback(
    async (s: Load): Promise<void> => {
      cancel(s, "refollow");
      s.wanted = false;
      const { docId, live } = opts.current;
      if (!live || s.seq === undefined || s.frame !== "open") return;
      if (!behind(s)) return;
      try {
        const at = await recover(s);
        const before = at.head;
        const lagged = lags(at);
        const changes = lagged ? undefined : await advance(s, at);
        if (!lagged && !changes) return;
        // Typing of other people goes in with no sign. A change that is
        // not typing flashes, and so do the changes that waited behind the
        // banner, and the live document that this client took as the head:
        // they can hold any change.
        const pushed = changes
          ? !changes.typed
          : s.update !== "none" || s.sync === "unsure";
        const asks = () =>
          pushed &&
          !opts.current.editing &&
          !hidden() &&
          s.update !== "asked" &&
          !unsaved(s);
        let patched = await patch(s, pushed, asks());
        // The frame answered after Edit mode started, or after the tab hid:
        // the change does not wait.
        if (patched === "held" && !asks()) patched = await patch(s, pushed, false);
        if (gone(s)) return;
        if (patched === "shown") {
          if (at.held === undefined) {
            s.update = "none";
            s.since = undefined;
            opts.current.frameShows(at.head.seq, at.head.version);
            opts.current.holdUpdate(undefined);
          }
          // More can wait after a head that the frame lagged behind.
          s.wanted = true;
        } else if (patched === "held") {
          // The frame keeps what it shows in place of the head, and the
          // changes go in when the reader asks for them.
          at.held ??= at.shown.source;
          at.shown = { source: at.head.source, regions: at.head.source };
          at.ahead = undefined;
          s.since ??= before.seq;
          // The banner names the people whose changes wait, and not those
          // who typed in the same changes: typing shows live. A banner for
          // the same changes stays as it is.
          const { madeBy, holdUpdate } = opts.current;
          const authors = changes
            ? (madeBy(s.since, changes.seq) ?? changes.authors)
            : [];
          if (changes || s.update !== "again") holdUpdate({ authors });
          s.update = "held";
          s.askedAt = Date.now();
        } else if (patched === "busy") {
          wait(s, "refollow", STALE_MS, () => (s.wanted = true));
        } else {
          expire(s);
          s.dirty ||= writes(s);
        }
      } catch (e) {
        const queryKey = queryKeys.document(docId);
        if (removed(s, e)) {
          // The page reads the document again first, so that the frame
          // loads the version that is current now.
          await q.refetchQueries({ queryKey, exact: true });
          expire(s);
        } else if (denied(e)) void q.invalidateQueries({ queryKey });
        else if (outdated(e)) lose(s);
        else if (!gone(s)) wait(s, "refollow", RETRY_MS, () => (s.wanted = true));
      }
    },
    [q, recover, advance, patch, behind, writes, wait],
  );

  // work does what waits, one thing at a time: it sends the text that the
  // frame holds, then follows, and so on until nothing waits. The follow
  // after each send shows the text of other people also to a person who
  // types faster than the server answers. A send that failed waits for its
  // next try. A stale frame then loads the document again, once: never
  // while it holds text that is not sent.
  const work = useCallback(
    (s: Load): Promise<void> => {
      const sends = () =>
        pending(s) &&
        !opts.current.loads.signedOut &&
        s.timers.burst === undefined &&
        s.timers.resend === undefined;
      const follows = () => s.wanted && !s.unsent;
      const loop = async () => {
        while (sends() || follows()) {
          release(s);
          if (sends()) await send(s);
          if (follows()) await follow(s);
        }
      };
      return (s.run ??= loop().then(() => {
        s.run = undefined;
        // More came in after the last look.
        if (sends() || follows()) return work(s);
        if (s.frame !== "stale" || unsaved(s)) return;
        s.frame = "reloading";
        opts.current.reload();
      }));
    },
    [send, follow],
  );
  run.current = work;

  // flush does at once what waits for its time.
  const flush = useCallback(
    (s: Load) => {
      s.wanted ||= s.timers.refollow !== undefined;
      (["burst", "resend", "refollow"] as const).forEach((timer) => cancel(s, timer));
      return work(s);
    },
    [work],
  );

  // refresh loads the document in the frame again, after the text on screen
  // is sent.
  const refresh = useCallback(
    (s: Load) => {
      expire(s);
      return work(s);
    },
    [work],
  );

  // end ends a load whose frame goes. The last draft stands for the frame
  // from then on. Text that can still go stays in storage, and goes again
  // from the draft until the server has it. Text that cannot save stays in
  // storage, and does not go again. The page shows the state of such text
  // until the server has it, or the reader discards it. Its message goes
  // with the frame, and the next load shows it again.
  const end = useCallback(
    (s: Load) => {
      if (gone(s)) return;
      TIMERS.forEach((timer) => cancel(s, timer));
      s.frame = "gone";
      s.leave();
      toast.dismiss(REFUSED_TOAST);
      if (s.refusal) s.dirty = false;
      else if (pending(s)) keep(s);
      if (!unsaved(s)) drop(opts.current.loads, s);
    },
    [keep],
  );

  // A new load of the frame starts over. The load before ends, and its last
  // edits go to the server from its draft. A frame that loaded by itself,
  // as when a script of the document loads it again, is a new load too: it
  // shows the document as the page loaded it, and none of what the load
  // before put in it. What such a frame shows is never an edit of the reader.
  const [restarts, restart] = useReducer((n: number) => n + 1, 0);
  const frame = `${loaded.url} ${loaded.version} ${loaded.seq} ${restarts}`;
  useEffect(() => {
    const { loaded, loads, holdUpdate } = opts.current;
    const s = (load.current = newLoad(loaded.version, loaded.seq));
    enter(loads, s);
    show();
    holdUpdate(undefined);
    return () => {
      end(s);
      void run.current(s);
    };
  }, [frame, end, show]);
  // The load ends at once: the frame tells nothing more for it.
  const restarted = useCallback(() => {
    end(load.current);
    restart();
  }, [end]);

  // showUpdate brings the frame to the newest state of the document for a
  // reader who asked for it: the change that waited goes in, in place when
  // the frame can show it so. Else the frame loads the document again,
  // unless the changes did not come: the follow then tries again.
  const showUpdate = useCallback(async () => {
    const s = load.current;
    cancel(s, "ask");
    s.update = "asked";
    s.wanted = true;
    opts.current.holdUpdate(undefined);
    await flush(s);
    // The reader still waits for the changes when they did not come.
    if (s.timers.refollow !== undefined) return;
    if (s.update === "asked") s.update = "none";
    if (behind(s) && !gone(s)) await refresh(s);
  }, [flush, refresh, behind]);

  // The reader scrolled. A change that waits behind the banner can be far
  // from what they read now, so the frame is asked about it again, at most
  // once in ASK_MS.
  const scrolled = useCallback(() => {
    const s = load.current;
    if (s.update !== "held" || s.timers.ask !== undefined) return;
    // The follow asks the frame again about the changes that wait.
    wait(s, "ask", Math.max(0, s.askedAt + ASK_MS - Date.now()), () => {
      s.wanted = true;
      s.update = "again";
    });
  }, [wait]);

  // A reader whose session ended during a send signs in when the page
  // learns that they are signed out.
  useEffect(() => {
    if (signIn && opts.current.loads.signedOut) signIn();
  }, [signIn]);

  // An editor starts from the latest document, in a frame whose regions
  // can write its source.
  useEffect(() => {
    const s = load.current;
    if (!editing) return;
    if (s.unwritable) void refresh(s);
    else if (s.update === "held") void showUpdate();
  }, [editing, refresh, showUpdate]);

  // An editor has the loaded source before the first key: the first
  // operation then needs no other request, also from a page that goes.
  useEffect(() => {
    if (editing && live) void read(load.current).catch(() => {});
  }, [editing, live, frame, read]);

  // The reader changed the text of the frame, which tells its edits with
  // the change. The change goes out after the burst that it is in. A frame
  // whose regions cannot write what it shows loads again first.
  const changed = useCallback(
    (edits?: TextEditResult) => {
      const s = load.current;
      if (gone(s)) return;
      if (edits) s.draft = edits;
      if (s.kept) keep(s);
      if (s.seq === undefined) return;
      if (s.unwritable) return void refresh(s);
      s.dirty = true;
      opts.current.holdCursor(true);
      if (s.timers.burst === undefined) wait(s, "burst", BURST_MS);
    },
    [keep, refresh, wait],
  );

  // The page learns the seq that the frame shows when the frame is ready.
  // Until then, and in a preview, the frame shows no seq of the live
  // document.
  useEffect(() => {
    const { version, seq } = load.current;
    opts.current.frameShows(live ? seq : undefined, version);
  }, [live, frame]);

  // The page learned of a newer seq, or the frame is ready for one.
  useEffect(() => {
    load.current.wanted = true;
    void work(load.current);
  }, [work, latest, event, live, frame]);

  useEffect(() => {
    // A tab that the reader does not see sends its text at once, and keeps
    // it in storage until the server has it: the browser can end such a
    // tab with no sign.
    const onHidden = () => {
      const s = load.current;
      if (!hidden()) return;
      if (pending(s)) keep(s);
      void flush(s);
      // The person who comes back wants the current document, not a banner.
      if (s.update === "held") void showUpdate();
    };
    // The page goes, and gets no more answers from the frame. The load
    // ends, so the last draft stands for the frame, and the operation for
    // it starts in this task, in a request that outlives the page. An
    // operation that is on its way already outlives the page too.
    const onPageHide = () => {
      const s = load.current;
      end(s);
      void work(s);
    };
    // The browser kept the page and shows it again: its load ended.
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) opts.current.reload();
    };
    // An unload warns only about text that cannot go with the page: text
    // that cannot save, a send that failed, and text that is not sent while
    // the browser is offline.
    const stays = (s: Load) =>
      !!s.refusal || s.failing || (!navigator.onLine && pending(s));
    const warn = (e: BeforeUnloadEvent) => {
      if ([...opts.current.loads.all].some(stays)) e.preventDefault();
    };
    // A send that failed goes again when the network is back.
    const onOnline = () => opts.current.loads.all.forEach((s) => void flush(s));
    const listeners = [
      [document, "visibilitychange", onHidden],
      [window, "pagehide", onPageHide],
      [window, "pageshow", onPageShow],
      [window, "beforeunload", warn],
      [window, "online", onOnline],
    ] as [EventTarget, string, EventListener][];
    for (const [target, type, on] of listeners) target.addEventListener(type, on);
    return () => {
      for (const [target, type, on] of listeners) target.removeEventListener(type, on);
    };
  }, [flush, keep, end, work, showUpdate]);

  // settle sends the text of each load of the page at once, also a send
  // that waits for its next try, and tells whether the reader can leave it:
  // text that cannot save says why again, with the choices. A send that
  // failed for a reason that can pass goes on by itself.
  const settle = useCallback(async (): Promise<boolean> => {
    const all = [...opts.current.loads.all];
    await Promise.all(all.map(flush));
    show();
    return !all.some((s) => s.refusal);
  }, [flush, show]);

  // The reader put the caret in the text.
  const focused = useCallback(() => {
    const { text, version } = load.current;
    return beforeEdit(text?.head.version ?? version);
  }, [beforeEdit]);

  return { changed, scrolled, restarted, scriptEditable, focused, settle, showUpdate };
}
