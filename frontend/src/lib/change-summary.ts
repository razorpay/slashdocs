// changeSummaryLines splits a version's change summary into one entry per
// line. Agents write one change per line, often as a Markdown list, so any
// leading "-", "*", or "•" marker is dropped.
export function changeSummaryLines(summary = ""): string[] {
  return summary
    .split("\n")
    .map((line) => line.trim().replace(/^[-*•]\s*/, ""))
    .filter(Boolean);
}
