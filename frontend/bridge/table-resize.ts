import {
  setColumns,
  tableFingerprint,
  type TableEdit,
} from "../src/lib/table-edits.ts";

// While the reader resizes tables, every column line and row line of a table,
// inside or on its edge, can be dragged. A column line moves width between
// the columns beside it; the right edge of the table makes the last column
// and the table wider. A row line sets the height of the row above it.

const EDGE = 5;
const MIN_COLUMN = 24;
const MIN_ROW = 16;
const STYLE_ID = "slashdocs-table-resize-style";
const GUIDE_CLASS = "slashdocs-table-guide";

type Hit =
  | { kind: "column"; table: HTMLTableElement; line: number; x: number }
  | { kind: "row"; table: HTMLTableElement; line: number; y: number };

interface Original {
  style: string | null;
  colgroups: Array<{ node: Element; next: Node | null }>;
  added?: Element;
  rows: Map<HTMLTableRowElement, string | null>;
}

interface Sizes {
  columns?: number[];
  width?: number;
  rows: Record<string, number>;
}

// columnLines returns the x of the left edge of the table and of the right
// edge of each column, from the cells that end there. A column no cell ends
// in, such as one only spanned, gets a line between its neighbors.
export function columnLines(table: HTMLTableElement): number[] {
  const occupied: boolean[][] = [];
  const right: Array<number | undefined> = [];
  let left: number | undefined;
  let columns = 0;
  Array.from(table.rows).forEach((row, r) => {
    let c = 0;
    for (const cell of Array.from(row.cells)) {
      while (occupied[r]?.[c]) c++;
      const span = Math.max(1, cell.colSpan);
      const rowSpan = Math.max(1, cell.rowSpan);
      for (let dr = 0; dr < rowSpan; dr++) {
        const line = (occupied[r + dr] ||= []);
        for (let dc = 0; dc < span; dc++) line[c + dc] = true;
      }
      const rect = cell.getBoundingClientRect();
      if (c === 0) left ??= rect.left;
      right[c + span - 1] ??= rect.right;
      c += span;
      columns = Math.max(columns, c);
    }
  });
  const lines = [left ?? table.getBoundingClientRect().left];
  for (let c = 0; c < columns; c++) lines.push(right[c] ?? NaN);
  // Fill the lines of columns no cell ends in.
  for (let k = 1; k < lines.length; k++) {
    if (!Number.isNaN(lines[k])) continue;
    let next = k + 1;
    while (next < lines.length && Number.isNaN(lines[next])) next++;
    const end = next < lines.length ? lines[next] : table.getBoundingClientRect().right;
    lines[k] = lines[k - 1] + (end - lines[k - 1]) / (next - k + 1);
  }
  return lines;
}

