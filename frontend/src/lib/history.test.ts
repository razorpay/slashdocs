import { describe, expect, it } from "vitest";
import type { Principal, Version } from "@/api";
import { historySessions } from "./history";

const ana: Principal = { type: "user", id: "ana" };
const bot: Principal = { type: "service_account", id: "bot" };

function entry(number: number, by: Principal, minute: number): Version {
  return {
    id: `ver_${number}`,
    number,
    created_by: by,
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
        entry(4, ana, 50),
        entry(5, bot, 51),
        entry(6, ana, 52),
      ],
      30 * 60_000,
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
