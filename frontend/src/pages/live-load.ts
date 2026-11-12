// The state of one load of the document frame, for useLiveText: what the
// frame loaded, what the server has, and the work that waits.
//
// Three fields say where a load is. Each one has few values, and one value
// at a time.
//
// frame: what the frame is for the hook.
//   open       The frame answers. A take gives its text, and a patch brings
//              it to the head.
//   stale      The frame cannot show the head in place. Its text still goes
//              to the server.
//   reloading  The page loads the document in the frame again. The load ends
//              when the new frame comes.
//   gone       The frame went. The last draft stands for it, and text that
//              is not sent goes from the draft until the server has it.
//   open -> stale      A patch failed, the head is lost a second time, the
//                      loaded source did not load, the latest that the
//                      reader asked for cannot go in in place, or the
//                      reader starts to edit in an unwritable frame.
//   stale -> reloading The server holds the text on screen.
//   open -> reloading  The reader discarded text that cannot save.
//   each -> gone       The page gives a new load, or the page goes.
//
// sync: how this client knows the head.
//   sure    The frame loaded the head, or an answer of the server made it.
//   lost    The server no longer has the seq of the head, or an answer did
//           not make the source of the server.
//   unsure  The head is the live document, as this client read it. The
//           operations that lead to it are not known, so a patch to it is a
//           change that can be more than typing.
//   sure -> lost    409 stale, or a sum that is not the sum of the server.
//   lost -> unsure  The next read gets the live document.
//   unsure -> sure  An answer of the server makes its sum on this head.
//   unsure, and the head is lost again: the frame is stale. When the answer
//   of an operation lost it, the server holds the text of the operation:
//   unsure -> lost, so that the text that the frame holds more goes on the
//   live document before the frame loads again.
//
// update: the changes that wait for the reader.
//   none   No change waits.
//   held   The frame kept changes out, and the banner shows. The frame
//          shows text.held in place of the head: typing of other people
//          goes on in it, and other changes wait too, unless the frame
//          takes them.
//   asked  The reader asked for the latest: the changes that wait go in
//          with no ask.
//   again  The reader scrolled: the frame is asked again whether the
//          changes that wait are a small change for the reader.
//   none -> held           The frame holds a change that is not typing.
//   held -> asked          Show the latest, Edit mode, or a tab that hides.
//   held -> again          The reader scrolled.
//   again -> held          The frame holds the changes again.
//   asked, again -> none   The frame shows the head, or nothing waits for
//                          its next try.
//   After held, the work first lets the changes go into the frame (see
//   release), and then sends and follows.
//
// The other fields are the text and the work. The states above, and the
// work, depend on these:
//   text        Unset until the loaded source loads (lose, removed).
//   draft       The last edits of the frame: they stand for a frame that
//               went, and storage keeps them as operations (draftOf).
//   unsent      The operation on its way: no follow runs, and storage
//               keeps it with its id (opId).
//   refusal     The text on screen cannot save (unsaved).
//   dirty       The frame changed after the last take for a send (pending).
//   failing     The last send failed for a reason that can pass.
//   wanted      A newer state can go into the frame.
//   unwritable  The regions of the frame cannot write what it shows.
//   kept        Storage holds the draft.
//   timers, run The work that waits for its time, and the work that runs.
//
// A page answers for more than one load (see Loads): a load that ended
// while it held text that the server does not hold sends it on, and the
// page shows its state until the server has the text.

import { api, APIError, type Operation } from "@/api";
import {
  applyRegions,
  parseSource,
  replacementsBetween,
  type Change,
  type Replacement,
  type SourceTree,
} from "@/lib/source-edits";
import { applyReplacements, merge3, mergeOps, type Range } from "@/lib/source-merge";
import { draftLock, draftText, type TextDraft } from "@/lib/text-drafts";
import { randomId } from "@/lib/uuid";
import type { TextEditResult } from "./doc-context";

