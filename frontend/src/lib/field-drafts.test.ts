import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  clearFieldDrafts,
  readFieldDraft,
  saveFieldDraft,
  useFieldDraft,
} from "./field-drafts";

afterEach(() => {
  clearFieldDrafts();
  vi.useRealTimers();
});

it("keeps the words of a field after it closes, and gives them back when it opens again", () => {
  const first = renderHook(() => useFieldDraft("reject:doc_1", "ver_1"));
  act(() => void first.result.current.setText("Fix the table"));
  first.unmount();
  expect(readFieldDraft("reject:doc_1")).toMatchObject({
    body: "Fix the table",
    about: "ver_1",
  });
  const again = renderHook(() => useFieldDraft("reject:doc_1", "ver_2"));
  expect(again.result.current.text).toBe("Fix the table");
  expect(again.result.current.stored?.about).toBe("ver_1");
});

it("clears only the words that a late success sent", () => {
  vi.useFakeTimers();
  const { result } = renderHook(() => useFieldDraft("approver:doc_1"));
  act(() => void result.current.setText("ana@example.com"));
  act(() => void result.current.setText("bo@example.com"));
  act(
    () => void result.current.setText((now) => (now === "ana@example.com" ? "" : now)),
  );
  act(() => void vi.runAllTimers());
  expect(result.current.text).toBe("bo@example.com");
  expect(readFieldDraft("approver:doc_1")?.body).toBe("bo@example.com");
  act(() => void result.current.setText(""));
  act(() => void vi.runAllTimers());
  expect(readFieldDraft("approver:doc_1")).toBeUndefined();
});

it("keeps both texts of a two-tab conflict after the field closes", () => {
  const first = renderHook(() => useFieldDraft("reject:doc_1"));
  act(() => void first.result.current.setText("Shared"));
  first.unmount();
  const field = renderHook(() => useFieldDraft("reject:doc_1"));
  act(() => void field.result.current.setText("Shared and mine"));
  // Another tab saves first.
  act(() => saveFieldDraft("reject:doc_1", "Theirs"));
  expect(field.result.current.conflict?.theirs.body).toBe("Theirs");
  field.unmount();

  const again = renderHook(() => useFieldDraft("reject:doc_1"));
  expect(again.result.current.text).toBe("Shared and mine");
  expect(again.result.current.conflict?.theirs.body).toBe("Theirs");
  act(() => again.result.current.conflict!.keep());
  expect(readFieldDraft("reject:doc_1")).toMatchObject({ body: "Shared and mine" });
  expect(readFieldDraft("reject:doc_1")?.held).toBeUndefined();
});
