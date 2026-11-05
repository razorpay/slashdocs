import { useCallback, useEffect, useRef, useState } from "react";
import { readFieldDraft, saveFieldDraft, useFieldDraft } from "./field-drafts";

// useEditDraft is the text of a form field, kept as a field draft under `key`
// (useFieldDraft), and what the words are for: `now` when the reader starts
// to type. That is the saved value that the field edits, such as a title or
// the labels, or the version that a reason is about. With no words, the
// field shows `start`.
//
// Someone else can change `now` while the field is open. The field then keeps
// the reader's words, and `stale` holds until the reader chooses: `follow`
// writes the words for the new `now`, and `discard` drops them. A form sends
// only when it is not stale, so that it never sends words for something that
// the reader did not see.
export function useEditDraft(key: string, now: string, start = "") {
  const [restored] = useState(() => readFieldDraft(key));
  const [about, setAbout] = useState(restored?.about ?? now);
  const [touched, setTouched] = useState(!!restored);
  const { text, setText, conflict } = useFieldDraft(key, about);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => void (mounted.current = false);
  }, []);
  const value = touched ? text : start;
  return {
    value,
    about,
    stale: about !== now && value !== now,
    // The words came back from an earlier visit, as they were.
    cameBack: !!restored && touched && text === restored.body,
    conflict,
    setValue: (next: string) => {
      if (!touched) {
        setTouched(true);
        setAbout(now);
      }
      setText(next);
    },
    follow: () => {
      setAbout(now);
      setText((same) => same);
    },
    discard: () => {
      setTouched(false);
      setAbout(now);
      setText("");
    },
    // A success clears only the words that it sent, also after the form closed.
    sent: useCallback(
      (words: string) => {
        if (mounted.current) {
          if (setText((now) => (same(now, words) ? "" : now)) === "") setTouched(false);
        } else if (same(readFieldDraft(key)?.body, words)) saveFieldDraft(key, "");
      },
      [key, setText],
    ),
  };
}

const same = (now = "", sent: string) => now.trim() === sent.trim();

export type EditDraft = ReturnType<typeof useEditDraft>;
