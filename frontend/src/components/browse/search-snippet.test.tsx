import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SearchSnippet } from "./search-snippet";

describe("SearchSnippet", () => {
  it("marks the matching text", () => {
    render(<SearchSnippet text={"The error \u0002budget\u0003 for checkout"} />);
    expect(screen.getByText("budget").tagName).toBe("MARK");
    expect(screen.getByText(/for checkout/).textContent).toBe(
      "The error budget for checkout",
    );
  });
});
