import { describe, expect, it } from "vitest";
import type { Principal, Version } from "@/api";
import { historySessions, withoutUndone } from "./history";

const ana: Principal = { type: "user", id: "ana" };
const bot: Principal = { type: "service_account", id: "bot" };

function entry(
  number: number,
  by: Principal,
  minute: number,
  sha256?: string,
): Version {
  return {
    id: `ver_${number}`,
    number,
    created_by: by,
    sha256,
    created_at: new Date(Date.UTC(2026, 9, 1, 10, minute)).toISOString(),
  };
}

const ids = (versions: Version[]) => versions.map((v) => v.id);

describe("historySessions", () => {
  it("groups one person's entries until someone else edits or they pause", () => {
    const sessions = historySessions(
      [
        entry(1, bot, 0),
        entry(2, ana, 10),
        entry(3, ana, 12),
        entry(4, ana, 18),
        entry(5, bot, 51),
        entry(6, ana, 52),
      ],
      5 * 60_000,
    );
    expect(sessions.map((s) => [s.author?.id, ids(s.entries)])).toEqual([
      ["ana", ["ver_6"]],
      ["bot", ["ver_5"]],
      ["ana", ["ver_4"]],
      ["ana", ["ver_3", "ver_2"]],
      ["bot", ["ver_1"]],
    ]);
  });

  it("orders by number, not by the order the API listed", () => {
    const sessions = historySessions([entry(2, ana, 1), entry(1, ana, 0)]);
    expect(ids(sessions[0].entries)).toEqual(["ver_2", "ver_1"]);
  });
});

describe("withoutUndone", () => {
  it("leaves out an edit and the undo by the same person", () => {
    const versions = [
      entry(1, bot, 0, "a"),
      entry(2, ana, 1, "b"),
      entry(3, ana, 2, "a"),
      entry(4, ana, 3, "b"),
      entry(5, ana, 4, "a"),
      entry(6, ana, 5, "c"),
    ];
    expect(ids(withoutUndone(versions, new Set()))).toEqual(["ver_1", "ver_6"]);
  });

  it("leaves out every run by one person that ends where it started", () => {
    const shas = (...s: string[]) => s.map((sha, i) => entry(i + 2, ana, i + 1, sha));
    // A key and its Backspace.
    expect(
      ids(withoutUndone([entry(1, bot, 0, "a"), ...shas("ax", "a", "b")], new Set())),
    ).toEqual(["ver_1", "ver_4"]);
    // "Green" to "Greener" and back, in two saves each way.
    expect(
      ids(
        withoutUndone(
          [entry(1, bot, 0, "a"), ...shas("ae", "aer", "ae", "a", "b")],
          new Set(),
        ),
      ),
    ).toEqual(["ver_1", "ver_6"]);
    // q, qz, and back to the start in one save.
    expect(
      ids(
        withoutUndone(
          [entry(1, bot, 0, "a"), ...shas("aq", "aqz", "a", "b")],
          new Set(),
        ),
      ),
    ).toEqual(["ver_1", "ver_5"]);
    // "Greeny" and back as the newest run: the entry before it is the newest.
    expect(
      ids(withoutUndone([entry(1, bot, 0, "a"), ...shas("b", "by", "b")], new Set())),
    ).toEqual(["ver_1", "ver_2"]);
  });

  it("keeps a run that someone else's edit splits", () => {
    const versions = [
      entry(1, ana, 0, "a"),
      entry(2, ana, 1, "b"),
      entry(3, bot, 2, "c"),
      entry(4, ana, 3, "a"),
    ];
    expect(ids(withoutUndone(versions, new Set()))).toEqual(ids(versions));
  });

  it("keeps an undo of someone else's edit, and the entries to keep", () => {
    const versions = [
      entry(1, ana, 0, "a"),
      entry(2, bot, 1, "b"),
      entry(3, ana, 2, "a"),
    ];
    expect(ids(withoutUndone(versions, new Set()))).toEqual([
      "ver_1",
      "ver_2",
      "ver_3",
    ]);
    const mine = [entry(1, bot, 0, "a"), entry(2, ana, 1, "b"), entry(3, ana, 2, "a")];
    expect(ids(withoutUndone(mine, new Set(["ver_3"])))).toEqual([
      "ver_1",
      "ver_2",
      "ver_3",
    ]);
  });
});
