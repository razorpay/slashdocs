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

it("gives no thread when there is none", () => {
  expect(nextThread([], undefined, 1)).toBeUndefined();
});
