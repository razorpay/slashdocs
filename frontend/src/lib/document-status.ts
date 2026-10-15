import type { DocumentStatus } from "@/api";

export const DOCUMENT_STATUSES: {
  value: DocumentStatus;
  label: string;
  color: string;
}[] = [
  { value: "draft", label: "Draft", color: "var(--color-fg-muted)" },
  { value: "in_review", label: "In review", color: "var(--color-warning)" },
  { value: "approved", label: "Approved", color: "var(--color-success)" },
  { value: "archived", label: "Archived", color: "var(--color-border-strong)" },
];

export function statusMeta(status?: string) {
  return DOCUMENT_STATUSES.find((s) => s.value === status);
}

export function labelSearchPath(label: string) {
  return `/app/documents?q=${encodeURIComponent(`label:${label}`)}`;
}
