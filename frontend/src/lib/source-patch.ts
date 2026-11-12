// A patch brings the frame from the source that it loaded to a newer source
// without a load. patchBetween finds, for each change between the two
// sources, the deepest original element that holds the change in the two
// parses, and the original children around the change that stay as they
// are. The frame then changes only the nodes between those children.

import type { DefaultTreeAdapterTypes as P } from "parse5";
import type { Patch } from "../../bridge/source-pieces.ts";
import { childrenOf, VOID, type Change, type SourceTree } from "./source-edits";
import { changesBetween, type Range } from "./source-merge";

// The patches for a change, or the reason that the change cannot apply in
// place, so that the frame must load the version again. codes are the
// scripts whose code changes: the app finds the string that changed in
// each one, and makes its patch.
// tags are the start tags of the elements that the patches put in, as the
// target has them.
export type Patches =
  { patches: Patch[]; codes: Code[]; tags: string[] } | { reload: string };
export type Code = { script: number; html: string };

// The content that a patch never carries: it runs code, loads a resource,
// or holds state that a change of nodes does not keep. The content of a
// noscript is text for the parser here, where scripts run, and elements for
// the frame, which parses a patch in a document with no scripts.
const ACTIVE =
  /^(script|noscript|style|link|meta|base|iframe|frame|object|embed|canvas|svg|math|template|slot|form|input|button|select|textarea|video|audio|source|track|dialog)$/;
// An attribute that runs code: an event handler, or a URL of a script. The
// browser takes no space or control character in a URL scheme.
const runsCode = ({ name, value }: { name: string; value: string }) =>
  name.startsWith("on") || /^javascript:/i.test(value.replace(/[\0- ]/g, ""));
// The elements whose content is not HTML of the document: raw text, foreign
// content, and a template.
const OPAQUE =
  /^(script|style|title|textarea|xmp|iframe|noembed|noframes|noscript|plaintext|svg|math|template)$/;

// The children of one parent that a patch replaces: the source from `from`
// to `to`, between the child elements after and before.
type Run = {
  parent: P.Element;
  after?: P.Element;
  before?: P.Element;
  from: number;
  to: number;
};

