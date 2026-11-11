import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CHORD_KEYS } from "@/lib/esc-chord";
import { useDoc } from "./doc-context";

const MAC = /Mac|iPhone|iPad/.test(navigator.userAgent);
const MAC_KEYS: Record<string, string> = { Mod: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };

// chord names keys that are held together, as the comment chip in the
// document does: ⌘⌥M on a Mac, and Ctrl+Alt+M elsewhere.
const chord = (...keys: string[]) =>
  MAC
    ? keys.map((key) => MAC_KEYS[key] ?? key).join("")
    : keys.map((key) => (key === "Mod" ? "Ctrl" : key)).join("+");

type Section = { title: string; rows: [keys: string[], label: string][] };

// The keys of Edit mode. They show only to editors.
const EDITING: Section = {
  title: "Editing",
  rows: [
    [["E"], "Edit the text"],
    [["C"], "Stop editing, and comment"],
    [["Esc", "Esc"], "Leave the text, then stop editing"],
    [[chord("Mod", "B")], "Bold"],
    [[chord("Mod", "I")], "Italic"],
    [[chord("Mod", "K")], "Link"],
    [[chord("Mod", "Shift", "8")], "Bulleted list"],
    [[chord("Mod", "Shift", "7")], "Numbered list"],
    [[chord("Mod", "Z")], "Undo"],
    [[chord("Mod", "Shift", "Z")], "Redo"],
    [[chord("Shift", "Enter")], "Line break"],
  ],
};

// Every document-page shortcut. Each kbd is one key, or keys held together.
// Keys in a row of kbds are pressed in turn. The Esc chords come from
// CHORD_KEYS, so a new chord shows here without an edit.
const SECTIONS: Section[] = [
  {
    title: "Esc, then a letter",
    rows: CHORD_KEYS.map(({ key, hint }) => [
      ["Esc", key.toUpperCase()],
      hint[0].toUpperCase() + hint.slice(1),
    ]),
  },
  {
    title: "Reading",
    rows: [
      [["J"], "Scroll down"],
      [["K"], "Scroll up"],
      [[chord("Ctrl", "D")], "Half a page down"],
      [[chord("Ctrl", "U")], "Half a page up"],
      [["G", "G"], "Top"],
      [[chord("Shift", "G")], "Bottom"],
    ],
  },
  {
    title: "Comments",
    rows: [
      [["C"], "Comment on the selected text, or on a spot you click"],
      [["Esc"], "Stop placing a comment"],
      [[chord("Mod", "Alt", "M")], "Comment on the text you edit"],
      [[chord("Mod", "Enter")], "Post a comment"],
    ],
  },
  {
    title: "Cursors",
    rows: [[["/"], "Chat at your cursor"]],
  },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { canEdit } = useDoc();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            While the text has the caret in Edit mode, the keys type. Press Esc to leave
            the text, then use these keys.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          {(canEdit ? [EDITING, ...SECTIONS] : SECTIONS).map((section) => (
            <section key={section.title}>
              <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-[var(--color-fg-muted)]">
                {section.title}
              </h3>
              <dl className="space-y-1.5 text-sm">
                {section.rows.map(([keys, label]) => (
                  <div key={label} className="flex items-center justify-between gap-4">
                    <dt>{label}</dt>
                    <dd className="flex gap-1">
                      {keys.map((key, index) => (
                        <kbd
                          key={index}
                          className="min-w-6 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-muted)] px-1.5 py-0.5 text-center font-mono text-xs"
                        >
                          {key}
                        </kbd>
                      ))}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