// What the frame loaded: its source, and the parse of it that the regions
// from the frame and the patches for the frame refer to.
export type Base = { source: string; tree: SourceTree };

// A source for what the frame shows, with script text and without it.
export type Screen = { source: string; regions: string };

// The text of one load of the frame. head is the newest state of the
// document that this client knows exactly: its seq, the version that holds
// it, and its source. shown is the screen of the frame when the frame and
// the head were last compared: what the frame shows more than that is the
// text that the reader typed since, and it is not sent yet. The frame lags
// when shown is not the head: the head then also holds text of other people
// that the frame does not show yet.
export type Text = {
  base: Base;
  head: { seq: number; version: string; source: string };
  shown: Screen;
  // The changes of the loaded source that patches made in the frame and
  // that its regions do not write: of start tags and styles, in order.
  outside: Change[];
  // The start tags of the elements that patches put in the frame. Its
  // regions write those elements with these tags (see applyRegions).
  made: Set<string>;
  // What turns shown into the head, when the server gave it. The server
  // gives it exactly, also for a change too large for the diff here.
  ahead?: Replacement[][];
  // While changes wait behind the banner, the frame shows held in place of
  // the head: the head without those changes. shown is then the head, so
  // held is like text on top of it, and the typing of other people merges
  // around it as around the text of the reader. It never goes to the
  // server.
  held?: string;
};

// A script string that an operation changes: the text that the page shows
// for it before the operation and after it. key names the script text that
// the reader typed in.
export type ScriptEdit = { key: string; from: string; to: string };

// One operation: the screen of the frame when it was made, the source that
// it makes of the head, and the request. A request that failed for a reason
// that can pass goes again as it is, so that the server can tell that it is
// the same operation.
export type Op = {
  screen: Screen;
  target: string;
  body: Operation;
  scripts: ScriptEdit[];
};

// request gives the next operation of a load, which turns the head into
// target, or nothing when the head is target. summary says in words what
// the operation changes, when the server cannot tell.
export function request(
  s: Load,
  target: string,
  summary?: string,
): Operation | undefined {
  const { head } = s.text!;
  const replacements = replacementsBetween(head.source, target);
  if (!replacements.length) return undefined;
  const op = { base_seq: head.seq, client_op_id: s.opId, replacements };
  return summary ? { ...op, summary } : op;
}

// stage makes an operation the one on its way. The next operation gets
// another id.
export const stage = (s: Load, op: Op) => {
  s.opId = randomId();
  return (s.unsent = op);
};

// How a patch of the frame ended.
//   shown   The frame shows the head, around the text that the reader typed.
//   held    The frame was asked, and kept a change that the reader would
//           see as more than a small one. The frame did not change.
//   busy    The reader typed during each attempt. The frame did not change.
//   failed  The frame cannot show the head in place.
export type Patched = "shown" | "held" | "busy" | "failed";

