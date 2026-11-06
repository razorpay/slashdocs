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

// Dark enough for white text, and far enough apart to tell people apart.
const PRINCIPAL_COLORS = [
  "#e5484d",
  "#e5590c",
  "#d6409f",
  "#8e4ec6",
  "#3e63dd",
  "#0d74ce",
  "#0d9b8a",
  "#2b9a66",
];

// principalColor gives each person one color, the same in every session, for
// their cursor and the ring of their avatar.
export function principalColor(p: Principal) {
  let hash = 0;
  for (const char of `${p.type}:${p.id}`) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return PRINCIPAL_COLORS[Math.abs(hash) % PRINCIPAL_COLORS.length];
}
