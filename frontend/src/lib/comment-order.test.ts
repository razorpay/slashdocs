import { expect, it } from "vitest";
import { inDocumentOrder, nextThread } from "./comment-order";

const threads = ["late", "lost", "early", "middle"].map((id) => ({ id }));
const positions = new Map([
  ["early", { top: 10 }],
  ["middle", { top: 200 }],
  ["late", { top: 900 }],
]);
const ids = (list: { id: string }[]) => list.map((c) => c.id);

it("puts threads in the order of the document, with the ones it lacks last", () => {
  expect(ids(inDocumentOrder(threads, positions))).toEqual([
    "early",
    "middle",
    "late",
    "lost",
  ]);
});

it("goes to the next and previous thread, round the ends", () => {
  const order = inDocumentOrder(threads, positions);
  expect(nextThread(order, undefined, 1)).toBe("early");
  expect(nextThread(order, undefined, -1)).toBe("lost");
  expect(nextThread(order, "early", 1)).toBe("middle");
  expect(nextThread(order, "early", -1)).toBe("lost");
  expect(nextThread(order, "lost", 1)).toBe("early");
});

it("goes to the next thread that a filter takes, as the next unread one", () => {
  const order = inDocumentOrder(threads, positions);
  const unread = new Set(["early", "late"]);
  const pick = (c: { id: string }) => unread.has(c.id);
  expect(nextThread(order, "early", 1, pick)).toBe("late");
  expect(nextThread(order, "late", 1, pick)).toBe("early");
  expect(nextThread(order, "middle", 1, () => false)).toBeUndefined();
});
