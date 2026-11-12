import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentEvent, Principal } from "@/api";
import { samePrincipal } from "@/lib/principals";

// The server takes no approval while another person typed in the document
// in this time.
export const TYPING_MS = 10_000;

// useTypists follows who changes the document, from each event of the
// document: hear takes every event, also two that come in one render.
// typists are the people other than the reader who typed in the last
// TYPING_MS. A person leaves the list by itself when they stop for that
// long. madeBy gives the people who made the changes that are not typing
// after a seq, up to another one: a push waits for the reader, and typing
// does not. It gives none when no event named a change of those seqs, and
// an empty list when all of them were typing. shown is the seq that the
// frame shows: madeBy is never asked about a seq at or before it.
export function useTypists(reader?: Principal, shown?: number) {
  const [typed, setTyped] = useState<{ who: Principal; at: number }[]>([]);
  // The people who made the change of each seq, and none for typing. The
  // first event of a seq is the one of its operation: an event that seals
  // the version later names the seq again, with the person who sealed it.
  const made = useRef(new Map<number, Principal[]>());
  const hear = useCallback((event: DocumentEvent) => {
    const { seq, typed, authors } = event;
    if (!authors?.length || made.current.has(seq)) return;
    made.current.set(seq, typed ? [] : authors);
    if (!typed) return;
    const at = Date.now();
    setTyped((list) => [
      ...list.filter(
        ({ who }) => !authors.some((author) => samePrincipal(author, who)),
      ),
      ...authors.map((who) => ({ who, at })),
    ]);
  }, []);
  const madeBy = useCallback((after: number, upto: number) => {
    const known = [...made.current].filter(([seq]) => seq > after && seq <= upto);
    if (!known.length) return undefined;
    const authors = known.flatMap(([, authors]) => authors);
    return authors.filter(
      (who, i) => authors.findIndex((p) => samePrincipal(p, who)) === i,
    );
  }, []);
  useEffect(() => {
    if (shown === undefined) return;
    for (const seq of made.current.keys()) if (seq <= shown) made.current.delete(seq);
  }, [shown]);
  useEffect(() => {
    if (!typed.length) return;
    const first = Math.min(...typed.map(({ at }) => at));
    const timer = window.setTimeout(
      () => setTyped((list) => list.filter(({ at }) => at > Date.now() - TYPING_MS)),
      first + TYPING_MS - Date.now(),
    );
    return () => window.clearTimeout(timer);
  }, [typed]);
  const typists = useMemo(
    () => typed.flatMap(({ who }) => (samePrincipal(who, reader) ? [] : [who])),
    [typed, reader],
  );
  return { typists, hear, madeBy };
}
