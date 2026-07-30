import assert from "node:assert/strict";
import test from "node:test";

import {
  canPopHistory,
  isCommentsSheetEntry,
  isFullscreenEntry,
} from "../src/lib/history.ts";

test("canPopHistory pops only past the first router entry", () => {
  assert.equal(canPopHistory({ idx: 1, key: "abc" }), true);
  assert.equal(canPopHistory({ idx: 7, key: "abc" }), true);
  assert.equal(canPopHistory({ idx: 0, key: "abc" }), false);
});

test("canPopHistory fails closed on entries the router did not create", () => {
  assert.equal(canPopHistory(null), false);
  assert.equal(canPopHistory(undefined), false);
  assert.equal(canPopHistory({}), false);
  assert.equal(canPopHistory({ idx: NaN }), false);
  assert.equal(canPopHistory({ idx: "2" }), false);
  assert.equal(canPopHistory({ idx: 1.5 }), false);
  assert.equal(canPopHistory({ idx: -1 }), false);
});

test("canPopHistory reads the sheet entry that preserved the router idx", () => {
  assert.equal(canPopHistory({ idx: 2, key: "abc", aidocsCommentsSheet: true }), true);
  assert.equal(canPopHistory({ aidocsCommentsSheet: true }), false);
});

test("isFullscreenEntry detects only our tagged fullscreen push", () => {
  assert.equal(
    isFullscreenEntry({ idx: 2, key: "abc", usr: { aidocsFullscreen: true } }),
    true,
  );
  assert.equal(isFullscreenEntry({ idx: 2, usr: {} }), false);
  assert.equal(isFullscreenEntry({ idx: 2, usr: null }), false);
  assert.equal(isFullscreenEntry({ idx: 2, usr: { aidocsFullscreen: false } }), false);
  assert.equal(isFullscreenEntry({ idx: 2 }), false);
  assert.equal(isFullscreenEntry(null), false);
  assert.equal(isFullscreenEntry(undefined), false);
});

test("isCommentsSheetEntry detects only our tagged sheet push", () => {
  assert.equal(isCommentsSheetEntry({ idx: 2, aidocsCommentsSheet: true }), true);
  assert.equal(isCommentsSheetEntry({ idx: 2 }), false);
  assert.equal(isCommentsSheetEntry(null), false);
  assert.equal(isCommentsSheetEntry(undefined), false);
});
