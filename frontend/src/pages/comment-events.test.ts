import { describe, expect, it } from "vitest";
import type { Comment, DocumentKVEvent, Principal } from "@/api";
import { withThread } from "./comment-events";

const me = { type: "user" as const, id: "usr_me" };
const asha = { type: "user" as const, id: "usr_a", name: "Asha" };

const comment = (
  id: string,
  author: Principal = asha,
  extra: Partial<Comment> = {},
): Comment => ({
  id,
  body: id,
  status: "open",
  author,
  created_on_version_id: "ver_1",
  ...extra,
});
const event = (id: string, thread?: Comment) =>
  ({
    document_id: "doc_1",
    revision: 1,
    changes: [],
    data: { id, thread },
  }) as DocumentKVEvent;

describe("withThread", () => {
  it("adds a new thread at the end, unread when someone else wrote it", () => {
    const items = [comment("cm_1", me)];

    expect(withThread(items, event("cm_2", comment("cm_2")), me)).toEqual([
      items[0],
      { ...comment("cm_2"), unread: true },
    ]);
    expect(withThread(items, event("cm_2", comment("cm_2", me)), me)?.[1].unread).toBe(
      false,
    );
  });

  it("makes a thread unread only for a new message by someone else", () => {
    const before = comment("cm_1", me, { replies: [comment("cm_r1")] });
    const items = [before];

    const edited = { ...before, body: "edited" };
    expect(withThread(items, event("cm_1", edited), me)?.[0].unread).toBe(false);

    const ownReply = { ...before, replies: [...before.replies!, comment("cm_r2", me)] };
    expect(withThread(items, event("cm_1", ownReply), me)?.[0].unread).toBe(false);

    const reply = { ...before, replies: [...before.replies!, comment("cm_r2")] };
    expect(withThread(items, event("cm_1", reply), me)?.[0]).toEqual({
      ...reply,
      unread: true,
    });
  });

  it("keeps a thread unread until the reader reads it", () => {
    const items = [comment("cm_1", asha, { unread: true })];

    expect(withThread(items, event("cm_1", comment("cm_1")), me)?.[0].unread).toBe(
      true,
    );
  });

  it("gives a signed-out reader no read state", () => {
    expect(withThread([], event("cm_1", comment("cm_1")))?.[0].unread).toBe(false);
  });

  it("marks the reactions of the reader, on the thread and its replies", () => {
    const reactions = [
      { emoji: "+1", count: 2, reacted: false, reactors: [asha, me] },
      { emoji: "eyes", count: 1, reacted: false, reactors: [asha] },
    ];
    const thread = comment("cm_1", asha, {
      reactions,
      replies: [comment("cm_r1", asha, { reactions })],
    });

    const [got] = withThread([], event("cm_1", thread), me)!;

    const reacted = [true, false];
    expect(got.reactions?.map((r) => r.reacted)).toEqual(reacted);
    expect(got.replies?.[0].reactions?.map((r) => r.reacted)).toEqual(reacted);
  });

  it("takes out a thread that is gone", () => {
    const items = [comment("cm_1"), comment("cm_2")];

    expect(withThread(items, event("cm_1"), me)).toEqual([items[1]]);
  });

  it("gives nothing for an event with no thread data", () => {
    expect(
      withThread([], { document_id: "doc_1", revision: 1, changes: [] }, me),
    ).toBeUndefined();
  });
});
