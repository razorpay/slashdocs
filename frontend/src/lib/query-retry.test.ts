import { QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APIError } from "@/api";
import { toastQueryError } from "./query-retry";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

function query(data?: unknown, meta?: Record<string, unknown>) {
  const qc = new QueryClient();
  const q = qc.getQueryCache().build(qc, { queryKey: ["q"], meta });
  if (data !== undefined) q.setData(data);
  return q;
}

describe("toastQueryError", () => {
  afterEach(() => vi.mocked(toast.error).mockClear());

  it("leaves a query with no data to its own error state", () => {
    toastQueryError(new Error("Failed to fetch"), query());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("says when a refresh of shown data fails", () => {
    toastQueryError(new Error("Failed to fetch"), query({ items: [] }));
    expect(toast.error).toHaveBeenCalledOnce();
  });

  it("stays quiet for a signed-out reader and a suppressed query", () => {
    toastQueryError(new APIError(401, "unauthorized", "Sign in"), query({}));
    toastQueryError(new Error("x"), query({}, { suppressGlobalError: true }));
    expect(toast.error).not.toHaveBeenCalled();
  });
});
