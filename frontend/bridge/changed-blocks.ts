import { blockOf } from "./dom.ts";

// Changed blocks tell a reader what changed when a new version loads: the
// bridge keeps the text of each block as the document goes, and the next load
// of the same document compares its blocks with them.

// Text that is not the document's words: code, and the bridge's controls.
const NOT_WORDS =
  "script,style,noscript,template,.slashdocs-selection-action,.slashdocs-heading-link";
// The comparison of the blocks between the first and the last change takes at
// most this many steps. A larger change counts every block in it as changed.
const MAX_STEPS = 1_000_000;

export type Block = { nodes: Text[]; text: string };

// blockTexts gives the blocks of document d in order, each with its own text:
// the text nodes whose nearest block it is.
export function blockTexts(d: Document): Block[] {
  const blocks = new Map<Element, Block>();
  const walker = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    const block = blockOf(node);
    if (!block || !node.data.trim() || node.parentElement?.closest(NOT_WORDS)) continue;
    const entry = blocks.get(block) ?? { nodes: [], text: "" };
    entry.nodes.push(node);
    entry.text += node.data;
    blocks.set(block, entry);
  }
  return [...blocks.values()].map(({ nodes, text }) => ({
    nodes,
    text: text.replace(/\s+/g, " ").trim(),
  }));
}

// changedBlocks gives the indexes of the blocks in after that are not in
// before, from the longest run of blocks that both have in the same order.
export function changedBlocks(
  before: readonly string[],
  after: readonly string[],
): number[] {
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  let end = 0;
  while (
    end < Math.min(before.length, after.length) - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  )
    end++;
  const a = before.slice(start, before.length - end);
  const b = after.slice(start, after.length - end);
  const changed = b.map((_, j) => start + j);
  if (!a.length || a.length * b.length > MAX_STEPS) return changed;
  // common[i][j] is the length of the longest common run of a from i and b from j.
  const common = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      common[i][j] =
        a[i] === b[j]
          ? common[i + 1][j + 1] + 1
          : Math.max(common[i + 1][j], common[i][j + 1]);
  const kept = new Set<number>();
  for (let i = 0, j = 0; i < a.length && j < b.length;) {
    if (a[i] === b[j]) {
      kept.add(start + j);
      i++;
      j++;
    } else if (common[i + 1][j] >= common[i][j + 1]) i++;
    else j++;
  }
  return changed.filter((j) => !kept.has(j));
}
