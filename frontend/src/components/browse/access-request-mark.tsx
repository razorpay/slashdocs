import { useAccessRequests } from "@/lib/hooks";

// AccessRequestMark is a dot on a document that people asked to see. The
// requests are in the header inbox and in the share sheet.
export function AccessRequestMark({ documentId }: { documentId: string }) {
  const count =
    useAccessRequests().data?.items.filter((r) => r.document_id === documentId)
      .length ?? 0;
  if (!count) return null;
  return (
    <span
      role="img"
      aria-label={`${count} ${count === 1 ? "request" : "requests"} for access`}
      className="h-2 w-2 shrink-0 rounded-full bg-[var(--color-accent)]"
    />
  );
}
