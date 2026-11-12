// Helpers for the Slack-style document search language. The server owns the
// meaning of a query; these helpers only find, mark, and replace its tokens.

export const SEARCH_MODIFIERS = [
  { key: "from", hint: "Documents from a person" },
  { key: "in", hint: "Documents in a folder" },
  { key: "before", hint: "Updated before a date" },
  { key: "after", hint: "Updated after a date" },
  { key: "on", hint: "Updated on a date" },
  { key: "during", hint: "Updated during a week, month, or year" },
] as const;

export const DATE_KEYS = new Set(["before", "after", "on", "during"]);

// label: is left out of suggestions while labels are gated, and the aliases
// keep earlier queries working.
const MODIFIER_KEYS = new Set([
  ...SEARCH_MODIFIERS.map((m) => m.key),
  "label",
  "labels",
  "author",
]);

export type SearchToken = {
  start: number;
  end: number;
  text: string;
  // Set when the token is a known modifier, such as "from" in from:alice.
  key?: string;
  value: string;
};

// Split on whitespace outside double quotes, as the server does. A date goes
// on over the next words that can be part of a date, as in after:last week.
export function searchTokens(query: string): SearchToken[] {
  const tokens: SearchToken[] = [];
  for (const match of query.matchAll(/(?:"[^"]*(?:"|$)|[^\s"])+/g)) {
    const text = match[0];
    const previous = tokens.at(-1);
    if (previous?.key && DATE_KEYS.has(previous.key) && isDateWord(text)) {
      previous.end = match.index + text.length;
      previous.text = query.slice(previous.start, previous.end);
      previous.value = previous.text.slice(previous.key.length + 1).replaceAll('"', "");
      continue;
    }
    const modifier = /^([a-z]+):(.*)$/i.exec(text);
    const key = modifier?.[1].toLowerCase();
    const known = !!key && MODIFIER_KEYS.has(key);
    tokens.push({
      start: match.index,
      end: match.index + text.length,
      text,
      key: known ? key : undefined,
      value: (known ? modifier![2] : text).replaceAll('"', ""),
    });
  }
  return tokens;
}

// Words of dates, such as "last", "week", and "september". The server has
// the full rules. Here a start of a word is enough, because the last word is
// often still being typed.
const DATE_WORDS = [
  ..."today yesterday this last past ago of day days week weeks month months year years".split(
    " ",
  ),
  ..."january february march april may june july august september october november december".split(
    " ",
  ),
  ..."monday tuesday wednesday thursday friday saturday sunday".split(" "),
];

function isDateWord(word: string): boolean {
  const w = word.toLowerCase().replace(/,$/, "");
  return /^[\d/.-]+(st|nd|rd|th)?$/.test(w) || DATE_WORDS.some((d) => d.startsWith(w));
}

// The token that the cursor is in or at the end of. Between tokens, it is
// an empty token at the cursor.
export function searchTokenAt(query: string, cursor: number): SearchToken {
  return (
    searchTokens(query).find((t) => t.start <= cursor && cursor <= t.end) || {
      start: cursor,
      end: cursor,
      text: "",
      value: "",
    }
  );
}

// Reports whether the query is more than plain words. The folder results on
// the documents page match plain words only.
export function hasDocumentSearchOperators(query: string): boolean {
  return searchTokens(query).some(
    (t) => t.key || t.text.startsWith('"') || /^-./.test(t.text),
  );
}

export function replaceSearchToken(
  query: string,
  token: SearchToken,
  replacement: string,
): { value: string; cursor: number } {
  // A finished modifier ends with a space, so the next word starts fresh.
  const tail = query.slice(token.end);
  const space = replacement.endsWith(":") || tail.startsWith(" ") ? "" : " ";
  const value = query.slice(0, token.start) + replacement + space + tail;
  return { value, cursor: token.start + replacement.length + space.length };
}

export function quoteSearchValue(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}
