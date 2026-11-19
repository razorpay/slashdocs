import { expect, test, vi } from "vitest";

// A srcdoc frame holds an empty about:blank document until its srcdoc document
// loads. The app sends the fragment of its URL once, at the first
// slashdocs:ready, so a ready for the empty document sends it to a document
// that is about to be replaced. The bridge runs once per window, so this file
// loads its own copy with a srcdoc frame.
//
// Setting up the srcdoc document itself is not tested here: jsdom rejects an
// AbortSignal of the parent window in the frame's addEventListener, so the
// setup cannot finish in jsdom (bridge.test.ts does not run it either).
test("the bridge does not set up the empty document a srcdoc frame starts with", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "requestAnimationFrame"] });
  document.body.innerHTML =
    '<iframe id="slashdocs-doc" srcdoc="<p>Hello</p>"></iframe>';
  const frame = document.querySelector("iframe")!;
  const posted: { type: string }[] = [];
  vi.spyOn(window, "postMessage").mockImplementation((data) => void posted.push(data));

  await import("../bridge/bridge.ts");
  // jsdom does not load srcdoc: the frame keeps its initial document, which is
  // complete, so the bridge tries to set it up on a timer.
  const d = frame.contentDocument!;
  expect(d.URL).toBe("about:blank");
  expect(d.readyState).toBe("complete");
  vi.runOnlyPendingTimers();
  expect(posted.filter(({ type }) => type === "slashdocs:ready")).toEqual([]);
});
