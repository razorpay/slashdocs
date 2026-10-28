// Checkboxes remember their state in the document KV. A plain HTML checkbox
// only holds its state in the page, so a reload or a new version showed the
// state of the HTML again. The bridge saves each change under a key that
// names the checkbox by what it says, not where it is, so the state carries
// over to new versions that keep the checkbox.

export const CHECKBOX_KEY_PREFIX = "slashdocs.checkbox.";

// A document can keep its checkboxes to itself, for example when it saves
// their state under its own KV keys.
const OPT_OUT = '[data-slashdocs-kv="off"]';
// Text the bridge adds is not part of what a checkbox says.
const BRIDGE_NODES = "[class^='slashdocs-'],[class*=' slashdocs-']";

// fnv1a is a short stable hash; two seeds make an accidental collision
// between the checkboxes of one document very unlikely.
function fnv1a(text: string, seed: number): string {
  let h = seed;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function ownText(holder: Element): string {
  const copy = holder.cloneNode(true) as Element;
  // The text of nested lists belongs to their own checkboxes.
  copy.querySelectorAll(`ul,ol,${BRIDGE_NODES}`).forEach((node) => node.remove());
  return (copy.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

// checkboxIdentity is what a checkbox says: its id, or else its name and
// value and the text of its label, list item, or table row.
export function checkboxIdentity(input: HTMLInputElement): string {
  if (input.id) return "id:" + input.id;
  const holder =
    input.closest("label") ||
    input.labels?.[0] ||
    input.closest("li,tr,dt,dd,p") ||
    input.parentElement;
  let text = holder ? ownText(holder) : "";
  if (holder?.tagName === "TR") {
    const cell = input.closest("td,th") as HTMLTableCellElement | null;
    text += "#" + (cell ? cell.cellIndex : -1);
  }
  const name = input.name ? `n:${input.name}=${input.value}|` : "";
  return "t:" + name + text;
}

export function checkboxes(d: Document): HTMLInputElement[] {
  return Array.from(
    d.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ).filter((input) => !input.closest(OPT_OUT));
}

// checkboxKeys names every checkbox. Checkboxes that say the same thing are
// told apart by their order.
export function checkboxKeys(
  inputs: HTMLInputElement[],
): Map<HTMLInputElement, string> {
  const seen = new Map<string, number>();
  const keys = new Map<HTMLInputElement, string>();
  for (const input of inputs) {
    const identity = checkboxIdentity(input);
    const n = seen.get(identity) || 0;
    seen.set(identity, n + 1);
    const hash = fnv1a(identity, 0x811c9dc5) + fnv1a(identity, 0x01000193);
    keys.set(input, CHECKBOX_KEY_PREFIX + hash + (n ? "." + n : ""));
  }
  return keys;
}

interface KVDetail {
  items?: Record<string, unknown>;
  changes?: Array<{ key?: unknown; value?: unknown; deleted?: unknown }>;
}

// createCheckboxState keeps the checkboxes of the document in the frame in
// step with the KV. save sends one change to the KV.
export function createCheckboxState(
  doc: () => Document | null,
  save: (key: string, checked: boolean) => void,
) {
  let stored: Record<string, boolean> = {};
  let applying = false;

  // apply sets each checkbox that has a stored state, and tells the
  // document's own handlers, as a click would.
  function apply(): void {
    const d = doc();
    const view = d?.defaultView;
    if (!d || !view) return;
    applying = true;
    try {
      for (const [input, key] of checkboxKeys(checkboxes(d))) {
        if (!(key in stored) || input.checked === stored[key]) continue;
        input.checked = stored[key];
        input.dispatchEvent(new view.Event("input", { bubbles: true }));
        input.dispatchEvent(new view.Event("change", { bubbles: true }));
      }
    } finally {
      applying = false;
    }
  }

  function onChange(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    if (applying || input?.tagName !== "INPUT" || input.type !== "checkbox") return;
    const d = doc();
    if (!d || input.closest(OPT_OUT)) return;
    const key = checkboxKeys(checkboxes(d)).get(input);
    if (!key) return;
    stored[key] = input.checked;
    save(key, input.checked);
  }

  // receive takes a KV snapshot or a list of changes.
  function receive(detail: unknown): void {
    if (!detail || typeof detail !== "object") return;
    const { items, changes } = detail as KVDetail;
    let touched = false;
    if (items && typeof items === "object") {
      for (const [key, value] of Object.entries(items)) {
        if (!key.startsWith(CHECKBOX_KEY_PREFIX)) continue;
        stored[key] = value === true;
        touched = true;
      }
    }
    for (const change of Array.isArray(changes) ? changes : []) {
      if (typeof change?.key !== "string") continue;
      if (!change.key.startsWith(CHECKBOX_KEY_PREFIX)) continue;
      if (change.deleted) delete stored[change.key];
      else stored[change.key] = change.value === true;
      touched = true;
    }
    if (touched) apply();
  }

  function reset(): void {
    stored = {};
  }

  return { apply, onChange, receive, reset };
}
