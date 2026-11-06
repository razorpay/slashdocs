import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { FileText, Folder as FolderIcon } from "lucide-react";

// The list view of folders and documents. An empty column name makes a narrow
// column for row actions.
export function EntryTable({
  columns,
  children,
}: {
  columns: string[];
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] shadow-[var(--shadow-card)] dark:border-transparent">
      <table className="w-full text-sm">
        <thead className="text-[11px] uppercase tracking-[0.08em] text-[var(--color-fg-muted)]">
          <tr>
            {columns.map((name, i) =>
              name ? (
                <th key={i} className="px-4 py-2.5 text-left font-medium">
                  {name}
                </th>
              ) : (
                <th key={i} className="w-12 px-2 py-2.5"></th>
              ),
            )}
          </tr>
        </thead>
        <tbody className="stagger-rows">{children}</tbody>
      </table>
    </div>
  );
}

// The colors of a row that is not a drop target.
export const ENTRY_ROW =
  "border-[var(--color-border)] hover:bg-[var(--color-surface-muted)] dark:border-white/5";

// The name cell link: an icon, the title, and marks after the title.
export function EntryName({
  to,
  folder,
  title,
  children,
}: {
  to: string;
  folder: boolean;
  title: string;
  children?: ReactNode;
}) {
  return (
    <Link
      to={to}
      className="flex cursor-default items-center gap-2 font-medium hover:underline"
      draggable={false}
    >
      {folder ? (
        <FolderIcon className="h-4 w-4 text-[var(--color-accent)]" />
      ) : (
        <FileText className="h-4 w-4 text-[var(--color-fg-muted)]" />
      )}
      {title}
      {children}
    </Link>
  );
}
