import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useDocumentExport } from "./use-document-export";

const openPreview = vi.hoisted(() => vi.fn());
vi.mock("@/lib/document-export", async (original) => ({
  ...(await original<typeof import("@/lib/document-export")>()),
  openPrintPreview: openPreview,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  openPreview.mockReset();
});

function setup(active: boolean) {
  vi.stubGlobal("navigator", { userActivation: { isActive: active } });
  const element = document.createElement("iframe");
  document.body.append(element);
  const frame = { current: element };
  const hook = renderHook(() =>
    useDocumentExport(frame, "https://render.example", true, vi.fn()),
  );
  return { ...hook, frame };
}

it("denies document exports without browser-owned user activation", () => {
  const { frame, unmount } = setup(false);
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://render.example",
        source: frame.current.contentWindow,
        data: { type: "slashdocs:print-request", userActivated: true },
      }),
    ),
  );
  expect(openPreview).not.toHaveBeenCalled();
  unmount();
});

it("denies messages from another origin or window even during a real activation", () => {
  const { frame, unmount } = setup(true);
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://evil.example",
        source: frame.current.contentWindow,
        data: { type: "slashdocs:print-request" },
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "https://render.example",
        source: window,
        data: { type: "slashdocs:print-request" },
      }),
    );
  });
  expect(openPreview).not.toHaveBeenCalled();
  unmount();
});
