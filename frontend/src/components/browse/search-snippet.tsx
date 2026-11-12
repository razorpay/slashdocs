import { cn } from "@/lib/cn";

// The text of a search result that matched. The server puts U+0002 before
// and U+0003 after each match. Split at both, and the parts alternate between
// plain text and matches.
export function SearchSnippet({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const parts = text.split("\u0002").flatMap((part) => part.split("\u0003"));
  return (
    <p className={cn("text-[var(--color-fg-muted)]", className)}>
      {parts.map((part, index) =>
        index % 2 ? (
          <mark
            key={index}
            className="rounded-[3px] bg-[var(--color-accent)]/15 font-medium text-[var(--color-fg)]"
          >
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </p>
  );
}
