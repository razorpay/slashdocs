import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Calendar, Folder, Search, SlidersHorizontal, UserRound } from "lucide-react";
import { api } from "@/api";
import { Avatar } from "@/components/ui/misc";
import { queryKeys } from "@/lib/queryKeys";
import {
  DATE_KEYS,
  quoteSearchValue,
  replaceSearchToken,
  SEARCH_MODIFIERS,
  searchTokenAt,
  searchTokens,
  type SearchToken,
} from "@/lib/search-query";

type Suggestion = {
  label: string;
  detail?: string;
  icon: ReactNode;
  replacement: string;
};

type Suggestions = { heading: string; items: Suggestion[]; status?: string };

// A Slack-style search box: modifiers are highlighted as you type, and the
// menu below suggests modifiers, people, folders, and dates for the token at
// the cursor.
export function DocumentSearchInput({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(value.length);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const token = useMemo(() => searchTokenAt(value, cursor), [value, cursor]);
  const lookup = remoteQuery(token);
  const lookupText = useDebounced(lookup.query, 150);

  const people = useQuery({
    queryKey: queryKeys.userSearch(lookupText),
    queryFn: () => api.searchUsers(lookupText),
    enabled: lookup.key === "from" && lookupText.length >= 2,
    staleTime: 30_000,
  });
  const folders = useQuery({
    queryKey: [...queryKeys.folders(), lookupText],
    queryFn: () => api.listFolders(undefined, undefined, lookupText),
    enabled: lookup.key === "in" && lookupText.length >= 1,
    staleTime: 30_000,
  });

  const suggestions = suggestionsFor(token, value, {
    people: people.data?.items.map((person) => ({
      label: person.name || person.email || person.id,
      detail: person.name ? person.email : undefined,
      icon: (
        <Avatar src={person.picture_url} name={person.name || person.email} size={20} />
      ),
      replacement: `from:${person.email || person.id}`,
    })),
    folders: folders.data?.items.flatMap(({ folder }) =>
      folder
        ? [
            {
              label: folder.title,
              detail: folder.owner?.name,
              icon: <Folder className="h-4 w-4" />,
              replacement: `in:${quoteSearchValue(folder.title)}`,
            },
          ]
        : [],
    ),
    searching: people.isFetching || folders.isFetching,
  });
  const items = suggestions?.items || [];
  const open = focused && !dismissed && !!suggestions;

  useEffect(() => setActiveIndex(0), [suggestions?.heading, items.length]);

  function syncCursor() {
    const input = inputRef.current;
    if (!input) return;
    setCursor(input.selectionStart ?? input.value.length);
    if (mirrorRef.current) mirrorRef.current.scrollLeft = input.scrollLeft;
  }

  function choose(index: number) {
    const suggestion = items[index];
    if (!suggestion) return;
    const next = replaceSearchToken(value, token, suggestion.replacement);
    onChange(next.value);
    setCursor(next.cursor);
    window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.cursor, next.cursor);
      syncCursor();
    });
  }

  return (
    // The search is the page's composer, so it takes Slash's RazorSense ring.
    // The ring isolates its stacking context, so the z-index lifts the whole
    // box, suggestions included, above the cards that follow it.
    <div className="razorsense-ring z-20 w-full rounded-[18px]">
      <Search className="pointer-events-none absolute left-5 top-1/2 z-10 h-5 w-5 -translate-y-1/2 text-[var(--color-fg-muted)]" />
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => {
          setDismissed(false);
          onChange(event.target.value);
          setCursor(event.target.selectionStart ?? event.target.value.length);
        }}
        onSelect={syncCursor}
        onScroll={syncCursor}
        onFocus={() => setFocused(true)}
        spellCheck={false}
        onBlur={() => {
          setFocused(false);
          setDismissed(false);
        }}
        onKeyDown={(event) => {
          if (!open) return;
          if (event.key === "Escape") {
            event.preventDefault();
            setDismissed(true);
          }
          if (items.length === 0) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActiveIndex((index) => (index + step + items.length) % items.length);
          } else if (event.key === "Enter" || (event.key === "Tab" && token.text)) {
            event.preventDefault();
            choose(activeIndex);
          }
        }}
        placeholder="Search every word, even the footnotes…"
        className="h-14 w-full rounded-[18px] bg-[var(--color-surface)] pl-14 pr-5 text-base text-transparent caret-[var(--color-fg)] shadow-[0_12px_40px_rgb(20_30_48/0.1)] outline-none placeholder:text-[var(--color-fg-muted)] dark:shadow-[0_14px_36px_rgb(0_0_0/0.42)]"
        role="combobox"
        aria-label="Search documents"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? "document-search-suggestions" : undefined}
        aria-activedescendant={
          open && items.length > 0
            ? `document-search-suggestion-${activeIndex}`
            : undefined
        }
      />
      {/* The input text is transparent. This copy draws it with modifiers
          highlighted, clipped to the input's content box: pl-14 / pr-5. */}
      <div
        ref={mirrorRef}
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-14 right-5 flex items-center overflow-hidden whitespace-pre text-base text-[var(--color-fg)]"
      >
        <HighlightedQuery value={value} />
      </div>
      {open ? (
        <div
          id="document-search-suggestions"
          role="listbox"
          aria-label={suggestions.heading}
          className="absolute inset-x-0 top-[calc(100%+8px)] z-50 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-1 text-left shadow-[var(--shadow-pop)] dark:border-transparent"
        >
          <p className="px-3 pb-1 pt-2 text-xs font-medium text-[var(--color-fg-muted)]">
            {suggestions.heading}
          </p>
          {items.map((item, index) => (
            <button
              id={`document-search-suggestion-${index}`}
              key={item.replacement}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className="flex min-h-10 w-full items-center gap-3 rounded-sm px-3 py-2 text-left transition-[background-color,color] duration-150 ease-out hover:bg-[var(--color-surface-muted)] aria-selected:bg-[var(--color-surface-muted)]"
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(index)}
            >
              <span className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--color-fg-muted)]">
                {item.icon}
              </span>
              <span className="min-w-0 truncate text-sm font-medium">{item.label}</span>
              {item.detail ? (
                <span className="ml-auto min-w-0 shrink truncate text-xs text-[var(--color-fg-muted)]">
                  {item.detail}
                </span>
              ) : null}
            </button>
          ))}
          {suggestions.status ? (
            <p className="px-3 py-2 text-sm text-[var(--color-fg-muted)]">
              {suggestions.status}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function HighlightedQuery({ value }: { value: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const token of searchTokens(value)) {
    if (!token.key) continue;
    parts.push(value.slice(last, token.start));
    parts.push(
      // A shadow, not padding, so the text keeps the input's exact positions.
      <span
        key={token.start}
        className="rounded-[3px] bg-[var(--color-accent)]/15 text-[var(--color-accent)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-accent)_15%,transparent)]"
      >
        {token.text}
      </span>,
    );
    last = token.end;
  }
  parts.push(value.slice(last));
  return <>{parts}</>;
}

// The text that people and folder suggestions search for.
function remoteQuery(token: SearchToken): { key?: string; query: string } {
  const key = token.key === "author" ? "from" : token.key;
  return { key, query: token.value.replace(/^[@#]/, "").trim() };
}

function suggestionsFor(
  token: SearchToken,
  query: string,
  found: { people?: Suggestion[]; folders?: Suggestion[]; searching: boolean },
): Suggestions | null {
  const typed = token.value.replace(/^[@#]/, "").toLowerCase();
  const { key } = remoteQuery(token);
  if (!key) {
    const text = token.text.toLowerCase();
    if (text === "" ? query.trim() !== "" : text.includes(":")) return null;
    const items = SEARCH_MODIFIERS.filter((m) => m.key.startsWith(text)).map((m) => ({
      label: `${m.key}:`,
      detail: m.hint,
      icon: <SlidersHorizontal className="h-4 w-4" />,
      replacement: `${m.key}:`,
    }));
    return items.length ? { heading: "Narrow your search", items } : null;
  }
  if (key === "from") {
    const me: Suggestion[] = "me".startsWith(typed)
      ? [
          {
            label: "me",
            detail: "Your documents",
            icon: <UserRound className="h-4 w-4" />,
            replacement: "from:me",
          },
        ]
      : [];
    const items = [...me, ...(typed.length >= 2 ? found.people || [] : [])];
    return {
      heading: "People",
      items,
      status: statusFor(typed.length >= 2, found.searching, items.length, "people"),
    };
  }
  if (key === "in") {
    const items = typed ? found.folders || [] : [];
    return {
      heading: "Folders",
      items,
      status: statusFor(!!typed, found.searching, items.length, "folders"),
    };
  }
  if (DATE_KEYS.has(key)) {
    const items = dateValues(typed.trim()).map((d) => ({
      label: d.value,
      detail: d.detail,
      icon: <Calendar className="h-4 w-4" />,
      replacement: `${key}:${d.value}`,
    }));
    return {
      heading: "Dates",
      items,
      status: `Also works: ${dayLabel(new Date())}, 5 march, 3 days ago`,
    };
  }
  return null;
}

function statusFor(
  searched: boolean,
  searching: boolean,
  count: number,
  noun: string,
): string | undefined {
  if (!searched) return `Type to search ${noun}`;
  if (searching && count === 0) return "Searching…";
  if (count === 0) return `No matching ${noun}`;
  return undefined;
}

// Common dates come first. Typing also finds months and weekdays.
function dateValues(typed: string): { value: string; detail: string }[] {
  const now = new Date();
  const day = (offset: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
  const monday = -((now.getDay() + 6) % 7);
  const monthName = (date: Date) => date.toLocaleString("en-US", { month: "long" });
  const month = (offset: number) =>
    new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const common = [
    { value: "today", detail: dayLabel(day(0)) },
    { value: "yesterday", detail: dayLabel(day(-1)) },
    { value: "this week", detail: `Since ${dayLabel(day(monday))}` },
    {
      value: "last week",
      detail: `${dayLabel(day(monday - 7))} to ${dayLabel(day(monday - 1))}`,
    },
    { value: "last 7 days", detail: `Since ${dayLabel(day(-6))}` },
    { value: "this month", detail: monthName(month(0)) },
    { value: "last month", detail: monthName(month(-1)) },
    { value: "this year", detail: String(now.getFullYear()) },
    { value: "last year", detail: String(now.getFullYear() - 1) },
  ];
  if (!typed) return common;
  // A month or a weekday without a year is the most recent one.
  const months = Array.from({ length: 12 }, (_, index) => {
    const date = new Date(
      now.getFullYear() - (index > now.getMonth() ? 1 : 0),
      index,
      1,
    );
    return {
      value: monthName(date).toLowerCase(),
      detail: `${monthName(date)} ${date.getFullYear()}`,
    };
  });
  const weekdays = Array.from({ length: 7 }, (_, index) => ({
    value: day(-index).toLocaleString("en-US", { weekday: "long" }).toLowerCase(),
    detail: dayLabel(day(-index)),
  }));
  return [...common, ...months, ...weekdays]
    .filter((d) => d.value.startsWith(typed))
    .slice(0, 8);
}

// Search dates show as dd-mm-yy, a form that the server also reads.
function dayLabel(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}-${pad(date.getMonth() + 1)}-${pad(date.getFullYear() % 100)}`;
}

function useDebounced(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delay);
    return () => window.clearTimeout(timeout);
  }, [value, delay]);
  return debounced;
}
