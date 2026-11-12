import { useEffect } from "react";
import { toast, type ExternalToast } from "sonner";
import { api, type Operation } from "@/api";
import { replacementsBetween, type Replacement } from "@/lib/source-edits";
import { applyOps, applyReplacements, mergeOps, sumOf } from "@/lib/source-merge";
import {
  readTextDrafts,
  removeTextDraft,
  typedText,
  unowned,
  writeTextDraft,
  type TextDraft,
} from "@/lib/text-drafts";
import { randomId } from "@/lib/uuid";
import { applied, passing } from "./live-load";

const COPIED_TOAST = "live-text-copied";
const EARLIER_TOAST = "live-text-earlier";

type Answer = Awaited<ReturnType<typeof api.sendOps>>;
type Draft = Omit<TextDraft, "updatedAt">;

// useEarlierDraft sends the text that did not save on earlier visits to the
// document when the page opens, with no step of the reader. A draft holds
// operations with their ids (see TextDraft), and the server applies an
// operation with one id once: also one that it took before, as from a page
// that went while the operation was on its way. A draft that a live load
// holds, in this tab or in another one, is left to that load. A draft that
// fails for a reason that can pass, as offline, goes again when the network
// is back. Only text that the server cannot place is offered to the reader,
// who copies it to add it again, or discards it. The loads of this visit
// keep their drafts under other ids, which this leaves. Only the drafts of
// owner, the principal of the reader, go and show.
export function useEarlierDraft(docId: string, owner?: string) {
  useEffect(() => {
    if (!owner) return;
    // The drafts that wait to go, and the text of each one that cannot go.
    const ids = new Set(Object.keys(readTextDrafts(owner, docId)));
    if (!ids.size) return;
    const failed = new Map<string, string>();
    let on = true;
    const settle = async () => {
      for (const id of [...ids]) {
        if (!on) return;
        const done = await unowned(id, async () => {
          const copy = await restore(owner, docId, id);
          if (copy) failed.set(id, copy);
        }).then(
          () => true,
          () => false,
        );
        if (done) ids.delete(id);
      }
      if (!on || !failed.size) return;
      toast.error("You have text in this document that was not saved.", {
        id: EARLIER_TOAST,
        duration: Infinity,
        action: copyAction(async () => [...failed.values()].join("\n\n")),
        cancel: {
          label: "Discard my change",
          onClick: () => failed.forEach((_, id) => removeTextDraft(owner, docId, id)),
        },
      });
    };
    // One try runs at a time, so that no draft goes twice at once.
    let trying: Promise<void> | undefined;
    const retry = () => void (trying ??= settle().finally(() => (trying = undefined)));
    retry();
    window.addEventListener("online", retry);
    return () => {
      on = false;
      window.removeEventListener("online", retry);
      toast.dismiss(EARLIER_TOAST);
    };
  }, [docId, owner]);
}

// restore sends the operations of a draft in order, and gives the text that
// cannot go, for the reader to copy. Storage follows each step, so that an
// operation that fails for a reason that can pass goes again as it is. It
// fails only for such a reason.
async function restore(
  owner: string,
  docId: string,
  id: string,
): Promise<string | undefined> {
  let draft: Draft | undefined = readTextDrafts(owner, docId)[id];
  while (draft?.op) {
    draft = await step(docId, draft.op, draft);
    writeTextDraft(owner, docId, id, draft);
  }
  if (!draft?.copy) removeTextDraft(owner, docId, id);
  return draft?.copy;
}

// step sends the operation of a draft, and gives the draft that is left: the
// text typed after it as the next operation, on the seq of the answer. That
// text moves over the operations of other people that the answer names.
// Text that the server cannot place is left to copy: a merge of sources
// with no operations could put text in twice.
async function step(docId: string, op: Operation, { version, next = [], copy }: Draft) {
  const left = (...texts: string[]): Draft => ({
    version,
    copy: [copy, ...texts].filter(Boolean).join("\n\n") || undefined,
  });
  // The source that op is on, from which next moves.
  const base = next.length ? await sourceAt(docId, version, op.base_seq) : undefined;
  let answer: Answer | undefined;
  try {
    answer = await api.sendOps(docId, op);
  } catch (e) {
    if (passing(e)) throw e;
    // The server did not apply op: its text and the text after it are to copy.
    if (!applied(e)) return left(typedText(op.replacements), typedText(next));
    // The server applied op before, and no longer has its answer.
  }
  if (!next.length) return left();
  const on = answer && base !== undefined ? moved(base, op, next, answer) : undefined;
  if (!answer || !on) return left(typedText(next));
  const replacements = replacementsBetween(on.head, on.source);
  if (!replacements.length) return left();
  const following = { base_seq: answer.seq, client_op_id: randomId(), replacements };
  return { ...left(), version: answer.version_id, op: following };
}

// moved gives the source of an answer, and that source with next on it:
// next, typed on the source that op makes of base, moves over the operations
// that the answer names. It gives nothing when the sources do not agree.
function moved(base: string, op: Operation, next: Replacement[], answer: Answer) {
  const target = applyReplacements(base, op.replacements);
  if (target === undefined) return undefined;
  const later = applyReplacements(target, next);
  const head = applyOps(target, answer.others);
  if (later === undefined || head === undefined || sumOf(head) !== answer.sum)
    return undefined;
  return { head, source: mergeOps(target, later, answer.others).source };
}

// sourceAt gives the source of the document at a seq of a version, or
// nothing when the server no longer has it.
const sourceAt = (docId: string, version: string, seq: number) =>
  api.versionSource(docId, version, seq).then(
    (at) => (at.seq === seq ? at.source : undefined),
    (e) => {
      if (passing(e)) throw e;
      return undefined;
    },
  );

// copyAction puts text that the reader typed on the clipboard. The message
// stays after a copy, so that the reader can still choose.
export function copyAction(text: () => Promise<string>): ExternalToast["action"] {
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
