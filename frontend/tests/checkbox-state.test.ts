import { assert, beforeEach, test } from "vitest";
import {
  CHECKBOX_KEY_PREFIX,
  checkboxes,
  checkboxKeys,
  createCheckboxState,
} from "../bridge/checkbox-state.ts";

// The bridge dispatches events through the document's own window, which a
// parsed document lacks, so the tests use the jsdom page itself.
function page(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

const LIST = `
  <ul>
    <li><input type="checkbox"> Write the spec</li>
    <li><input type="checkbox"> Review <ul><li><input type="checkbox"> Nested</li></ul></li>
    <li><input type="checkbox" id="ship"> <label for="ship">Ship it</label></li>
  </ul>`;

function keysOf(d: Document): string[] {
  return Array.from(checkboxKeys(checkboxes(d)).values());
}

beforeEach(() => {
  document.body.innerHTML = "";
});

test("keys name checkboxes by what they say, so they survive a new version", () => {
  const before = keysOf(page(LIST));
  assert.lengthOf(new Set(before), 4);
  assert.isTrue(before.every((key) => key.startsWith(CHECKBOX_KEY_PREFIX)));
  assert.isTrue(before.every((key) => key.length <= 128));
  // A new version adds text and an item before the list; the keys stay.
  const after = keysOf(
    page(`<h1>New intro</h1><ul><li><input type="checkbox"> Added</li></ul>${LIST}`),
  );
  for (const key of before) assert.include(after, key);
});

test("checkboxes that say the same thing are told apart by order", () => {
  const keys = keysOf(
    page(`<table>
      <tr><td>Spec</td><td><input type="checkbox"></td><td><input type="checkbox"></td></tr>
      <tr><td>Spec</td><td><input type="checkbox"></td><td><input type="checkbox"></td></tr>
    </table>`),
  );
  assert.lengthOf(new Set(keys), 4);
});

test("a document can opt checkboxes out", () => {
  const d = page(`<div data-slashdocs-kv="off"><input type="checkbox"></div>
    <p><input type="checkbox"> Mine</p>`);
  assert.lengthOf(checkboxes(d), 1);
});

test("a change is saved, and the stored state comes back after a reload", () => {
  const saved: Record<string, boolean> = {};
  const state = createCheckboxState(
    () => document,
    (key, checked) => (saved[key] = checked),
  );
  page(LIST);
  document.addEventListener("change", state.onChange, true);
  const first = checkboxes(document)[0];
  first.click();
  assert.isTrue(first.checked);
  assert.deepEqual(Object.values(saved), [true]);

  // A new version renders unticked boxes; the hydrate snapshot restores them
  // and tells the document's own handlers.
  page(LIST);
  state.reset();
  let heard = 0;
  document.addEventListener("change", () => heard++);
  state.receive({ revision: 3, items: { ...saved, "doc.own": 1 } });
  assert.isTrue(checkboxes(document)[0].checked);
  assert.isFalse(checkboxes(document)[1].checked);
  assert.strictEqual(heard, 1);
  // Restoring is not a change to save again.
  assert.lengthOf(Object.keys(saved), 1);
  document.removeEventListener("change", state.onChange, true);
});

test("changes from other readers apply, and later checkboxes get their state", () => {
  const state = createCheckboxState(
    () => document,
    () => {},
  );
  page(LIST);
  const [, second] = keysOf(document);
  state.receive({ changes: [{ key: second, value: true, revision: 4 }] });
  assert.isTrue(checkboxes(document)[1].checked);

  // A script renders the list again later.
  page(LIST);
  state.apply();
  assert.isTrue(checkboxes(document)[1].checked);

  state.receive({ changes: [{ key: second, deleted: true, revision: 5 }] });
  page(LIST);
  state.apply();
  assert.isFalse(checkboxes(document)[1].checked);
});
