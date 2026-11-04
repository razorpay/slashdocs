import type { Node as JSNode, TemplateLiteral } from "acorn";
import type { DefaultTreeAdapterTypes as P5 } from "parse5";
import { parseSource, tagSource, type SourceTree } from "@/lib/source-edits";
import type { ProbeResult } from "../../bridge/script-text";
import type { Locator, ScriptChange } from "../../bridge/source-pieces";

// Script text is text that a document's own script shows. When it comes from
// one string in the source, an editor can change that string. These helpers
// find the strings that hold a text and write a new text into one of them.

// A string in an inline script of the source: its source range, quotes
// included, and its value. json marks a string in a JSON block.
export type LiteralCandidate = {
  start: number;
  end: number;
  value: string;
  json: boolean;
};

const JS_TYPES = /^(?:|module|(?:text|application)\/(?:x-)?(?:java|ecma)script)$/;

// findLiterals gives the strings in the inline scripts of source whose value
// equals text, both trimmed at the ends. A string counts when the script
// shows it as it is: a string or template literal without expressions in a
// classic or module script, or a string value in a data block that holds
// JSON, such as application/json or an import map. Keys, module
// names and tagged templates are code, not text, so they never count.
export async function findLiterals(
  source: string,
  text: string,
): Promise<LiteralCandidate[]> {
  const wanted = text.trim();
  if (!wanted) return [];
  // acorn parses the scripts. ast-grep has no small browser build (its WASM
  // is several MB). acorn 8 is 122 KB minified and 35 KB gzipped, and loads
  // only when an editor clicks script text.
  const [acorn, { parse }] = await Promise.all([import("acorn"), import("parse5")]);
  const tree = parse(source, { sourceCodeLocationInfo: true });
  const found: LiteralCandidate[] = [];
  for (const { code, at, type } of inlineScripts(tree, source)) {
    const json = !JS_TYPES.test(type);
    const values = json ? jsonStrings(acorn, code) : jsStrings(acorn, code);
    for (const { start, end, value } of values)
      if (value.trim() === wanted)
        found.push({ start: at + start, end: at + end, value, json });
  }
  return found;
}

// replaceLiteral gives source with the string at candidate changed to text.
// The string keeps its quotes and the white space at its ends. The new value
// is escaped so that it stays one string, and never closes its script.
export function replaceLiteral(
  source: string,
  candidate: LiteralCandidate,
  text: string,
): string {
  const { start, end, value, json } = candidate;
  const lead = value.slice(0, value.length - value.trimStart().length);
  const trail = value.slice(value.trimEnd().length);
  const next = lead + text.trim() + trail;
  const quote = source[start];
  const literal = json ? JSON.stringify(next) : quote + escapeJS(next, quote) + quote;
  return (
    source.slice(0, start) +
    literal.replace(/<\/(script)/gi, "<\\/$1") +
    source.slice(end)
  );
}

const JS_ESCAPES: Record<string, string> = { "\n": "\\n", "\r": "\\r" };

