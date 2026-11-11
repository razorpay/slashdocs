import { describe, expect, it } from "vitest";
import type { FolderEntry } from "@/api";
import { sortEntries } from "./sort-entries";

const doc = (id: string, title: string, last_active?: string): FolderEntry => ({
  type: "document",
  document: { id, title },
  last_active,
});
const titles = (entries: FolderEntry[]) =>
  entries.map((e) => e.folder?.title || e.document?.title);

describe("sortEntries", () => {
  const entries = [
    doc("d10", "10 · Agents", "2026-03-03T00:00:00Z"),
    doc("d2", "2 · Prompts", "2026-03-01T00:00:00Z"),
    doc("d1", "1 · Basics", "2026-03-02T00:00:00Z"),
    { type: "folder", folder: { id: "f", title: "Labs" } } as FolderEntry,
  ];

  it("puts folders first, then the latest activity", () => {
    expect(titles(sortEntries(entries, new Set()))).toEqual([
      "Labs",
      "10 · Agents",
      "1 · Basics",
      "2 · Prompts",
    ]);
  });

  it("orders numbered names as people read them, after pinned entries", () => {
    expect(titles(sortEntries(entries, new Set(["d10"]), "name"))).toEqual([
      "10 · Agents",
      "Labs",
      "1 · Basics",
      "2 · Prompts",
    ]);
    expect(titles(sortEntries(entries, new Set(), "name"))).toEqual([
      "Labs",
      "1 · Basics",
      "2 · Prompts",
      "10 · Agents",
    ]);
  });
});
