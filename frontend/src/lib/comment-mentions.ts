import type { CommentMention, CommentMentionPrincipal, Principal } from "@/api";

export type MentionDraft = {
  body: string;
  mentions: CommentMention[];
};

export type MentionTextSegment = {
  text: string;
  mention?: CommentMention;
};

export type TextSelection = {
  start: number;
  end: number;
};

export type MentionTextEdit = {
  oldStart: number;
  oldEnd: number;
  newEnd: number;
};

export const MAX_COMMENT_MENTIONS = 50;

export function emptyMentionDraft(): MentionDraft {
  return { body: "", mentions: [] };
}

export function mentionPrincipalLabel(principal: Principal) {
  return principal.name || principal.email || principal.id;
}

// inferTextareaEdit reconstructs the exact range replaced by a native textarea
// edit from the selection captured in beforeinput and the post-edit caret. It
// deliberately returns null for browser edits that cannot be proven from those
// coordinates and the unchanged prefix/suffix.
export function inferTextareaEdit(
  oldBody: string,
  nextBody: string,
  before: TextSelection,
  after: TextSelection,
): MentionTextEdit | null {
  if (
    !validSelection(before, oldBody.length) ||
    !validSelection(after, nextBody.length) ||
    after.start !== after.end
  ) {
    return null;
  }

  const newEnd = after.start;
  const oldStart = newEnd < before.start ? newEnd : before.start;
  const oldEnd = oldBody.length + newEnd - nextBody.length;
  const edit = { oldStart, oldEnd, newEnd };
  if (!validMentionTextEdit(oldBody, nextBody, edit)) return null;

  if (before.start !== before.end) {
    return oldStart === before.start && oldEnd === before.end ? edit : null;
  }
  if (newEnd < before.start) {
    return oldEnd === before.end ? edit : null;
  }
  return oldEnd >= before.end ? edit : null;
}

// reconcileMentionDraft carries structured ranges through one exact textarea
// edit. JavaScript string indexes and lengths are UTF-16 code units, matching
// the API contract. Any edit that touches a mention drops its annotation rather
// than risking a stale principal-to-text association. An unprovable edit drops
// all annotations conservatively.
export function reconcileMentionDraft(
  draft: MentionDraft,
  nextBody: string,
  edit: MentionTextEdit | null,
): MentionDraft {
  if (draft.body === nextBody && !edit) return draft;
  if (!edit || !validMentionTextEdit(draft.body, nextBody, edit)) {
    return { body: nextBody, mentions: [] };
  }

  const delta = edit.newEnd - edit.oldEnd;
  const mentions: CommentMention[] = [];

  for (const mention of draft.mentions) {
    const mentionEnd = mention.offset + mention.length;
    let offset = mention.offset;
    if (mentionEnd <= edit.oldStart) {
      // The mention is wholly before the replaced range.
    } else if (edit.oldEnd <= mention.offset) {
      offset += delta;
    } else {
      continue;
    }

    const oldLabel = draft.body.slice(mention.offset, mentionEnd);
    if (nextBody.slice(offset, offset + mention.length) !== oldLabel) continue;
    if (!hasMentionTextBoundaries(nextBody, offset, offset + mention.length)) continue;
    mentions.push({ ...mention, offset });
  }

  return { body: nextBody, mentions: sortMentions(mentions) };
}

export function insertMention(
  draft: MentionDraft,
  start: number,
  end: number,
  principal: CommentMentionPrincipal,
): MentionDraft {
  if (draft.mentions.length >= MAX_COMMENT_MENTIONS) return draft;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > draft.body.length
  ) {
    return draft;
  }
  const label = `@${mentionPrincipalLabel(principal)}`;
  const body = draft.body.slice(0, start) + label + " " + draft.body.slice(end);
  const reconciled = reconcileMentionDraft(draft, body, {
    oldStart: start,
    oldEnd: end,
    newEnd: start + label.length + 1,
  });
  return {
    body,
    mentions: sortMentions([
      ...reconciled.mentions,
      { principal, offset: start, length: label.length },
    ]),
  };
}

