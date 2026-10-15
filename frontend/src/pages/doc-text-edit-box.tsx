import {
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Bold, Code, Italic, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const MOD = /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

const FORMATS = {
  bold: { tags: ["strong", "b"], create: "strong" },
  italic: { tags: ["em", "i"], create: "em" },
  code: { tags: ["code"], create: "code" },
  link: { tags: ["a"], create: "a" },
} as const;

type Format = keyof typeof FORMATS;

function selectedRange(editor: HTMLElement): Range | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (range.collapsed || !editor.contains(range.commonAncestorContainer)) return null;
  return range;
}

function enclosing(node: Node, editor: HTMLElement, tags: readonly string[]) {
  for (let n: Node | null = node; n && n !== editor; n = n.parentNode) {
    if (n instanceof Element && tags.includes(n.localName)) return n;
  }
  return null;
}

function unwrap(element: Element) {
  element.replaceWith(...Array.from(element.childNodes));
}

// Extracting a range that ends inside an element leaves an empty copy of it behind.
function removeEmptyInlines(editor: HTMLElement) {
  editor.querySelectorAll("strong,b,em,i,code,a").forEach((element) => {
    if (!element.textContent && !element.querySelector("br")) element.remove();
  });
  editor.normalize();
}

function select(node: Node) {
  const range = document.createRange();
  range.selectNodeContents(node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

// Wraps the range in the format, or removes the format when the range is inside it.
function toggle(editor: HTMLElement, range: Range, format: Format, href?: string) {
  const { tags, create } = FORMATS[format];
  const wrapper = enclosing(range.commonAncestorContainer, editor, tags);
  if (wrapper) {
    unwrap(wrapper);
    editor.normalize();
    return;
  }
  const contents = range.extractContents();
  contents.querySelectorAll(tags.join(",")).forEach(unwrap);
  const element = document.createElement(create);
  if (href) element.setAttribute("href", href);
  element.appendChild(contents);
  range.insertNode(element);
  removeEmptyInlines(editor);
  select(element);
}

function linkAddress(value: string): string | null {
  const address = value.trim();
  if (!address || /\s/.test(address)) return null;
  if (/^(https?:|mailto:)/i.test(address)) return address;
  if (/^[^/]+@[^/]+$/.test(address)) return `mailto:${address}`;
  return `https://${address}`;
}

export function TextEditBox({
  seed,
  dropped,
  position,
  onApply,
  onCancel,
}: {
  seed: string;
  dropped: boolean;
  position: { left: number; top: number };
  onApply: (html: string) => void;
  onCancel: () => void;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const linkRange = useRef<Range | null>(null);
  const [linking, setLinking] = useState(false);
  const [address, setAddress] = useState("");

  useLayoutEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.innerHTML = seed;
    editor.focus();
    select(editor);
  }, [seed]);

  const format = (name: Format) => {
    const editor = editorRef.current;
    const range = editor && selectedRange(editor);
    if (!editor || !range) return;
    if (name === "link" && !enclosing(range.commonAncestorContainer, editor, ["a"])) {
      linkRange.current = range.cloneRange();
      setAddress("");
      setLinking(true);
      return;
    }
    toggle(editor, range, name);
  };

  const addLink = () => {
    const editor = editorRef.current;
    const range = linkRange.current;
    const href = linkAddress(address);
    if (!editor || !range || !href) return;
    toggle(editor, range, "link", href);
    linkRange.current = null;
    setLinking(false);
    editor.focus();
  };

  const apply = () => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.normalize();
    onApply(editor.innerHTML);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (mod && event.key === "Enter") {
      event.preventDefault();
      apply();
    } else if (event.key === "Enter") {
      // Edits stay inside one block: no new paragraphs.
      event.preventDefault();
      const range = event.shiftKey && selectedRangeOrCaret();
      if (range) {
        range.deleteContents();
        const br = document.createElement("br");
        range.insertNode(br);
        range.setStartAfter(br);
        range.collapse(true);
      }
    } else if (mod && (event.key === "b" || event.key === "i")) {
      event.preventDefault();
      format(event.key === "b" ? "bold" : "italic");
    }
  };

  const selectedRangeOrCaret = () => {
    const selection = window.getSelection();
    const editor = editorRef.current;
    if (!selection?.rangeCount || !editor) return null;
    const range = selection.getRangeAt(0);
    return editor.contains(range.commonAncestorContainer) ? range : null;
  };

  const tool = (name: Format, label: string, icon: ReactNode, keys?: string) => (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      aria-label={label}
      tooltip={keys ? `${label} (${keys})` : label}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => format(name)}
    >
      {icon}
    </Button>
  );

  return (
    <div
      role="dialog"
      aria-label="Edit text"
      className="fixed z-50 w-[min(28rem,calc(100vw-1rem))] rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2 shadow-lg"
      style={{ left: position.left, top: position.top }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div role="toolbar" aria-label="Formatting" className="mb-1.5 flex gap-0.5">
        {tool("bold", "Bold", <Bold className="h-4 w-4" />, `${MOD}B`)}
        {tool("italic", "Italic", <Italic className="h-4 w-4" />, `${MOD}I`)}
        {tool("code", "Code", <Code className="h-4 w-4" />)}
        {tool("link", "Link", <Link2 className="h-4 w-4" />)}
      </div>
      {linking ? (
        <form
          className="mb-1.5 flex gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            addLink();
          }}
        >
          <Input
            autoFocus
            aria-label="Link address"
            placeholder="https://"
            className="h-8"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            variant="secondary"
            disabled={!linkAddress(address)}
          >
            Add link
          </Button>
        </form>
      ) : null}
      <div
        ref={editorRef}
        role="textbox"
        aria-label="Edited text"
        contentEditable
        suppressContentEditableWarning
        className="max-h-48 min-h-9 overflow-auto rounded-sm border border-[var(--color-border)] px-2.5 py-1.5 text-sm leading-relaxed text-[var(--color-fg)] outline-none focus:border-[var(--color-accent)] [&_a]:text-[var(--color-accent)] [&_a]:underline [&_code]:rounded [&_code]:bg-[var(--color-surface-muted)] [&_code]:px-1 [&_code]:font-mono"
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          event.preventDefault();
          const range = selectedRangeOrCaret();
          if (!range) return;
          range.deleteContents();
          const text = document.createTextNode(
            event.clipboardData.getData("text/plain"),
          );
          range.insertNode(text);
          range.setStartAfter(text);
          range.collapse(true);
        }}
      />
      {dropped ? (
        <p role="status" className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">
          Styling other than bold, italic, code, and links will be removed.
        </p>
      ) : null}
      <div className="mt-2 flex items-center justify-end gap-1.5">
        <span className="mr-auto text-xs text-[var(--color-fg-muted)]">
          {MOD}↵ to apply
        </span>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={apply}>
          Apply
        </Button>
      </div>
    </div>
  );
}
