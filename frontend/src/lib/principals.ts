import type { Principal } from "@/api";

export function samePrincipal(a?: Principal, b?: Principal) {
  return !!a && !!b && a.type === b.type && a.id === b.id;
}

export function principalLabel(p?: Principal) {
  if (!p) return "Unknown owner";
  if (p.name) return p.name;
  if (p.email) return p.email;
  if (p.type === "service_account") return p.id || "Service account";
  return p.id || "Unknown owner";
}

// principalNames lists people by name, as in "Asha, Ravi, and Ana".
export function principalNames(people: Principal[]) {
  return new Intl.ListFormat("en").format(people.map(principalLabel));
}

// Ten hues, each at least 4.5:1 with white text, so initials stay readable
// in light and dark. None is a blue near the accent color or the selection
// color of the browser: the selection of another person must not look like
// the selection of the reader.
const PRINCIPAL_COLORS = [
  "#ce2c31",
  "#cc4e00",
  "#a35829",
  "#5c7c2f",
  "#218358",
  "#008573",
  "#107d98",
  "#6550b9",
  "#ab4aba",
  "#c2298a",
];

// principalColor gives each person one color, the same in every session, for
// their cursor and the ring of their avatar. The hash is FNV-1a with a final
// mix, so ids that differ in a few characters still get different colors.
export function principalColor(p: Principal) {
  let hash = 0x811c9dc5;
  for (const char of `${p.type}:${p.id}`) {
    hash = Math.imul(hash ^ char.charCodeAt(0), 0x01000193);
  }
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return PRINCIPAL_COLORS[((hash ^ (hash >>> 16)) >>> 0) % PRINCIPAL_COLORS.length];
}
