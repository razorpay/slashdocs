// Documents written before the rename from aidocs use the aidocs names for the
// document API, the theme attribute, and events. Stored versions never change,
// so the bridge serves every public name.
export const PUBLIC_NAMES = ["slashdocs", "aidocs"] as const;

// dispatchPublicEvent dispatches `<name>:<event>` once for each public name.
export function dispatchPublicEvent(
  view: Window,
  event: string,
  init?: CustomEventInit,
): void {
  for (const name of PUBLIC_NAMES) {
    view.dispatchEvent(new CustomEvent(`${name}:${event}`, init));
  }
}
