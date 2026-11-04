const words = new Intl.Segmenter(undefined, { granularity: "word" });

// wordAt gives the word in text that holds the character at index, or null
// where that character is not part of a word.
function wordAt(text: string, index: number): { start: number; end: number } | null {
  const segment = index >= 0 ? words.segment(text).containing(index) : undefined;
  if (!segment?.isWordLike) return null;
  return { start: segment.index, end: segment.index + segment.segment.length };
}

/**
 * Return a copy of `range` whose ends move out to whole words, so that a
 * drag which starts or stops in a word quotes the full word.
 */
export function snapToWords(range: Range): Range {
  const snapped = range.cloneRange();
  const { startContainer, startOffset, endContainer, endOffset } = range;
  if (startContainer.nodeType === Node.TEXT_NODE) {
    const word = wordAt(startContainer.nodeValue!, startOffset);
    if (word) snapped.setStart(startContainer, word.start);
  }
  if (endContainer.nodeType === Node.TEXT_NODE) {
    const word = wordAt(endContainer.nodeValue!, endOffset - 1);
    if (word) snapped.setEnd(endContainer, word.end);
  }
  return snapped;
}