// marks are the ranges of target that other people put in. Each patch gets
// those that lie in its html. A range that crosses the edge of a run is
// left out. shows is the source that the frame shows, when it is not the
// loaded source. The patches also bring each change of it that the target
// does not have back to the target, as when a person typed a word and took
// it out again.
export function patchBetween(
  tree: SourceTree,
  target: string,
  marks: Range[] = [],
  shows = tree.source,
): Patches {
  const { source } = tree;
  const changes = changesOf(source, target);
  for (const { start, end } of changesOf(source, shows))
    if (!changes.some((change) => change.start <= end && start <= change.end))
      changes.push({ start, end, text: source.slice(start, end) });
  changes.sort((a, b) => a.start - b.start);
  if (!changes.length) return { patches: [], codes: [], tags: [] };
  const next = tree.parse(target);
  const body = bodyOf(tree);
  const nextBody = bodyOf(next);
  if (!body || !nextBody) return { reload: "the document has no body" };

  // at maps an offset of the loaded source to the target. The offset is
  // outside every change. Text that a change adds exactly at the offset
  // comes before it when inserted is set.
  const at = (offset: number, inserted: boolean) => {
    let moved = offset;
    for (const { start, end, text } of changes) {
      if (start < offset && offset < end) return NaN;
      if (end < offset || (end === offset && (start < offset || inserted)))
        moved += text.length - (end - start);
    }
    return moved;
  };

  // twin gives the element of the target that an element of the loaded
  // source became, when it has the same tag name and its tags are at the
  // same places. Its attributes can change. A body with no start tag has a
  // twin when the two bodies start at the same place.
  const twin = (element: P.Element): P.Element | undefined => {
    const from = element.sourceCodeLocation;
    if (!from?.startTag) {
      const same =
        !nextBody.sourceCodeLocation?.startTag &&
        contentOf(next, nextBody)[0] === at(contentOf(tree, element)[0], false);
      return same ? nextBody : undefined;
    }
    const other = next.elements.get(at(from.startTag.startOffset, true));
    const to = other?.sourceCodeLocation;
    const same =
      to?.startTag &&
      other?.tagName === element.tagName &&
      closed(element) &&
      !tree.copied.has(from.startTag.startOffset) &&
      !next.copied.has(to.startTag.startOffset) &&
      to.endTag?.startOffset === (from.endTag && at(from.endTag.startOffset, true)) &&
      to.endOffset === at(from.endOffset, false);
    return same ? other : undefined;
  };

  // holderOf gives the deepest element in parent, or parent, whose content
  // holds the change and that has a twin.
  const holderOf = (parent: P.Element, change: Change): P.Element | undefined => {
    const tags = parent.sourceCodeLocation;
    if (tags?.startTag && !tags.endTag) return undefined;
    const [from, to] = contentOf(tree, parent);
    if (change.start < from || change.end > to || !twin(parent)) return undefined;
    for (const child of childrenOf(parent)) {
      const inner = "element" in child && holderOf(child.element, change);
      if (inner) return inner;
    }
    return parent;
  };

  // The patches of start tags, styles and scripts, by the offset of their
  // element.
  const others = new Map<number, Patch | Code>();
  // retext gives the patch for a change in the text of a style or a script,
  // which can be in the head. One in foreign content or in a template is
  // not one: the html element is above each other one.
  const retext = (
    change: Change,
  ): Code | { style: number; html: string } | undefined => {
    for (const [at, element] of tree.elements) {
      const up = above(element);
      const other = /^(style|script)$/.test(element.tagName) && twin(element);
      if (
        !other ||
        up.at(-1)?.tagName !== "html" ||
        up.some((el) => OPAQUE.test(el.tagName))
      )
        continue;
      const [from, to] = contentOf(tree, element);
      if (from > change.start || change.end > to) continue;
      const html = target.slice(...contentOf(next, other));
      return element.tagName === "style" ? { style: at, html } : { script: at, html };
    }
    return undefined;
  };
  // retag gives the patch for a change of the attributes of a child of
  // parent, or why the change cannot apply in place. A change of an
  // attribute that runs code never applies in place.
  const retag = (parent: P.Element, change: Change) => {
    const element = elementsOf(parent).find((child) => {
      const { startOffset, endOffset } = child.sourceCodeLocation!.startTag!;
      return change.start === change.end
        ? startOffset < change.start && change.start < endOffset
        : startOffset <= change.start && change.end <= endOffset;
    });
    const other = element && twin(element);
    // A new tag name, or a start tag of active content, goes in a run.
    if (!other || ACTIVE.test(element.tagName)) return undefined;
    const was = new Map(element.attrs.map(({ name, value }) => [name, value]));
    const now = new Map(other.attrs.map(({ name, value }) => [name, value]));
    const changed = [...was.keys(), ...now.keys()].filter(
      (name) => was.get(name) !== now.get(name),
    );
    if (changed.some((name) => runsCode({ name, value: now.get(name) ?? "" })))
      return "a change has an event handler or a script URL in it";
    const { startOffset, endOffset } = other.sourceCodeLocation!.startTag!;
    return { tag: startOf(element)!, html: target.slice(startOffset, endOffset) };
  };

  const runs: Run[] = [];
  for (const change of changes) {
    const text = retext(change);
    if (text) {
      others.set("style" in text ? text.style : text.script, text);
      continue;
    }
    const parent = holderOf(body, change);
    if (!parent) return { reload: "a change is outside the body" };
    const opaque = [parent, ...above(parent)].find((el) => OPAQUE.test(el.tagName));
    if (opaque) return { reload: `a change is in <${opaque.tagName}>` };
    const tag = retag(parent, change);
    if (typeof tag === "string") return { reload: tag };
    if (tag) {
      others.set(tag.tag, tag);
      continue;
    }
    // A child stays when it has a twin that is a child of the parent's twin.
    const nextChildren = new Set(elementsOf(twin(parent)!));
    const stays = (child: P.Element) => nextChildren.has(twin(child)!);
    const children = elementsOf(parent);
    const after = children
      .filter((child) => child.sourceCodeLocation!.endOffset <= change.start)
      .reverse()
      .find(stays);
    const before = children.find(
      (child) => child.sourceCodeLocation!.startOffset >= change.end && stays(child),
    );
    const [from, to] = runOf(tree, parent, after, before);
    // The children that stay divide a parent into runs, so two changes of
    // one parent have the same run or two separate ones.
    if (!runs.some((run) => run.parent === parent && run.from === from))
      runs.push({ parent, after, before, from, to });
  }

  const patches: Patch[] = [];
  const tags: string[] = [];
  for (const run of runs) {
    // The run of an outer parent already carries a change in it.
    const parentAt = startOf(run.parent);
    if (runs.some((outer) => outer.from <= parentAt! && parentAt! < outer.to)) continue;
    const [from, to] = [at(run.from, false), at(run.to, true)];
    const unfit =
      unfitIn(tree, run.parent, run.from, run.to) ??
      unfitIn(next, twin(run.parent)!, from, to);
    if (unfit) return { reload: `a change has ${unfit} in it` };
    const inside = marks
      .filter(([start, end]) => from <= start && end <= to)
      .map(([start, end]): Range => [start - from, end - from]);
    for (const [offset, element] of next.elements)
      if (from <= offset && offset < to)
        tags.push(
          target.slice(offset, element.sourceCodeLocation!.startTag!.endOffset),
        );
    patches.push({
      in: parentAt ?? null,
      after: run.after ? startOf(run.after)! : null,
      before: run.before ? startOf(run.before)! : null,
      html: target.slice(from, to),
      ...(inside.length > 0 && { marks: inside }),
    });
  }
  // A run that holds a start tag changes it already.
  const codes: Code[] = [];
  for (const [at, patch] of others) {
    if (runs.some((run) => run.from <= at && at < run.to)) continue;
    if ("script" in patch) codes.push(patch);
    else patches.push(patch);
  }
  return { patches, codes, tags };
}

