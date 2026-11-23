import { readUnsavedWords } from "./persistent-store";

// The build of this page, which the server writes into index.html. The dev
// server leaves the placeholder.
declare global {
  interface Window {
    __SLASHDOCS_BUILD__?: string;
  }
}

// A page loads again at most once in this time. During a rolling deploy the
// servers run two builds, and a page can get its code from one and its
// events from the other.
const RELOAD_GAP = 10 * 60_000;
const RELOADED_AT = "slashdocs:build-reload";

let stale = false;

// noticeBuild takes the build that the server runs. A page of another build
// loads again the next time that it is hidden, so that the reader sees no
// reload and no old code stays open for days. A page that holds what the
// reader cannot get back waits for the next time.
export function noticeBuild(build?: string) {
  const own = window.__SLASHDOCS_BUILD__;
  if (stale || !build || !own || own === "__SLASHDOCS_BUILD_VALUE__" || build === own)
    return;
  stale = true;
  const reload = () => {
    if (!document.hidden || !canLeave()) return;
    try {
      if (Date.now() - Number(sessionStorage.getItem(RELOADED_AT)) < RELOAD_GAP) return;
      sessionStorage.setItem(RELOADED_AT, String(Date.now()));
    } catch {
      return;
    }
    window.location.reload();
  };
  document.addEventListener("visibilitychange", reload);
  reload();
}

// canLeave tells whether the reader can leave the page with no loss: no
// words only in this tab, and no guard of the page that would warn on an
// unload, as for a key that shows once or text that failed to send.
function canLeave() {
  const leave = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(leave);
  return !leave.defaultPrevented && readUnsavedWords().length === 0;
}
