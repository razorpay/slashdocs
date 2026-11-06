import { describe, expect, it, vi, afterEach } from "vitest";
import { downloadFilename, printDocumentHTML } from "./document-export";
import { snapshotForPrint } from "../../bridge/document-export";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe("isolated print output", () => {
  it("keeps styling and content but removes active markup and hostile policies", () => {
    const output = printDocumentHTML(
      `<html><head><style>h1{color:red}</style><meta http-equiv="refresh" content="0;url=https://evil.example"><base href="https://evil.example"></head><body onload="alert(1)"><h1>Report</h1><script>alert(1)</script><iframe srcdoc="evil"></iframe><a href="javascript:alert(1)">Link</a><img src="https://example.com/chart.png" onerror="alert(1)"></body></html>`,
    );
    const d = new DOMParser().parseFromString(output, "text/html");
    expect(d.querySelector("h1")?.textContent).toBe("Report");
    expect(d.querySelector("style")?.textContent).toContain("color:red");
    expect(d.querySelector("script,iframe,base,[onload],[onerror]")).toBeNull();
    expect(d.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(d.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(
      d
        .querySelector('meta[http-equiv="Content-Security-Policy"]')
        ?.getAttribute("content"),
    ).toContain("script-src 'none'");
  });
  it("prints without a handler and preserves form state without passwords", async () => {
    document.body.innerHTML =
      '<input value="old"><input type="password" value="secret"><textarea>old</textarea><details><summary>More</summary>Expanded content</details>';
    document.querySelector("input")!.value = "edited";
    document.querySelector("textarea")!.value = "new text";
    document.querySelector("details")!.open = true;
    const html = await snapshotForPrint(document);
    expect(html).toContain('value="edited"');
    expect(html).toContain("new text");
    expect(html).toContain("<details open=");
    expect(html).not.toContain("secret");
  });
  it("waits for async preparation and snapshots revealed content", async () => {
    document.body.innerHTML = "<p hidden>Extra detail</p>";
    window.addEventListener(
      "slashdocs:beforeprint",
      (event) => {
        (event as CustomEvent).detail.waitUntil(
          Promise.resolve().then(() => {
            document.querySelector("p")!.hidden = false;
          }),
        );
      },
      { once: true },
    );
    expect(await snapshotForPrint(document)).not.toContain("<p hidden");
  });
  it("waits for documents that listen for the pre-rename aidocs event", async () => {
    document.body.innerHTML = "<p hidden>Extra detail</p>";
    window.addEventListener(
      "aidocs:beforeprint",
      (event) => {
        (event as CustomEvent).detail.waitUntil(
          Promise.resolve().then(() => {
            document.querySelector("p")!.hidden = false;
          }),
        );
      },
      { once: true },
    );
    expect(await snapshotForPrint(document)).not.toContain("<p hidden");
  });
  it("falls back for rejected and never-settling preparation handlers", async () => {
    vi.useFakeTimers();
    document.body.textContent = "Still printable";
    window.addEventListener(
      "slashdocs:beforeprint",
      (event) => {
        const { waitUntil } = (event as CustomEvent).detail;
        waitUntil(Promise.reject(new Error("failed")));
        waitUntil(new Promise(() => {}));
      },
      { once: true },
    );
    const result = snapshotForPrint(document);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await result).toContain("Still printable");
  });
});
it("makes bounded download names rather than paths", () => {
  expect(downloadFilename("../../report\u202e.pdf")).toBe("_.._report.pdf");
  expect(downloadFilename("x".repeat(200)).length).toBe(160);
  expect(() => downloadFilename("...")).toThrow();
});
