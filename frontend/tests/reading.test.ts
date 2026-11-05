import { describe, expect, it } from "vitest";
import {
  applyChangeDots,
  CHANGE_DOT_CLASS,
  CHANGE_DOT_CSS,
  markedHeadingIds,
  DEFAULT_READER_SETTINGS,
  documentTheme,
  progression,
  READER_KEYS,
  scrollProgression,
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
  // A page that does not scroll says nothing about how far the reader got.
  it("is unknown when the page does not scroll", () => {
    expect(progression(0, 400, 500)).toBeNull();
    expect(progression(0, 500, 500)).toBeNull();
  });
  it("is a share of scrollable height", () =>
    expect(progression(250, 1000, 500)).toBe(0.5));
  it("is 0 for non-finite input", () => expect(progression(NaN, 1000, 500)).toBe(0));
});

describe("scrollProgression", () => {
  const fits = { top: 0, height: 500, client: 500 };
  it("measures the page when it scrolls", () =>
    expect(
      scrollProgression([
        { top: 100, height: 600, client: 500 },
        { top: 0, height: 900, client: 300 },
      ]),
    ).toBe(1));
  // App-style chapters scroll an inner container and never the page.
  it("falls back to a nested scroller", () =>
    expect(
      scrollProgression([fits, null, { top: 300, height: 900, client: 300 }]),
    ).toBe(0.5));
  it("is unknown when nothing scrolls", () => {
    expect(scrollProgression([fits, { top: 0, height: 10, client: 20 }])).toBeNull();
    expect(scrollProgression([])).toBeNull();
  });
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

describe("change dots", () => {
  function page(html: string): Document {
    const d = document.implementation.createHTMLDocument("t");
    d.body.innerHTML = html;
    return d;
  }
  const dots = (d: Document) =>
    Array.from(d.querySelectorAll(`.${CHANGE_DOT_CLASS}`)).map(
      (x) => x.parentElement!.id,
    );

  it("puts a dot at the start of each listed heading", () => {
    const d = page('<h2 id="a">One</h2><h2 id="b">Two</h2><p id="p">x</p>');
    applyChangeDots(d, ["a", "p", "missing"]);
    expect(dots(d)).toEqual(["a"]);
    const a = d.getElementById("a")!;
    expect(a.firstElementChild?.className).toBe(CHANGE_DOT_CLASS);
    expect(a.firstElementChild?.getAttribute("aria-hidden")).toBe("true");
    // The heading's text, used by anchors and heading links, is unchanged.
    expect(a.textContent).toBe("One");
  });

  it("moves dots when the list changes and never doubles them", () => {
    const d = page('<h2 id="a">One</h2><h3 id="b">Two</h3>');
    applyChangeDots(d, ["a"]);
    applyChangeDots(d, ["a", "b"]);
    expect(dots(d)).toEqual(["a", "b"]);
    applyChangeDots(d, ["b"]);
    expect(dots(d)).toEqual(["b"]);
    applyChangeDots(d, []);
    expect(dots(d)).toEqual([]);
  });

  // Documents number headings with ::before (counter(section) ". "); a
  // dot drawn with ::before would replace that number.
  it("styles only its own element, never a heading pseudo-element", () => {
    expect(CHANGE_DOT_CSS).not.toMatch(/::?(before|after)/);
    expect(CHANGE_DOT_CSS.startsWith(`.${CHANGE_DOT_CLASS}{`)).toBe(true);
  });

  it("accepts only bounded string ids", () => {
    const long = "x".repeat(1025);
    expect(markedHeadingIds(["a", "", 3, long, "b"])).toEqual(["a", "b"]);
    expect(markedHeadingIds("a")).toEqual([]);
    expect(
      markedHeadingIds(Array.from({ length: 1200 }, (_, i) => `h${i}`)),
    ).toHaveLength(1000);
  });
});

describe("READER_KEYS", () => {
  it("lists the reader shortcuts", () =>
    expect([...READER_KEYS]).toEqual(["ArrowLeft", "ArrowRight", "t", "T", "/"]));
});
