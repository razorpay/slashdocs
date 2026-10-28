import { describe, expect, it } from "vitest";
import { applyTableEdits, parseTableEdits, tableFingerprint } from "./table-edits";

const HTML = `<!doctype html><html><head><title>T</title></head><body>
<table id="a"><caption>Owners</caption><colgroup><col span="2"></colgroup>
<tr><th>Task</th><th>Owner</th></tr><tr><td>Spec</td><td>Asha</td></tr></table>
<table id="b"><tr><td>Other</td></tr></table>
<script>document.body.dataset.x = "1"</script>
</body></html>`;

function parse(html: string) {
  return new DOMParser().parseFromString(html, "text/html");
}

describe("applyTableEdits", () => {
  it("writes column widths, table width and row heights into the stored HTML", () => {
    const fingerprint = tableFingerprint(parse(HTML).querySelector("table")!);
    const result = applyTableEdits(HTML, [
      { index: 0, fingerprint, columns: [120, 200], width: 330, rows: { "1": 48 } },
    ]);
    expect(result).toMatchObject({ applied: 1, skipped: 0 });
    expect(result.html.startsWith("<!DOCTYPE html>")).toBe(true);
    const table = parse(result.html).getElementById("a") as HTMLTableElement;
    const groups = table.querySelectorAll(":scope > colgroup");
    expect(groups).toHaveLength(1);
    // The colgroup follows the caption, as HTML requires.
    expect(table.firstElementChild?.tagName).toBe("CAPTION");
    expect(table.children[1]).toBe(groups[0]);
    expect(
      Array.from(groups[0].querySelectorAll("col")).map((c) => c.style.width),
    ).toEqual(["120px", "200px"]);
    expect(table.style.tableLayout).toBe("fixed");
    expect(table.style.width).toBe("330px");
    expect(table.rows[1].style.height).toBe("48px");
    // Everything else, scripts included, is kept.
    expect(result.html).toContain('document.body.dataset.x = "1"');
  });

  it("finds a table by its fingerprint when a script added a table before it", () => {
    const fingerprint = tableFingerprint(
      parse(HTML).getElementById("b") as HTMLTableElement,
    );
    const result = applyTableEdits(HTML, [
      { index: 2, fingerprint, rows: { "0": 30 } },
    ]);
    expect(result.applied).toBe(1);
    const table = parse(result.html).getElementById("b") as HTMLTableElement;
    expect(table.rows[0].style.height).toBe("30px");
  });

  it("skips a table the stored HTML does not have", () => {
    const result = applyTableEdits(HTML, [
      { index: 5, fingerprint: "3|Generated", rows: { "0": 30 } },
    ]);
    expect(result).toMatchObject({ applied: 0, skipped: 1 });
  });
});

describe("parseTableEdits", () => {
  it("keeps well-formed edits, rounded and bounded", () => {
    expect(
      parseTableEdits([
        {
          index: 0,
          fingerprint: "f",
          columns: [10.4, 20.6],
          width: 31,
          rows: { "2": 40 },
        },
        { index: -1, fingerprint: "f", rows: { "0": 10 } },
        { index: 1, fingerprint: "f", columns: [10, "x"] },
        { index: 2, fingerprint: "f", rows: { a: 10, "1": -5 } },
        { index: 3, fingerprint: "f", rows: { "1": 1e9 } },
      ]),
    ).toEqual([
      { index: 0, fingerprint: "f", columns: [10, 21], width: 31, rows: { "2": 40 } },
      { index: 3, fingerprint: "f", rows: { "1": 100_000 } },
    ]);
    expect(parseTableEdits("nope")).toEqual([]);
  });
});
