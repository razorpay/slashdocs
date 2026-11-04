import { describe, expect, it } from "vitest";
import {
  changedHeadingsCSS,
  DEFAULT_READER_SETTINGS,
  documentTheme,
  progression,
  READER_KEYS,
  READER_SIZES,
  READER_WIDTHS,
  readerSettingsCSS,
  RESTORE_METHODS,
  restoreMethod,
  sectionAt,
} from "../bridge/reading.ts";

describe("sectionAt", () => {
  const hs = [
    { id: "a", top: 100 },
    { id: "b", top: 600 },
  ];
  it("is empty before the first heading", () => expect(sectionAt(hs, 50)).toBe(""));
  it("picks the last heading above the probe", () =>
    expect(sectionAt(hs, 700)).toBe("b"));
  it("counts a heading exactly at the probe", () =>
    expect(sectionAt(hs, 100)).toBe("a"));
  it("is empty without headings", () => expect(sectionAt([], 100)).toBe(""));
});

describe("progression", () => {
  it("clamps", () => {
    expect(progression(-5, 1000, 500)).toBe(0);
    expect(progression(800, 1000, 500)).toBe(1);
  });
  it("is 1 when the page does not scroll", () =>
    expect(progression(0, 400, 500)).toBe(1));
  it("is a share of scrollable height", () =>
    expect(progression(250, 1000, 500)).toBe(0.5));
  it("is 0 for non-finite input", () => expect(progression(NaN, 1000, 500)).toBe(0));
});

describe("readerSettingsCSS", () => {
  it("sets size with zoom and width with max-width", () => {
    const css = readerSettingsCSS({ size: "l", width: "narrow", theme: "system" });
    expect(css).toContain("zoom:1.125");
    expect(css).toContain("max-width:60ch");
    expect(css).toContain("margin-inline:auto");
    expect(css).not.toContain("font-size");
  });
  it("maps every size and width", () => {
    expect(readerSettingsCSS({ ...DEFAULT_READER_SETTINGS, size: "s" })).toContain(
      "zoom:0.9375",
    );
    expect(readerSettingsCSS(DEFAULT_READER_SETTINGS)).toContain("zoom:1;");
    expect(readerSettingsCSS(DEFAULT_READER_SETTINGS)).toContain("max-width:72ch");
    expect(readerSettingsCSS({ ...DEFAULT_READER_SETTINGS, width: "wide" })).toContain(
      "max-width:none",
    );
  });
  it("adds paper background only for paper", () => {
    expect(
      readerSettingsCSS({ size: "m", width: "comfortable", theme: "paper" }),
    ).toContain("html{background:#f8f4ea}body{background:transparent}");
    expect(
      readerSettingsCSS({ size: "m", width: "comfortable", theme: "light" }),
    ).not.toContain("#f8f4ea");
    expect(
      readerSettingsCSS({ size: "m", width: "comfortable", theme: "system" }),
    ).not.toContain("#f8f4ea");
  });
  it("gives every allowed size and width its own CSS", () => {
    const sizes = READER_SIZES.map((size) =>
      readerSettingsCSS({ ...DEFAULT_READER_SETTINGS, size }),
    );
    const widths = READER_WIDTHS.map((width) =>
      readerSettingsCSS({ ...DEFAULT_READER_SETTINGS, width }),
    );
    expect(new Set(sizes).size).toBe(READER_SIZES.length);
    expect(new Set(widths).size).toBe(READER_WIDTHS.length);
  });
  it("ignores inherited keys", () => {
    const css = readerSettingsCSS({
      size: "constructor",
      width: "toString",
      theme: "system",
    } as unknown as typeof DEFAULT_READER_SETTINGS);
    expect(css).toBe(readerSettingsCSS(DEFAULT_READER_SETTINGS));
  });
  it("falls back to defaults for unknown values", () => {
    const css = readerSettingsCSS({
      size: "xl",
      width: "huge",
      theme: "neon",
    } as unknown as typeof DEFAULT_READER_SETTINGS);
    expect(css).toBe(readerSettingsCSS(DEFAULT_READER_SETTINGS));
  });
});

describe("documentTheme", () => {
  it("forces light for light and paper", () => {
    expect(documentTheme("light", "dark")).toBe("light");
    expect(documentTheme("paper", "dark")).toBe("light");
  });
  it("follows the app for system", () => {
    expect(documentTheme("system", "dark")).toBe("dark");
    expect(documentTheme("system", "light")).toBe("light");
    expect(documentTheme(undefined, "dark")).toBe("dark");
  });
});

describe("restoreMethod", () => {
  it("returns only listed methods", () =>
    expect([...RESTORE_METHODS]).toEqual(["quote", "section", "progression", "none"]));
  it("prefers the quote", () =>
    expect(
      restoreMethod({ quoteResolved: true, sectionExists: true, progression: 0.4 }),
    ).toBe("quote"));
  it("falls back to the section", () =>
    expect(
      restoreMethod({ quoteResolved: false, sectionExists: true, progression: 0.4 }),
    ).toBe("section"));
  it("then to progression", () =>
    expect(
      restoreMethod({ quoteResolved: false, sectionExists: false, progression: 0.4 }),
    ).toBe("progression"));
  it("accepts progression 1", () =>
    expect(
      restoreMethod({ quoteResolved: false, sectionExists: false, progression: 1 }),
    ).toBe("progression"));
  it("reports none at the top", () => {
    expect(
      restoreMethod({ quoteResolved: false, sectionExists: false, progression: 0 }),
    ).toBe("none");
    expect(
      restoreMethod({ quoteResolved: false, sectionExists: false, progression: null }),
    ).toBe("none");
  });
  it("reports none for out-of-range progression", () => {
    expect(
      restoreMethod({ quoteResolved: false, sectionExists: false, progression: 1.5 }),
    ).toBe("none");
    expect(
      restoreMethod({ quoteResolved: false, sectionExists: false, progression: NaN }),
    ).toBe("none");
  });
});

describe("changedHeadingsCSS", () => {
  it("escapes ids", () =>
    expect(changedHeadingsCSS(['a"b'])).toContain('[id="a\\"b"]'));
  it("escapes backslashes", () =>
    expect(changedHeadingsCSS(["a\\b"])).toContain('[id="a\\\\b"]'));
  it("escapes newlines so the selector string stays closed", () =>
    expect(changedHeadingsCSS(["a\nb"])).toContain('[id="a\\a b"]'));
  it("draws a dot before each heading", () => {
    const css = changedHeadingsCSS(["x", "y"]);
    expect(css).toContain(
      '[id="x"]::before{content:"";display:inline-block;width:.45em;height:.45em;border-radius:50%;background:#d97706;margin-right:.45em;vertical-align:middle}',
    );
    expect(css).toContain('[id="y"]::before');
  });
  it("is empty for no ids", () => expect(changedHeadingsCSS([])).toBe(""));
});

describe("READER_KEYS", () => {
  it("lists the reader shortcuts", () =>
    expect([...READER_KEYS]).toEqual(["ArrowLeft", "ArrowRight", "t", "T", "/"]));
});