// escapeJS escapes value for a string in quote. In a template, "${" starts an
// expression, so it is escaped too.
function escapeJS(value: string, quote: string): string {
  const special = new RegExp(
    `[\\\\${quote}\\n\\r]${quote === "`" ? "|\\$\\{" : ""}`,
    "g",
  );
  return value.replace(special, (c) => JS_ESCAPES[c] ?? "\\" + c);
}

type Acorn = typeof import("acorn");
type AnyNode = JSNode & Record<string, unknown>;
type StringNode = { start: number; end: number; value: string };

// inlineScripts gives the code of every script without src in the document,
// outside templates, with the source offset of its first character. The code
// comes from the source, not the parsed text, so that offsets in it map to
// the source.
function* inlineScripts(
  node: P5.ParentNode,
  source: string,
): Generator<{ code: string; at: number; type: string }> {
  for (const child of node.childNodes) {
    if (!("tagName" in child)) continue;
    const text = child.childNodes[0];
    const attr = (name: string) => child.attrs.find((a) => a.name === name)?.value;
    if (
      child.tagName === "script" &&
      attr("src") === undefined &&
      text?.sourceCodeLocation
    ) {
      const { startOffset, endOffset } = text.sourceCodeLocation;
      const type = (attr("type") ?? "").split(";")[0].trim().toLowerCase();
      yield { code: source.slice(startOffset, endOffset), at: startOffset, type };
    }
    yield* inlineScripts(child, source);
  }
}

// jsStrings parses code as a classic script, else as a module, as the
// browser runs either kind.
function jsStrings(acorn: Acorn, code: string): StringNode[] {
  for (const sourceType of ["script", "module"] as const) {
    try {
      return strings(acorn.parse(code, { ecmaVersion: "latest", sourceType }));
    } catch {
      // Not this kind of script.
    }
  }
  return [];
}

// jsonStrings finds the strings of a JSON block. JSON is a JavaScript
// expression, so acorn gives the exact range of each string and tells keys
// from values, and no second scanner is needed. JSON.parse first makes sure
// that the block is JSON and not some other text.
function jsonStrings(acorn: Acorn, code: string): StringNode[] {
  try {
    JSON.parse(code);
    return strings(acorn.parseExpressionAt(code, 0, { ecmaVersion: "latest" }));
  } catch {
    return [];
  }
}

// strings gives the string literals and the templates without expressions
// under node, except those in code positions.
function strings(node: JSNode): StringNode[] {
  const out: StringNode[] = [];
  const visit = (n: AnyNode) => {
    const value =
      n.type === "TemplateLiteral"
        ? (n as AnyNode & TemplateLiteral).expressions.length === 0 &&
          (n as AnyNode & TemplateLiteral).quasis[0].value.cooked
        : n.type === "Literal" && n.value;
    if (typeof value === "string") out.push({ start: n.start, end: n.end, value });
    for (const [key, child] of Object.entries(n)) {
      const code =
        (key === "key" && !n.computed) ||
        (key === "source" && /Import|Export/.test(n.type)) ||
        key === "quasi";
      if (code) continue;
      for (const c of [child].flat())
        if (typeof (c as AnyNode | null)?.type === "string") visit(c as AnyNode);
    }
  };
  visit(node as AnyNode);
  return out;
}

// writeScriptChange gives source with before changed to after in the one
// string that holds before, or null when no one string holds it.
export async function writeScriptChange(
  source: string,
  before: string,
  after: string,
): Promise<string | null> {
  const found = await findLiterals(source, before);
  return found.length === 1 ? replaceLiteral(source, found[0], after) : null;
}

// A render of a tagged source in a probe frame: the text at a locator, and
// how many text nodes show each string.
export type Render = (
  html: string,
  locator: Locator,
  strings: string[],
) => Promise<ProbeResult>;

// checkScriptChange makes sure that the change shows on the page when its new
// text goes into the one string of the loaded source that holds its old
// text. Both sources render in probe frames. The locator must show the new
// text, and as many places must stop showing the old text as start showing
// the new text. The scripts must throw no new errors, and no other text may
// go. It gives that number of places, or why the change cannot save.
export async function checkScriptChange(
  loaded: { source: string; tree: SourceTree },
  { locator, before, after }: ScriptChange,
  render: Render,
): Promise<{ places: number } | { refused: string }> {
  const found = await findLiterals(loaded.source, before);
  if (found.length !== 1)
    return { refused: "This text does not come from one string in the script." };
  if (!after.trim()) return { refused: "Script text cannot be empty." };
  const changed = replaceLiteral(loaded.source, found[0], after);
  // The elements after the string move by the change in its length. The
  // probe gives them their loaded offsets, so that the locator finds them.
  const moved = changed.length - loaded.source.length;
  const offsetOf = (at: number) => (at > found[0].start ? at - moved : at);
  const strings = [before, after];
  const [was, now] = await Promise.all([
    render(tagSource(loaded.tree), locator, strings),
    render(tagSource(await parseSource(changed), offsetOf), locator, strings),
  ]);
  const places = now.counts[1] - was.counts[1];
  const shows =
    now.text?.trim() === after.trim() &&
    places >= 1 &&
    was.counts[0] - now.counts[0] === places;
  if (now.errors > was.errors || now.texts < was.texts)
    return { refused: "This change stops a script on the page." };
  return shows
    ? { places }
    : { refused: "The page does not show the new text where you typed it." };
}
