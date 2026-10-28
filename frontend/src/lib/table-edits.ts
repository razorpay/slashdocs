// Table edits are the column widths, row heights and table width a reader set
// by dragging the lines of a table. The bridge measures them in the rendered
// document; the app writes them into the stored HTML of the version, so the
// new version is the author's HTML with only the sizes changed, never the
// page as scripts left it.

export type TableEdit = {
  // The position of the table among the tables of the document.
  index: number;
  fingerprint: string;
  // Every column width in CSS pixels, when a column line moved.
  columns?: number[];
  // The table width in CSS pixels, set with the columns.
  width?: number;
  // Row heights in CSS pixels, by the row's index in table.rows.
  rows?: Record<string, number>;
};

// tableFingerprint tells a table apart from the others by its number of rows
// and the text of its first row, so an edit still finds its table when a
// script added another table before it.
export function tableFingerprint(table: HTMLTableElement): string {
  const first = table.rows[0];
  const text = first ? (first.textContent || "").replace(/\s+/g, " ").trim() : "";
  return `${table.rows.length}|${text.slice(0, 200)}`;
}

const MAX_SIZE = 100_000;

function size(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(MAX_SIZE, Math.round(value))
    : null;
}

// parseTableEdits keeps the well-formed edits of a bridge message. The frame
// hosts untrusted HTML, so the message is checked and bounded here.
export function parseTableEdits(value: unknown): TableEdit[] {
  if (!Array.isArray(value)) return [];
  const edits: TableEdit[] = [];
  for (const item of value.slice(0, 200)) {
    if (
      !item ||
      !Number.isInteger(item.index) ||
      item.index < 0 ||
      typeof item.fingerprint !== "string"
    )
      continue;
    const edit: TableEdit = {
      index: item.index,
      fingerprint: item.fingerprint.slice(0, 1024),
    };
    if (Array.isArray(item.columns) && item.columns.length <= 1000) {
      const columns = item.columns.map(size);
      if (columns.every((w: number | null) => w !== null)) {
        edit.columns = columns as number[];
        edit.width = size(item.width) ?? undefined;
      }
    }
    if (item.rows && typeof item.rows === "object") {
      const rows: Record<string, number> = {};
      for (const [key, height] of Object.entries(item.rows).slice(0, 10_000)) {
        const h = size(height);
        if (/^\d+$/.test(key) && h !== null) rows[key] = h;
      }
      if (Object.keys(rows).length) edit.rows = rows;
    }
    if (edit.columns || edit.rows) edits.push(edit);
  }
  return edits;
}

// setColumns replaces the column widths of a table with a colgroup, and
// fixes the layout so the widths hold.
export function setColumns(table: HTMLTableElement, columns: number[], width?: number) {
  const d = table.ownerDocument;
  table.querySelectorAll(":scope > colgroup").forEach((group) => group.remove());
  const group = d.createElement("colgroup");
  for (const w of columns) {
    const col = d.createElement("col");
    col.style.width = `${w}px`;
    group.appendChild(col);
  }
  // A colgroup comes after the caption, if there is one.
  const caption = table.querySelector(":scope > caption");
  table.insertBefore(group, caption ? caption.nextSibling : table.firstChild);
  table.style.tableLayout = "fixed";
  if (width) table.style.width = `${width}px`;
  return group;
}

// applyTableEdits writes the edits into an HTML document. Each edit goes to
// the table at its index when the fingerprint agrees, or else to the table
// with its fingerprint. An edit whose table is not in the HTML, such as a
// table a script builds, is skipped.
export function applyTableEdits(
  html: string,
  edits: TableEdit[],
): { html: string; applied: number; skipped: number } {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const tables = Array.from(parsed.querySelectorAll("table"));
  let applied = 0;
  let skipped = 0;
  for (const edit of edits) {
    let table: HTMLTableElement | undefined = tables[edit.index];
    if (!table || tableFingerprint(table) !== edit.fingerprint) {
      const matches = tables.filter((t) => tableFingerprint(t) === edit.fingerprint);
      table = matches.length === 1 ? matches[0] : undefined;
    }
    if (!table) {
      skipped++;
      continue;
    }
    if (edit.columns) setColumns(table, edit.columns, edit.width);
    for (const [index, height] of Object.entries(edit.rows || {})) {
      const row = table.rows[Number(index)];
      if (row) row.style.height = `${height}px`;
    }
    applied++;
  }
  const doctype = parsed.doctype ? `<!DOCTYPE ${parsed.doctype.name}>\n` : "";
  return { html: doctype + parsed.documentElement.outerHTML, applied, skipped };
}
