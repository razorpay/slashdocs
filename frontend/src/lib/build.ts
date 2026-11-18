import { readUnsavedWords } from "./persistent-store";

// The build of this page, which the server writes into index.html. The dev
// server leaves the placeholder.
declare global {
  interface Window {
    __SLASHDOCS_BUILD__?: string;
  }
}

let stale = false;

// noticeBuild takes the build that the server runs. A page of another build
// loads again the next time that it is hidden, so that the reader sees no
// reload and no old code stays open for days. A page that holds words that
// only it has waits for the next time.
export function noticeBuild(build?: string) {
  const own = window.__SLASHDOCS_BUILD__;
  if (stale || !build || !own || own === "__SLASHDOCS_BUILD_VALUE__" || build === own)
    return;
  stale = true;
  const reload = () => {
    if (document.hidden && readUnsavedWords().length === 0) window.location.reload();
  };
  document.addEventListener("visibilitychange", reload);
  reload();
}
