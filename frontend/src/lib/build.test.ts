import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each test loads the module again, because a page notices another build once.
async function setup({ own = "own", hidden = false, unsaved = [] as string[] } = {}) {
  vi.resetModules();
  vi.doMock("./persistent-store", () => ({ readUnsavedWords: () => unsaved }));
  window.__SLASHDOCS_BUILD__ = own;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const reload = vi.fn();
  vi.stubGlobal("location", { ...window.location, reload });
  const { noticeBuild } = await import("./build");
  const hide = () => {
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  };
  return { noticeBuild, reload, hide };
}

beforeEach(() => {
  vi.restoreAllMocks();
  sessionStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("./persistent-store");
});

describe("noticeBuild", () => {
  it("loads a page of another build again when it is hidden, not while it shows", async () => {
    const { noticeBuild, reload, hide } = await setup();

    noticeBuild("new");
    expect(reload).not.toHaveBeenCalled();

    hide();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("loads a hidden page of another build again at once", async () => {
    const { noticeBuild, reload } = await setup({ hidden: true });

    noticeBuild("new");

    expect(reload).toHaveBeenCalledOnce();
  });

  it("waits while the page holds words that only it has", async () => {
    const { noticeBuild, reload } = await setup({ hidden: true, unsaved: ["draft"] });

    noticeBuild("new");

    expect(reload).not.toHaveBeenCalled();
  });

  it("waits while a guard of the page would warn on an unload", async () => {
    const { noticeBuild, reload } = await setup({ hidden: true });
    const warn = (e: Event) => e.preventDefault();
    window.addEventListener("beforeunload", warn);

    noticeBuild("new");
    window.removeEventListener("beforeunload", warn);

    expect(reload).not.toHaveBeenCalled();
  });

  it("loads a page again at most once in ten minutes", async () => {
    const first = await setup({ hidden: true });
    first.noticeBuild("new");
    expect(first.reload).toHaveBeenCalledOnce();

    // The reloaded page gets the other build of a rolling deploy.
    const second = await setup({ own: "new", hidden: true });
    second.noticeBuild("own");
    expect(second.reload).not.toHaveBeenCalled();
  });

  it("keeps a page of the same build, of the dev server, or with no build named", async () => {
    for (const [own, build] of [
      ["own", "own"],
      ["__SLASHDOCS_BUILD_VALUE__", "new"],
      ["own", undefined],
    ]) {
      const { noticeBuild, reload } = await setup({ own: own!, hidden: true });
      noticeBuild(build);
      expect(reload).not.toHaveBeenCalled();
    }
  });
});
