import { blockOf, equalPairs, sameEnds } from "./dom.ts";

// Changed blocks tell a reader what changed when a new version loads: the
// bridge keeps the text of each block as the document goes, and the next load
// of the same document compares its blocks with them.

// Text that is not the document's words: code, and the bridge's controls.
const NOT_WORDS =
  "script,style,noscript,template,.slashdocs-selection-action,.slashdocs-heading-link";

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
// When the blocks between the first and the last change are too many to
// compare, each of them counts as changed.
export function changedBlocks(
  before: readonly string[],
  after: readonly string[],
): number[] {
  const [start, end] = sameEnds(before, after);
  const count = after.length - start - end;
  const kept = new Set(
    equalPairs(
      before.length - start - end,
      count,
      (i, j) => before[start + i] === after[start + j],
    ).map(([, j]) => j),
  );
  return Array.from({ length: count }, (_, j) => start + j).filter(
    (_, j) => !kept.has(j),
  );
}
