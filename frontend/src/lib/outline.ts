import { createPersistentStore } from "./persistent-store";

// A heading of the rendered document, as the bridge reports it.
export type OutlineHeading = {
  id: string;
  level: number;
  text: string;
};

// The outline shows by default. A reader who hides it gets the document
// without it, across documents and visits, until they show it again.
export const outlineOpenStore = createPersistentStore<boolean>(
  "slashdocs:outline-open",
  true,
  (parsed) => parsed !== false,
);

// parseOutline keeps the well-formed headings of a bridge message. The frame
// hosts untrusted HTML, so the message is checked and bounded here.
export function parseOutline(value: unknown): OutlineHeading[] {
  if (!Array.isArray(value)) return [];
  const headings: OutlineHeading[] = [];
  for (const item of value.slice(0, 500)) {
    if (
      item &&
      typeof item.id === "string" &&
      item.id.length <= 1024 &&
      typeof item.text === "string" &&
      Number.isInteger(item.level) &&
      item.level >= 1 &&
      item.level <= 6
    ) {
      headings.push({ id: item.id, level: item.level, text: item.text.slice(0, 200) });
    }
  }
  return headings;
}
