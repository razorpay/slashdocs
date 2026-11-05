import type { ReactNode } from "react";
import { Notice, NoticeAction } from "@/components/ui/notice";
import type { EditDraft } from "@/lib/edit-drafts";

const quote = (text: string) => (
  <span className="whitespace-pre-wrap break-words">{text}</span>
);

// DraftNotice tells the reader about the words in a form field: another tab
// changed them, what they are for changed elsewhere, or they came back from
// an earlier visit. It shows the most urgent one. The words stay in the field
// until the reader chooses.
export function DraftNotice({
  draft,
  cameBack,
  stale,
}: {
  draft: EditDraft;
  // What the words that came back were written for.
  cameBack: string;
  // What changed elsewhere, and the two choices: take the new state without
  // the reader's words (discard by default), or keep the words for it
  // (follow by default).
  stale?: {
    say: string;
    quote?: string;
    take: string;
    keep: string;
    onTake?: () => void;
    onKeep?: () => void;
  };
}): ReactNode {
  const { conflict } = draft;
  if (conflict)
    return (
      <Notice
        say="This draft changed in another tab. It now says:"
        quotes={[quote(conflict.theirs.body)]}
      >
        <NoticeAction onClick={conflict.take}>Use the new text</NoticeAction>
        <NoticeAction onClick={conflict.keep}>Keep mine</NoticeAction>
      </Notice>
    );
  if (draft.stale && stale)
    return (
      <Notice
        say={stale.say}
        quotes={stale.quote === undefined ? [] : [quote(stale.quote)]}
      >
        <NoticeAction onClick={stale.onTake ?? draft.discard}>
          {stale.take}
        </NoticeAction>
        <NoticeAction onClick={stale.onKeep ?? draft.follow}>{stale.keep}</NoticeAction>
      </Notice>
    );
  if (draft.cameBack)
    return (
      <Notice say={cameBack}>
        <NoticeAction onClick={draft.discard}>Discard</NoticeAction>
      </Notice>
    );
  return null;
}
