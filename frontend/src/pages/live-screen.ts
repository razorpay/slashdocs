// What the frame of a load shows, as a source, and what a patch must still
// bring to it, for useLiveText.

import {
  checkCodeChange,
  checkScriptChange,
  stringChange,
  writeScriptChange,
  type Render,
} from "@/lib/script-literals";
import { applyRegions, type Change } from "@/lib/source-edits";
import { patchBetween, patchRun, type Code } from "@/lib/source-patch";
import type { Patch } from "../../bridge/source-pieces";
import type { TextEditResult } from "./doc-context";
import { gone, Refused, type Base, type Load, type ScriptEdit } from "./live-load";

// screenOf gives the screen for edits of the frame: the loaded source with
// every region and each change of a patch outside them, and with each
// script change that shows on the page. probe renders a source, to make
// sure that a script change shows. refused tells why a script change is
// left out.
export async function screenOf(
  s: Load,
  { regions, scripts }: TextEditResult,
  probe: Render,
) {
  const { base, outside, made } = s.text!;
  const applied = applyRegions(base.tree, regions, outside, made);
  if ("refused" in applied) throw new Refused(applied.refused);
  let source = applied.html;
  let refused: string | undefined;
  const changes: ScriptEdit[] = [];
  for (const change of scripts) {
    const key = JSON.stringify(change.locator);
    const last = s.written.get(key);
    // Text typed back to its loaded text writes nothing into the source,
    // but its other places still show the text that was sent last.
    if (change.before.trim() === change.after.trim()) {
      if (last !== undefined) changes.push({ key, from: last, to: change.after });
      continue;
    }
    // Each script change is checked once: it must show on the page.
    // Without the frame, only a change that was checked before can save.
    const id = JSON.stringify(change);
    if (!s.checks.has(id) && !gone(s))
      s.checks.set(
        id,
        checkScriptChange(base, change, probe).catch(() => ({
          refused: "The new text could not be checked.",
        })),
      );
    const checked = await s.checks.get(id);
    if (checked && "refused" in checked) refused ??= checked.refused;
    if (!checked || "refused" in checked) continue;
    const done = await writeScriptChange(source, change.before, change.after);
    if (!done) continue;
    source = done;
    changes.push({ key, from: last ?? change.before, to: change.after });
  }
  return { source, regions: applied.html, scripts: changes, refused };
}

// without gives the patches that a frame still needs: not those of the
// source that it shows already, which are the text that it holds. Two
// patches are the same when they put the same html in place of the same
// source.
export function without<T extends Patch | Code>(
  patches: T[],
  base: Base,
  shows?: string,
): T[] {
  const keyOf = (patch: Patch | Code) =>
    JSON.stringify([patchRun(base.tree, patch), patch.html]);
  const there = shows === undefined ? undefined : patchBetween(base.tree, shows);
  const has =
    there && "patches" in there ? [...there.patches, ...there.codes].map(keyOf) : [];
  return patches.filter((p) => !has.includes(keyOf(p)));
}

// stringPatches gives the patch of each script whose code changed in one
// string that the page shows, or nothing when a code changed in another
// way. The frame shows the code that it shows outside its regions, or else
// the loaded code. Each change renders once in probe frames (see
// checkCodeChange). The script text that the reader typed in changes only
// in a load.
export async function stringPatches(
  s: Load,
  codes: Code[],
  { scripts }: TextEditResult,
  probe: Render,
): Promise<Patch[] | undefined> {
  const { base, outside } = s.text!;
  const patches: Patch[] = [];
  for (const code of codes) {
    const range = patchRun(base.tree, code);
    const was =
      outside.find((change) => change.start === range[0])?.text ??
      base.source.slice(...range);
    const type = base.tree.elements
      .get(code.script)!
      .attrs.find(({ name }) => name === "type")?.value;
    const change = await stringChange(type, was, code.html);
    const typed = (text: string) => text.trim() === change?.from.trim();
    if (!change || scripts.some((c) => typed(c.before) || typed(c.after)))
      return undefined;
    const id = JSON.stringify([range, was, code.html]);
    if (!s.checks.has(id) && !gone(s))
      s.checks.set(
        id,
        checkCodeChange(base.source, range, [was, code.html], change, probe).catch(
          () => ({ refused: "The new text could not be checked." }),
        ),
      );
    const checked = await s.checks.get(id);
    if (!checked || "refused" in checked) return undefined;
    patches.push({ ...code, ...change, places: checked.places });
  }
  return patches;
}

// describe says in words what an operation changed in script text.
export function describe(scripts: ScriptEdit[]): string {
  return scripts
    .map(({ from, to }) => `Changed “${from.trim()}” to “${to.trim()}”`)
    .join(", ");
}

// outsideAfter gives the changes outside the regions of a frame after it
// took patches: each patch of a start tag or a style replaces the change of
// its element, and one that gives back the loaded source is no change.
export function outsideAfter(
  outside: Change[],
  base: Base,
  patches: Patch[],
): Change[] {
  const changes = new Map(outside.map((change) => [change.start, change]));
  for (const patch of patches) {
    if ("in" in patch) continue;
    const [start, end] = patchRun(base.tree, patch);
    if (base.source.slice(start, end) === patch.html) changes.delete(start);
    else changes.set(start, { start, end, text: patch.html });
  }
  return [...changes.values()].sort((a, b) => a.start - b.start);
}