// All that the hook knows about one load of the frame (see the top). A new
// load starts with a new one, so nothing of the load before stays.
export type Load = {
  // The storage entry of the draft of this load, and the name of its lock.
  id: string;
  // The id of the next operation. Storage can name the text that did not
  // go yet with it, before the operation goes (see draftOf).
  opId: string;
  // The version that the frame loaded, and the seq of the document that it
  // showed then. A server with no live documents gives no seq.
  version: string;
  seq?: number;
  // Unset until the source of the loaded version loads. reading is the
  // read of that source that is on its way.
  text?: Text;
  reading?: Promise<Text>;
  frame: "open" | "stale" | "reloading" | "gone";
  sync: "sure" | "lost" | "unsure";
  update: "none" | "held" | "asked" | "again";
  // The frame shows the head, but its regions cannot write it, as after a
  // push that adds a table. Only a frame with no text of the reader can be
  // so, outside Edit mode. It takes patches, sends nothing, and loads again
  // before the reader types in it.
  unwritable: boolean;
  // The frame changed after the last take for a send.
  dirty: boolean;
  // The operation that is on its way, or that failed and goes again.
  unsent?: Op;
  // The last send failed for a reason that can pass, and did not go again
  // yet.
  failing: boolean;
  // A newer state of the document can go into the frame.
  wanted: boolean;
  // The run of sends and follows that is on its way: one runs at a time.
  run?: Promise<void>;
  // What waits for its time: the end of a burst of keys, the next try of a
  // send or of a follow, and the next time that the frame is asked about a
  // change that waits.
  timers: Partial<Record<Timer, number>>;
  // The latest edits from the frame. They stand for the frame when the
  // frame went.
  draft?: TextEditResult;
  // Storage holds the draft.
  kept: boolean;
  // Lets go of the lock of the draft, which the load holds while it is on
  // the page (see enter).
  release: () => void;
  // left fails when the frame goes, so that nothing waits for an answer of
  // a frame that went (see fromFrame).
  left: Promise<never>;
  leave: () => void;
  // The time when the frame was last asked about the changes that wait,
  // and the seq of the head before them. The banner names the people who
  // made the changes after that seq.
  askedAt: number;
  since?: number;
  // Why the text on screen cannot save.
  refusal?: string;
  // The outcome of each script change, by its JSON, and the text that the
  // page shows for each script text that the reader typed in, by its key.
  checks: Map<string, Promise<{ places: number } | { refused: string }>>;
  written: Map<string, string>;
};

export const TIMERS = ["burst", "resend", "refollow", "ask"] as const;
export type Timer = (typeof TIMERS)[number];

export const newLoad = (version = "", seq?: number): Load => {
  let leave = () => {};
  const left = new Promise<never>((_, fail) => {
    leave = () => fail(new Error("The frame went."));
  });
  // Nobody waits for the frame of most loads.
  left.catch(() => {});
  return {
    id: randomId(),
    opId: randomId(),
    version,
    seq,
    frame: "open",
    sync: "sure",
    update: "none",
    unwritable: false,
    dirty: false,
    failing: false,
    wanted: false,
    timers: {},
    kept: false,
    release: () => {},
    left,
    leave: () => leave(),
    askedAt: 0,
    checks: new Map(),
    written: new Map(),
  };
};

// The loads that one page of the document answers for: the load of its
// frame, and each load that ended while it held text that the server does
// not hold. They outlive a mount of the frame, as full screen makes. late
// says that their sends failed for FAILED_SIGN_MS, and sign is the timer
// for it. signedOut says that the session of the reader ended while a load
// sent text: the text waits in storage while the reader signs in.
export type Loads = {
  all: Set<Load>;
  late: boolean;
  sign?: number;
  signedOut: boolean;
};
export const newLoads = (): Loads => ({
  all: new Set(),
  late: false,
  signedOut: false,
});

// enter puts a load on the page. While it is there, it holds the lock of its
// draft in each tab of the browser, so that no other page sends the draft
// (see unowned).
export const enter = (loads: Loads, s: Load) => {
  loads.all.add(s);
  const released = new Promise<void>((done) => (s.release = done));
  void navigator.locks?.request(draftLock(s.id), () => released);
};

// drop takes a load off the page: it holds no text that the server does
// not hold, or the reader discarded that text.
export const drop = (loads: Loads, s: Load) => {
  loads.all.delete(s);
  s.release();
};

export const cancel = (s: Load, timer: Timer) => {
  window.clearTimeout(s.timers[timer]);
  delete s.timers[timer];
};

// Whether the frame holds text that can still go to the server, and
// whether it holds text that the server does not hold.
export const pending = (s: Load) => s.dirty || !!s.unsent;
export const unsaved = (s: Load) => pending(s) || !!s.refusal;

// Whether the reader does not see the page: its tab is hidden, or it is on
// its way out.
export const hidden = () => document.visibilityState === "hidden";