// patchRun gives the range of the loaded source that a patch replaces.
export function patchRun(tree: SourceTree, patch: Patch | Code): [number, number] {
  const element = (at: number | null) =>
    at === null ? undefined : tree.elements.get(at);
  if ("tag" in patch) {
    const { startOffset, endOffset } = element(patch.tag)!.sourceCodeLocation!
      .startTag!;
    return [startOffset, endOffset];
  }
  if ("style" in patch) return contentOf(tree, element(patch.style)!);
  if ("script" in patch) return contentOf(tree, element(patch.script)!);
  return runOf(
    tree,
    element(patch.in) ?? bodyOf(tree)!,
    element(patch.after),
    element(patch.before),
  );
}

function runOf(
  tree: SourceTree,
  parent: P.Element,
  after?: P.Element,
  before?: P.Element,
): [number, number] {
  const [from, to] = contentOf(tree, parent);
  return [
    after?.sourceCodeLocation!.endOffset ?? from,
    before?.sourceCodeLocation!.startOffset ?? to,
  ];
}

// changesOf gives the changes from source to target, each one settled.
function changesOf(source: string, target: string): Change[] {
  const changes: Change[] = [];
  changesBetween(source, target).forEach((change, i, all) => {
    const low = changes.at(-1)?.end ?? 0;
    changes.push(settle(source, change, low, all[i + 1]?.start ?? source.length));
  });
  return changes;
}

