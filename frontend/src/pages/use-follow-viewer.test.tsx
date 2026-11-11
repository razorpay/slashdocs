import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { useFollowViewer } from "./use-follow-viewer";
import type { Viewer } from "./use-document-stream";

const reviewer: Viewer = {
  session: "s_reviewer",
  principal: { type: "user", id: "u_reviewer", name: "Reviewer" },
  version: "ver_2",
  seenAt: 1,
};

function follow(cursorVersion: (session: string) => string | undefined) {
  const showVersion = vi.fn();
  const hook = renderHook(
    () => useFollowViewer({ viewers: [reviewer], cursorVersion }, showVersion),
    {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter>{children}</MemoryRouter>
      ),
    },
  );
  return { hook, showVersion };
}

describe("useFollowViewer", () => {
  it("keeps a follow of a viewer who did not send their view yet", () => {
    const { hook, showVersion } = follow(() => undefined);
    act(() => hook.result.current.followViewer(reviewer, true));
    expect(hook.result.current.followedSession).toBe("s_reviewer");
    expect(hook.result.current.followedCursor).toEqual({
      session: "s_reviewer",
      continuous: true,
    });
    // Their version shows now, and the frame follows their first view.
    expect(showVersion).toHaveBeenCalledWith("ver_2", undefined);
  });

  it("goes once to a viewer with no view, and follows nobody", () => {
    const { hook, showVersion } = follow(() => undefined);
    act(() => hook.result.current.followViewer(reviewer));
    expect(hook.result.current.followedCursor).toBeUndefined();
    expect(showVersion).toHaveBeenCalledWith("ver_2", undefined);
  });

  it("follows a viewer at the version of their cursor", () => {
    const { hook, showVersion } = follow(() => "ver_3");
    act(() => hook.result.current.followViewer(reviewer, true));
    expect(hook.result.current.followedSession).toBe("s_reviewer");
    expect(showVersion).toHaveBeenCalledWith("ver_3");
  });

  it("stops following on an Esc that nothing else took", () => {
    const { hook } = follow(() => undefined);
    act(() => hook.result.current.followViewer(reviewer, true));
    const esc = () =>
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    // Edit mode takes the Esc, as the Esc chord tells.
    const taken = esc();
    taken.preventDefault();
    act(() => void window.dispatchEvent(taken));
    expect(hook.result.current.followedSession).toBe("s_reviewer");
    act(() => void window.dispatchEvent(esc()));
    expect(hook.result.current.followedSession).toBeUndefined();
  });
});
