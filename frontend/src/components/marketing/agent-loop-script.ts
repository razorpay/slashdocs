// The landing demo as data: a list of beats. Each beat lasts `ms`, then the
// next one starts. The scene at a beat is everything that happened so far.
// The terminal strings are real slashdocs CLI output.

export type Side = "terminal" | "browser";
export type Doc = "none" | "v1" | "selecting" | "composing" | "open" | "v2";
export type Line = { kind: "prompt" | "note" | "cmd" | "out"; text: string };
type Beat = { ms: number; line?: Line; doc?: Doc; step?: number; send?: Side };

export const TYPE_MS = 14;
export const TITLE = "How GPS knows where you are";
export const QUOTE = "four satellites";
export const COMMENT = "Why four and not three?";
export const REPLY = "Added in v2";
export const HOST = "docs.example.com";
export const DOC_ID = "doc_463fshhb64djw6pf";
const CMT_ID = "cmt_zyrkukqrr3zdiysz";
const URL = `https://${HOST}/app/d/${DOC_ID}`;

export const isTyped = (line: Line) => line.kind === "prompt" || line.kind === "cmd";

// A typed line lasts as long as its typing plus a short pause.
function say(kind: Line["kind"], text: string): Beat {
  const line = { kind, text };
  return { ms: isTyped(line) ? text.length * TYPE_MS + 350 : 450, line };
}

const send = (to: Side): Beat => ({ ms: 900, send: to });

const BEATS: Beat[] = [
  { ms: 600, doc: "none", step: 0 },
  say(
    "prompt",
    `Write an explainer on how GPS knows where you are and publish it to slashdocs`,
  ),
  say("note", "Wrote gps.html"),
  say("cmd", `slashdocs docs create gps.html --title "${TITLE}"`),
  say("out", `✓ Created document "${TITLE}" (${DOC_ID}). Review it at ${URL}`),
  send("browser"),
  { ms: 1200, doc: "v1", step: 1 },
  { ms: 1000, doc: "selecting" },
  { ms: COMMENT.length * TYPE_MS * 3 + 700, doc: "composing" },
  { ms: 900, doc: "open" },
  send("terminal"),
  { ...say("cmd", `slashdocs docs comments list ${DOC_ID}`), step: 2 },
  say("out", `id=${CMT_ID}  status=open  selected_text=${QUOTE}  body=${COMMENT}`),
  say("note", "Edited gps.html"),
  say(
    "cmd",
    `slashdocs docs push ${DOC_ID} gps.html --summary "Explain the fourth satellite"`,
  ),
  say(
    "out",
    `✓ Pushed version 2 (ver_5zohe3vi6o4li2ml) to ${DOC_ID}. Review it at ${URL}`,
  ),
  say("cmd", `slashdocs docs comments reply ${DOC_ID} ${CMT_ID} --body "${REPLY}"`),
  say("out", `✓ Created reply cmt_ud2bqdfx6vwfso4x on comment ${CMT_ID}.`),
  say("cmd", `slashdocs docs comments update ${DOC_ID} ${CMT_ID} --status resolved`),
  say("out", `✓ Updated comment ${CMT_ID}.`),
  send("browser"),
  { ms: 4500, doc: "v2" },
];

export const BEAT_COUNT = BEATS.length;
export const beatMs = (i: number) => BEATS[i].ms;

export function sceneAt(i: number) {
  const past = BEATS.slice(0, i + 1);
  return {
    lines: past.flatMap((b) => (b.line ? [b.line] : [])),
    doc: past.reduce<Doc>((doc, b) => b.doc ?? doc, "none"),
    step: past.reduce((step, b) => b.step ?? step, 0),
    send: BEATS[i].send,
  };
}