// settle moves a change that only adds or only removes text to the nearest
// place where that text is whole tags, when there is one. A diff gives a
// new paragraph between two as "new</p><p>" as readily as "<p>new</p>", and
// only the second one fits between the two paragraphs. The change stays
// between low and high, the changes around it.
function settle(source: string, change: Change, low: number, high: number): Change {
  if (change.text && change.end > change.start) return change;
  for (const step of [-1, 1]) {
    const left = step < 0;
    let { start, end } = change;
    let text = change.text || source.slice(start, end);
    for (let moved = 0; moved <= text.length; moved++) {
      if (wholeTags(text)) return { start, end, text: change.text && text };
      // The text moves over one unit of the source, which must be the unit
      // at its other end.
      const unit = left ? source[start - 1] : source[end];
      const stop = left ? start === low : end === high;
      if (stop || unit !== (left ? text.at(-1) : text[0])) break;
      text = left ? unit + text.slice(0, -1) : text.slice(1) + unit;
      start += step;
      end += step;
    }
  }
  return change;
}

const TAG = /<(\/?)([a-z][^\s/>]*)[^>]*>/gi;

// Whether HTML does not start or end in a tag, and has an end tag for each
// start tag, after it.
function wholeTags(html: string) {
  if (!/^[^<>]*(?:<|$)/.test(html) || !/(?:^|>)[^<>]*$/.test(html)) return false;
  let open = 0;
  for (const [, end, name] of html.matchAll(TAG)) {
    if (!VOID.test(name)) open += end ? -1 : 1;
    if (open < 0) return false;
  }
  return open === 0;
}

const bodyOf = (tree: SourceTree) =>
  tree.document.childNodes
    .find((node): node is P.Element => node.nodeName === "html")
    ?.childNodes.find((node): node is P.Element => node.nodeName === "body");

// The offset of the start tag of an element, or undefined when it has none.
const startOf = (element: P.Element) =>
  element.sourceCodeLocation?.startTag?.startOffset;

// Whether the source says where an element ends: it has an end tag, or it
// has no content.
function closed(element: P.Element) {
  const at = element.sourceCodeLocation!;
  return !!at.endTag || at.endOffset === at.startTag!.endOffset;
}

// contentOf gives the range of the content of an element that has an end
// tag: after its start tag, before its end tag. The content of a body with
// no start tag goes from its first child to the end of the source.
function contentOf(tree: SourceTree, element: P.Element): [number, number] {
  const at = element.sourceCodeLocation;
  if (at?.startTag) return [at.startTag.endOffset, at.endTag!.startOffset];
  const [first] = childrenOf(element);
  const start =
    first &&
    ("element" in first ? first.element.sourceCodeLocation!.startOffset : first.start);
  return [start ?? tree.source.length, tree.source.length];
}

// The child elements of an element, as the source map counts them.
const elementsOf = (element: P.Element) =>
  childrenOf(element).flatMap((child) => ("element" in child ? [child.element] : []));

// unfitIn names what starts in a range of the content of parent and that a
// patch cannot carry, if there is some: active content, or an element that
// the parser copied or moved out of parent, as it does for a tag that
// closes too late. No node of the frame stands for such an element.
function unfitIn(tree: SourceTree, parent: P.Element, from: number, to: number) {
  for (const [start, element] of tree.elements) {
    if (start < from || start >= to) continue;
    if (ACTIVE.test(element.tagName)) return `<${element.tagName}>`;
    if (element.attrs.some(runsCode)) return "an event handler or a script URL";
    if (tree.copied.has(start) || !above(element).includes(parent))
      return "markup that the parser moves";
  }
  return undefined;
}

// The elements that an element is in, the nearest first.
function above(element: P.Element) {
  const elements: P.Element[] = [];
  for (let node = element.parentNode; node && "tagName" in node; node = node.parentNode)
    elements.push(node);
  return elements;
}
