import { assert, test } from "vitest";

import type { CommentMention, CommentMentionPrincipal } from "../api.ts";
import {
  inferTextareaEdit,
  getMentionTarget,
  insertMention,
  mentionTextSegments,
  reconcileMentionDraft,
} from "./comment-mentions.ts";

const alice: CommentMentionPrincipal = {
  type: "user",
  id: "usr_alice",
  name: "Alice",
  email: "alice@example.com",
};

const bob: CommentMentionPrincipal = {
  type: "user",
  id: "usr_bob",
  name: "Bob",
  email: "bob@example.com",
};

function mention(
  principal: CommentMentionPrincipal,
  offset: number,
  length: number,
): CommentMention {
  return { principal, offset, length };
}

test("reconciliation keeps the tagged occurrence when identical text is inserted before it", () => {
  const draft = {
    body: "@Alice",
    mentions: [mention(alice, 0, 6)],
  };

  const edit = inferTextareaEdit(
    draft.body,
    "@Alice @Alice",
    { start: 0, end: 0 },
    { start: 7, end: 7 },
  );
  assert.deepEqual(edit, { oldStart: 0, oldEnd: 0, newEnd: 7 });

  const got = reconcileMentionDraft(draft, "@Alice @Alice", edit);

  assert.deepEqual(got, {
    body: "@Alice @Alice",
    mentions: [mention(alice, 7, 6)],
  });
});

test("reconciliation drops a deleted tagged occurrence instead of rebinding identical text", () => {
  const draft = {
    body: "@Alice @Alice",
    mentions: [mention(alice, 0, 6)],
  };

  const edit = inferTextareaEdit(
    draft.body,
    "@Alice",
    { start: 0, end: 7 },
    { start: 0, end: 0 },
  );
  assert.deepEqual(edit, { oldStart: 0, oldEnd: 7, newEnd: 0 });

  const got = reconcileMentionDraft(draft, "@Alice", edit);

  assert.deepEqual(got, { body: "@Alice", mentions: [] });
});

test("reconciliation drops an exact same-text replacement of a tagged mention", () => {
  const draft = {
    body: "@Alice",
    mentions: [mention(alice, 0, 6)],
  };

  const edit = inferTextareaEdit(
    draft.body,
    "@Alice",
    { start: 0, end: 6 },
    { start: 6, end: 6 },
  );
  assert.deepEqual(edit, { oldStart: 0, oldEnd: 6, newEnd: 6 });

  const got = reconcileMentionDraft(draft, "@Alice", edit);

  assert.deepEqual(got, { body: "@Alice", mentions: [] });
});

test("insertMention replaces an exactly selected tagged mention", () => {
  const draft = {
    body: "@Alice",
    mentions: [mention(alice, 0, 6)],
  };

  assert.deepEqual(insertMention(draft, 0, 6, bob), {
    body: "@Bob ",
    mentions: [mention(bob, 0, 4)],
  });
});

test("rendering rejects structured ranges embedded in longer mention tokens", () => {
  for (const [body, candidate] of [
    ["@Alice_evil", mention(alice, 0, 6)],
    ["@Alice'evil", mention(alice, 0, 6)],
    ["@alice@example.com.evil", mention(alice, 0, 18)],
    ["@Alice．evil", mention(alice, 0, 6)],
    ["@Alice‿evil", mention(alice, 0, 6)],
    ["@Alice…!evil", mention(alice, 0, 6)],
    ["@Alice…”$", mention(alice, 0, 6)],
  ] as const) {
    assert.deepEqual(mentionTextSegments(body, [candidate]), [{ text: body }]);
  }
});

test("rendering preserves structured ranges before terminal punctuation", () => {
  for (const body of ["@Alice.", "@Alice, next", "@Alice…” next"]) {
    const candidate = mention(alice, 0, 6);
    const segments = mentionTextSegments(body, [candidate]);

    assert.deepEqual(segments[0], { text: "@Alice", mention: candidate });
    assert.strictEqual(
      segments
        .slice(1)
        .map(({ text }) => text)
        .join(""),
      body.slice(6),
    );
  }
});

test("mention search accepts full names and Unicode without reopening accepted tags", () => {
  assert.deepEqual(getMentionTarget("Review @Anurag Rao", 18), {
    start: 7,
    end: 18,
    query: "Anurag Rao",
  });
  assert.strictEqual(getMentionTarget("me@example.com", 14), null);
  assert.strictEqual(
    getMentionTarget("@Alice please review", 20, [mention(alice, 0, 6)]),
    null,
  );
  assert.deepEqual(getMentionTarget("@José", 5), { start: 0, end: 5, query: "José" });
});