// fromFrame gives an answer of the frame of a load, or fails at once when
// the frame went: a frame that went does not answer.
export const fromFrame = <T>(s: Load, answer: Promise<T>) =>
  Promise.race([answer, s.left]);

// open reads the source that the frame of a load loaded. The text of the
// load starts there: the frame shows the head.
export async function open(s: Load, docId: string): Promise<Text> {
  const { version, seq } = s;
  if (seq === undefined) throw new Unread();
  const { source } = await api.versionSource(docId, version, seq);
  const base = { source, tree: await parseSource(source) };
  const shown = { source, regions: source };
  return (s.text = {
    base,
    head: { seq, version, source },
    shown,
    outside: [],
    made: new Set(),
  });
}

// expire says that the frame of a load cannot show the head in place.
export const expire = (s: Load) => {
  if (s.frame === "open") s.frame = "stale";
};

// lose says that this client does not know the head of a load any more. The
// next read takes the live document as the head. When the head was the live
// document already, or when the loaded source did not load, the frame loads
// the document again.
export const lose = (s: Load) => {
  if (!s.text || s.sync === "unsure") return expire(s);
  s.sync = "lost";
  s.wanted = true;
};

// release lets the changes that wait behind the banner go into the frame
// when the reader no longer waits (see update): the frame then lags behind
// the head by them. Only the work calls it, so no patch is on its way.
export const release = (s: Load) => {
  const at = s.text;
  if (s.update === "held" || at?.held === undefined) return;
  at.shown = { source: at.held, regions: at.held };
  at.ahead = at.held = undefined;
};

// Whether the frame of a load went.
export const gone = (s: Load) => s.frame === "gone";

// Whether the frame does not show the head yet.
export const lags = (at?: Text) => !!at && at.shown.source !== at.head.source;

// over gives the source that the document has when the text that the
// reader typed is on top of the head, and the ranges of it that other
// people put in, when the server gave their operations. now is the source
// for what the frame shows. The result is the head with the changes from
// shown to now: the operations that turn shown into the head go around
// them, or else the merge is from the two sources.
export function over(
  {
    shown,
    head,
    ahead,
  }: Pick<Text, "ahead"> & {
    shown: { source: string };
    head: { source: string };
  },
  now: string,
): { source: string; marks: Range[] } {
  if (shown.source === head.source) return { source: now, marks: [] };
  if (ahead) return mergeOps(shown.source, now, ahead);
  const source =
    now === shown.source ? head.source : merge3(shown.source, now, head.source);
  return { source, marks: [] };
}

// apart gives target with the changes from before to screen that touch no
// change from before to target. When the frame did not answer for a patch,
// it shows the patch or it does not: only such changes are surely keys of
// the reader. The others can be the text of the patch.
export function apart(before: string, screen: string, target: string): string {
  const patch = replacementsBetween(before, target);
  const keys = replacementsBetween(before, screen).filter(
    (key) => !patch.some((p) => key.start <= p.end && p.start <= key.end),
  );
  return merge3(before, applyReplacements(before, keys) ?? before, target);
}