export function createTableResizer(options: {
  doc: () => Document | null;
  // Runs DOM writes the bridge's mutation observer must not treat as the
  // document's own changes.
  quietly: (write: () => void) => void;
  report: (edits: TableEdit[]) => void;
}) {
  const { doc, quietly, report } = options;
  let enabled = false;
  let listening: Document | null = null;
  let originals = new Map<HTMLTableElement, Original>();
  let sizes = new Map<HTMLTableElement, Sizes>();
  let drag: {
    hit: Hit;
    pointer: number;
    start: number;
    columns: number[];
    width: number;
    height: number;
    // The last sizes at which no text spilled out of its cell.
    good: { widths: number[]; width: number };
    spilled: Set<Element>;
  } | null = null;
  let guide: HTMLDivElement | null = null;

  function hitAt(d: Document, x: number, y: number): Hit | null {
    for (const [px, py] of [
      [x, y],
      [x - EDGE - 1, y],
      [x, y - EDGE - 1],
    ]) {
      const cell = d.elementFromPoint(px, py)?.closest("td,th");
      const table = cell?.closest("table");
      if (!table) continue;
      const rect = table.getBoundingClientRect();
      if (y >= rect.top - EDGE && y <= rect.bottom + EDGE) {
        const lines = columnLines(table);
        for (let k = 1; k < lines.length; k++) {
          if (Math.abs(x - lines[k]) <= EDGE)
            return { kind: "column", table, line: k, x: lines[k] };
        }
      }
      if (x >= rect.left - EDGE && x <= rect.right + EDGE) {
        const rows = Array.from(table.rows);
        for (let r = 0; r < rows.length; r++) {
          const bottom = rows[r].getBoundingClientRect().bottom;
          if (Math.abs(y - bottom) <= EDGE)
            return { kind: "row", table, line: r, y: bottom };
        }
      }
    }
    return null;
  }

  function showGuide(d: Document, hit: Hit | null): void {
    quietly(() => {
      d.documentElement.classList.toggle(
        "slashdocs-col-resize",
        hit?.kind === "column",
      );
      d.documentElement.classList.toggle("slashdocs-row-resize", hit?.kind === "row");
      if (!hit) {
        guide?.remove();
        guide = null;
        return;
      }
      if (!guide || !guide.isConnected) {
        guide = d.createElement("div");
        guide.className = GUIDE_CLASS;
        d.body.appendChild(guide);
      }
      const rect = hit.table.getBoundingClientRect();
      guide.style.cssText =
        hit.kind === "column"
          ? `left:${hit.x - 1}px;top:${rect.top}px;width:2px;height:${rect.height}px`
          : `left:${rect.left}px;top:${hit.y - 1}px;width:${rect.width}px;height:2px`;
    });
  }

  // prepare gives the table a colgroup of its measured widths, once, and
  // keeps what it replaced so cancelling can put it back.
  function prepare(table: HTMLTableElement): Original {
    let original = originals.get(table);
    if (!original) {
      original = { style: table.getAttribute("style"), colgroups: [], rows: new Map() };
      originals.set(table, original);
    }
    return original;
  }

  function prepareColumns(table: HTMLTableElement): number[] {
    const original = prepare(table);
    const lines = columnLines(table);
    const widths = lines.slice(1).map((x, i) => Math.max(MIN_COLUMN, x - lines[i]));
    if (!original.added) {
      table.querySelectorAll(":scope > colgroup").forEach((node) => {
        original.colgroups.push({ node, next: node.nextSibling });
      });
      original.added = setColumns(table, widths, table.getBoundingClientRect().width);
    }
    return widths;
  }

  function setWidths(table: HTMLTableElement, widths: number[], width: number): void {
    const cols = table.querySelectorAll(":scope > colgroup > col");
    widths.forEach((w, i) => {
      const col = cols[i] as HTMLElement | undefined;
      if (col) col.style.width = `${Math.round(w)}px`;
    });
    table.style.width = `${Math.round(width)}px`;
    const entry = sizes.get(table) || { rows: {} };
    entry.columns = widths.map(Math.round);
    entry.width = Math.round(width);
    sizes.set(table, entry);
  }

  function setRow(table: HTMLTableElement, index: number, height: number): void {
    const row = table.rows[index];
    if (!row) return;
    const original = prepare(table);
    if (!original.rows.has(row)) original.rows.set(row, row.getAttribute("style"));
    row.style.height = `${Math.round(height)}px`;
    const entry = sizes.get(table) || { rows: {} };
    entry.rows[String(index)] = Math.round(height);
    sizes.set(table, entry);
  }

  function edits(d: Document): TableEdit[] {
    const tables = Array.from(d.querySelectorAll("table"));
    const out: TableEdit[] = [];
    for (const [table, size] of sizes) {
      const index = tables.indexOf(table);
      if (index < 0) continue;
      const edit: TableEdit = { index, fingerprint: tableFingerprint(table) };
      if (size.columns) {
        edit.columns = size.columns;
        edit.width = size.width;
      }
      if (Object.keys(size.rows).length) edit.rows = { ...size.rows };
      out.push(edit);
    }
    return out;
  }

  // spilling lists the cells whose text is wider than the cell.
  function spilling(table: HTMLTableElement): Set<Element> {
    const cells = new Set<Element>();
    for (const row of Array.from(table.rows)) {
      for (const cell of Array.from(row.cells)) {
        if (cell.scrollWidth > cell.clientWidth + 1) cells.add(cell);
      }
    }
    return cells;
  }

  function onPointerDown(event: PointerEvent): void {
    const d = doc();
    if (!d || event.button !== 0) return;
    const hit = hitAt(d, event.clientX, event.clientY);
    if (!hit) return;
    // No text selection, comment draft, or click starts from a drag.
    event.preventDefault();
    event.stopPropagation();
    let columns: number[] = [];
    let width = 0;
    quietly(() => {
      if (hit.kind === "column") {
        columns = prepareColumns(hit.table);
        width = hit.table.getBoundingClientRect().width;
      }
    });
    drag = {
      hit,
      pointer: event.pointerId,
      start: hit.kind === "column" ? event.clientX : event.clientY,
      columns,
      width,
      height:
        hit.kind === "row"
          ? hit.table.rows[hit.line].getBoundingClientRect().height
          : 0,
      good: { widths: columns, width },
      spilled: hit.kind === "column" ? spilling(hit.table) : new Set(),
    };
    try {
      d.documentElement.setPointerCapture(event.pointerId);
    } catch (e) {}
  }

  function onPointerMove(event: PointerEvent): void {
    const d = doc();
    if (!d) return;
    if (!drag) {
      if (event.buttons === 0) showGuide(d, hitAt(d, event.clientX, event.clientY));
      return;
    }
    if (event.pointerId !== drag.pointer) return;
    event.preventDefault();
    const { hit, columns } = drag;
    quietly(() => {
      if (hit.kind === "row") {
        const height = Math.max(MIN_ROW, drag!.height + event.clientY - drag!.start);
        setRow(hit.table, hit.line, height);
        return;
      }
      const delta = event.clientX - drag!.start;
      const widths = columns.slice();
      const k = hit.line - 1;
      let width = drag!.width;
      if (k + 1 < widths.length) {
        // A line inside the table keeps the table width.
        const pair = columns[k] + columns[k + 1];
        widths[k] = Math.min(
          pair - MIN_COLUMN,
          Math.max(MIN_COLUMN, columns[k] + delta),
        );
        widths[k + 1] = pair - widths[k];
      } else {
        widths[k] = Math.max(MIN_COLUMN, columns[k] + delta);
        width += widths[k] - columns[k];
      }
      setWidths(hit.table, widths, width);
      // A column stops where its text would spill into the next one.
      const spilled = spilling(hit.table);
      if (Array.from(spilled).some((cell) => !drag!.spilled.has(cell))) {
        setWidths(hit.table, drag!.good.widths, drag!.good.width);
      } else {
        drag!.good = { widths, width };
      }
    });
    const now = hitAt(d, event.clientX, event.clientY);
    showGuide(d, now && now.table === hit.table ? now : hit);
  }

  function onPointerUp(event: PointerEvent): void {
    const d = doc();
    if (!drag || !d || event.pointerId !== drag.pointer) return;
    drag = null;
    try {
      d.documentElement.releasePointerCapture(event.pointerId);
    } catch (e) {}
    showGuide(d, hitAt(d, event.clientX, event.clientY));
    report(edits(d));
  }

  function listen(d: Document | null): void {
    if (listening === d) return;
    if (listening) {
      listening.removeEventListener("pointerdown", onPointerDown, true);
      listening.removeEventListener("pointermove", onPointerMove, true);
      listening.removeEventListener("pointerup", onPointerUp, true);
      listening.removeEventListener("pointercancel", onPointerUp, true);
    }
    listening = d;
    if (!d) return;
    d.addEventListener("pointerdown", onPointerDown, true);
    d.addEventListener("pointermove", onPointerMove, true);
    d.addEventListener("pointerup", onPointerUp, true);
    d.addEventListener("pointercancel", onPointerUp, true);
  }

  function revert(): void {
    for (const [table, original] of originals) {
      if (original.style === null) table.removeAttribute("style");
      else table.setAttribute("style", original.style);
      original.added?.remove();
      for (const { node, next } of original.colgroups) {
        table.insertBefore(
          node,
          next && next.parentNode === table ? next : table.firstChild,
        );
      }
      for (const [row, style] of original.rows) {
        if (style === null) row.removeAttribute("style");
        else row.setAttribute("style", style);
      }
    }
  }

  // setEnabled turns resizing on or off. Turning it off with revert puts
  // every table back as the version has it; without, the sizes stay, as
  // after they are saved.
  function setEnabled(on: boolean, undo: boolean): void {
    const d = doc();
    quietly(() => {
      if (!on && undo) revert();
      if (!on) {
        originals = new Map();
        sizes = new Map();
        drag = null;
      }
      if (!d) return;
      showGuide(d, null);
      d.getElementById(STYLE_ID)?.remove();
      if (on) {
        const style = d.createElement("style");
        style.id = STYLE_ID;
        style.textContent =
          `table{outline:1px dashed rgba(99,102,241,.7)!important;outline-offset:1px}` +
          `.${GUIDE_CLASS}{position:fixed!important;z-index:2147483647!important;background:#6366f1!important;pointer-events:none!important}` +
          `html.slashdocs-col-resize,html.slashdocs-col-resize *{cursor:col-resize!important}` +
          `html.slashdocs-row-resize,html.slashdocs-row-resize *{cursor:row-resize!important}`;
        (d.head || d.documentElement).appendChild(style);
      }
    });
    enabled = on;
    listen(on ? d : null);
    if (d && !on) report([]);
  }

  // reset forgets a document that the frame navigated away from.
  function reset(): void {
    originals = new Map();
    sizes = new Map();
    drag = null;
    guide = null;
    listen(null);
    if (enabled) setEnabled(true, false);
  }

  return { setEnabled, reset };
}