// mentionTextSegments is defensive at the rendering boundary: malformed or
// overlapping server ranges render as ordinary text instead of breaking the
// comment body. Valid spans remain structured-only; there is no regex fallback.
export function mentionTextSegments(
  body: string,
  mentions: CommentMention[],
): MentionTextSegment[] {
  const segments: MentionTextSegment[] = [];
  let cursor = 0;
  for (const mention of sortMentions(mentions)) {
    const end = mention.offset + mention.length;
    if (
      !Number.isInteger(mention.offset) ||
      !Number.isInteger(mention.length) ||
      mention.offset < cursor ||
      mention.length <= 0 ||
      end > body.length ||
      !isUTF16Boundary(body, mention.offset) ||
      !isUTF16Boundary(body, end) ||
      !hasMentionTextBoundaries(body, mention.offset, end) ||
      !body.slice(mention.offset, end).startsWith("@") ||
      body.slice(mention.offset, end) === "@"
    ) {
      continue;
    }
    if (mention.offset > cursor)
      segments.push({ text: body.slice(cursor, mention.offset) });
    segments.push({ text: body.slice(mention.offset, end), mention });
    cursor = end;
  }
  if (cursor < body.length) segments.push({ text: body.slice(cursor) });
  if (segments.length === 0) segments.push({ text: body });
  return segments;
}

function sortMentions(mentions: CommentMention[]) {
  return [...mentions].sort(
    (a, b) =>
      a.offset - b.offset ||
      a.length - b.length ||
      a.principal.type.localeCompare(b.principal.type) ||
      a.principal.id.localeCompare(b.principal.id),
  );
}

function isUTF16Boundary(body: string, offset: number) {
  if (offset <= 0 || offset >= body.length) return true;
  const previous = body.charCodeAt(offset - 1);
  const next = body.charCodeAt(offset);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  );
}

function validSelection(selection: TextSelection, bodyLength: number) {
  return (
    Number.isInteger(selection.start) &&
    Number.isInteger(selection.end) &&
    selection.start >= 0 &&
    selection.start <= selection.end &&
    selection.end <= bodyLength
  );
}

function validMentionTextEdit(
  oldBody: string,
  nextBody: string,
  edit: MentionTextEdit,
) {
  if (
    !Number.isInteger(edit.oldStart) ||
    !Number.isInteger(edit.oldEnd) ||
    !Number.isInteger(edit.newEnd) ||
    edit.oldStart < 0 ||
    edit.oldStart > edit.oldEnd ||
    edit.oldEnd > oldBody.length ||
    edit.newEnd < edit.oldStart ||
    edit.newEnd > nextBody.length ||
    nextBody.length !== oldBody.length - edit.oldEnd + edit.newEnd
  ) {
    return false;
  }
  return (
    oldBody.slice(0, edit.oldStart) === nextBody.slice(0, edit.oldStart) &&
    oldBody.slice(edit.oldEnd) === nextBody.slice(edit.newEnd)
  );
}

function hasMentionTextBoundaries(body: string, start: number, end: number) {
  const previous = start === 0 ? "" : Array.from(body.slice(0, start)).at(-1) || "";
  const validStart =
    start === 0 || /\p{White_Space}/u.test(previous) || "([{".includes(previous);
  const validEnd = validMentionEndBoundary(body, end);
  return validStart && validEnd;
}

function validMentionEndBoundary(body: string, end: number) {
  for (const value of body.slice(end)) {
    if (/\p{White_Space}/u.test(value)) return true;
    if (
      !/\p{P}/u.test(value) ||
      /\p{Pc}/u.test(value) ||
      isMentionTokenPunctuation(value)
    ) {
      return false;
    }
  }
  return true;
}

function isMentionTokenPunctuation(value: string) {
  return "_%+-@'".includes(value);
}

export type MentionTarget = { start: number; end: number; query: string };

export function getMentionTarget(
  value: string,
  caret: number,
  mentions: CommentMention[] = [],
): MentionTarget | null {
  if (mentions.some((m) => caret > m.offset && caret <= m.offset + m.length))
    return null;
  const match = /(^|\p{White_Space}|[([{])@([\p{L}\p{N}._%+\-'’ ]*)$/u.exec(
    value.slice(0, caret),
  );
  if (!match || match[2].length > 100) return null;
  const start = match.index + match[1].length;
  if (mentions.some((m) => start >= m.offset && start < m.offset + m.length))
    return null;
  return { start, end: caret, query: match[2] };
}
