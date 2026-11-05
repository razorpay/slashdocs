import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import { Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/misc";
import { principalColor } from "@/lib/principals";
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

const NONE: UserPrincipal[] = [];

export function MentionTextarea({
  draft,
  onChange,
  onKeyDown,
  placeholder,
  label,
  autoFocus,
  action,
}: {
  draft: MentionDraft;
  onChange: (draft: MentionDraft) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  // The name of a field without a placeholder.
  label?: string;
  autoFocus?: boolean;
  // A button at the end of the field, such as Send. The notes under the
  // field do not move it.
  action?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const beforeInputSelection = useRef<TextSelection | null>(null);
  // Caret position to apply right after the commit that renders an accepted
  // mention. A layout effect (not requestAnimationFrame) applies it: rAF can
  // fire after further keystrokes and yank the caret back mid-word.
  const caretRestore = useRef<number | null>(null);
  // The caret right after a picked mention and the space that follows it.
  const afterMention = useRef<number | null>(null);
  const [caret, setCaret] = useState(0);
  const [target, setTarget] = useState<MentionTarget | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [focused, setFocused] = useState(false);
  // The words for which Escape closed the list. New words open it again.
  const [closed, setClosed] = useState<string>();
  const listID = useId();
  const [position, setPosition] = useState({ left: 0, top: 0, width: 0 });
  // The people found for some words, or a search for them that failed.
  const [found, setFound] = useState<{
    query: string;
    people: UserPrincipal[];
    failed?: boolean;
  }>();
  const [attempt, setAttempt] = useState(0);
  const query = target?.query.trim() || "";
  // Only the people found for the words at the caret, never an older search.
  const result = query.length >= 2 && found?.query === query ? found : undefined;
  const suggestions = result?.people ?? NONE;
  const visible = focused && suggestions.length > 0 && query !== closed;

  // Use the browser event: React's synthetic beforeinput omits paste and some
  // native edits, which previously cleared every accepted mention on change.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const capture = (event: InputEvent) => {
      const { selectionStart: start, selectionEnd: end } = el;
      const spaced = start === end && start === afterMention.current;
      afterMention.current = null;
      // A picked mention brings its space, so a space typed next is not a
      // second one.
      if (spaced && event.inputType === "insertText" && event.data === " ") {
        event.preventDefault();
        return;
      }
      beforeInputSelection.current = { start, end };
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

  // The caret goes to the end, so a kept draft goes on where it stopped.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!autoFocus || !el) return;
    el.focus({ preventScroll: true });
    el.setSelectionRange(el.value.length, el.value.length);
  }, [autoFocus]);

  const syncTarget = (el: HTMLTextAreaElement) => {
    const nextCaret = el.selectionStart ?? 0;
    if (nextCaret !== afterMention.current) afterMention.current = null;
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
    if (query.length < 2) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      api.searchUsers(query).then(
        (r) => !cancelled && setFound({ query, people: r.items || [] }),
        () => !cancelled && setFound({ query, people: [], failed: true }),
      );
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [query, attempt]);

  useEffect(() => setActiveIndex(0), [suggestions]);

  useLayoutEffect(() => {
    const at = caretRestore.current;
    if (at === null) return;
    caretRestore.current = null;
    ref.current?.focus({ preventScroll: true });
    ref.current?.setSelectionRange(at, at);
    // Only now is the caret behind the mention. The browser reports the
    // selection of the pick's own key press before this, with the old caret.
    afterMention.current = at;
  });

  const accept = (user: UserPrincipal) => {
    if (!target) return;
    if (draft.mentions.length >= MAX_COMMENT_MENTIONS) {
      toast.error(`A comment can mention up to ${MAX_COMMENT_MENTIONS} people.`);
      setClosed(query);
      return;
    }
    const label = `@${mentionPrincipalLabel(user)}`;
    const nextCaret = target.start + label.length + 1;
    onChange(insertMention(draft, target.start, target.end, user));
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
        // It closes the suggestions only, not the popover around the field.
        event.preventDefault();
        event.stopPropagation();
        setClosed(query);
        return;
      }
    }
    onKeyDown?.(event);
  };

  return (
    <div className="relative min-w-0 flex-1">
      <div className="flex items-end gap-2">
        <Textarea
          ref={ref}
          rows={1}
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
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyUp={(event) => syncTarget(event.currentTarget)}
          onSelect={(event) => syncTarget(event.currentTarget)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          aria-label={label}
          // One line that grows with the text.
          className="block max-h-40 min-h-9 min-w-0 resize-none py-1.5 text-sm [field-sizing:content]"
        />
        {action}
      </div>
      {visible
        ? createPortal(
            <div
              id={listID}
              role="listbox"
              aria-label="Mention people"
              style={position}
              className="fixed z-[100] max-h-60 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-1 shadow-lg"
            >
              {suggestions.map((user, index) => {
                const label = mentionPrincipalLabel(user);
                return (
                  // The pointer moves the highlight too, so one option shows
                  // what Enter picks, as in a menu.
                  <div
                    key={user.id || user.email}
                    id={`${listID}-${index}`}
                    role="option"
                    aria-selected={index === activeIndex}
                    className="flex min-h-10 w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-[background-color,color] duration-150 ease-out aria-selected:bg-[var(--color-highlight)]"
                    onPointerDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={(event) => {
                      event.stopPropagation();
                      accept(user);
                    }}
                  >
                    <Avatar
                      size={24}
                      name={label}
                      src={user.picture_url}
                      color={principalColor(user)}
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{label}</span>
                      {user.email && user.email !== label ? (
                        <span className="block truncate text-xs text-[var(--color-fg-muted)]">
                          {user.email}
                        </span>
                      ) : null}
                    </span>
                  </div>
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
        <div className="mt-1 flex items-center gap-2 text-xs text-[var(--color-fg-muted)]">
          <p className="min-w-0 flex-1" role={result?.failed ? "alert" : undefined}>
            {result?.failed
              ? "Could not search people. Your words stay."
              : result && suggestions.length === 0
                ? `No one matches @${query}.`
                : "Choose a person from suggestions to notify them."}
          </p>
          {result?.failed ? (
            <Button
              variant="outline"
              size="sm"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                setFound(undefined);
                setAttempt((n) => n + 1);
              }}
            >
              Retry
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function CommentBody({
  text,
  mentions,
  preview = false,
}: {
  text: string;
  mentions: Comment["mentions"];
  // A preview sits in a row that opens the thread: two lines, and no links.
  preview?: boolean;
}) {
  const Text = preview ? "span" : "p";
  return (
    <Text
      className={
        preview
          ? "line-clamp-2 block text-sm break-words"
          : "min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed [overflow-wrap:anywhere]"
      }
    >
      {mentionTextSegments(text, mentions || []).map((segment, index) =>
        segment.mention ? (
          <span
            key={`${segment.mention.offset}-${segment.mention.principal.type}-${segment.mention.principal.id}`}
            className="rounded bg-[var(--color-accent-muted)] px-1 py-0.5 font-medium text-[var(--color-accent)]"
          >
            {segment.text}
          </span>
        ) : preview ? (
          segment.text
        ) : (
          <CommentText key={`text-${index}`} text={segment.text} />
        ),
      )}
    </Text>
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
