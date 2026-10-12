// randomId returns a RFC 4122 version 4 UUID string on any origin.
//
// crypto.randomUUID is only exposed in secure contexts (https or localhost),
// so on plain-http deployments it is undefined and every document page would
// crash on mount with "crypto.randomUUID is not a function". This helper uses
// the real API when available and otherwise derives a v4 UUID from
// crypto.getRandomValues, which works on insecure origins too.
export function randomId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
