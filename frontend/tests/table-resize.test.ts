import { assert, test } from "vitest";
import { columnLines } from "../bridge/table-resize.ts";

test("column lines come from the cells that end at them, around spans", () => {
  document.body.innerHTML = `<table>
    <tr><td colspan="2">wide</td><td>c</td></tr>
    <tr><td>a</td><td rowspan="2">b</td><td>c</td></tr>
    <tr><td>a</td><td>c</td></tr>
  </table>`;
  const table = document.querySelector("table")!;
  // jsdom lays nothing out: give every cell a box from its grid position.
  const boxes = new Map<Element, [number, number]>([
    [table.rows[0].cells[0], [0, 200]],
    [table.rows[0].cells[1], [200, 300]],
    [table.rows[1].cells[0], [0, 80]],
    [table.rows[1].cells[1], [80, 200]],
    [table.rows[1].cells[2], [200, 300]],
    [table.rows[2].cells[0], [0, 80]],
    [table.rows[2].cells[1], [200, 300]],
  ]);
  for (const [cell, [left, right]] of boxes) {
    cell.getBoundingClientRect = () => ({ left, right }) as DOMRect;
  }
  assert.deepEqual(columnLines(table), [0, 80, 200, 300]);
});
