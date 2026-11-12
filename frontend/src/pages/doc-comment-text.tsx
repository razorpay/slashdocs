import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/input";
import { api, type Comment, type UserPrincipal } from "@/api";
import {
  getMentionTarget,
  type MentionTarget,
  inferTextareaEdit,
  insertMention,
  MAX_COMMENT_MENTIONS,
  mentionPrincipalLabel,
  mentionTextSegments,
  reconcileMentionDraft,
  type MentionDraft,
  type TextSelection,
} from "@/lib/comment-mentions";

// The text of a comment: the field that writes it, with @mention suggestions,
// and the body that shows it, with mentions and web links marked.

export function MentionTextarea({
  draft,
  onChange,
  onKeyDown,
  placeholder,
  rows,
  className,
  autoFocus,
}: {
  draft: MentionDraft;
  onChange: (draft: MentionDraft) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
  autoFocus?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const beforeInputSelection = useRef<TextSelection | null>(null);
  // Caret position to apply right after the commit that renders an accepted
  // mention. A layout effect (not requestAnimationFrame) applies it: rAF can
  // fire after further keystrokes and yank the caret back mid-word.
  const caretRestore = useRef<number | null>(null);
  const [caret, setCaret] = useState(0);
  const [target, setTarget] = useState<MentionTarget | null>(null);
  const [suggestions, setSuggestions] = useState<UserPrincipal[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [open, setOpen] = useState(false);
  const listID = useId();
  const [suggestionQuery, setSuggestionQuery] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 });
  const visible =
    open && suggestions.length > 0 && suggestionQuery === target?.query.trim();

  // Use the browser event: React's synthetic beforeinput omits paste and some
  // native edits, which previously cleared every accepted mention on change.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const capture = () => {
      beforeInputSelection.current = { start: el.selectionStart, end: el.selectionEnd };
    };
    el.addEventListener("beforeinput", capture);
    return () => el.removeEventListener("beforeinput", capture);
  }, []);

  useLayoutEffect(() => {
    if (!visible) return;
    const place = () => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      const height = Math.min(240, suggestions.length * 64);
      setPosition({
        left: rect.left,
        width: rect.width,
        top:
          rect.bottom + height + 8 > window.innerHeight
            ? Math.max(8, rect.top - height - 4)
            : rect.bottom + 4,
      });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [visible, suggestions.length]);

  useLayoutEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const syncTarget = (el: HTMLTextAreaElement) => {
    const nextCaret = el.selectionStart ?? 0;
    setCaret(nextCaret);
    setTarget(
      el.selectionStart === el.selectionEnd
        ? getMentionTarget(el.value, nextCaret, draft.mentions)
        : null,
    );
  };

  useEffect(() => {
    setTarget(getMentionTarget(draft.body, caret, draft.mentions));
  }, [draft.body, draft.mentions, caret]);

  useEffect(() => {
    const query = target?.query.trim() || "";
    if (query.length < 2) {
      setSuggestions([]);
      setOpen(false);
      return;
    }
    let cancelled = false;
    const timeout = window.setTimeout(async () => {
      try {
        const result = await api.searchUsers(query);
        if (cancelled) return;
        setSuggestionQuery(query);
        setSuggestions(result.items || []);
        setActiveIndex(0);
        setOpen((result.items || []).length > 0);
      } catch {
        if (!cancelled) {
          setSuggestions([]);
          setOpen(false);
        }
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [target?.query]);

  useLayoutEffect(() => {
    if (caretRestore.current === null) return;
    const el = ref.current;
    if (el) {
      el.focus({ preventScroll: true });
      el.setSelectionRange(caretRestore.current, caretRestore.current);
    }
    caretRestore.current = null;
  });

  const accept = (user: UserPrincipal) => {
    if (!target) return;
    if (draft.mentions.length >= MAX_COMMENT_MENTIONS) {
      toast.error(`A comment can mention up to ${MAX_COMMENT_MENTIONS} people.`);
      setOpen(false);
      return;
    }
    const label = `@${mentionPrincipalLabel(user)}`;
    const nextCaret = target.start + label.length + 1;
    onChange(insertMention(draft, target.start, target.end, user));
    setOpen(false);
    setSuggestions([]);
    setCaret(nextCaret);
    caretRestore.current = nextCaret;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (visible) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setActiveIndex((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex(
          (index) => (index - 1 + suggestions.length) % suggestions.length,
        );
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        accept(suggestions[activeIndex]);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        return;
      }
    }
    onKeyDown?.(event);
  };

  return (
    <div className="relative min-w-0 flex-1">
      <Textarea
        ref={ref}
        rows={rows}
        value={draft.body}
        onChange={() => {}}
        onInput={(event) => {
          const el = event.currentTarget;
          const before = beforeInputSelection.current;
          beforeInputSelection.current = null;
          const after = { start: el.selectionStart, end: el.selectionEnd };
          const edit = before
            ? inferTextareaEdit(draft.body, el.value, before, after)
            : null;
          onChange(reconcileMentionDraft(draft, el.value, edit));
          syncTarget(el);
        }}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={visible ? listID : undefined}
        aria-activedescendant={visible ? `${listID}-${activeIndex}` : undefined}
        onClick={(event) => syncTarget(event.currentTarget)}
        onBlur={() => setOpen(false)}
        onKeyUp={(event) => syncTarget(event.currentTarget)}
        onSelect={(event) => syncTarget(event.currentTarget)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={className}
      />
      {visible
        ? createPortal(
            <div
              id={listID}
              role="listbox"
              aria-label="Mention people"
              style={position}
              className="fixed z-[100] max-h-60 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-lg"
            >
              {suggestions.map((user, index) => {
                const active = index === activeIndex;
                return (
                  <button
                    key={user.id || user.email}
                    id={`${listID}-${index}`}
                    role="option"
                    aria-selected={active}
                    type="button"
                    className={`block min-h-10 w-full px-3 py-2 text-left text-sm transition-colors ${active ? "bg-[var(--color-surface-muted)] text-[var(--color-fg)]" : "text-[var(--color-fg)] hover:bg-[var(--color-surface-muted)]"}`}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.stopPropagation();
                      accept(user);
                    }}
                  >
                    <span className="block truncate font-medium">
                      {mentionPrincipalLabel(user)}
                    </span>
                    {user.email && user.email !== mentionPrincipalLabel(user) ? (
                      <span className="block truncate text-xs text-[var(--color-fg-muted)]">
                        {user.email}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>,
            document.body,
          )
        : null}
      {draft.mentions.length > 0 && (
        <p className="mt-1 text-xs text-[var(--color-accent)]" aria-live="polite">
          Mentioned:{" "}
          {[
            ...new Map(
              draft.mentions.map((m) => [
                m.principal.id,
                mentionPrincipalLabel(m.principal),
              ]),
            ).values(),
          ].join(", ")}
        </p>
      )}
      {target && !visible && (
        <p className="mt-1 text-xs text-[var(--color-fg-muted)]">
          Choose a person from suggestions to notify them.
        </p>
      )}
    </div>
  );
}

export function CommentBody({
  text,
  mentions,
}: {
  text: string;
  mentions: Comment["mentions"];
}) {
  return (
    <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]">
      {mentionTextSegments(text, mentions || []).map((segment, index) =>
        segment.mention ? (
          <span
            key={`${segment.mention.offset}-${segment.mention.principal.type}-${segment.mention.principal.id}`}
            className="rounded bg-[var(--color-accent-muted)] px-1 py-0.5 font-medium text-[var(--color-accent)]"
          >
            {segment.text}
          </span>
        ) : (
          <CommentText key={`text-${index}`} text={segment.text} />
        ),
      )}
    </p>
  );
}

// Only web URLs become links; comment text always goes through React escaping.
function CommentText({ text }: { text: string }) {
  return text.split(/(https?:\/\/[^\s<>"]+)/gi).map((part, index) => {
    if (!/^https?:\/\//i.test(part)) return part;
    let href = part.replace(/[.,!?;:]+$/, "");
    for (const [open, close] of [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ]) {
      let extra = href.split(close).length - href.split(open).length;
      while (extra > 0 && href.endsWith(close)) {
        href = href.slice(0, -1);
        extra--;
      }
    }
    try {
      if (!["http:", "https:"].includes(new URL(href).protocol)) return part;
    } catch {
      return part;
    }
    return (
      <span key={index}>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[var(--color-accent)] underline decoration-[var(--color-accent)]/40 underline-offset-2 hover:decoration-current"
          onClick={(event) => event.stopPropagation()}
        >
          {href}
        </a>
        {part.slice(href.length)}
      </span>
    );
  });
}