// draftOf gives what storage keeps for a load (see TextDraft): the
// operation on its way and the text typed after it, or else the text on
// screen as the next operation. It reads the last draft of the frame and
// asks the frame nothing, so that it runs as the page goes. Script text
// goes only from a frame that shows it, so storage keeps it to copy. So
// does text that cannot save, or that has no loaded source to go on. A
// frame that cannot hold text of the reader (writes) holds no text to
// send.
export function draftOf(
  s: Load,
  writes: boolean,
): Omit<TextDraft, "updatedAt"> | undefined {
  const { text: at, draft, unsent } = s;
  if (!draft) return undefined;
  const version = at?.head.version ?? s.version;
  const regions =
    at && !s.refusal && applyRegions(at.base.tree, draft.regions, at.outside, at.made);
  if (!regions || "refused" in regions)
    return { version, copy: draftText(at?.base.tree, draft) };
  // The text that the reader typed after the screen from goes onto the
  // source that the operation on its way makes, or else onto the head. A
  // screen with script text gives no operations to merge over: its regions
  // do not hold that text.
  const from = unsent?.screen ?? at.shown;
  const onto = unsent ? { source: unsent.target } : at.head;
  const scripted = from.regions !== from.source;
  const later =
    s.unwritable || !writes
      ? onto.source
      : over(
          {
            shown: scripted ? { source: from.regions } : from,
            head: onto,
            ahead: unsent || scripted ? undefined : at.ahead,
          },
          regions.html,
        ).source;
  const sent = (key: string) =>
    unsent?.scripts.find((c) => c.key === key)?.to ?? s.written.get(key);
  const copy =
    draft.scripts
      .filter(
        (c) => c.after.trim() !== (sent(JSON.stringify(c.locator)) ?? c.before).trim(),
      )
      .map((c) => c.after.trim())
      .join("\n\n") || undefined;
  if (unsent) {
    const next = replacementsBetween(unsent.target, later);
    return { version, op: unsent.body, next: next.length ? next : undefined, copy };
  }
  const op = request(s, later);
  return op || copy ? { version, op, copy } : undefined;
}

// The edits cannot be written into the source.
export class Refused extends Error {}

// A source that a load needs did not load here: the source that the frame
// loaded, or the live document. It says nothing about the edit, so the read
// goes again.
export class Unread extends Error {}

// The answer of the server does not make the source that the server has.
export class Lost extends Error {}

// passing reports an error that sending again can fix: the network, the
// frame that did not answer, a server that is busy or failed, a session that
// ended, which the reader starts again, or a server of the release before
// during a deploy. That server has no route for the request, so it answers
// 404 with no error code, and the next request can go to a new server.
export function passing(e: unknown): boolean {
  return (
    !(e instanceof APIError) ||
    e.status >= 500 ||
    [401, 408, 429].includes(e.status) ||
    (e.status === 404 && e.code === "http_error")
  );
}

// The error of a request, when the server answered it. A read of a source
// that failed holds it.
const answered = (e: unknown) => {
  const error = e instanceof Unread ? e.cause : e;
  return error instanceof APIError ? error : undefined;
};

// outdated reports that the server no longer has the seq that a request
// names.
export const outdated = (e: unknown) => answered(e)?.code === "stale";

// applied reports that the server refused an operation as outdated, and
// that it applied the same operation before: the document has its text.
export const applied = (e: unknown) =>
  outdated(e) && (answered(e)?.details as { applied?: boolean })?.applied === true;

// denied reports that the reader cannot read the document: it is gone, or
// their access to it is.
export const denied = (e: unknown) => [403, 404].includes(answered(e)?.status ?? 0);

// signedOut reports that the session of the reader ended. The page then
// asks who the reader is, and takes them to sign in.
export const signedOut = (e: unknown) => answered(e)?.status === 401;

// How a send failed.
//   passing  It can pass (see passing): the same operation goes again.
//   lost     This client lost the head: the answer does not make the
//            source of the server, or the server no longer has the seq.
//   unfit    The edits do not fit the source that the server has, or the
//            source of the frame.
//   refused  The server refused the operation for another reason.
export function failure(e: unknown): "passing" | "lost" | "unfit" | "refused" {
  if (e instanceof Refused) return "unfit";
  if (e instanceof Lost || outdated(e)) return "lost";
  if (e instanceof Unread || passing(e)) return "passing";
  return answered(e)?.code === "edit_failed" ? "unfit" : "refused";
}

// removed reports that the version that the frame of a load loaded is no
// longer a version of the document, as after a sitting that ended on the
// text where it started.
export const removed = (s: Load, e: unknown) => !s.text && answered(e)?.status === 404;
