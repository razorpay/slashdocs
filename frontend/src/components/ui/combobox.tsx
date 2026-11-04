import {
  useEffect,
  useId,
  useState,
  type InputHTMLAttributes,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import { Input } from "./input";

export type ComboboxOption = {
  key: string;
  name: string;
  detail?: string;
  icon?: ReactNode;
  // An option that shows, with a note such as "Has access", but cannot be
  // picked.
  disabledNote?: string;
};

// Combobox is a field with suggestions that float under it, or above it at
// the bottom of a dialog. The arrow keys move through the options that can be
// picked, and Enter picks the active one. The first one is active when the
// list opens, so one match takes one Enter. Escape closes the list before the
// dialog or sheet around it.
export function Combobox<T extends ComboboxOption>({
  value,
  onValueChange,
  options,
  onPick,
  listAbove = false,
  ...inputProps
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: T[];
  onPick: (option: T) => void;
  listAbove?: boolean;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "role">) {
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [activeKey, setActiveKey] = useState<string>();
  const showList = open && options.length > 0;
  const pickable = options.filter((o) => !o.disabledNote);
  const active = showList
    ? (pickable.find((o) => o.key === activeKey) ?? pickable[0])
    : undefined;
  const optionId = (o: T) => `${listId}-${options.indexOf(o)}`;
  const pick = (o: T) => {
    onPick(o);
    setOpen(false);
  };
  const move = (step: number) => {
    const i = active ? pickable.indexOf(active) : -1;
    setOpen(true);
    setActiveKey(pickable[Math.min(Math.max(i + step, 0), pickable.length - 1)]?.key);
  };

  // Radix closes a dialog on an Escape that reaches the document, so the list
  // takes the key on the window first.
  useEffect(() => {
    if (!showList) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [showList]);

  return (
    <div className="relative">
      <Input
        {...inputProps}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showList}
        aria-controls={listId}
        aria-activedescendant={active ? optionId(active) : undefined}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        onChange={(e) => {
          onValueChange(e.target.value);
          setOpen(true);
          setActiveKey(undefined);
        }}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            move(e.key === "ArrowDown" ? 1 : -1);
          } else if (e.key === "Enter" && active) {
            e.preventDefault();
            pick(active);
          }
        }}
      />
      <ul
        id={listId}
        role="listbox"
        hidden={!showList}
        data-state="open"
        className={cn(
          "pop absolute inset-x-0 z-10 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] py-1 shadow-[var(--shadow-pop)]",
          listAbove ? "bottom-full mb-1 max-h-36" : "top-full mt-1 max-h-64",
        )}
      >
        {options.map((option) => (
          <li
            key={option.key}
            id={optionId(option)}
            role="option"
            aria-selected={option === active}
            aria-disabled={!!option.disabledNote || undefined}
            // The field keeps the focus. The pointer moves the active option
            // too, so one option shows what Enter picks.
            onMouseDown={(e) => e.preventDefault()}
            onMouseEnter={() => !option.disabledNote && setActiveKey(option.key)}
            onClick={() => !option.disabledNote && pick(option)}
            className={cn(
              "flex min-h-10 items-center gap-2 px-3 py-1.5 text-sm transition-[background-color] duration-150 ease-out",
              option.disabledNote
                ? "cursor-default text-[var(--color-fg-muted)]"
                : "cursor-pointer aria-selected:bg-[var(--color-highlight)]",
            )}
          >
            {option.icon}
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{option.name}</span>
              {option.detail ? (
                <span className="block truncate text-xs text-[var(--color-fg-muted)]">
                  {option.detail}
                </span>
              ) : null}
            </span>
            {option.disabledNote ? (
              <span className="shrink-0 text-xs">{option.disabledNote}</span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
