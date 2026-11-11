// The disruption score says how much a change that is not live typing
// moves under a reader. A small change applies in place. A large one waits
// behind a banner until the reader asks for it.

import type { SourceTree } from "./source-edits";
import { patchBetween, patchRun } from "./source-patch";

// The most words and places that a change can have and still apply in
// place. More than that, the text moves too much to keep reading.
export const QUIET_MAX_WORDS = 40;
export const QUIET_MAX_PLACES = 3;

// words counts the words that a change adds plus those that it removes, in
// the text that a reader sees. places counts the runs that change. reload
// says that the change cannot apply in place, and then the counts are 0.
export type Disruption = {
  words: number;
  places: number;
  reload: boolean;
  disruptive: boolean;
};

// disruption scores the change from the source that the frame loaded to
// target.
export function disruption(tree: SourceTree, target: string): Disruption {
  const result = patchBetween(tree, target);
  if ("reload" in result)
    return { words: 0, places: 0, reload: true, disruptive: true };
  let words = 0;
  for (const patch of result.patches) {
    // The count of each word in the old run, less its count in the new one.
    const counts = new Map<string, number>();
    const count = (html: string, step: number) => {
      for (const word of wordsOf(tree, html))
        counts.set(word, (counts.get(word) ?? 0) + step);
    };
    count(tree.source.slice(...patchRun(tree, patch)), 1);
    count(patch.html, -1);
    for (const left of counts.values()) words += Math.abs(left);
  }
  const places = result.patches.length;
  return {
    words,
    places,
    reload: false,
    disruptive: words > QUIET_MAX_WORDS || places > QUIET_MAX_PLACES,
  };
}

const TAG = /<[^>]*>/g;
const REFERENCE = /&(?:#\d+|#x[\da-f]+|[a-z][a-z\d]*);/gi;

// wordsOf gives the words of the text of HTML: the runs of characters that
// are not white space, without the tags and with the character references
// decoded.
const wordsOf = (tree: SourceTree, html: string) =>
  html
    .replace(TAG, " ")
    .replace(REFERENCE, (reference) => tree.decode(reference))
    .match(/\S+/g) ?? [];
